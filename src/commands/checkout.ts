import type { Context } from '../lib/context.js';
import { c, rand } from '../lib/ui.js';
import { buildCheckoutPlan, describeCard, resumeCheckout, runCheckout } from '../lib/checkout.js';
import { confirm } from '../lib/prompt.js';
import { redact } from '../lib/redact.js';
import { clearPendingOrder, loadPendingOrder } from '../lib/config.js';

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
        if (plan.delivery) {
          process.stdout.write(`\n  ${c.bold('Deliver to:')} ${plan.delivery.address ?? c.gray('(not set)')}\n`);
          if (plan.delivery.options?.length) process.stdout.write(`  ${c.bold('Options:')} ${plan.delivery.options.join(', ')}\n`);
          if (plan.delivery.eta) process.stdout.write(`  ${c.bold('ETA:')} ${plan.delivery.eta}\n`);
          if (plan.delivery.fee !== undefined) process.stdout.write(`  ${c.bold('Delivery fee:')} ${rand(plan.delivery.fee)}\n`);
        }
        process.stdout.write(`\n  ${c.bold('Total:')} ${c.cyan(rand(plan.amountDue))}\n`);
        process.stdout.write(`  ${c.bold('Pay with:')} ${describeCard(plan.selectedCard)}\n`);
        if (!plan.selectedCard) process.stdout.write(c.yellow('\n  ⚠ No saved card — checkout would fail.\n'));
        process.stdout.write(c.dim('\n  Run again with --confirm to place the order.\n'));
      },
      redact({ dryRun: true, ...plan }),
    );
    return;
  }

  // Live checkout.
  const plan = await buildCheckoutPlan(ctx.client, ctx.config);
  if (!plan.cart.items.length) throw new Error('Cart is empty — nothing to check out.');
  if (!plan.selectedCard) throw new Error('No saved card available to complete payment.');

  if (!opts.yes && !ctx.logger.isJson && process.stdin.isTTY) {
    process.stderr.write(
      `\nAbout to place an order for ${c.bold(rand(plan.amountDue))} using ${describeCard(plan.selectedCard)}.\n`,
    );
    if (!(await confirm('Proceed with payment?', false))) {
      ctx.logger.info('Cancelled.');
      return;
    }
  }

  const result = await runCheckout(ctx.client, ctx.config, ctx.logger, ctx.accountHash());
  if (!result.success && result.status !== 'action_required') process.exitCode = 1;
  emitCheckout(ctx, result);
}

/**
 * `checkout resume <orderId>` — reconcile + complete/initiate a payment. GATED
 * like `checkout --confirm`: dry-run by default (read-only status preview of what
 * it WOULD do), performs any payment only with `--confirm` (`--yes` skips the
 * TTY prompt).
 */
export async function checkoutResume(
  ctx: Context,
  orderId: string,
  opts: { confirm?: boolean; yes?: boolean } = {},
): Promise<void> {
  await ctx.ensureCredentials();

  if (!opts.confirm) {
    const plan = await resumeCheckout(ctx.client, ctx.config, ctx.logger, ctx.accountHash(), orderId, { dryRun: true });
    ctx.logger.result(
      () => {
        process.stdout.write(`${c.yellow('DRY RUN')} — ${plan.message}\n`);
        process.stdout.write(c.dim('  Re-run with --confirm to perform any payment.\n'));
      },
      redact({ dryRun: true, orderId, plan: plan.message }),
    );
    return;
  }

  if (!opts.yes && !ctx.logger.isJson && process.stdin.isTTY) {
    process.stderr.write(`\nAbout to reconcile and complete/initiate payment for order ${orderId}.\n`);
    if (!(await confirm('Proceed?', false))) {
      ctx.logger.info('Cancelled.');
      return;
    }
  }

  const result = await resumeCheckout(ctx.client, ctx.config, ctx.logger, ctx.accountHash(), orderId);
  if (!result.success && result.status !== 'action_required') process.exitCode = 1;
  emitCheckout(ctx, result);
}

/**
 * `checkout reset` — the manual escape: delete the per-account pending-order
 * marker after the user has verified via `orders` that no order is outstanding.
 * Never auto-runs; the user invokes it explicitly to unblock a stuck reconcile.
 */
export async function checkoutReset(ctx: Context): Promise<void> {
  await ctx.ensureCredentials();
  const acct = ctx.accountHash();
  const pending = loadPendingOrder(acct);
  clearPendingOrder(acct);
  ctx.logger.result(
    () =>
      process.stdout.write(
        pending
          ? `${c.green('✓')} Cleared the pending checkout marker${pending.orderId ? ` (order ${pending.orderId})` : ''}. Verify via \`takealot orders\` before re-checking out.\n`
          : `${c.dim('No pending checkout marker to clear.')}\n`,
      ),
    { cleared: Boolean(pending), pending: pending ? { stage: pending.stage, orderId: pending.orderId } : null },
  );
}

function emitCheckout(ctx: Context, result: import('../types.js').CheckoutResult): void {
  ctx.logger.result(() => {
    if (result.success) {
      process.stdout.write(`\n${c.green('✅')} ${result.message}\n`);
    } else if (result.status === 'action_required') {
      process.stdout.write(`\n${c.yellow('🔐 Action required')} — ${result.message}\n`);
      if (result.challengeUrl) process.stdout.write(`  ${c.blue(result.challengeUrl)}\n`);
    } else if (result.status === 'ambiguous') {
      process.stdout.write(`\n${c.yellow('⚠')} ${result.message}\n`);
    } else {
      process.stdout.write(`\n${c.red('✖')} Checkout failed: ${result.message}\n`);
    }
  }, redact(result));
}
