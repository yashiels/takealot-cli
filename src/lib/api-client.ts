/**
 * TakealotClient — pure-API client (no browser automation).
 *
 * Two transports, both MITM-verified:
 *   - Unauthenticated SEARCH uses the desktop search endpoint + a browser UA,
 *     which returns rich product results and isn't blocked by Cloudflare.
 *   - Everything authenticated (cart, orders, cards, checkout) uses the mobile
 *     app endpoint + the TAL-Android UA + Bearer/csrf/cookies, which bypasses
 *     the anti-bot that blocks the desktop API on transactional routes.
 *
 * Money note: authenticated endpoints return amounts in cents; this client
 * converts them to Rand. Search prices are passed through as the raw API value
 * and surfaced for display via `prettyPrice`.
 */

import type { AuthManager } from './auth.js';
import { findPreferredProduct, type PreferenceMatch } from './preferences.js';
import type {
  AddToCartResult,
  CartItem,
  CartResult,
  OrderItem,
  OrderSummary,
  PreferenceItem,
  SavedCard,
  SearchProduct,
  SearchResult,
} from '../types.js';

// Defaults (overridable via config).
export const DEFAULTS = {
  searchApiBase: 'https://api.takealot.com/rest/v-1-14-0',
  mobileApiBase: 'https://api.takealot.com/rest/v-1-16-0',
  browserUserAgent:
    'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  mobileUserAgent: 'TAL-Android/3.51.0 (fi.android.takealot; build:800735; 14; samsung; SM-S928B; Phone)',
  platform: 'android',
} as const;

const ORIGIN = 'https://www.takealot.com';

export interface ClientLogger {
  debug(msg: string): void;
}

export interface ClientOptions {
  auth: AuthManager;
  logger: ClientLogger;
  searchApiBase?: string;
  mobileApiBase?: string;
  browserUserAgent?: string;
  /** Order-history products for preference matching. */
  history?: PreferenceItem[];
  /** Explicit preferred brands for preference matching. */
  preferredBrands?: string[];
}

/** Convert an API money value (cents) to Rand. Returns 0 for missing values. */
function centsToRand(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

export class TakealotClient {
  readonly auth: AuthManager;
  private logger: ClientLogger;
  private searchApiBase: string;
  private mobileApiBase: string;
  private browserUA: string;
  private history: PreferenceItem[];
  private preferredBrands: string[];

  constructor(opts: ClientOptions) {
    this.auth = opts.auth;
    this.logger = opts.logger;
    this.searchApiBase = opts.searchApiBase ?? DEFAULTS.searchApiBase;
    this.mobileApiBase = opts.mobileApiBase ?? DEFAULTS.mobileApiBase;
    this.browserUA = opts.browserUserAgent ?? DEFAULTS.browserUserAgent;
    this.history = opts.history ?? [];
    this.preferredBrands = opts.preferredBrands ?? [];
  }

  get mobileBase(): string {
    return this.mobileApiBase;
  }

  // =====================
  // Authenticated transport
  // =====================

  /**
   * Authenticated fetch against the mobile API. Ensures a valid jwt first,
   * sets the mobile UA + auth headers, and retries once on a 401 after
   * re-authenticating. `path` may be absolute or relative to the mobile base.
   */
  async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    await this.auth.ensureValid();
    let res = await this.rawAuthedFetch(path, init);
    if (res.status === 401) {
      this.logger.debug('authedFetch: 401, re-authenticating and retrying once');
      await this.auth.reauthenticate();
      res = await this.rawAuthedFetch(path, init);
    }
    return res;
  }

  private async rawAuthedFetch(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith('http') ? path : this.mobileApiBase + path;
    const headers: Record<string, string> = {
      accept: 'application/json, */*',
      'content-type': 'application/json',
      'user-agent': DEFAULTS.mobileUserAgent,
      ...this.auth.authHeaders(),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    this.logger.debug(`${init.method ?? 'GET'} ${url}`);
    return fetch(url, { ...init, headers });
  }

  /** authedFetch + JSON parse, throwing a useful error on non-2xx. */
  private async authedJson<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.authedFetch(path, init);
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.message ?? data?.error ?? res.statusText;
      throw new Error(`HTTP ${res.status} ${msg} (${path})`);
    }
    return data as T;
  }

  private requireCustomerId(): number {
    const id = this.auth.customerId;
    if (id === null) throw new Error('Not authenticated. Run `takealot login` first.');
    return id;
  }

  // =====================
  // SEARCH (unauthenticated)
  // =====================

  async search(query: string, limit = 10): Promise<SearchResult> {
    const params = new URLSearchParams({
      r: '1',
      sb: '1',
      si: '63b04484becf69dd89948104f99effc7',
      qsearch: query,
      searchbox: 'true',
    });
    const customerId = this.auth.customerId;
    if (customerId !== null) params.set('customer_id', String(customerId));
    if (this.auth.trackingId) params.set('client_id', this.auth.trackingId);

    const url = `${this.searchApiBase}/searches/products,filters,facets,sort_options,breadcrumbs,slots_audience,context,seo,layout?${params.toString()}`;

    this.logger.debug(`GET ${url}`);
    const res = await fetch(url, {
      headers: {
        accept: 'application/json, */*',
        'content-type': 'application/json',
        origin: ORIGIN,
        referer: ORIGIN + '/',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'user-agent': this.browserUA,
        ...this.auth.authHeaders(),
      },
    });

    if (!res.ok) {
      throw new Error(`Search failed (HTTP ${res.status} ${res.statusText})`);
    }
    const data: any = await res.json();
    const results: any[] = data?.sections?.products?.results ?? [];
    const total: number = data?.sections?.products?.total ?? 0;

    const products = results
      .slice(0, limit)
      .map((r) => this.mapSearchResult(r))
      .filter((p): p is SearchProduct => p !== null);

    return { products, total };
  }

  private mapSearchResult(r: any): SearchProduct | null {
    const pv = r?.product_views ?? r?.product ?? r?.data?.product ?? {};
    const bb = pv?.buybox_summary ?? {};
    const core = pv?.core ?? {};

    const productId: number | null = bb?.product_id ?? core?.id ?? null;
    if (!productId) return null;

    return {
      productId,
      title: core?.title || pv?.title || '',
      brand: core?.brand || undefined,
      price: Array.isArray(bb?.prices) && bb.prices.length ? bb.prices[0] : 0,
      prettyPrice: bb?.pretty_price || '',
      inStock: this.isInStock(bb, pv),
      delivery:
        pv?.stock_availability_summary?.delivery_date ||
        pv?.stock_availability_summary?.estimated_delivery?.estimated_dates ||
        '',
      rating: core?.star_rating || 0,
      reviewCount: core?.review_count || 0,
      saving: bb?.discount_percentage ? `${bb.discount_percentage}%` : undefined,
    };
  }

  // Takealot mixes formats: "in_stock" / "In stock" / lead-time strings.
  // Prefer stock_availability_summary.status; fall back to buybox status.
  private isInStock(bb: any, pv: any): boolean {
    const s1 = String(bb?.stock_availability_status || '').toLowerCase();
    const s2 = String(pv?.stock_availability_summary?.status || '').toLowerCase();
    const ok = (s: string): boolean => {
      if (!s) return false;
      if (s.includes('out of stock') || s.includes('unavailable')) return false;
      if (s.includes('in_stock') || s.includes('in stock')) return true;
      if (s.startsWith('ships in')) return true;
      return false;
    };
    return ok(s2) || ok(s1);
  }

  /** Find the best result for a query using order history + preferred brands. */
  pickPreferred(products: SearchProduct[]): PreferenceMatch | null {
    return findPreferredProduct(products, this.history, this.preferredBrands);
  }

  // =====================
  // CART
  // =====================

  async getCart(): Promise<CartResult> {
    const customerId = this.requireCustomerId();
    const data = await this.authedJson(`/customers/${customerId}/cart`);
    const raw: any[] = data?.products ?? data?.cart_items ?? data?.cart?.items ?? [];
    const items: CartItem[] = raw.map((p) => ({
      productId: p.product_id ?? p.id,
      title: p.title ?? '',
      quantity: p.quantity ?? 1,
      price: centsToRand(p.selling_price ?? p.price ?? p.unit_price),
    }));
    const total =
      data?.total_amount !== undefined
        ? centsToRand(data.total_amount)
        : items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    return { items, total };
  }

  async addToCart(productId: number, quantity = 1): Promise<AddToCartResult> {
    const customerId = this.requireCustomerId();
    const data = await this.authedJson(`/customers/${customerId}/cart/items`, {
      method: 'POST',
      body: JSON.stringify({ products: [{ id: productId, quantity }] }),
    });
    const added = (data?.products ?? []).find((p: any) => p.product_id === productId);
    return { productId, title: added?.title };
  }

  /** Search for a query and add the preference-matched result to the cart. */
  async searchAndAdd(
    query: string,
    quantity = 1,
  ): Promise<AddToCartResult & { match: PreferenceMatch }> {
    // Pull a deeper result set so preferred brands that don't rank #1 are seen.
    const { products } = await this.search(query, 30);
    if (!products.length) throw new Error(`No results found for "${query}"`);

    const match = this.pickPreferred(products);
    if (!match) throw new Error(`No valid product found for "${query}"`);

    const res = await this.addToCart(match.product.productId, quantity);
    return { ...res, title: res.title ?? match.product.title, match };
  }

  async clearCart(): Promise<{ removed: number }> {
    const customerId = this.requireCustomerId();
    const cart = await this.getCart();
    if (!cart.items.length) return { removed: 0 };

    // Takealot expects a DELETE on /cart/items with a JSON body listing ids.
    const res = await this.authedFetch(`/customers/${customerId}/cart/items`, {
      method: 'DELETE',
      body: JSON.stringify({ products: cart.items.map((i) => ({ id: i.productId })) }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Clear cart failed (HTTP ${res.status} ${txt})`);
    }
    return { removed: cart.items.length };
  }

  // =====================
  // ORDERS
  // =====================

  async fetchOrders(pages = 50, period = 'all'): Promise<OrderSummary[]> {
    const customerId = this.requireCustomerId();
    const summaries: OrderSummary[] = [];

    for (let page = 0; page < pages; page++) {
      const data = await this.authedJson(
        `/customer/${customerId}/orders?period=${encodeURIComponent(period)}&page_number=${page}`,
      );
      const orders: any[] = data?.response?.orders ?? data?.orders ?? [];
      if (!orders.length) break;

      for (const order of orders) {
        const items: OrderItem[] = [];
        for (const c of order.consignments ?? []) {
          for (const item of c.order_items ?? []) {
            items.push({
              orderId: order.order_id,
              orderDate: order.order_date,
              productId: item.product_id ?? item?.sku?.sku_id ?? 0,
              title: item.title ?? item?.sku?.title ?? '',
              brand: item.brand || undefined,
              quantity: item.quantity || 1,
              unitPrice: centsToRand(item.unit_price),
            });
          }
        }
        summaries.push({
          orderId: order.order_id,
          orderDate: order.order_date,
          status: order.status ?? order.order_status,
          total: order.total_amount !== undefined ? centsToRand(order.total_amount) : undefined,
          items,
        });
      }
      this.logger.debug(`orders page ${page}: ${orders.length} orders (${summaries.length} total)`);
    }
    return summaries;
  }

  async getOrder(orderId: string, pages = 50): Promise<OrderSummary | null> {
    const orders = await this.fetchOrders(pages, 'all');
    return orders.find((o) => String(o.orderId) === String(orderId)) ?? null;
  }

  /** Flatten order history into unique preference items. */
  toPreferenceItems(orders: OrderSummary[]): PreferenceItem[] {
    const seen = new Set<number>();
    const items: PreferenceItem[] = [];
    for (const o of orders) {
      for (const it of o.items) {
        if (it.productId && !seen.has(it.productId)) {
          seen.add(it.productId);
          items.push({ productId: it.productId, title: it.title, brand: it.brand });
        }
      }
    }
    return items;
  }

  // =====================
  // SAVED CARDS
  // =====================

  async getSavedCards(): Promise<SavedCard[]> {
    const data = await this.authedJson(`/customers/card`);
    const raw: any[] = data?.saved_cards ?? data?.cards ?? [];
    return raw.map((card) => ({
      reference: card.reference,
      lastFourDigits: card.last_four_digits,
      bank: card.bank,
      cardScheme: card.card_scheme,
      cardExpires: card.card_expires,
      enabled: card.enabled !== false,
      isDefault: card.is_default ?? card.default ?? false,
    }));
  }
}
