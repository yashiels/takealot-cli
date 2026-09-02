import type { Context } from '../lib/context.js';
import { c, rand } from '../lib/ui.js';
import { gate } from './generic.js';
import type { PreferenceMatch } from '../lib/preferences.js';

export interface CartWriteFlags {
  confirm?: boolean;
  yes?: boolean;
}

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
          `   ${c.cyan(`${item.quantity} × ${rand(item.price)}`)}  ${c.gray(`id ${item.productId}`)}  ${c.blue(item.url)}\n`,
        );
      });
      process.stdout.write(`\n${c.bold(`Total: ${rand(cart.total)}`)}\n`);
    },
    cart,
  );
}

/**
 * `cart add` — exact buyable via `--sku`, a `--plid` resolved to its SKU, or a
 * free-text query that falls back to the preference-ranked search (as before).
 */
export async function cartAdd(
  ctx: Context,
  raw: string,
  opts: { sku?: number; plid?: number; qty?: number } & CartWriteFlags = {},
): Promise<void> {
  await ctx.ensureCredentials();

  // Exact-id add — no search, no preference pick.
  if (opts.sku !== undefined || opts.plid !== undefined) {
    const qty = opts.qty ?? 1;
    const target = opts.sku !== undefined ? `SKU ${opts.sku}` : `PLID ${opts.plid}`;
    if (!(await gate(ctx, opts, { action: `add ${qty}× ${target} to the cart` }))) return;
    const skuId = opts.sku ?? (await ctx.client.skuForPlid(opts.plid!));
    ctx.logger.info(`➕ Adding SKU ${skuId} (qty ${qty})…`);
    const res = await ctx.client.addSkuToCart(skuId, qty);
    ctx.logger.result(
      () => process.stdout.write(`${c.green('✓')} Added ${c.bold(`${qty}×`)} ${res.title ?? `SKU ${skuId}`}\n`),
      { added: true, quantity: qty, skuId, plid: opts.plid, title: res.title },
    );
    return;
  }

  const { qty, query } = parseQuantity(raw);
  if (!query) throw new Error('nothing to add — pass a search query, --sku <id>, or --plid <id>');
  if (!(await gate(ctx, opts, { action: `search "${query}" and add the best match (qty ${qty}) to the cart` }))) return;
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

export async function cartAddBasket(ctx: Context, raw: string, flags: CartWriteFlags = {}): Promise<void> {
  await ctx.ensureCredentials();
  const items = raw
    .split(/\r?\n|;|,/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) throw new Error('No items parsed for basket.');
  if (!(await gate(ctx, flags, { action: `add ${items.length} item(s) to the cart: ${items.join(', ')}` }))) return;

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

export async function cartClear(ctx: Context, flags: CartWriteFlags = {}): Promise<void> {
  await ctx.ensureCredentials();
  if (!(await gate(ctx, flags, { action: 'clear the entire cart' }))) return;
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

/** `cart set-qty <sku> <n>` — update a cart line's quantity (by buyable SKU id). */
export async function cartSetQty(ctx: Context, skuId: number, quantity: number, flags: CartWriteFlags = {}): Promise<void> {
  await ctx.ensureCredentials();
  if (!Number.isFinite(quantity) || quantity < 1) throw new Error('quantity must be a positive integer');
  if (!(await gate(ctx, flags, { action: `set SKU ${skuId} quantity to ${quantity}` }))) return;
  ctx.logger.info(`✏️  Setting SKU ${skuId} → qty ${quantity}…`);
  await ctx.client.setCartItemQuantity(skuId, quantity);
  const cart = await ctx.client.getCart();
  ctx.logger.result(
    () => process.stdout.write(`${c.green('✓')} Updated SKU ${skuId} to ${quantity}. Total ${rand(cart.total)}\n`),
    { updated: true, skuId, quantity, total: cart.total },
  );
}

/** `cart remove <sku>` — remove one cart line by its buyable SKU id. */
export async function cartRemove(ctx: Context, skuId: number, flags: CartWriteFlags = {}): Promise<void> {
  await ctx.ensureCredentials();
  if (!(await gate(ctx, flags, { action: `remove SKU ${skuId} from the cart` }))) return;
  ctx.logger.info(`➖ Removing SKU ${skuId}…`);
  await ctx.client.removeCartItem(skuId);
  const cart = await ctx.client.getCart();
  ctx.logger.result(
    () => process.stdout.write(`${c.green('✓')} Removed SKU ${skuId}. ${cart.items.length} item(s) left.\n`),
    { removed: true, skuId, remaining: cart.items.length, total: cart.total },
  );
}
