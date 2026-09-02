/**
 * Generic command helpers shared by the passthrough command groups.
 *
 * Every catalogue endpoint reaches the API through `ctx.client.call(id, …)`;
 * these helpers wrap that with the plan's cross-cutting contracts: recursive
 * redaction on output, mutation gating (dry-run unless --confirm), and the
 * locally-bound data-section form→submit flow.
 */

import * as fs from 'node:fs';
import type { Context } from '../lib/context.js';
import { c, renderRaw } from '../lib/ui.js';
import { redact, redactUrl } from '../lib/redact.js';
import { confirm } from '../lib/prompt.js';
import { loadFormCache, saveFormCache } from '../lib/config.js';
import { GATE_EXEMPT_MUTATIONS } from '../lib/catalogue.js';

export interface CommonFlags {
  json?: boolean;
  unsafeRaw?: boolean;
  confirm?: boolean;
  yes?: boolean;
  file?: string;
}

/**
 * The mutation gate: dry-run by default. Returns `true` when the caller should
 * proceed with the write, `false` when it printed a dry-run/cancellation and the
 * caller must return without mutating. Shared by the bespoke (cart/…) and the
 * generic passthrough command paths so gating is identical everywhere.
 */
export async function gate(
  ctx: Context,
  flags: { confirm?: boolean; yes?: boolean },
  preview: { action: string; request?: unknown },
): Promise<boolean> {
  if (!flags.confirm) {
    ctx.logger.result(
      () => {
        process.stdout.write(`${c.yellow('DRY RUN')} — would ${preview.action}\n`);
        process.stdout.write(c.dim('  Re-run with --confirm to perform this write.\n'));
      },
      { dryRun: true, action: preview.action, request: preview.request },
    );
    return false;
  }
  if (flags.confirm && !flags.yes && !ctx.logger.isJson && process.stdin.isTTY) {
    process.stderr.write(`\nAbout to ${preview.action}\n`);
    if (!(await confirm('Proceed?', false))) {
      ctx.logger.info('Cancelled.');
      return false;
    }
  }
  return true;
}

/** Emit a read result: redacted JSON on --json, a compact summary otherwise. */
export function emit(ctx: Context, data: unknown, unsafe = false): void {
  const safe = redact(data, { unsafe });
  ctx.logger.result(() => {
    process.stdout.write(renderRaw(safe) + '\n');
  }, safe);
}

/** A read (never gated). */
export async function readEndpoint(
  ctx: Context,
  id: string,
  args: Parameters<Context['client']['call']>[1] = {},
  flags: CommonFlags = {},
): Promise<void> {
  await ctx.ensureCredentials().catch(() => undefined); // authed calls need creds; reads on public don't
  const data = await ctx.client.call(id, args);
  emit(ctx, data, flags.unsafeRaw);
}

/**
 * A mutating call: dry-run by default (prints the exact intended request), writes
 * only with --confirm. `help chat …` and other conversational endpoints on the
 * gate-exempt allowlist skip the gate.
 */
export async function mutateEndpoint(
  ctx: Context,
  id: string,
  args: Parameters<Context['client']['call']>[1] = {},
  flags: CommonFlags = {},
): Promise<void> {
  await ctx.ensureCredentials();
  const exempt = GATE_EXEMPT_MUTATIONS.has(id);
  const preview = ctx.client.describeCall(id, args);
  if (!exempt) {
    // Redact any auth token in the URL (query AND fragment) before it is printed
    // in the dry-run preview.
    const safeUrl = redactUrl(preview.url);
    const req = { method: preview.method, url: safeUrl, body: preview.body };
    if (!(await gate(ctx, flags, { action: `${preview.method} ${safeUrl}`, request: req }))) return;
  }
  const data = await ctx.client.call(id, args);
  emit(ctx, data, flags.unsafeRaw);
}

// =====================
// Data-section form → submit (locally bound)
// =====================

/** GET a data-section form layout, cache it for local submit binding, emit it. */
export async function fetchForm(
  ctx: Context,
  flow: string,
  id: string,
  args: Parameters<Context['client']['call']>[1] = {},
  flags: CommonFlags = {},
): Promise<void> {
  await ctx.ensureCredentials();
  const layout = await ctx.client.call(id, args);
  saveFormCache(ctx.accountHash(), flow, layout);
  ctx.logger.info(c.dim(`form cached — fill it and run the matching \`submit --file <json>\``));
  emit(ctx, layout, flags.unsafeRaw);
}

/** Read a completed-form payload from a file path (or `-` for stdin). */
function readPayload(file: string): unknown {
  const raw = file === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`--file is not valid JSON: ${(e as Error).message}`);
  }
}

/** Index the (section_id → set of field_id) pairs discoverable in a form layout. */
function indexForm(layout: unknown): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const sid = obj.section_id;
    if (typeof sid === 'string') {
      const fields = new Set<string>();
      for (const key of ['fields', 'data_fields']) {
        const arr = obj[key];
        if (Array.isArray(arr)) {
          for (const f of arr) {
            const fid = (f as any)?.field_id;
            if (typeof fid === 'string') fields.add(fid);
          }
        }
      }
      index.set(sid, fields);
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(layout);
  return index;
}

/** Validate a completed payload's ids against the cached form (local binding). */
function validateAgainstForm(payload: unknown, index: Map<string, Set<string>>): void {
  if (index.size === 0) return; // form had no indexable sections — can't bind, proceed
  const sections = (payload as any)?.sections;
  if (!Array.isArray(sections)) {
    throw new Error('payload must have a top-level `sections` array (from the fetched form)');
  }
  for (const s of sections) {
    const sid = s?.section_id;
    if (!index.has(sid)) {
      throw new Error(`unknown section_id "${sid}" — it is not in the fetched form (stale or foreign)`);
    }
    const known = index.get(sid)!;
    if (known.size === 0) continue;
    for (const f of s?.fields ?? []) {
      if (f?.field_id && !known.has(f.field_id)) {
        throw new Error(`unknown field_id "${f.field_id}" in section "${sid}" — not in the fetched form`);
      }
    }
  }
}

/**
 * Submit a completed data-section payload, locally bound to the cached form.
 * Rejects section/field ids the fetched form didn't contain, injects `platform`,
 * and applies the same dry-run/--confirm gate as any other write.
 */
export async function submitForm(
  ctx: Context,
  flow: string,
  id: string,
  pathArgs: { params?: Record<string, string | number> },
  flags: CommonFlags,
): Promise<void> {
  await ctx.ensureCredentials();
  if (!flags.file) throw new Error('provide the completed form with --file <json> (or --file - for stdin)');
  const payload = readPayload(flags.file);

  const cached = loadFormCache(ctx.accountHash(), flow);
  if (!cached) {
    throw new Error(`no cached form for "${flow}" — run \`${flow} form\` first, then submit`);
  }
  validateAgainstForm(payload, indexForm(cached.layout));

  const body = { platform: 'android', ...(payload as Record<string, unknown>) };
  await mutateEndpoint(ctx, id, { ...pathArgs, body }, flags);
}
