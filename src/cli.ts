#!/usr/bin/env node
/**
 * takealot — command-line entry point.
 *
 * Wires every command group onto a Commander program. `--json` and `--verbose`
 * are accepted in any position (before or after the subcommand) by defining
 * them on each command and OR-ing the values up the ancestor chain.
 */

import { Command, CommanderError } from 'commander';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Context, OtpFlowError, type GlobalOptions } from './lib/context.js';
import { ApiError } from './lib/api-client.js';
import { isAuthFailure } from './lib/auth.js';
import { UsageError } from './lib/errors.js';
import { c } from './lib/ui.js';
import { searchCommand } from './commands/search.js';
import { cartShow, cartAdd, cartAddBasket, cartClear, cartSetQty, cartRemove } from './commands/cart.js';
import { checkoutCommand } from './commands/checkout.js';
import { cardsCommand, cardsRemove } from './commands/cards.js';
import { infoCommand } from './commands/info.js';
import { reviewsCommand } from './commands/reviews.js';
import { recommendCommand, recommendLayout } from './commands/recommend.js';
import { ordersList, ordersShow } from './commands/orders.js';
import { preferencesRefresh, preferencesShow } from './commands/preferences.js';
import { configShow } from './commands/config.js';
import { loginCommand } from './commands/login.js';
import { registerCatalogue } from './commands/register.js';
import { mutateEndpoint, readBodyFromFlags } from './commands/generic.js';

declare const __TAKEALOT_VERSION__: string | undefined;
const VERSION =
  typeof __TAKEALOT_VERSION__ === 'string' && __TAKEALOT_VERSION__ ? __TAKEALOT_VERSION__ : '0.6.1';

const intOpt = (name: string) => (v: string) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new UsageError(`invalid ${name}: ${v}`);
  return n;
};

/** Add the two global flags to a command so they parse in any position. */
function withGlobals(cmd: Command): Command {
  return cmd
    .option('--json', 'output results as machine-readable JSON')
    .option('--verbose', 'print debug logging to stderr');
}

/** Collect --json/--verbose from this command and all its ancestors. */
function globalFlags(command: Command): GlobalOptions {
  let json = false;
  let verbose = false;
  for (let cmd: Command | undefined = command; cmd; cmd = cmd.parent ?? undefined) {
    const opts = cmd.opts();
    if (opts.json) json = true;
    if (opts.verbose) verbose = true;
  }
  return { json, verbose };
}

/** Build a Context for the invocation and run the handler with unified error handling. */
function errorDetails(err: unknown): { error: string; code: string; status?: number } {
  const error = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError) return { error, code: err.info.code, status: err.info.status };
  if (err instanceof UsageError) return { error, code: err.code };
  if (err instanceof OtpFlowError) return { error, code: err.code };
  if (isAuthFailure(err)) return { error, code: err.code };
  if (err instanceof CommanderError) return { error, code: err.code };
  return { error, code: 'runtime_error' };
}

function errorExitCode(err: unknown): number {
  if (err instanceof UsageError || err instanceof CommanderError) return 4;
  if (err instanceof OtpFlowError || isAuthFailure(err) || (err instanceof ApiError && err.info.status === 401)) return 3;
  return 1;
}

export async function run(command: Command, fn: (ctx: Context) => Promise<void>): Promise<void> {
  const flags = globalFlags(command);
  const ctx = new Context(flags);
  try {
    await fn(ctx);
  } catch (err) {
    const details = errorDetails(err);
    if (ctx.logger.isJson) {
      process.stdout.write(JSON.stringify(details, null, 2) + '\n');
    } else {
      ctx.logger.error(details.error);
      if (flags.verbose && err instanceof Error && err.stack) {
        process.stderr.write(c.gray(err.stack) + '\n');
      }
    }
    process.exitCode = errorExitCode(err);
  }
}

const program = new Command();

program.exitOverride().configureOutput({
  writeErr: (text) => {
    if (!process.argv.includes('--json')) process.stderr.write(text);
  },
});

withGlobals(program)
  .name('takealot')
  .description('Command-line tool for Takealot.com — search, cart, checkout preview, and order history.')
  .version(VERSION, '-V, --version', 'print the version')
  .showHelpAfterError();

// ---- search ----
withGlobals(program.command('search'))
  .description('search the Takealot catalogue (no login required)')
  .allowExcessArguments(false)
  .argument('<query>', 'what to search for')
  .option('--limit <n>', 'max results to show', (v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 1) throw new UsageError(`invalid --limit: ${v}`);
    return n;
  }, 10)
  .action((query: string, options: { limit: number }, command: Command) =>
    run(command, (ctx) => searchCommand(ctx, query, { limit: options.limit })),
  );

// ---- cart ----
const cart = withGlobals(program.command('cart'))
  .description('view and modify your cart')
  .allowExcessArguments(false)
  .action((_options: unknown, command: Command) => run(command, (ctx) => cartShow(ctx)));

const confirmOpts = (cmd: Command): Command =>
  cmd.option('--confirm', 'perform the write (default is a dry run)').option('--yes', 'skip the confirm prompt');

confirmOpts(withGlobals(cart.command('add')))
  .description('add an item: --sku <id> (exact), --plid <id> (resolved to sku), or a search query')
  .argument('[item...]', 'search query, optionally prefixed with a quantity (e.g. "3 pencils")')
  .option('--sku <id>', 'add this exact buyable SKU id', intOpt('--sku'))
  .option('--plid <id>', 'add the buyable SKU for this PLID', intOpt('--plid'))
  .option('--qty <n>', 'quantity (with --sku/--plid)', intOpt('--qty'))
  .action((item: string[], options: any, command: Command) =>
    run(command, (ctx) => cartAdd(ctx, (item ?? []).join(' '), options)),
  );

confirmOpts(withGlobals(cart.command('set-qty')))
  .description('update a cart line quantity (by buyable SKU id)')
  .allowExcessArguments(false)
  .argument('<sku>', 'buyable SKU id', intOpt('<sku>'))
  .argument('<qty>', 'new quantity', intOpt('<qty>'))
  .action((sku: number, qty: number, options: any, command: Command) =>
    run(command, (ctx) => cartSetQty(ctx, sku, qty, options)),
  );

confirmOpts(withGlobals(cart.command('remove')))
  .description('remove one cart line (by buyable SKU id)')
  .allowExcessArguments(false)
  .argument('<sku>', 'buyable SKU id', intOpt('<sku>'))
  .action((sku: number, options: any, command: Command) => run(command, (ctx) => cartRemove(ctx, sku, options)));

confirmOpts(withGlobals(cart.command('basket')))
  .description('add several items at once (comma/semicolon/newline separated)')
  .allowExcessArguments(false)
  .argument('<items>', 'e.g. "3 pencils, 2 pens, notebook"')
  .action((items: string, options: any, command: Command) =>
    run(command, (ctx) => cartAddBasket(ctx, items, options)),
  );

confirmOpts(withGlobals(cart.command('clear')))
  .description('remove everything from the cart')
  .allowExcessArguments(false)
  .action((options: any, command: Command) => run(command, (ctx) => cartClear(ctx, options)));

// ---- info (product detail) ----
withGlobals(program.command('info'))
  .description('product detail for a PLID (price, stock, sku, rating)')
  .allowExcessArguments(false)
  .argument('<plid>', 'product PLID', intOpt('<plid>'))
  .option('--credit-options', 'show instalment/credit options')
  .option('--bundle <ids>', 'show bundle deals for the given bundle ids')
  .option('--card', 'lightweight product card')
  .option('--reviews', 'public product reviews')
  .option('--unsafe-raw', 'print unredacted JSON (leaks secrets)')
  .action((plid: number, options: any, command: Command) =>
    run(command, (ctx) => infoCommand(ctx, plid, options)),
  );

withGlobals(program.command('reviews'))
  .description('public product reviews for a PLID')
  .allowExcessArguments(false)
  .argument('<plid>', 'product PLID', intOpt('<plid>'))
  .option('--page <n>', 'review page', intOpt('--page'), 1)
  .option('--sort <key>', 'review sort key')
  .action((plid: number, options: { page: number; sort?: string }, command: Command) =>
    run(command, (ctx) => reviewsCommand(ctx, plid, options)),
  );

const recommend = withGlobals(program.command('recommend'))
  .description('product recommendations')
  .allowExcessArguments(false)
  .argument('[location]', 'recommendation location', 'home-page')
  .option('--model <key>', 'recommendation model key')
  .option('--limit <n>', 'max products to show', intOpt('--limit'), 10)
  .action((location: string, options: { model?: string; limit: number }, command: Command) =>
    run(command, (ctx) => recommendCommand(ctx, location, options)),
  );

withGlobals(recommend.command('layout'))
  .description('list recommendation model keys')
  .allowExcessArguments(false)
  .option('--location <location>', 'recommendation location', 'home-page')
  .action((options: { location: string }, command: Command) =>
    run(command, (ctx) => recommendLayout(ctx, options.location)),
  );

// ---- checkout ----
const checkout = withGlobals(program.command('checkout'))
  .description('preview checkout; orders are placed in the Takealot app')
  .allowExcessArguments(false)
  .option('--confirm', 'refused: orders are placed in the Takealot app')
  .action((options: { confirm?: boolean }, command: Command) =>
    run(command, (ctx) => checkoutCommand(ctx, { confirm: Boolean(options.confirm) })),
  );

confirmOpts(withGlobals(checkout.command('start')))
  .description('start or refresh checkout state')
  .allowExcessArguments(false)
  .option('--file <path>', 'JSON payload (or - for stdin)')
  .action((options: any, command: Command) =>
    run(command, (ctx) =>
      mutateEndpoint(ctx, 'checkout.create', { body: readBodyFromFlags(options) ?? {} }, options),
    ),
  );

confirmOpts(withGlobals(checkout.command('submit')))
  .description('submit checkout delivery or pickup selections')
  .allowExcessArguments(false)
  .requiredOption('--file <path>', 'completed JSON payload (or - for stdin)')
  .action((options: any, command: Command) =>
    run(command, (ctx) =>
      mutateEndpoint(ctx, 'checkout.update', { body: readBodyFromFlags(options, true) }, options),
    ),
  );

const cards = withGlobals(program.command('cards'))
  .description('list saved cards without exposing card references')
  .allowExcessArguments(false)
  .option('--unsafe-raw', 'accepted but card secrets remain hidden')
  .action((_options: unknown, command: Command) => run(command, (ctx) => cardsCommand(ctx)));

confirmOpts(withGlobals(cards.command('rm')))
  .description('remove a saved card by its last four digits')
  .allowExcessArguments(false)
  .requiredOption('--last4 <digits>', 'last four card digits')
  .action((options: any, command: Command) =>
    run(command, (ctx) => cardsRemove(ctx, String(options.last4), options)),
  );

// ---- preferences ----
const preferences = withGlobals(program.command('preferences'))
  .description('manage the order-history preference cache')
  .allowExcessArguments(false)
  .action((_options: unknown, command: Command) => run(command, (ctx) => preferencesShow(ctx)));

withGlobals(preferences.command('refresh'))
  .description('rebuild the preference cache from order history')
  .allowExcessArguments(false)
  .action((_options: unknown, command: Command) => run(command, (ctx) => preferencesRefresh(ctx)));

withGlobals(preferences.command('show'))
  .description('list the products currently in the preference cache')
  .allowExcessArguments(false)
  .action((_options: unknown, command: Command) => run(command, (ctx) => preferencesShow(ctx)));

// ---- config ----
const config = withGlobals(program.command('config'))
  .description('show configuration and credential status')
  .allowExcessArguments(false)
  .action((_options: unknown, command: Command) => run(command, (ctx) => configShow(ctx)));

withGlobals(config.command('show'))
  .description('show configuration with secrets redacted')
  .allowExcessArguments(false)
  .action((_options: unknown, command: Command) => run(command, (ctx) => configShow(ctx)));

// ---- login ----
withGlobals(program.command('login'))
  .description('log in to Takealot, rotating the cached tokens')
  .allowExcessArguments(false)
  .option('--reset', 're-enter email/password before logging in')
  .option('--otp <code>', 'complete a 2FA challenge (prefer TAKEALOT_OTP — flags leak via ps/history)')
  .option('--challenge <nonce>', 'the challenge nonce from the otp_required output (required with --otp)')
  .action((options: { reset?: boolean; otp?: string; challenge?: string }, command: Command) =>
    run(command, (ctx) =>
      loginCommand(ctx, {
        reset: Boolean(options.reset),
        otp: options.otp,
        challenge: options.challenge,
      }),
    ),
  );

// ---- orders (typed) — registered before the catalogue so it wins over the
// generic passthrough; `orders track/cancel/...` are auto-wired under this group.
const orders = withGlobals(program.command('orders'))
  .description('list recent orders')
  .allowExcessArguments(false)
  .option('--limit <n>', 'max orders to show', intOpt('--limit'), 20)
  .action((options: { limit: number }, command: Command) =>
    run(command, (ctx) => ordersList(ctx, { limit: options.limit })),
  );

withGlobals(orders.command('show'))
  .description('show full detail for one order')
  .allowExcessArguments(false)
  .argument('<id>', 'order id')
  .action((id: string, _options: unknown, command: Command) => run(command, (ctx) => ordersShow(ctx, id)));

// ---- everything else: auto-wired from the endpoint catalogue ----
registerCatalogue(program, withGlobals, run, globalFlags);

export async function main(argv = process.argv): Promise<void> {
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError && (err.code === 'commander.helpDisplayed' || err.code === 'commander.version')) {
      process.exitCode = 0;
      return;
    }
    const details = errorDetails(err);
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(details, null, 2) + '\n');
    else if (!(err instanceof CommanderError)) process.stderr.write(`${details.error}\n`);
    process.exitCode = errorExitCode(err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
