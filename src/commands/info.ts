import type { Context } from '../lib/context.js';
import { parseProductDetails } from '../lib/api-client.js';
import { c, rand } from '../lib/ui.js';
import { redact } from '../lib/redact.js';
import { renderRaw } from '../lib/ui.js';
import { reviewsCommand } from './reviews.js';

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
    return reviewsCommand(ctx, plid, { page: 1 });
  }

  ctx.logger.info(`🔎 Fetching PLID${plid}…`);
  const data: any = await ctx.client.call('product.details', { params: { plid }, query: { platform: 'android', offer_opt: true } });
  const typed = parseProductDetails(data, plid);
  ctx.logger.result(
    () => {
      process.stdout.write(`\n${c.bold(typed.title ?? `PLID${plid}`)}\n`);
      const meta = [c.cyan(typed.prettyPrice || rand(typed.price ?? undefined))];
      if (typed.brand) meta.push(c.dim(typed.brand));
      process.stdout.write(`  ${meta.join('  ')}\n`);
      process.stdout.write(`  ${typed.inStock ? 'In stock' : 'Unavailable'}\n`);
      if (typed.skuId !== null) {
        process.stdout.write(`  ${c.gray(`sku ${typed.skuId}`)}\n`);
      } else {
        process.stdout.write(`  ${c.bold('pick a variant:')}\n`);
        for (const variant of typed.variants) {
          process.stdout.write(`    ${variant.title}: ${variant.value}\n`);
        }
      }
      if (typed.rating) process.stdout.write(`  ${c.yellow(`★ ${typed.rating}`)} ${c.dim(`(${typed.reviewCount ?? 0} reviews)`)}\n`);
    },
    typed,
  );
}

function emit(ctx: Context, data: unknown, unsafe?: boolean): void {
  const safe = redact(data, { unsafe });
  ctx.logger.result(() => process.stdout.write(renderRaw(safe) + '\n'), safe);
}
