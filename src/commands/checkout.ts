import type { Context } from '../lib/context.js';
import { c, rand } from '../lib/ui.js';
import { buildCheckoutPlan, describeCard, runCheckout } from '../lib/checkout.js';
import { confirm } from '../lib/prompt.js';

export async function checkoutCommand(
  ctx: Context,
  opts: { confirm: boolean; yes: boolean },
): Promise<void> {
  await ctx.ensureCredentials();

  if (!opts.confirm) {
    // Dry run — inspect only, no order created.
    ctx.logger.info('🧾 Checkout dry run (no order will be created)…');
    const plan = await buildCheckoutPlan(ctx.client, ctx.config);
    ctx.logger.result(
      () => {
        if (!plan.cart.items.length) {
          process.stdout.write('\n🛒 Cart is empty — nothing to check out.\n');
          return;
        }
        process.stdout.write(`\n${c.bold('🧾 Checkout plan')} ${c.dim('(dry run)')}\n\n`);
        plan.cart.items.forEach((item) => {
          process.stdout.write(`  • ${item.quantity} × ${item.title} ${c.cyan(rand(item.price))}\n`);
        });
        process.stdout.write(`\n  ${c.bold('Total:')} ${c.cyan(rand(plan.amountDue))}\n`);
        process.stdout.write(`  ${c.bold('Pay with:')} ${describeCard(plan.selectedCard)}\n`);
        if (!plan.selectedCard) {
          process.stdout.write(c.yellow('\n  ⚠ No saved card — checkout would fail.\n'));
        }
        process.stdout.write(c.dim('\n  Run again with --confirm to place the order.\n'));
      },
      { dryRun: true, ...plan },
    );
    return;
  }

  // Live checkout.
  const plan = await buildCheckoutPlan(ctx.client, ctx.config);
  if (!plan.cart.items.length) {
    throw new Error('Cart is empty — nothing to check out.');
  }
  if (!plan.selectedCard) {
    throw new Error('No saved card available to complete payment.');
  }

  if (!opts.yes && !ctx.logger.isJson && process.stdin.isTTY) {
    process.stderr.write(
      `\nAbout to place an order for ${c.bold(rand(plan.amountDue))} ` +
        `using ${describeCard(plan.selectedCard)}.\n`,
    );
    const proceed = await confirm('Proceed with payment?', false);
    if (!proceed) {
      ctx.logger.info('Cancelled.');
      return;
    }
  }

  const result = await runCheckout(ctx.client, ctx.config, ctx.logger);
  if (!result.success) process.exitCode = 1;
  ctx.logger.result(
    () => {
      if (result.success) {
        process.stdout.write(`\n${c.green('✅')} ${result.message}\n`);
      } else {
        process.stdout.write(`\n${c.red('✖')} Checkout failed: ${result.message}\n`);
      }
    },
    result,
  );
}
