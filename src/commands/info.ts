import type { Context } from '../lib/context.js';
import { c, rand } from '../lib/ui.js';
import { redact } from '../lib/redact.js';
import { renderRaw } from '../lib/ui.js';

/**
 * `info <PLID>` — product detail (typed buybox/price/stock), with optional
 * `--credit-options`, `--bundle`, `--card`, `--reviews` extras.
 */
export async function infoCommand(
  ctx: Context,
  plid: number,
  opts: { creditOptions?: boolean; bundle?: string; card?: boolean; reviews?: boolean; unsafeRaw?: boolean } = {},
): Promise<void> {
  if (opts.card) {
    return emit(ctx, await ctx.client.call('product.card', { params: { plid } }), opts.unsafeRaw);
  }
  if (opts.creditOptions) {
    return emit(ctx, await ctx.client.call('product.creditOptions', { params: { plid } }), opts.unsafeRaw);
  }
  if (opts.bundle) {
    return emit(ctx, await ctx.client.call('product.bundleDeals', { params: { plid, bundleIds: opts.bundle } }), opts.unsafeRaw);
  }
  if (opts.reviews) {
    return emit(ctx, await ctx.client.call('reviews.public', { params: { plid } }), opts.unsafeRaw);
  }

  ctx.logger.info(`🔎 Fetching PLID${plid}…`);
  const data: any = await ctx.client.call('product.details', { params: { plid }, query: { platform: 'android', offer_opt: true } });
  const pv = data?.product_views ?? data?.product ?? data ?? {};
  const core = pv?.core ?? {};
  const bb = pv?.buybox_summary ?? {};
  const typed = {
    plid,
    skuId: bb?.product_id,
    title: core?.title ?? pv?.title,
    brand: core?.brand,
    price: Array.isArray(bb?.prices) && bb.prices.length ? bb.prices[0] : undefined,
    prettyPrice: bb?.pretty_price,
    saving: bb?.saving,
    inStock: bb?.stock_availability_status ?? pv?.stock_availability_summary?.status,
    rating: core?.star_rating,
    reviewCount: core?.reviews,
  };
  ctx.logger.result(
    () => {
      process.stdout.write(`\n${c.bold(typed.title ?? `PLID${plid}`)}\n`);
      const meta = [c.cyan(typed.prettyPrice || rand(typed.price))];
      if (typed.saving) meta.push(c.green(`-${typed.saving}`));
      if (typed.brand) meta.push(c.dim(typed.brand));
      process.stdout.write(`  ${meta.join('  ')}\n`);
      process.stdout.write(`  ${typed.inStock ?? ''}  ${c.gray(`sku ${typed.skuId ?? '?'}`)}\n`);
      if (typed.rating) process.stdout.write(`  ${c.yellow(`★ ${typed.rating}`)} ${c.dim(`(${typed.reviewCount ?? 0} reviews)`)}\n`);
    },
    redact({ ...typed, raw: data }, { unsafe: opts.unsafeRaw }),
  );
}

function emit(ctx: Context, data: unknown, unsafe?: boolean): void {
  const safe = redact(data, { unsafe });
  ctx.logger.result(() => process.stdout.write(renderRaw(safe) + '\n'), safe);
}
