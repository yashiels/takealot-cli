/**
 * The endpoint catalogue — the single, authoritative map of every Takealot
 * mobile-API endpoint the app exposes (extracted from the decompiled APK v4.2.2;
 * see docs/MOBILE-API.md and the domain grouping in the repo docs).
 *
 * This TS array is the runtime source; `docs/endpoints-catalogue.json` is the
 * committed frozen artifact generated from it (a test asserts they are identical,
 * and the contract test drives every non-excluded row through the client and
 * asserts the exact outgoing request). Coverage is proven against this catalogue,
 * so no endpoint can be silently dropped.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
export type Encoding = 'json' | 'form' | 'text' | 'delete-body' | 'none';
export type Base = 'mobile' | 'search' | 'absolute';

export interface EndpointRow {
  /** Stable id (e.g. "cart.add"); also the registry key. */
  id: string;
  domain: string;
  method: HttpMethod;
  /** Path template relative to `base`; `{param}` placeholders (customerId auto-filled). */
  path: string;
  base: Base;
  auth: boolean;
  encoding: Encoding;
  mutating: boolean;
  excluded: boolean;
  reason?: string;
  /** The CLI command that wires it (null when excluded). */
  command: string | null;
  /** Args the contract test drives to assert method/path/auth/encoding. */
  sample?: { params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown };
}

type Row = Omit<EndpointRow, 'base' | 'excluded'> & { base?: Base; excluded?: boolean };
const r = (row: Row): EndpointRow => ({ base: 'mobile', excluded: false, ...row });

const CID = { customerId: 12345 };

export const CATALOGUE: EndpointRow[] = [
  // ── 1. Auth & Session ──────────────────────────────────────────────────
  r({ id: 'auth.login.form', domain: 'auth', method: 'GET', path: 'customers/login', auth: false, encoding: 'none', mutating: false, command: 'account login-form', sample: {} }),
  r({ id: 'auth.login', domain: 'auth', method: 'POST', path: 'customers/login', auth: false, encoding: 'json', mutating: true, command: 'login', sample: { body: { platform: 'android', sections: [] } } }),
  r({ id: 'auth.signon', domain: 'auth', method: 'POST', path: 'customers/signon', auth: false, encoding: 'json', mutating: true, command: 'account signon submit', sample: { body: {} } }),
  r({ id: 'auth.register.form', domain: 'auth', method: 'GET', path: 'customers/register', auth: false, encoding: 'none', mutating: false, command: 'account register form', sample: {} }),
  r({ id: 'auth.register', domain: 'auth', method: 'POST', path: 'customers/register', auth: false, encoding: 'json', mutating: true, command: 'account register submit', sample: { body: {} } }),
  r({ id: 'auth.register.update', domain: 'auth', method: 'PUT', path: 'customers/register', auth: false, encoding: 'json', mutating: true, command: 'account register update', sample: { body: {} } }),
  r({ id: 'auth.logout', domain: 'auth', method: 'POST', path: 'logout', auth: true, encoding: 'json', mutating: true, command: 'account logout', sample: { body: {} } }),
  r({ id: 'auth.refresh', domain: 'auth', method: 'POST', path: 'customers/auth/refresh', auth: true, encoding: 'json', mutating: true, command: null, excluded: true, reason: 'token refresh is internal to the auth layer, not a user command' }),
  r({ id: 'auth.password.forgot.form', domain: 'auth', method: 'GET', path: 'customer/password/forgot', auth: false, encoding: 'none', mutating: false, command: 'account forgot-password form', sample: {} }),
  r({ id: 'auth.password.forgot', domain: 'auth', method: 'POST', path: 'customer/password/forgot', auth: false, encoding: 'json', mutating: true, command: 'account forgot-password submit', sample: { body: {} } }),
  r({ id: 'auth.password.reset.form', domain: 'auth', method: 'GET', path: 'customer/password/reset', auth: false, encoding: 'none', mutating: false, command: 'account reset-password form', sample: {} }),
  r({ id: 'auth.password.reset', domain: 'auth', method: 'POST', path: 'customer/password/reset', auth: false, encoding: 'json', mutating: true, command: 'account reset-password submit', sample: { body: {} } }),

  // ── 2. Config, App & Telemetry ─────────────────────────────────────────
  r({ id: 'config.get', domain: 'config', method: 'GET', path: 'config', auth: false, encoding: 'none', mutating: false, command: 'config remote', sample: {} }),
  r({ id: 'config.appVersion', domain: 'config', method: 'GET', path: 'app-version', auth: false, encoding: 'none', mutating: false, command: 'config app-version', sample: {} }),
  r({ id: 'config.abtest', domain: 'config', method: 'GET', path: 'ab-test/assign-buckets', auth: false, encoding: 'none', mutating: false, command: null, excluded: true, reason: 'A/B bucket assignment is app internals, not a shopping action' }),
  r({ id: 'cms.page', domain: 'config', method: 'GET', path: 'cms/pages/{slug}', auth: false, encoding: 'none', mutating: false, command: 'cms page', sample: { params: { slug: 'help' } } }),
  r({ id: 'cms.route', domain: 'config', method: 'GET', path: 'cms/route', auth: false, encoding: 'none', mutating: false, command: 'cms route', sample: { query: { url: '/x' } } }),
  r({ id: 'ute.collect', domain: 'config', method: 'POST', path: 'collect', auth: false, encoding: 'json', mutating: true, command: null, excluded: true, reason: 'UTE analytics/telemetry ingest — nothing to expose to a shopper' }),

  // ── 3. Search & Browse ─────────────────────────────────────────────────
  r({ id: 'search.autocomplete', domain: 'search', method: 'GET', path: 'search/autocomplete', base: 'mobile', auth: false, encoding: 'none', mutating: false, command: 'autocomplete', sample: { query: { query: 'milk', include_pages: true } } }),
  r({ id: 'search.trending', domain: 'search', method: 'GET', path: 'search/trending', auth: false, encoding: 'none', mutating: false, command: 'trending', sample: { query: { platform: 'android', limit: 10 } } }),
  r({ id: 'search.main', domain: 'search', method: 'GET', path: 'searches/products,filters,facets,sort_options,breadcrumbs,slots_audience,context,seo,layout', base: 'search', auth: false, encoding: 'none', mutating: false, command: 'search', sample: { query: { qsearch: 'milk' } } }),
  r({ id: 'search.facets', domain: 'search', method: 'GET', path: 'searches/facets,product_count', base: 'search', auth: false, encoding: 'none', mutating: false, command: 'search --facets-only', sample: { query: { qsearch: 'milk' } } }),

  // ── 4. Product ─────────────────────────────────────────────────────────
  r({ id: 'product.details', domain: 'product', method: 'GET', path: 'product-details/PLID{plid}', auth: false, encoding: 'none', mutating: false, command: 'info', sample: { params: { plid: 52341565 }, query: { platform: 'android' } } }),
  r({ id: 'product.creditOptions', domain: 'product', method: 'GET', path: 'product-details/PLID{plid}/credit-options', auth: false, encoding: 'none', mutating: false, command: 'info --credit-options', sample: { params: { plid: 52341565 } } }),
  r({ id: 'product.bundleDeals', domain: 'product', method: 'GET', path: 'product-details/PLID{plid}/bundle-deals/{bundleIds}', auth: false, encoding: 'none', mutating: false, command: 'info --bundle', sample: { params: { plid: 52341565, bundleIds: '1' } } }),
  r({ id: 'product.card', domain: 'product', method: 'GET', path: 'product-card/PLID{plid}', auth: false, encoding: 'none', mutating: false, command: 'info --card', sample: { params: { plid: 52341565 } } }),
  r({ id: 'product.cards', domain: 'product', method: 'GET', path: 'product-cards', auth: false, encoding: 'none', mutating: false, command: 'info --batch', sample: { query: { plids: 'PLID1,PLID2' } } }),
  r({ id: 'product.alsoBought', domain: 'product', method: 'GET', path: 'products/{plids}/recommendations', auth: false, encoding: 'none', mutating: false, command: 'info --also-bought', sample: { params: { plids: 'PLID1' } } }),
  r({ id: 'product.report.form', domain: 'product', method: 'GET', path: 'customers/{customerId}/report-product/{skuId}', auth: true, encoding: 'none', mutating: false, command: 'info report-form', sample: { params: { ...CID, skuId: 999 } } }),

  // ── 5. Recommendations & Sponsored Ads ─────────────────────────────────
  r({ id: 'reco.location', domain: 'recommend', method: 'GET', path: 'recommendations/{location}', auth: false, encoding: 'none', mutating: false, command: 'recommend', sample: { params: { location: 'home' } } }),
  r({ id: 'reco.location.layout', domain: 'recommend', method: 'GET', path: 'recommendations/{location}/layout', auth: false, encoding: 'none', mutating: false, command: 'recommend --layout', sample: { params: { location: 'home' } } }),
  r({ id: 'reco.customer', domain: 'recommend', method: 'GET', path: 'customer/{customerId}/recommendations', auth: true, encoding: 'none', mutating: false, command: 'recommend --personal', sample: { params: CID } }),
  r({ id: 'reco.trending', domain: 'recommend', method: 'GET', path: 'recommend/trending', auth: false, encoding: 'none', mutating: false, command: 'recommend --trending', sample: {} }),
  r({ id: 'ads.sponsoredProducts', domain: 'recommend', method: 'GET', path: 'sponsored-products', auth: false, encoding: 'none', mutating: false, command: null, excluded: true, reason: 'sponsored ad slot — not a shopper action' }),
  r({ id: 'ads.sponsoredDisplay', domain: 'recommend', method: 'GET', path: 'sponsored-display', auth: false, encoding: 'none', mutating: false, command: null, excluded: true, reason: 'sponsored ad slot — not a shopper action' }),
  r({ id: 'reco.buyAgain', domain: 'recommend', method: 'GET', path: 'orders/frequently-purchased', auth: true, encoding: 'none', mutating: false, command: 'buy-again', sample: {} }),

  // ── 6. Cart ────────────────────────────────────────────────────────────
  r({ id: 'cart.get', domain: 'cart', method: 'GET', path: 'customers/{customerId}/cart', auth: true, encoding: 'none', mutating: false, command: 'cart', sample: { params: CID } }),
  r({ id: 'cart.add', domain: 'cart', method: 'POST', path: 'customers/{customerId}/cart/items', auth: true, encoding: 'json', mutating: true, command: 'cart add', sample: { params: CID, body: { products: [{ id: 1, quantity: 1 }] } } }),
  r({ id: 'cart.update', domain: 'cart', method: 'PUT', path: 'customers/{customerId}/cart/items', auth: true, encoding: 'json', mutating: true, command: 'cart set-qty', sample: { params: CID, body: { products: [{ id: 1, quantity: 2 }] } } }),
  r({ id: 'cart.remove', domain: 'cart', method: 'DELETE', path: 'customers/{customerId}/cart/items', auth: true, encoding: 'delete-body', mutating: true, command: 'cart remove', sample: { params: CID, body: { products: [{ id: 1 }] } } }),

  // ── 7. Checkout ────────────────────────────────────────────────────────
  r({ id: 'checkout.get', domain: 'checkout', method: 'GET', path: 'checkout/{customerId}', auth: true, encoding: 'none', mutating: false, command: 'checkout', sample: { params: CID } }),
  r({ id: 'checkout.create', domain: 'checkout', method: 'POST', path: 'checkout/{customerId}', auth: true, encoding: 'json', mutating: true, command: 'checkout --refresh', sample: { params: CID, body: {} } }),
  r({ id: 'checkout.update', domain: 'checkout', method: 'PUT', path: 'checkout/{customerId}', auth: true, encoding: 'json', mutating: true, command: 'checkout submit', sample: { params: CID, body: { platform: 'android', sections: [] } } }),
  r({ id: 'checkout.complete', domain: 'checkout', method: 'POST', path: 'checkout/{customerId}/complete', auth: true, encoding: 'text', mutating: true, command: 'checkout --confirm', sample: { params: CID, body: 'android' } }),
  r({ id: 'checkout.order', domain: 'checkout', method: 'GET', path: 'checkout/{customerId}/order/{orderId}', auth: true, encoding: 'none', mutating: false, command: 'checkout order', sample: { params: { ...CID, orderId: 'O1' } } }),
  r({ id: 'checkout.order.update', domain: 'checkout', method: 'PUT', path: 'checkout/{customerId}/order/{orderId}', auth: true, encoding: 'json', mutating: true, command: 'checkout order submit', sample: { params: { ...CID, orderId: 'O1' }, body: { platform: 'android', sections: [] } } }),
  r({ id: 'checkout.pickupPoints', domain: 'checkout', method: 'GET', path: 'checkout/{customerId}/pickup-points', auth: true, encoding: 'none', mutating: false, command: 'pickup-points', sample: { params: CID } }),
  r({ id: 'checkout.payment', domain: 'checkout', method: 'POST', path: 'order/{orderId}/payment', auth: true, encoding: 'form', mutating: true, command: 'checkout --confirm', sample: { params: { orderId: 'O1' }, body: { method: 'Credit Card Token', token_reference: 'x', budget_period: 'Straight' } } }),
  r({ id: 'checkout.payment.complete', domain: 'checkout', method: 'POST', path: 'order/{orderId}/payment/complete', auth: true, encoding: 'json', mutating: true, command: 'checkout resume', sample: { params: { orderId: 'O1' }, body: { platform: 'android', status: 'success' } } }),

  // ── 8. Payment Cards & eBucks ──────────────────────────────────────────
  r({ id: 'cards.list', domain: 'cards', method: 'GET', path: 'customers/card', auth: true, encoding: 'none', mutating: false, command: 'cards', sample: {} }),
  r({ id: 'cards.remove', domain: 'cards', method: 'DELETE', path: 'customers/card', auth: true, encoding: 'delete-body', mutating: true, command: 'cards rm', sample: { body: { reference: 'ref' } } }),
  r({ id: 'checkout.payhost', domain: 'cards', method: 'GET', path: 'checkout/order/{orderId}/payhost', auth: true, encoding: 'none', mutating: false, command: 'checkout payhost', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'ebucks.requestotp', domain: 'cards', method: 'GET', path: 'order/{orderId}/payment/ebucks/requestotp', auth: true, encoding: 'none', mutating: false, command: 'ebucks requestotp', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'ebucks.login', domain: 'cards', method: 'POST', path: 'order/{orderId}/payment/ebucks/login', auth: true, encoding: 'json', mutating: true, command: 'ebucks login', sample: { params: { orderId: 'O1' }, body: {} } }),
  r({ id: 'ebucks.pay', domain: 'cards', method: 'POST', path: 'order/{orderId}/payment/ebucks', auth: true, encoding: 'json', mutating: true, command: 'ebucks pay', sample: { params: { orderId: 'O1' }, body: {} } }),

  // ── 9. Orders & Tracking ───────────────────────────────────────────────
  r({ id: 'orders.list', domain: 'orders', method: 'GET', path: 'customer/{customerId}/orders', auth: true, encoding: 'none', mutating: false, command: 'orders', sample: { params: CID, query: { period: 'all', page_number: 0 } } }),
  r({ id: 'orders.detail', domain: 'orders', method: 'GET', path: 'order/{orderId}/detail', auth: true, encoding: 'none', mutating: false, command: 'orders show', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'orders.tracking', domain: 'orders', method: 'GET', path: 'order/{orderId}/consignment/tracking/{waybill}', auth: true, encoding: 'none', mutating: false, command: 'orders track', sample: { params: { orderId: 'O1', waybill: 'W1' } } }),
  r({ id: 'orders.cancel.form', domain: 'orders', method: 'GET', path: 'order/{orderId}/cancel', auth: true, encoding: 'none', mutating: false, command: 'orders cancel form', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'orders.cancel', domain: 'orders', method: 'POST', path: 'order/{orderId}/cancel', auth: true, encoding: 'json', mutating: true, command: 'orders cancel', sample: { params: { orderId: 'O1' }, body: {} } }),
  r({ id: 'orders.requestCancel.form', domain: 'orders', method: 'GET', path: 'order/{orderId}/request-cancel', auth: true, encoding: 'none', mutating: false, command: 'orders request-cancel form', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'orders.requestCancel', domain: 'orders', method: 'POST', path: 'order/{orderId}/request-cancel', auth: true, encoding: 'json', mutating: true, command: 'orders request-cancel submit', sample: { params: { orderId: 'O1' }, body: {} } }),
  r({ id: 'orders.consignment.cancel.form', domain: 'orders', method: 'GET', path: 'order/{orderId}/consignment/{waybill}/cancel', auth: true, encoding: 'none', mutating: false, command: 'orders consignment-cancel form', sample: { params: { orderId: 'O1', waybill: 'W1' } } }),
  r({ id: 'orders.consignment.cancel', domain: 'orders', method: 'POST', path: 'order/{orderId}/consignment/{waybill}/cancel', auth: true, encoding: 'json', mutating: true, command: 'orders consignment-cancel submit', sample: { params: { orderId: 'O1', waybill: 'W1' }, body: {} } }),
  r({ id: 'orders.reschedule.form', domain: 'orders', method: 'GET', path: 'order/{orderId}/delivery/{waybill}/reschedule', auth: true, encoding: 'none', mutating: false, command: 'orders reschedule form', sample: { params: { orderId: 'O1', waybill: 'W1' } } }),
  r({ id: 'orders.reschedule', domain: 'orders', method: 'POST', path: 'order/{orderId}/delivery/{waybill}/reschedule', auth: true, encoding: 'json', mutating: true, command: 'orders reschedule submit', sample: { params: { orderId: 'O1', waybill: 'W1' }, body: {} } }),
  r({ id: 'orders.returns', domain: 'orders', method: 'GET', path: 'order/{orderId}/returns', auth: true, encoding: 'none', mutating: false, command: 'orders returns', sample: { params: { orderId: 'O1' } } }),

  // ── 10. Invoices & Credit Notes ────────────────────────────────────────
  r({ id: 'invoices.list', domain: 'invoices', method: 'GET', path: 'order/{orderId}/invoices', auth: true, encoding: 'none', mutating: false, command: 'invoices', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'invoices.request.form', domain: 'invoices', method: 'GET', path: 'order/{orderId}/invoice/{invoiceId}/request', auth: true, encoding: 'none', mutating: false, command: 'invoices request form', sample: { params: { orderId: 'O1', invoiceId: 'I1' } } }),
  r({ id: 'invoices.request', domain: 'invoices', method: 'POST', path: 'order/{orderId}/invoice/{invoiceId}/request', auth: true, encoding: 'json', mutating: true, command: 'invoices request submit', sample: { params: { orderId: 'O1', invoiceId: 'I1' }, body: {} } }),
  r({ id: 'invoices.pdf', domain: 'invoices', method: 'GET', path: 'order/{orderId}/invoice/{invoiceId}/pdf/url', auth: true, encoding: 'none', mutating: false, command: 'invoices pdf', sample: { params: { orderId: 'O1', invoiceId: 'I1' } } }),
  r({ id: 'invoices.creditnote.pdf', domain: 'invoices', method: 'GET', path: 'order/{orderId}/creditnote/{creditnoteId}/pdf/url', auth: true, encoding: 'none', mutating: false, command: 'invoices creditnote-pdf', sample: { params: { orderId: 'O1', creditnoteId: 'C1' } } }),
  r({ id: 'invoices.business.get', domain: 'invoices', method: 'GET', path: 'order/{orderId}/invoice/business-details', auth: true, encoding: 'none', mutating: false, command: 'invoices business form', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'invoices.business.set', domain: 'invoices', method: 'PUT', path: 'order/{orderId}/invoice/business-details', auth: true, encoding: 'json', mutating: true, command: 'invoices business submit', sample: { params: { orderId: 'O1' }, body: {} } }),
  r({ id: 'invoices.delivered', domain: 'invoices', method: 'GET', path: 'customer/{customerId}/orders/delivered', auth: true, encoding: 'none', mutating: false, command: 'invoices delivered', sample: { params: CID } }),

  // ── 11. Returns & Refunds ──────────────────────────────────────────────
  r({ id: 'returns.orders', domain: 'returns', method: 'GET', path: 'customers/{customerId}/returns/orders', auth: true, encoding: 'none', mutating: false, command: 'returns orders', sample: { params: CID } }),
  r({ id: 'returns.items', domain: 'returns', method: 'GET', path: 'customers/{customerId}/returns/items', auth: true, encoding: 'none', mutating: false, command: 'returns items', sample: { params: CID } }),
  r({ id: 'returns.cart.get', domain: 'returns', method: 'GET', path: 'customers/{customerId}/returns/cart', auth: true, encoding: 'none', mutating: false, command: 'returns cart', sample: { params: CID } }),
  r({ id: 'returns.cart.add', domain: 'returns', method: 'POST', path: 'customers/{customerId}/returns/cart', auth: true, encoding: 'json', mutating: true, command: 'returns cart add', sample: { params: CID, body: {} } }),
  r({ id: 'returns.cart.update', domain: 'returns', method: 'PUT', path: 'customers/{customerId}/returns/cart', auth: true, encoding: 'json', mutating: true, command: 'returns cart set', sample: { params: CID, body: {} } }),
  r({ id: 'returns.cart.remove', domain: 'returns', method: 'DELETE', path: 'customers/{customerId}/returns/cart', auth: true, encoding: 'delete-body', mutating: true, command: 'returns cart rm', sample: { params: CID, body: {} } }),
  r({ id: 'returns.checkout.get', domain: 'returns', method: 'GET', path: 'customers/{customerId}/returns/checkout', auth: true, encoding: 'none', mutating: false, command: 'returns checkout', sample: { params: CID } }),
  r({ id: 'returns.checkout.create', domain: 'returns', method: 'POST', path: 'customers/{customerId}/returns/checkout', auth: true, encoding: 'json', mutating: true, command: 'returns checkout create', sample: { params: CID, body: {} } }),
  r({ id: 'returns.checkout.update', domain: 'returns', method: 'PUT', path: 'customers/{customerId}/returns/checkout', auth: true, encoding: 'json', mutating: true, command: 'returns checkout submit', sample: { params: CID, body: {} } }),
  r({ id: 'returns.checkout.complete', domain: 'returns', method: 'POST', path: 'customers/{customerId}/returns/checkout/complete', auth: true, encoding: 'json', mutating: true, command: 'returns checkout complete', sample: { params: CID, body: {} } }),
  r({ id: 'returns.checkout.pickupPoints', domain: 'returns', method: 'GET', path: 'customers/{customerId}/returns/checkout/pickup-points', auth: true, encoding: 'none', mutating: false, command: 'returns pickup-points', sample: { params: CID } }),
  r({ id: 'returns.order', domain: 'returns', method: 'GET', path: 'orders/{orderId}/returns', auth: true, encoding: 'none', mutating: false, command: 'returns order', sample: { params: { orderId: 'O1' } } }),
  r({ id: 'returns.order.item', domain: 'returns', method: 'GET', path: 'orders/{orderId}/returns/items/{orderItemId}', auth: true, encoding: 'none', mutating: false, command: 'returns order-item', sample: { params: { orderId: 'O1', orderItemId: 'OI1' } } }),
  r({ id: 'returns.tracking', domain: 'returns', method: 'GET', path: 'returns/tracking-details/{returnId}', auth: true, encoding: 'none', mutating: false, command: 'returns track', sample: { params: { returnId: 'R1' } } }),
  r({ id: 'returns.reschedule.form', domain: 'returns', method: 'GET', path: 'returns/{rrn}/reschedule/{waybill}', auth: true, encoding: 'none', mutating: false, command: 'returns reschedule form', sample: { params: { rrn: 'RRN1', waybill: 'W1' } } }),
  r({ id: 'returns.reschedule', domain: 'returns', method: 'POST', path: 'returns/{rrn}/reschedule/{waybill}', auth: true, encoding: 'json', mutating: true, command: 'returns reschedule submit', sample: { params: { rrn: 'RRN1', waybill: 'W1' }, body: {} } }),
  r({ id: 'refunds.list', domain: 'returns', method: 'GET', path: 'customers/{customerId}/refunds', auth: true, encoding: 'none', mutating: false, command: 'refunds', sample: { params: CID } }),
  r({ id: 'refunds.detail', domain: 'returns', method: 'GET', path: 'customers/{customerId}/refunds/{refundId}', auth: true, encoding: 'none', mutating: false, command: 'refunds show', sample: { params: { ...CID, refundId: 'RF1' } } }),
  r({ id: 'refunds.request.form', domain: 'returns', method: 'GET', path: 'customers/{customerId}/refunds/request', auth: true, encoding: 'none', mutating: false, command: 'refunds request form', sample: { params: CID } }),
  r({ id: 'refunds.request', domain: 'returns', method: 'POST', path: 'customers/{customerId}/refunds/request', auth: true, encoding: 'json', mutating: true, command: 'refunds request submit', sample: { params: CID, body: {} } }),
  r({ id: 'refunds.contacts.get', domain: 'returns', method: 'GET', path: 'contacts/refunds', auth: true, encoding: 'none', mutating: false, command: 'refunds contact form', sample: {} }),
  r({ id: 'refunds.contacts.post', domain: 'returns', method: 'POST', path: 'contacts/refunds', auth: true, encoding: 'json', mutating: true, command: 'refunds contact submit', sample: { body: {} } }),

  // ── 12. Delivery, Address & Pickup ─────────────────────────────────────
  r({ id: 'address.list', domain: 'address', method: 'GET', path: 'customers/{customerId}/addresses', auth: true, encoding: 'none', mutating: false, command: 'address list', sample: { params: CID } }),
  r({ id: 'address.add', domain: 'address', method: 'POST', path: 'customers/{customerId}/addresses', auth: true, encoding: 'json', mutating: true, command: 'address add submit', sample: { params: CID, body: {} } }),
  r({ id: 'address.update', domain: 'address', method: 'PUT', path: 'addresses/{addressId}', auth: true, encoding: 'json', mutating: true, command: 'address update submit', sample: { params: { addressId: 'A1' }, body: {} } }),
  r({ id: 'address.delete', domain: 'address', method: 'DELETE', path: 'addresses/{addressId}', auth: true, encoding: 'none', mutating: true, command: 'address rm', sample: { params: { addressId: 'A1' } } }),
  r({ id: 'address.config', domain: 'address', method: 'GET', path: 'addresses/config', auth: true, encoding: 'none', mutating: false, command: 'address config', sample: {} }),
  r({ id: 'address.validate', domain: 'address', method: 'POST', path: '{absoluteUrl}', base: 'absolute', auth: false, encoding: 'json', mutating: true, command: 'address validate', sample: { params: { absoluteUrl: 'https://api.takealot.com/validate' }, body: {} } }),
  r({ id: 'address.select', domain: 'address', method: 'PUT', path: 'customer/address/selected', auth: true, encoding: 'json', mutating: true, command: 'address use', sample: { body: { address_id: 'A1' } } }),
  r({ id: 'pickup.extended', domain: 'address', method: 'GET', path: 'pickup-points/extended', auth: false, encoding: 'none', mutating: false, command: 'pickup-points --extended', sample: {} }),

  // ── 13. Wishlist ───────────────────────────────────────────────────────
  r({ id: 'wishlist.list', domain: 'wishlist', method: 'GET', path: 'customers/{customerId}/wishlists', auth: true, encoding: 'none', mutating: false, command: 'wishlist list', sample: { params: CID } }),
  r({ id: 'wishlist.summary', domain: 'wishlist', method: 'GET', path: 'customers/{customerId}/wishlists/summary', auth: true, encoding: 'none', mutating: false, command: 'wishlist', sample: { params: CID } }),
  r({ id: 'wishlist.create', domain: 'wishlist', method: 'POST', path: 'customers/{customerId}/wishlists', auth: true, encoding: 'json', mutating: true, command: 'wishlist mk', sample: { params: CID, body: {} } }),
  r({ id: 'wishlist.rename', domain: 'wishlist', method: 'PUT', path: 'customers/{customerId}/wishlists/{groupId}', auth: true, encoding: 'json', mutating: true, command: 'wishlist rename', sample: { params: { ...CID, groupId: 'G1' }, body: {} } }),
  r({ id: 'wishlist.delete', domain: 'wishlist', method: 'DELETE', path: 'customers/{customerId}/wishlists/{groupId}', auth: true, encoding: 'none', mutating: true, command: 'wishlist rm-list', sample: { params: { ...CID, groupId: 'G1' } } }),
  r({ id: 'wishlist.items', domain: 'wishlist', method: 'GET', path: 'customers/{customerId}/wishlists/{groupId}/items', auth: true, encoding: 'none', mutating: false, command: 'wishlist items', sample: { params: { ...CID, groupId: 'G1' } } }),
  r({ id: 'wishlist.items.add', domain: 'wishlist', method: 'POST', path: 'customers/{customerId}/wishlists/{groupId}/items', auth: true, encoding: 'json', mutating: true, command: 'wishlist add --group', sample: { params: { ...CID, groupId: 'G1' }, body: {} } }),
  r({ id: 'wishlist.items.addLast', domain: 'wishlist', method: 'POST', path: 'customers/{customerId}/wishlists/last_used/items', auth: true, encoding: 'json', mutating: true, command: 'wishlist add', sample: { params: CID, body: {} } }),
  r({ id: 'wishlist.items.move', domain: 'wishlist', method: 'PUT', path: 'customers/{customerId}/wishlists/items/move', auth: true, encoding: 'json', mutating: true, command: 'wishlist move', sample: { params: CID, body: {} } }),
  r({ id: 'wishlist.items.updatePid', domain: 'wishlist', method: 'PUT', path: 'customers/{customerId}/wishlists/items/pid/{skuId}', auth: true, encoding: 'json', mutating: true, command: 'wishlist update-pid', sample: { params: { ...CID, skuId: 9 }, body: {} } }),
  r({ id: 'wishlist.items.updateTsin', domain: 'wishlist', method: 'PUT', path: 'customers/{customerId}/wishlists/items/tsin/{tsinId}', auth: true, encoding: 'json', mutating: true, command: 'wishlist update-tsin', sample: { params: { ...CID, tsinId: 9 }, body: {} } }),
  r({ id: 'wishlist.items.rmPid', domain: 'wishlist', method: 'DELETE', path: 'customers/{customerId}/wishlists/items/pid/{skuId}', auth: true, encoding: 'none', mutating: true, command: 'wishlist rm', sample: { params: { ...CID, skuId: 9 } } }),
  r({ id: 'wishlist.items.rmTsin', domain: 'wishlist', method: 'DELETE', path: 'customers/{customerId}/wishlists/items/tsin/{tsinId}', auth: true, encoding: 'none', mutating: true, command: 'wishlist rm-tsin', sample: { params: { ...CID, tsinId: 9 } } }),
  r({ id: 'wishlist.items.bulkRemove', domain: 'wishlist', method: 'DELETE', path: 'customers/{customerId}/wishlists/{groupId}/items', auth: true, encoding: 'delete-body', mutating: true, command: 'wishlist rm-items', sample: { params: { ...CID, groupId: 'G1' }, body: {} } }),
  r({ id: 'wishlist.shared', domain: 'wishlist', method: 'GET', path: 'customers/wishlists/{sharedGroupId}', auth: false, encoding: 'none', mutating: false, command: 'wishlist shared', sample: { params: { sharedGroupId: 'S1' } } }),
  r({ id: 'wishlist.reco', domain: 'wishlist', method: 'GET', path: 'recommend/wishlist', auth: true, encoding: 'none', mutating: false, command: 'wishlist recommend', sample: {} }),
  r({ id: 'wishlist.reco.plids', domain: 'wishlist', method: 'GET', path: 'recommend/wishlist/{plids}', auth: true, encoding: 'none', mutating: false, command: 'wishlist recommend-for', sample: { params: { plids: 'PLID1' } } }),

  // ── 14. Credits & Vouchers ─────────────────────────────────────────────
  r({ id: 'credits.overview', domain: 'credits', method: 'GET', path: 'customers/{customerId}/credits', auth: true, encoding: 'none', mutating: false, command: 'credits overview', sample: { params: CID } }),
  r({ id: 'credits.balance', domain: 'credits', method: 'GET', path: 'customers/{customerId}/credits/balance', auth: true, encoding: 'none', mutating: false, command: 'credits', sample: { params: CID } }),
  r({ id: 'credits.balance.detail', domain: 'credits', method: 'GET', path: 'customers/{customerId}/credits/balance/detail', auth: true, encoding: 'none', mutating: false, command: 'credits --detail', sample: { params: CID } }),
  r({ id: 'credits.redeem', domain: 'credits', method: 'POST', path: 'customer/{customerId}/credits', auth: true, encoding: 'form', mutating: true, command: 'credits redeem', sample: { params: CID, body: { voucher_code: 'X' } } }),

  // ── 15. Subscription (Takealot Plus) ───────────────────────────────────
  r({ id: 'plus.get', domain: 'plus', method: 'GET', path: 'subscription', auth: true, encoding: 'none', mutating: false, command: 'plus', sample: {} }),
  r({ id: 'plus.plans', domain: 'plus', method: 'GET', path: 'subscription/plans', auth: true, encoding: 'none', mutating: false, command: 'plus plans', sample: {} }),
  r({ id: 'plus.signup.form', domain: 'plus', method: 'GET', path: 'subscription/signup/plan/{planId}', auth: true, encoding: 'none', mutating: false, command: 'plus signup form', sample: { params: { planId: 'P1' } } }),
  r({ id: 'plus.signup', domain: 'plus', method: 'PUT', path: 'subscription/signup/plan/{planId}', auth: true, encoding: 'json', mutating: true, command: 'plus signup submit', sample: { params: { planId: 'P1' }, body: {} } }),
  r({ id: 'plus.pay', domain: 'plus', method: 'POST', path: 'subscription/pay', auth: true, encoding: 'json', mutating: true, command: 'plus pay', sample: { body: {} } }),
  r({ id: 'plus.history', domain: 'plus', method: 'GET', path: 'subscription/history', auth: true, encoding: 'none', mutating: false, command: 'plus history', sample: {} }),
  r({ id: 'plus.savings', domain: 'plus', method: 'GET', path: 'subscription/current-savings', auth: true, encoding: 'none', mutating: false, command: 'plus savings', sample: {} }),
  r({ id: 'plus.cancel.form', domain: 'plus', method: 'GET', path: 'subscription/cancel', auth: true, encoding: 'none', mutating: false, command: 'plus cancel form', sample: {} }),
  r({ id: 'plus.cancel', domain: 'plus', method: 'POST', path: 'subscription/cancel', auth: true, encoding: 'json', mutating: true, command: 'plus cancel submit', sample: { body: {} } }),
  r({ id: 'plus.cancelReason.form', domain: 'plus', method: 'GET', path: 'subscription/cancel/reason', auth: true, encoding: 'none', mutating: false, command: 'plus cancel-reason form', sample: {} }),
  r({ id: 'plus.cancelReason', domain: 'plus', method: 'POST', path: 'subscription/cancel/reason', auth: true, encoding: 'json', mutating: true, command: 'plus cancel-reason submit', sample: { body: {} } }),
  r({ id: 'plus.reactivate.form', domain: 'plus', method: 'GET', path: 'subscription/reactivate', auth: true, encoding: 'none', mutating: false, command: 'plus reactivate form', sample: {} }),
  r({ id: 'plus.reactivate', domain: 'plus', method: 'PUT', path: 'subscription/reactivate', auth: true, encoding: 'json', mutating: true, command: 'plus reactivate submit', sample: { body: {} } }),
  r({ id: 'plus.claimDiscount.form', domain: 'plus', method: 'GET', path: 'subscription/claim-discount', auth: true, encoding: 'none', mutating: false, command: 'plus claim-discount form', sample: {} }),
  r({ id: 'plus.claimDiscount', domain: 'plus', method: 'PUT', path: 'subscription/claim-discount', auth: true, encoding: 'json', mutating: true, command: 'plus claim-discount submit', sample: { body: {} } }),
  r({ id: 'plus.manage.plan', domain: 'plus', method: 'GET', path: 'subscription/manage/plan', auth: true, encoding: 'none', mutating: false, command: 'plus manage plan', sample: {} }),
  r({ id: 'plus.manage.upgrade.form', domain: 'plus', method: 'GET', path: 'subscription/manage/plan/upgrade', auth: true, encoding: 'none', mutating: false, command: 'plus manage upgrade form', sample: {} }),
  r({ id: 'plus.manage.upgrade', domain: 'plus', method: 'PUT', path: 'subscription/manage/plan/upgrade', auth: true, encoding: 'json', mutating: true, command: 'plus manage upgrade submit', sample: { body: {} } }),
  r({ id: 'plus.manage.downgrade.form', domain: 'plus', method: 'GET', path: 'subscription/manage/plan/downgrade', auth: true, encoding: 'none', mutating: false, command: 'plus manage downgrade form', sample: {} }),
  r({ id: 'plus.manage.downgrade', domain: 'plus', method: 'PUT', path: 'subscription/manage/plan/downgrade', auth: true, encoding: 'json', mutating: true, command: 'plus manage downgrade submit', sample: { body: {} } }),
  r({ id: 'plus.manage.address.form', domain: 'plus', method: 'GET', path: 'subscription/manage/address', auth: true, encoding: 'none', mutating: false, command: 'plus manage address form', sample: {} }),
  r({ id: 'plus.manage.address', domain: 'plus', method: 'PUT', path: 'subscription/manage/address', auth: true, encoding: 'json', mutating: true, command: 'plus manage address submit', sample: { body: {} } }),
  r({ id: 'plus.manage.card.form', domain: 'plus', method: 'GET', path: 'subscription/manage/card', auth: true, encoding: 'none', mutating: false, command: 'plus manage card form', sample: {} }),
  r({ id: 'plus.manage.card', domain: 'plus', method: 'PUT', path: 'subscription/manage/card', auth: true, encoding: 'json', mutating: true, command: 'plus manage card submit', sample: { body: {} } }),
  r({ id: 'plus.card.add', domain: 'plus', method: 'GET', path: 'subscription/card/add', auth: true, encoding: 'none', mutating: false, command: 'plus card-add form', sample: {} }),
  r({ id: 'plus.card.payment', domain: 'plus', method: 'GET', path: 'subscription/card/payment', auth: true, encoding: 'none', mutating: false, command: 'plus card-payment', sample: {} }),
  r({ id: 'plus.invoice.pdf', domain: 'plus', method: 'GET', path: 'subscription/invoice/{invoiceId}/pdf/url', auth: true, encoding: 'none', mutating: false, command: 'plus invoice-pdf', sample: { params: { invoiceId: 'I1' } } }),
  r({ id: 'plus.account.linkingPage', domain: 'plus', method: 'GET', path: 'customers/{customerId}/account/linking-page', auth: true, encoding: 'none', mutating: false, command: 'plus link page', sample: { params: CID } }),
  r({ id: 'plus.account.link', domain: 'plus', method: 'POST', path: 'customers/{customerId}/account/link', auth: true, encoding: 'json', mutating: true, command: 'plus link', sample: { params: CID, body: {} } }),
  r({ id: 'plus.account.unlink', domain: 'plus', method: 'POST', path: 'customers/{customerId}/account/unlink', auth: true, encoding: 'json', mutating: true, command: 'plus unlink', sample: { params: CID, body: {} } }),

  // ── 16. Account, Personal Details & Security ────────────────────────────
  r({ id: 'account.summary', domain: 'account', method: 'GET', path: 'customers/summary', auth: true, encoding: 'none', mutating: false, command: 'account summary', sample: {} }),
  r({ id: 'account.group.get', domain: 'account', method: 'GET', path: 'customers/{customerId}/groups/{groupId}', auth: true, encoding: 'none', mutating: false, command: 'account group form', sample: { params: { ...CID, groupId: 'G1' } } }),
  r({ id: 'account.group.update', domain: 'account', method: 'PUT', path: 'customers/{customerId}/groups/{groupId}/sections/{sectionId}', auth: true, encoding: 'json', mutating: true, command: 'account group submit', sample: { params: { ...CID, groupId: 'G1', sectionId: 'S1' }, body: {} } }),
  r({ id: 'account.email.get', domain: 'account', method: 'GET', path: 'customers/account/personal/email', auth: true, encoding: 'none', mutating: false, command: 'account personal email form', sample: {} }),
  r({ id: 'account.email.set', domain: 'account', method: 'PUT', path: 'customers/account/personal/email', auth: true, encoding: 'json', mutating: true, command: 'account personal email submit', sample: { body: {} } }),
  r({ id: 'account.mobile.get', domain: 'account', method: 'GET', path: 'customers/account/personal/mobile', auth: true, encoding: 'none', mutating: false, command: 'account personal mobile form', sample: {} }),
  r({ id: 'account.mobile.set', domain: 'account', method: 'PUT', path: 'customers/account/personal/mobile', auth: true, encoding: 'json', mutating: true, command: 'account personal mobile submit', sample: { body: {} } }),
  r({ id: 'account.security', domain: 'account', method: 'GET', path: 'customers/account/security', auth: true, encoding: 'none', mutating: false, command: 'account security', sample: {} }),
  r({ id: 'account.password.get', domain: 'account', method: 'GET', path: 'customers/account/security/password', auth: true, encoding: 'none', mutating: false, command: 'account password form', sample: {} }),
  r({ id: 'account.password.set', domain: 'account', method: 'PUT', path: 'customers/account/security/password', auth: true, encoding: 'json', mutating: true, command: 'account password submit', sample: { body: {} } }),
  r({ id: 'account.2fa.get', domain: 'account', method: 'GET', path: 'customers/account/security/two-step-verification', auth: true, encoding: 'none', mutating: false, command: 'account 2fa status', sample: {} }),
  r({ id: 'account.2fa.enable', domain: 'account', method: 'PUT', path: 'customers/account/security/two-step-verification/enable', auth: true, encoding: 'json', mutating: true, command: 'account 2fa enable submit', sample: { body: {} } }),
  r({ id: 'account.2fa.disable', domain: 'account', method: 'PUT', path: 'customers/account/security/two-step-verification/disable', auth: true, encoding: 'json', mutating: true, command: 'account 2fa disable submit', sample: { body: {} } }),
  r({ id: 'account.trustedDevices', domain: 'account', method: 'GET', path: 'customers/account/security/trusted-devices', auth: true, encoding: 'none', mutating: false, command: 'account trusted-devices list', sample: {} }),
  r({ id: 'account.trustedDevices.remove', domain: 'account', method: 'DELETE', path: 'customers/account/security/trusted-devices/{deviceId}/remove', auth: true, encoding: 'none', mutating: true, command: 'account trusted-devices rm', sample: { params: { deviceId: 'D1' } } }),
  r({ id: 'account.trustedDevices.removeAll', domain: 'account', method: 'DELETE', path: 'customers/account/security/trusted-devices/remove-all', auth: true, encoding: 'none', mutating: true, command: 'account trusted-devices rm-all', sample: {} }),
  r({ id: 'account.deviceActivity', domain: 'account', method: 'GET', path: 'customers/account/security/device-login-activity', auth: true, encoding: 'none', mutating: false, command: 'account activity', sample: {} }),

  // ── 17. Reviews ────────────────────────────────────────────────────────
  r({ id: 'reviews.public', domain: 'reviews', method: 'GET', path: 'product-reviews/plid/PLID{plid}', auth: false, encoding: 'none', mutating: false, command: 'reviews', sample: { params: { plid: 52341565 } } }),
  r({ id: 'myreviews.list', domain: 'reviews', method: 'GET', path: 'customers/{customerId}/reviews', auth: true, encoding: 'none', mutating: false, command: 'myreviews list', sample: { params: CID } }),
  r({ id: 'myreviews.get', domain: 'reviews', method: 'GET', path: 'customers/{customerId}/reviews/{tsinId}', auth: true, encoding: 'none', mutating: false, command: 'myreviews show', sample: { params: { ...CID, tsinId: 'T1' } } }),
  r({ id: 'myreviews.create', domain: 'reviews', method: 'POST', path: 'customers/{customerId}/reviews/{tsinId}', auth: true, encoding: 'json', mutating: true, command: 'myreviews add submit', sample: { params: { ...CID, tsinId: 'T1' }, body: {} } }),
  r({ id: 'myreviews.update', domain: 'reviews', method: 'PUT', path: 'customers/{customerId}/reviews/{tsinId}', auth: true, encoding: 'json', mutating: true, command: 'myreviews edit submit', sample: { params: { ...CID, tsinId: 'T1' }, body: {} } }),
  r({ id: 'myreviews.delete', domain: 'reviews', method: 'DELETE', path: 'customers/{customerId}/reviews/{tsinId}', auth: true, encoding: 'none', mutating: true, command: 'myreviews rm', sample: { params: { ...CID, tsinId: 'T1' } } }),
  r({ id: 'myreviews.reviewable', domain: 'reviews', method: 'GET', path: 'customers/{customerId}/reviews/orders/items', auth: true, encoding: 'none', mutating: false, command: 'myreviews reviewable', sample: { params: CID } }),
  r({ id: 'myreviews.form', domain: 'reviews', method: 'GET', path: 'customers/{customerId}/reviews/order_item/{orderItemId}/form', auth: true, encoding: 'none', mutating: false, command: 'myreviews add form', sample: { params: { ...CID, orderItemId: 'OI1' } } }),
  r({ id: 'myreviews.vote', domain: 'reviews', method: 'POST', path: 'customers/{customerId}/reviews/{tsinId}/votes', auth: true, encoding: 'json', mutating: true, command: 'myreviews vote', sample: { params: { ...CID, tsinId: 'T1' }, body: {} } }),
  r({ id: 'myreviews.report.form', domain: 'reviews', method: 'GET', path: 'customers/{customerId}/reviews/{tsinId}/reports/form', auth: true, encoding: 'none', mutating: false, command: 'myreviews report form', sample: { params: { ...CID, tsinId: 'T1' } } }),
  r({ id: 'myreviews.report', domain: 'reviews', method: 'POST', path: 'customers/{customerId}/reviews/{tsinId}/reports', auth: true, encoding: 'json', mutating: true, command: 'myreviews report submit', sample: { params: { ...CID, tsinId: 'T1' }, body: {} } }),

  // ── 18. Promotions & Deals ─────────────────────────────────────────────
  r({ id: 'deals.ontab', domain: 'deals', method: 'GET', path: 'promotions/ontab', auth: false, encoding: 'none', mutating: false, command: 'deals', sample: {} }),

  // ── 19. Help & Chatbot ─────────────────────────────────────────────────
  r({ id: 'help.topics', domain: 'help', method: 'GET', path: 'help/topics', auth: false, encoding: 'none', mutating: false, command: 'help topics', sample: {} }),
  r({ id: 'help.topic', domain: 'help', method: 'GET', path: 'help/topic/{slug}', auth: false, encoding: 'none', mutating: false, command: 'help topic', sample: { params: { slug: 'returns' } } }),
  r({ id: 'help.context', domain: 'help', method: 'GET', path: 'help/context/{slug}', auth: false, encoding: 'none', mutating: false, command: 'help context', sample: { params: { slug: 'cart' } } }),
  r({ id: 'help.search', domain: 'help', method: 'GET', path: 'help/search', auth: false, encoding: 'none', mutating: false, command: 'help search', sample: { query: { q: 'refund' } } }),
  r({ id: 'help.search.autocomplete', domain: 'help', method: 'GET', path: 'help/search/autocomplete', auth: false, encoding: 'none', mutating: false, command: 'help search --autocomplete', sample: { query: { q: 'ref' } } }),
  r({ id: 'help.chat.get', domain: 'help', method: 'GET', path: 'help/chatbot', auth: true, encoding: 'none', mutating: false, command: 'help chat start', sample: {} }),
  r({ id: 'help.chat.send', domain: 'help', method: 'POST', path: 'help/chatbot', auth: true, encoding: 'json', mutating: true, command: 'help chat send', sample: { body: {} } }),
  r({ id: 'help.chat.end', domain: 'help', method: 'GET', path: 'help/chatbot/end', auth: true, encoding: 'none', mutating: false, command: 'help chat end', sample: {} }),
  r({ id: 'help.chat.callback.form', domain: 'help', method: 'GET', path: 'help/chatbot/request-callback', auth: true, encoding: 'none', mutating: false, command: 'help chat callback form', sample: {} }),
  r({ id: 'help.chat.callback', domain: 'help', method: 'POST', path: 'help/chatbot/request-callback', auth: true, encoding: 'json', mutating: true, command: 'help chat callback submit', sample: { body: {} } }),
  r({ id: 'help.chat.upvote', domain: 'help', method: 'POST', path: 'help/chatbot/vote/upvote', auth: true, encoding: 'json', mutating: true, command: 'help chat upvote', sample: { body: {} } }),
  r({ id: 'help.chat.downvote', domain: 'help', method: 'POST', path: 'help/chatbot/vote/downvote', auth: true, encoding: 'json', mutating: true, command: 'help chat downvote', sample: { body: {} } }),
];

/** The chatbot "send" mutates a conversational session, not shopper/account state
 *  or money — it is intentionally NOT --confirm-gated (an agent drives support
 *  turn-by-turn). Every other mutating endpoint's command must be gated. */
export const GATE_EXEMPT_MUTATIONS = new Set(['help.chat.send', 'help.chat.callback', 'help.chat.upvote', 'help.chat.downvote', 'ute.collect', 'auth.login', 'auth.refresh', 'auth.signon', 'auth.register', 'auth.register.update']);

const byId = new Map(CATALOGUE.map((e) => [e.id, e]));
export const endpoint = (id: string): EndpointRow => {
  const e = byId.get(id);
  if (!e) throw new Error(`unknown endpoint id: ${id}`);
  return e;
};
