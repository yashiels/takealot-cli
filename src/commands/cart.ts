import type { Context } from '../lib/context.js';
import { c, rand } from '../lib/ui.js';
import { gate } from './generic.js';
import type { PreferenceMatch } from '../lib/preferences.js';
import { UsageError } from '../lib/errors.js';
import type { CartItem, CartResult } from '../types.js';

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

type CartLine = { skuId: number; quantity: number; title: string };

const skuOf = (item: CartItem): number => item.skuId ?? item.productId;

const cartLines = (cart: CartResult): CartLine[] =>
  cart.items.map((item) => ({ skuId: skuOf(item), quantity: item.quantity, title: item.title }));

const quantityBySku = (cart: CartResult): Map<number, number> => {
  const totals = new Map<number, number>();
  for (const item of cart.items) totals.set(skuOf(item), (totals.get(skuOf(item)) ?? 0) + item.quantity);
  return totals;
};

const changedLines = (
  before: CartResult,
  after: CartResult,
  targetSkuId: number,
  targetQuantity: number | null,
): CartLine[] => {
  const beforeTotals = quantityBySku(before);
  const afterTotals = quantityBySku(after);
  const reported = new Set<number>();
  return cartLines(before).filter((line) => {
    if (line.skuId === targetSkuId || reported.has(line.skuId)) return false;
    if ((afterTotals.get(line.skuId) ?? 0) === beforeTotals.get(line.skuId)) return false;
    reported.add(line.skuId);
    return true;
  }).concat(
    targetQuantity !== null && (afterTotals.get(targetSkuId) ?? 0) !== targetQuantity
      ? cartLines(before).filter((line) => line.skuId === targetSkuId).slice(0, 1)
      : [],
  );
};

const previewLines = (lines: CartLine[]): string =>
  lines.length ? lines.map((line) => `${line.quantity}× ${line.title} (SKU ${line.skuId})`).join('; ') : 'none';

function warnRestoration(ctx: Context, unexpected: CartLine[], after: CartResult): void {
  const remaining = new Set(after.items.map(skuOf));
  ctx.logger.error('CART SAFETY CHECK FAILED: other cart lines disappeared or changed quantity.');
  for (const line of unexpected) {
    const command = remaining.has(line.skuId)
      ? `takealot cart set-qty ${line.skuId} ${line.quantity} --confirm --yes`
      : `takealot cart add --sku ${line.skuId} --qty ${line.quantity} --confirm --yes`;
    ctx.logger.warn(`Restore ${line.title}: ${command}`);
  }
}

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
    let title: string | null = null;
    const skuId =
      opts.sku ??
      (await ctx.client.skuForPlid(opts.plid!, (product) => {
        title = product.title;
      }));
    const body = { products: [{ id: skuId, quantity: qty }] };
    const request = ctx.client.describeCall('cart.add', { body });
    const target = `SKU ${skuId}${title ? ` (${title})` : ''}`;
    if (!(await gate(ctx, opts, { action: `add ${qty}× ${target} to the cart`, request }))) return;
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
  const before = await ctx.client.getCart();
  if (!before.items.some((item) => skuOf(item) === skuId)) throw new UsageError(`SKU ${skuId} is not in the current cart`);
  const expected = cartLines(before).map((line) => line.skuId === skuId ? { ...line, quantity } : line);
  const body = { products: [{ id: skuId, quantity }] };
  const request = { ...ctx.client.describeCall('cart.update', { body }), remaining: expected };
  if (!(await gate(ctx, flags, { action: `set SKU ${skuId} quantity to ${quantity}; lines after: ${previewLines(expected)}`, request }))) return;
  ctx.logger.info(`✏️  Setting SKU ${skuId} → qty ${quantity}…`);
  await ctx.client.setCartItemQuantity(skuId, quantity);
  const cart = await ctx.client.getCart();
  const unexpectedRemovals = changedLines(before, cart, skuId, quantity);
  if (unexpectedRemovals.length) {
    warnRestoration(ctx, unexpectedRemovals, cart);
    ctx.logger.result(
      () => process.stdout.write(`${c.red('✗')} Cart update changed other lines; restore them with the commands above.\n`),
      { updated: false, skuId, quantity, remaining: cart.items.length, total: cart.total, unexpectedRemovals },
    );
    process.exitCode = 1;
    return;
  }
  ctx.logger.result(
    () => process.stdout.write(`${c.green('✓')} Updated SKU ${skuId} to ${quantity}. Total ${rand(cart.total)}\n`),
    { updated: true, skuId, quantity, total: cart.total },
  );
}

/** `cart remove <sku>` — remove one cart line by its buyable SKU id. */
export async function cartRemove(ctx: Context, skuId: number, flags: CartWriteFlags = {}): Promise<void> {
  await ctx.ensureCredentials();
  const before = await ctx.client.getCart();
  if (!before.items.some((item) => skuOf(item) === skuId)) throw new UsageError(`SKU ${skuId} is not in the current cart`);
  const remaining = cartLines(before).filter((line) => line.skuId !== skuId);
  const body = { products: [{ id: skuId }] };
  const request = { ...ctx.client.describeCall('cart.remove', { body }), remaining };
  if (!(await gate(ctx, flags, { action: `remove SKU ${skuId} from the cart; lines remaining: ${previewLines(remaining)}`, request }))) return;
  ctx.logger.info(`➖ Removing SKU ${skuId}…`);
  await ctx.client.removeCartItem(skuId);
  const cart = await ctx.client.getCart();
  const unexpectedRemovals = changedLines(before, cart, skuId, null);
  if (unexpectedRemovals.length) {
    warnRestoration(ctx, unexpectedRemovals, cart);
    ctx.logger.result(
      () => process.stdout.write(`${c.red('✗')} Cart removal changed other lines; restore them with the commands above.\n`),
      { removed: !cart.items.some((item) => skuOf(item) === skuId), skuId, remaining: cart.items.length, total: cart.total, unexpectedRemovals },
    );
    process.exitCode = 1;
    return;
  }
  ctx.logger.result(
    () => process.stdout.write(`${c.green('✓')} Removed SKU ${skuId}. ${cart.items.length} item(s) left.\n`),
    { removed: true, skuId, remaining: cart.items.length, total: cart.total },
  );
}
