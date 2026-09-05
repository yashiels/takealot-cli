#!/usr/bin/env node
/**
 * takealot — command-line entry point.
 *
 * Wires every command group onto a Commander program. `--json` and `--verbose`
 * are accepted in any position (before or after the subcommand) by defining
 * them on each command and OR-ing the values up the ancestor chain.
 */

import { Command } from 'commander';
import { Context, type GlobalOptions } from './lib/context.js';
import { c } from './lib/ui.js';
import { searchCommand } from './commands/search.js';
import { cartShow, cartAdd, cartAddBasket, cartClear, cartSetQty, cartRemove } from './commands/cart.js';
import { checkoutCommand, checkoutResume, checkoutReset } from './commands/checkout.js';
import { infoCommand } from './commands/info.js';
import { ordersList, ordersShow } from './commands/orders.js';
import { preferencesRefresh, preferencesShow } from './commands/preferences.js';
import { configShow } from './commands/config.js';
import { loginCommand } from './commands/login.js';
import { registerCatalogue } from './commands/register.js';

const VERSION = '0.6.1';

const intOpt = (name: string) => (v: string) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`invalid ${name}: ${v}`);
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
async function run(command: Command, fn: (ctx: Context) => Promise<void>): Promise<void> {
  const flags = globalFlags(command);
  const ctx = new Context(flags);
  try {
    await fn(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ctx.logger.isJson) {
      process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
    } else {
      ctx.logger.error(message);
      if (flags.verbose && err instanceof Error && err.stack) {
        process.stderr.write(c.gray(err.stack) + '\n');
      }
    }
    if (!process.exitCode) process.exitCode = 1;
  }
}

const program = new Command();

withGlobals(program)
  .name('takealot')
  .description('Command-line tool for Takealot.com — search, cart, pure-API checkout, and order history.')
  .version(VERSION, '-V, --version', 'print the version')
  .showHelpAfterError();

// ---- search ----
withGlobals(program.command('search'))
  .description('search the Takealot catalogue (no login required)')
  .argument('<query>', 'what to search for')
  .option('--limit <n>', 'max results to show', (v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 1) throw new Error(`invalid --limit: ${v}`);
    return n;
  }, 10)
  .action((query: string, options: { limit: number }, command: Command) =>
    run(command, (ctx) => searchCommand(ctx, query, { limit: options.limit })),
  );

// ---- cart ----
const cart = withGlobals(program.command('cart'))
  .description('view and modify your cart')
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
  .argument('<sku>', 'buyable SKU id', intOpt('<sku>'))
  .argument('<qty>', 'new quantity', intOpt('<qty>'))
  .action((sku: number, qty: number, options: any, command: Command) =>
    run(command, (ctx) => cartSetQty(ctx, sku, qty, options)),
  );

confirmOpts(withGlobals(cart.command('remove')))
  .description('remove one cart line (by buyable SKU id)')
  .argument('<sku>', 'buyable SKU id', intOpt('<sku>'))
  .action((sku: number, options: any, command: Command) => run(command, (ctx) => cartRemove(ctx, sku, options)));

confirmOpts(withGlobals(cart.command('basket')))
  .description('add several items at once (comma/semicolon/newline separated)')
  .argument('<items>', 'e.g. "3 pencils, 2 pens, notebook"')
  .action((items: string, options: any, command: Command) =>
    run(command, (ctx) => cartAddBasket(ctx, items, options)),
  );

confirmOpts(withGlobals(cart.command('clear')))
  .description('remove everything from the cart')
  .action((options: any, command: Command) => run(command, (ctx) => cartClear(ctx, options)));

// ---- info (product detail) ----
withGlobals(program.command('info'))
  .description('product detail for a PLID (price, stock, sku, rating)')
  .argument('<plid>', 'product PLID', intOpt('<plid>'))
  .option('--credit-options', 'show instalment/credit options')
  .option('--bundle <ids>', 'show bundle deals for the given bundle ids')
  .option('--card', 'lightweight product card')
  .option('--reviews', 'public product reviews')
  .option('--unsafe-raw', 'print unredacted JSON (leaks secrets)')
  .action((plid: number, options: any, command: Command) =>
    run(command, (ctx) => infoCommand(ctx, plid, options)),
  );

// ---- checkout ----
const checkout = withGlobals(program.command('checkout'))
  .description('check out the current cart (dry run unless --confirm)')
  .option('--confirm', 'actually place the order and pay')
  .option('--yes', 'skip the interactive confirmation prompt')
  .action((options: { confirm?: boolean; yes?: boolean }, command: Command) =>
    run(command, (ctx) => checkoutCommand(ctx, { confirm: Boolean(options.confirm), yes: Boolean(options.yes) })),
  );

withGlobals(checkout.command('resume'))
  .description('reconcile + complete/initiate a payment (dry-run unless --confirm)')
  .argument('<orderId>', 'the order id from the action_required result')
  .option('--confirm', 'actually reconcile and pay')
  .option('--yes', 'skip the interactive confirmation prompt')
  .action((orderId: string, options: { confirm?: boolean; yes?: boolean }, command: Command) =>
    run(command, (ctx) => checkoutResume(ctx, orderId, options)),
  );

withGlobals(checkout.command('reset'))
  .description('clear a stuck pending-checkout marker (after verifying via `orders`)')
  .action((_o: unknown, command: Command) => run(command, (ctx) => checkoutReset(ctx)));

// ---- preferences ----
const preferences = withGlobals(program.command('preferences'))
  .description('manage the order-history preference cache')
  .action((_options: unknown, command: Command) => run(command, (ctx) => preferencesShow(ctx)));

withGlobals(preferences.command('refresh'))
  .description('rebuild the preference cache from order history')
  .action((_options: unknown, command: Command) => run(command, (ctx) => preferencesRefresh(ctx)));

withGlobals(preferences.command('show'))
  .description('list the products currently in the preference cache')
  .action((_options: unknown, command: Command) => run(command, (ctx) => preferencesShow(ctx)));

// ---- config ----
const config = withGlobals(program.command('config'))
  .description('show configuration and credential status')
  .action((_options: unknown, command: Command) => run(command, (ctx) => configShow(ctx)));

withGlobals(config.command('show'))
  .description('show configuration with secrets redacted')
  .action((_options: unknown, command: Command) => run(command, (ctx) => configShow(ctx)));

// ---- login ----
withGlobals(program.command('login'))
  .description('log in to Takealot, rotating the cached tokens')
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
  .option('--limit <n>', 'max orders to show', intOpt('--limit'), 20)
  .action((options: { limit: number }, command: Command) =>
    run(command, (ctx) => ordersList(ctx, { limit: options.limit })),
  );

withGlobals(orders.command('show'))
  .description('show full detail for one order')
  .argument('<id>', 'order id')
  .action((id: string, _options: unknown, command: Command) => run(command, (ctx) => ordersShow(ctx, id)));

// ---- everything else: auto-wired from the endpoint catalogue ----
registerCatalogue(program, withGlobals, run, globalFlags);

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
