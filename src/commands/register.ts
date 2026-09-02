/**
 * Catalogue-driven command registration.
 *
 * Core shopping flows (search, info, cart, checkout) are bespoke (rich typed
 * output, id resolution, delivery preview, payment recovery). Every OTHER
 * non-excluded catalogue endpoint is auto-wired here into a commander command
 * matching its `command` string, with: path params as positional args, a `--query`
 * passthrough, `--file` for write bodies, `--confirm/--yes` gating for mutations,
 * the form→submit local-binding pair, and `--unsafe-raw`. This guarantees every
 * endpoint the app exposes is reachable, with the plan's safety contracts.
 */

import * as fs from 'node:fs';
import type { Command } from 'commander';
import { CATALOGUE, GATE_EXEMPT_MUTATIONS, type EndpointRow } from '../lib/catalogue.js';
import type { Context } from '../lib/context.js';
import { fetchForm, mutateEndpoint, readEndpoint, submitForm, type CommonFlags } from './generic.js';

/** First command words handled by bespoke modules — skipped by the auto-wirer. */
const BESPOKE_FIRST = new Set(['search', 'info', 'cart', 'checkout', 'login']);
/** Specific endpoint ids handled bespoke (typed) — the auto-wirer leaves them alone. */
const BESPOKE_IDS = new Set(['orders.list', 'orders.detail']);

interface RunFn {
  (command: Command, fn: (ctx: Context) => Promise<void>): void;
}

/** Collect a repeatable `--query k=v` / `--param k=v` into an object. */
function kv(value: string, prev: Record<string, string> = {}): Record<string, string> {
  const i = value.indexOf('=');
  if (i < 0) throw new Error(`expected key=value, got "${value}"`);
  prev[value.slice(0, i)] = value.slice(i + 1);
  return prev;
}

/**
 * Path params the command must supply as positionals, in order. `customerId` is
 * auto-filled from the session and never a positional; `absoluteUrl` (the sole
 * absolute-base row) IS a required positional so `address validate <url>` works.
 */
function pathParams(row: EndpointRow): string[] {
  const out: string[] = [];
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(row.path))) {
    if (m[1] !== 'customerId') out.push(m[1]!);
  }
  return out;
}

const sameParams = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Split a command string into { words, flag } — a single `--flag` variant selector. */
function parseCommand(cmd: string): { words: string[]; flag?: string } {
  const parts = cmd.split(/\s+/).filter(Boolean);
  const flag = parts.find((p) => p.startsWith('--'));
  return { words: parts.filter((p) => !p.startsWith('--')), flag: flag?.slice(2) };
}

interface Group {
  words: string[];
  base: EndpointRow; // no-flag row (or first)
  variants: { flag: string; row: EndpointRow }[];
}

export function registerCatalogue(
  program: Command,
  withGlobals: (c: Command) => Command,
  run: RunFn,
  globalFlags: (c: Command) => { json?: boolean; verbose?: boolean },
): void {
  // Pass 1: the no-flag base row per command path (its positional schema).
  const baseParams = new Map<string, string[]>();
  for (const row of CATALOGUE) {
    if (row.excluded || !row.command || BESPOKE_IDS.has(row.id)) continue;
    const { words, flag } = parseCommand(row.command);
    if (BESPOKE_FIRST.has(words[0]!)) continue;
    if (!flag) baseParams.set(words.join(' '), pathParams(row));
  }

  // Pass 2: group rows. A flag variant folds into the base ONLY when its path
  // params match the base's; otherwise its flag becomes a trailing subcommand
  // word so it gets its own command with its own required positionals (e.g.
  // `recommend --personal` → `recommend personal`, which takes no <location>).
  const groups = new Map<string, Group>();
  for (const row of CATALOGUE) {
    if (row.excluded || !row.command || BESPOKE_IDS.has(row.id)) continue;
    let { words, flag } = parseCommand(row.command);
    if (BESPOKE_FIRST.has(words[0]!)) continue;
    if (flag) {
      const bp = baseParams.get(words.join(' '));
      if (!bp || !sameParams(bp, pathParams(row))) {
        // divergent params (or no base) → make the flag a real subcommand word
        words = [...words, flag];
        flag = undefined;
      }
    }
    const key = words.join(' ');
    let g = groups.get(key);
    if (!g) {
      g = { words, base: row, variants: [] };
      groups.set(key, g);
    }
    if (flag) g.variants.push({ flag, row });
    else g.base = row;
  }

  // Wire shorter command paths first so a bare command (e.g. `wishlist`) gets its
  // action before it also becomes the parent of `wishlist list`.
  const ordered = [...groups.values()].sort((a, b) => a.words.length - b.words.length);
  for (const g of ordered) {
    wireGroup(program, g, withGlobals, run, globalFlags);
  }
}

/** Create (or fetch) the nested group command for all but the last word. */
function groupFor(program: Command, words: string[], withGlobals: (c: Command) => Command): Command {
  let parent = program;
  for (let i = 0; i < words.length - 1; i++) {
    const name = words[i]!;
    const existing = parent.commands.find((cm) => cm.name() === name);
    if (existing) {
      parent = existing;
      continue;
    }
    const grp = withGlobals(parent.command(name)).description(`${words.slice(0, i + 1).join(' ')} commands`);
    parent = grp;
  }
  return parent;
}

function wireGroup(
  program: Command,
  g: Group,
  withGlobals: (c: Command) => Command,
  run: RunFn,
  _globalFlags: (c: Command) => { json?: boolean; verbose?: boolean },
): void {
  const leafName = g.words[g.words.length - 1]!;
  const parent = groupFor(program, g.words, withGlobals);
  if (parent.commands.find((cm) => cm.name() === leafName)) return; // already wired (shared prefix)

  const row = g.base;
  const params = pathParams(row);
  const isForm = row.command!.endsWith(' form') || row.command === 'form';
  const isSubmit = row.command!.endsWith(' submit');
  const anyMutating = [row, ...g.variants.map((v) => v.row)].some((rr) => rr.mutating && !GATE_EXEMPT_MUTATIONS.has(rr.id));

  let cmd = withGlobals(parent.command(leafName)).description(describe(row));
  for (const p of params) cmd = cmd.argument(`<${p}>`, `${p} path parameter`);
  cmd = cmd.option('--unsafe-raw', 'print unredacted JSON (leaks secrets)');
  if (!isForm) cmd = cmd.option('--query <k=v...>', 'query parameter (repeatable)', kv);
  if (isSubmit || (anyMutating && !isForm)) {
    cmd = cmd.option('--file <path>', 'completed JSON payload (or - for stdin)');
  }
  if (anyMutating) {
    cmd = cmd.option('--confirm', 'perform the write (default is a dry run)').option('--yes', 'skip the confirm prompt');
  }
  for (const v of g.variants) cmd = cmd.option(`--${v.flag}`, `use the ${v.flag} variant`);

  cmd.action((...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const options = args[args.length - 2] as Record<string, unknown>;
    const positionals = args.slice(0, params.length) as string[];
    run(command, async (ctx) => {
      // Resolve which endpoint id (flag variant or base).
      let chosen = row;
      for (const v of g.variants) if (options[v.flag]) chosen = v.row;

      const paramObj: Record<string, string | number> = {};
      params.forEach((p, i) => (paramObj[p] = positionals[i]!));
      const query = (options.query as Record<string, string>) ?? undefined;
      const flags: CommonFlags = {
        unsafeRaw: Boolean(options.unsafeRaw),
        confirm: Boolean(options.confirm),
        yes: Boolean(options.yes),
        file: options.file as string | undefined,
      };

      const flow = g.words.slice(0, isForm ? -1 : isSubmit ? -1 : g.words.length).join(' ');
      if (isForm) {
        await fetchForm(ctx, flow, chosen.id, { params: paramObj, query }, flags);
      } else if (isSubmit) {
        await submitForm(ctx, flow, chosen.id, { params: paramObj }, flags);
      } else if (chosen.mutating && !GATE_EXEMPT_MUTATIONS.has(chosen.id)) {
        const body = flags.file ? undefined : {};
        await mutateEndpoint(
          ctx,
          chosen.id,
          { params: paramObj, query, body: flags.file ? readBodyFromFlags(flags) : body },
          flags,
        );
      } else if (chosen.mutating) {
        // gate-exempt write (e.g. chatbot) — send straight through
        await mutateEndpoint(ctx, chosen.id, { params: paramObj, query, body: readBodyFromFlags(flags) ?? {} }, flags);
      } else {
        await readEndpoint(ctx, chosen.id, { params: paramObj, query }, flags);
      }
    });
  });
}

function readBodyFromFlags(flags: CommonFlags): unknown {
  if (!flags.file) return undefined;
  const raw = flags.file === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(flags.file, 'utf-8');
  return JSON.parse(raw);
}

function describe(row: EndpointRow): string {
  const tag = row.mutating && !GATE_EXEMPT_MUTATIONS.has(row.id) ? ' (write — dry-run unless --confirm)' : '';
  return `${row.domain}: ${row.method} ${row.path}${tag}`;
}
