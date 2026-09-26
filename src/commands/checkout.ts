import type { Context } from '../lib/context.js';
import { UsageError } from '../lib/errors.js';
import { getCheckoutPreview } from '../lib/checkout.js';
import { c, rand } from '../lib/ui.js';

const money = (value: number | null): string => (value === null ? 'n/a' : rand(value));

export async function checkoutCommand(ctx: Context, opts: { confirm: boolean }): Promise<void> {
  if (opts.confirm) throw new UsageError('orders are placed in the Takealot app');
  await ctx.ensureCredentials();
  const preview = await getCheckoutPreview(ctx.client);
  ctx.logger.result(
    () => {
      if (!preview.items.length) {
        process.stdout.write('Cart is empty. Add items before previewing checkout.\n');
        return;
      }
      process.stdout.write(`\n${c.bold('Checkout preview')}\n\n`);
      for (const item of preview.items) {
        process.stdout.write(`  • ${item.quantity} × ${item.title} ${c.cyan(money(item.price))}\n`);
      }
      process.stdout.write(`\n  ${c.bold('Subtotal:')} ${money(preview.subtotal)}\n`);
      if (preview.discount !== 0) process.stdout.write(`  ${c.bold('Discount:')} ${money(preview.discount)}\n`);
      if (preview.shippingDiscount !== 0) process.stdout.write(`  ${c.bold('Shipping discount:')} ${money(preview.shippingDiscount)}\n`);
      if (preview.credits !== 0) process.stdout.write(`  ${c.bold('Credits:')} ${money(preview.credits)}\n`);
      process.stdout.write(`  ${c.bold('Total:')} ${money(preview.total)}\n`);
      process.stdout.write(`  ${c.bold('Amount due:')} ${c.cyan(money(preview.amountDue))}\n`);
      if (preview.shippingMethod) process.stdout.write(`  ${c.bold('Shipping:')} ${preview.shippingMethod}\n`);
      if (preview.sectionsIncomplete.length) {
        process.stdout.write(`  ${c.bold('Incomplete:')} ${preview.sectionsIncomplete.join(', ')}\n`);
      }
      process.stdout.write('\nPay in the Takealot app.\n');
    },
    preview,
  );
}
