import type { TakealotClient } from './api-client.js';
import type { CheckoutPreview } from '../types.js';

const amount = (value: any): number | null => {
  const raw = value?.price?.amount ?? value?.amount ?? value;
  if (raw === undefined || raw === null || raw === '') return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};

const itemId = (item: any): unknown => item?.product_id ?? item?.id ?? item?.sku_id;

export async function getCheckoutPreview(client: TakealotClient): Promise<CheckoutPreview> {
  const response: any = await client.call('checkout.get');
  const data = response?.response ?? response ?? {};
  const products: any[] = data.products ?? data.cart?.products ?? [];
  const rows: any[] = data.items ?? data.cart_items ?? data.checkout_items ?? products;
  const productsById = new Map(products.map((product) => [itemId(product), product]));
  const items = rows.map((item) => {
    const product = productsById.get(itemId(item)) ?? item.product ?? item;
    return {
      title: String(item.title ?? product.title ?? ''),
      quantity: Number(item.quantity ?? product.quantity ?? 1),
      price: amount(item.unit_price ?? item.price ?? product.selling_price ?? product.price),
    };
  });
  const summary = data.summary ?? {};
  const currency =
    summary.total?.price?.currency ??
    summary.amount_due?.price?.currency ??
    data.currency ??
    'ZAR';
  const shipping = data.shipping_method;
  return {
    items,
    subtotal: amount(summary.subtotal),
    discount: amount(summary.discount),
    shippingDiscount: amount(summary.shipping_discount),
    credits: amount(summary.customer_credits),
    total: amount(summary.total),
    amountDue: amount(summary.amount_due),
    shippingMethod: typeof shipping === 'string' ? shipping : String(shipping?.title ?? shipping?.name ?? ''),
    currency: String(currency),
    sectionsIncomplete: (data.data_sections ?? [])
      .filter((section: any) => section?.is_complete === false)
      .map((section: any) => String(section.section_id ?? section.id ?? section.title ?? 'unknown')),
    payInApp: true,
  };
}
