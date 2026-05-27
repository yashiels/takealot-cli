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
import { cartShow, cartAdd, cartAddBasket, cartClear } from './commands/cart.js';
import { checkoutCommand } from './commands/checkout.js';
import { ordersList, ordersShow } from './commands/orders.js';
import { preferencesRefresh, preferencesShow } from './commands/preferences.js';
import { configShow } from './commands/config.js';
import { loginCommand } from './commands/login.js';

const VERSION = '0.1.0';

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

withGlobals(cart.command('add'))
  .description('search for an item and add the preferred match to the cart')
  .argument('<item...>', 'item to add, optionally prefixed with a quantity (e.g. "3 pencils")')
  .action((item: string[], _options: unknown, command: Command) =>
    run(command, (ctx) => cartAdd(ctx, item.join(' '))),
  );

withGlobals(cart.command('basket'))
  .description('add several items at once (comma/semicolon/newline separated)')
  .argument('<items>', 'e.g. "3 pencils, 2 pens, notebook"')
  .action((items: string, _options: unknown, command: Command) =>
    run(command, (ctx) => cartAddBasket(ctx, items)),
  );

withGlobals(cart.command('clear'))
  .description('remove everything from the cart')
  .action((_options: unknown, command: Command) => run(command, (ctx) => cartClear(ctx)));

// ---- checkout ----
withGlobals(program.command('checkout'))
  .description('check out the current cart (dry run unless --confirm)')
  .option('--confirm', 'actually place the order and pay')
  .option('--yes', 'skip the interactive confirmation prompt')
  .action((options: { confirm?: boolean; yes?: boolean }, command: Command) =>
    run(command, (ctx) => checkoutCommand(ctx, { confirm: Boolean(options.confirm), yes: Boolean(options.yes) })),
  );

// ---- orders ----
const orders = withGlobals(program.command('orders'))
  .description('list recent orders')
  .option('--limit <n>', 'max orders to show', (v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 1) throw new Error(`invalid --limit: ${v}`);
    return n;
  }, 20)
  .action((options: { limit: number }, command: Command) =>
    run(command, (ctx) => ordersList(ctx, { limit: options.limit })),
  );

withGlobals(orders.command('show'))
  .description('show full detail for one order')
  .argument('<id>', 'order id')
  .action((id: string, _options: unknown, command: Command) =>
    run(command, (ctx) => ordersShow(ctx, id)),
  );

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
  .action((options: { reset?: boolean }, command: Command) =>
    run(command, (ctx) => loginCommand(ctx, { reset: Boolean(options.reset) })),
  );

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
