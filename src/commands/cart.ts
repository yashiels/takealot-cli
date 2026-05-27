import type { Context } from '../lib/context.js';
import { c, rand } from '../lib/ui.js';
import type { PreferenceMatch } from '../lib/preferences.js';

const REASON_LABEL: Record<PreferenceMatch['reason'], string> = {
  'order-history-product': 'previously ordered',
  'order-history-brand': 'brand from your orders',
  'preferred-brand': 'preferred brand',
  'top-result': 'top result',
};

/** Parse an optional leading quantity, e.g. "3 pencils" → { qty: 3, query: "pencils" }. */
function parseQuantity(raw: string): { qty: number; query: string } {
  const m = raw.trim().match(/^(\d+)\s+(.+)$/);
  if (m) return { qty: parseInt(m[1]!, 10), query: m[2]! };
  return { qty: 1, query: raw.trim() };
}

export async function cartShow(ctx: Context): Promise<void> {
  ctx.logger.info('🛒 Fetching cart…');
  const cart = await ctx.client.getCart();
  ctx.logger.result(
    () => {
      if (!cart.items.length) {
        process.stdout.write('\n🛒 Cart is empty.\n');
        return;
      }
      process.stdout.write(`\n${c.bold(`🛒 Cart`)} ${c.dim(`(${cart.items.length} items)`)}\n\n`);
      cart.items.forEach((item, i) => {
        process.stdout.write(`${c.dim(`${i + 1}.`)} ${item.title}\n`);
        process.stdout.write(
          `   ${c.cyan(`${item.quantity} × ${rand(item.price)}`)}  ${c.gray(`id ${item.productId}`)}\n`,
        );
      });
      process.stdout.write(`\n${c.bold(`Total: ${rand(cart.total)}`)}\n`);
    },
    cart,
  );
}

export async function cartAdd(ctx: Context, raw: string): Promise<void> {
  await ctx.ensureCredentials();
  const { qty, query } = parseQuantity(raw);
  ctx.logger.info(`🔍 Finding "${query}" (qty ${qty})…`);
  const result = await ctx.client.searchAndAdd(query, qty);
  ctx.logger.result(
    () => {
      process.stdout.write(
        `${c.green('✓')} Added ${c.bold(`${qty}×`)} ${result.title} ` +
          `${c.dim(`(${REASON_LABEL[result.match.reason]})`)}\n`,
      );
    },
    {
      added: true,
      quantity: qty,
      query,
      productId: result.productId,
      title: result.title,
      reason: result.match.reason,
    },
  );
}

export async function cartAddBasket(ctx: Context, raw: string): Promise<void> {
  await ctx.ensureCredentials();
  const items = raw
    .split(/\r?\n|;|,/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) throw new Error('No items parsed for basket.');

  ctx.logger.info(`🧺 Adding ${items.length} items…`);
  const results: Array<{ query: string; quantity: number; success: boolean; title?: string; error?: string }> = [];

  for (const item of items) {
    const { qty, query } = parseQuantity(item);
    try {
      const r = await ctx.client.searchAndAdd(query, qty);
      results.push({ query, quantity: qty, success: true, title: r.title });
      ctx.logger.info(`  ${c.green('✓')} ${qty}× ${r.title}`);
    } catch (err) {
      const msg = (err as Error).message;
      results.push({ query, quantity: qty, success: false, error: msg });
      ctx.logger.info(`  ${c.red('✗')} ${query} ${c.dim(`(${msg})`)}`);
    }
  }

  const ok = results.filter((r) => r.success).length;
  if (ok < items.length) process.exitCode = 2;
  ctx.logger.result(
    () => {
      process.stdout.write(`\nAdded ${c.bold(`${ok}/${items.length}`)} items.\n`);
    },
    { total: items.length, added: ok, results },
  );
}

export async function cartClear(ctx: Context): Promise<void> {
  await ctx.ensureCredentials();
  ctx.logger.info('🧹 Clearing cart…');
  const { removed } = await ctx.client.clearCart();
  ctx.logger.result(
    () => {
      process.stdout.write(
        removed ? `${c.green('✓')} Removed ${removed} item(s).\n` : 'Cart was already empty.\n',
      );
    },
    { cleared: true, removed },
  );
}
