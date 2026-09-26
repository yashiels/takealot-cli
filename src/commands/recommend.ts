import type { Context } from '../lib/context.js';
import { UsageError } from '../lib/errors.js';
import { c, rand } from '../lib/ui.js';

const LOCATIONS = ['home-page', 'add-to-cart', 'landing-page', 'domain'] as const;

function validateLocation(location: string): void {
  if (location === 'pdp')
    throw new UsageError('pdp recommendations are not supported by the API yet');
  if (!(LOCATIONS as readonly string[]).includes(location)) {
    throw new UsageError(
      `invalid recommendation location: ${location}; valid values: ${LOCATIONS.join(', ')}`,
    );
  }
}

export async function recommendLayout(ctx: Context, location: string): Promise<void> {
  validateLocation(location);
  const customerId = ctx.client.auth.customerId;
  const data: any = await ctx.client.call('reco.location.layout', {
    params: { location },
    query: {
      platform: 'android',
      number_of_slots: 5,
      has_customer_id: customerId !== null,
    },
  });
  const slots: any[] = data?.layout_items ?? [];
  ctx.logger.result(() => {
    for (const slot of slots) process.stdout.write(`${slot.model_key}  ${slot.display_title}\n`);
  }, data);
}

export async function recommendCommand(
  ctx: Context,
  location: string,
  opts: { model?: string; limit: number },
): Promise<void> {
  validateLocation(location);
  if (!opts.model)
    throw new UsageError('--model is required; run `takealot recommend layout` to list model keys');
  const customerId = ctx.client.auth.customerId;
  const query: Record<string, string | number> = {
    platform: 'android',
    model: opts.model,
    limit: opts.limit,
    display_type: 'product',
  };
  if (customerId !== null) query.customer_id = customerId;
  const data: any = await ctx.client.call('reco.location', { params: { location }, query });
  const products: any[] = data?.products ?? [];
  const shown = products.slice(0, opts.limit);
  ctx.logger.result(
    () => {
      for (const product of shown) {
        const title = product?.core?.title ?? product?.title ?? 'Untitled product';
        const price =
          product?.buybox_summary?.pretty_price || rand(product?.buybox_summary?.prices?.[0]);
        const plid = product?.core?.id ?? product?.plid ?? '?';
        process.stdout.write(`${c.bold(title)}\n  ${c.cyan(price)}  PLID${plid}\n`);
      }
    },
    { ...data, products: shown },
  );
}
