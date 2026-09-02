/**
 * TakealotClient — pure-API client (no browser automation).
 *
 * Two transports, both MITM-verified:
 *   - Unauthenticated SEARCH uses the desktop search endpoint + a browser UA,
 *     which returns rich product results without requiring authentication.
 *   - Everything authenticated (cart, orders, cards, checkout) uses the mobile
 *     API and User-Agent for authenticated calls; 2FA flow requires __cf_bm cookie.
 *
 * Money note: authenticated endpoints return amounts in cents; this client
 * converts them to Rand. Search prices are passed through as the raw API value
 * and surfaced for display via `prettyPrice`.
 */

import type { AuthManager } from './auth.js';
import { findPreferredProduct, type PreferenceMatch } from './preferences.js';
import { endpoint, type Base, type EndpointRow, type Encoding, type HttpMethod } from './catalogue.js';
import { redact, redactText, safeUrlPath } from './redact.js';
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

/** Structured API error — its `body` is redacted; commands surface it as {error}. */
export class ApiError extends Error {
  constructor(
    readonly info: {
      status: number;
      code: string;
      message: string;
      path: string;
      body?: unknown;
      retryAfter?: number;
    },
  ) {
    super(info.message);
    this.name = 'ApiError';
  }
  toJSON() {
    return { error: { ...this.info } };
  }
}

/**
 * Hosts an absolute (`@Url`) request may target. This is a **compile-time
 * constant**, never user-configurable — a runtime-overridable allowlist would
 * let a poisoned `addresses/config` response (or config) self-authorize an
 * arbitrary host, defeating the SSRF containment.
 */
const ABSOLUTE_ALLOWLIST = ['takealot.com'] as const;

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function hostAllowed(urlStr: string, allow: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return allow.some((a) => host === a || host.endsWith('.' + a));
}

export interface ApiRequestOpts {
  base?: Base;
  auth?: boolean;
  encoding?: Encoding;
  query?: Record<string, unknown>;
  /** Request body: shaped by `encoding` (json/form/text/delete-body). */
  body?: unknown;
  timeoutMs?: number;
  /** Bounded retry allowed (GET only). */
  idempotent?: boolean;
}

// Defaults (overridable via config).
export const DEFAULTS = {
  // Search stays on v-1-14-0: it works and its response parser is coupled to that
  // shape. The authenticated mobile API tracks the current app (v-1-18-0).
  searchApiBase: 'https://api.takealot.com/rest/v-1-14-0',
  mobileApiBase: 'https://api.takealot.com/rest/v-1-18-0',
  browserUserAgent:
    'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  // Fallback only — the client is normally handed a UA built from the device profile.
  mobileUserAgent: 'TAL-Android/4.2.2 (fi.android.takealot; build:800750; 14; samsung; SM-S928B; Phone)',
  platform: 'android',
} as const;

const ORIGIN = 'https://www.takealot.com';

/**
 * Canonical Takealot product-detail URL. The web + app both resolve
 * `www.takealot.com/<slug>/PLID<id>` (the app registers exactly this as its
 * PLID deep link); a slug-less `/PLID<id>` also redirects, so we fall back to
 * that when the API omits a slug (e.g. cart / order items).
 */
export function productUrl(productId: number, slug?: string): string {
  return slug ? `${ORIGIN}/${slug}/PLID${productId}` : `${ORIGIN}/PLID${productId}`;
}

export interface ClientLogger {
  debug(msg: string): void;
}

export interface ClientOptions {
  auth: AuthManager;
  logger: ClientLogger;
  searchApiBase?: string;
  mobileApiBase?: string;
  browserUserAgent?: string;
  /** Mobile UA for authenticated calls (built from the device profile). */
  mobileUserAgent?: string;
  /** Order-history products for preference matching. */
  history?: PreferenceItem[];
  /** Explicit preferred brands for preference matching. */
  preferredBrands?: string[];
}

/**
 * Coerce an API money value to a Rand number. The Takealot mobile API already
 * returns Rand (e.g. unit_price 102 == R102, cart total 833 == R833) — it does
 * NOT use cents — so this is a plain numeric coercion. The old implementation
 * divided by 100, rendering every price 100× too small (R102 → "R1.02").
 */
function toRand(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n;
}

/** Extract the numeric id from a "PLID12345" string (or undefined). */
function plidToId(plid: unknown): number | undefined {
  const m = String(plid ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Derive a human status from an order. The orders API has no `status` field;
 * it exposes booleans (is_fully_cancelled, is_awaiting_payment, is_authorized)
 * instead, so the old `order.status ?? order.order_status` was always undefined.
 */
function orderStatus(order: any): string | undefined {
  if (order?.is_fully_cancelled) return 'Cancelled';
  if (order?.is_awaiting_payment) return 'Awaiting payment';
  if (order?.is_authorized || order?.auth_status === 'authorized') return 'Paid';
  return undefined;
}

export class TakealotClient {
  readonly auth: AuthManager;
  private logger: ClientLogger;
  private searchApiBase: string;
  private mobileApiBase: string;
  private browserUA: string;
  private mobileUA: string;
  private history: PreferenceItem[];
  private preferredBrands: string[];

  constructor(opts: ClientOptions) {
    this.auth = opts.auth;
    this.logger = opts.logger;
    this.searchApiBase = opts.searchApiBase ?? DEFAULTS.searchApiBase;
    this.mobileApiBase = opts.mobileApiBase ?? DEFAULTS.mobileApiBase;
    this.browserUA = opts.browserUserAgent ?? DEFAULTS.browserUserAgent;
    this.mobileUA = opts.mobileUserAgent ?? DEFAULTS.mobileUserAgent;
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
    const genBefore = this.auth.currentAuthGeneration;
    let res = await this.rawAuthedFetch(path, init);
    if (res.status === 401) {
      if (this.auth.currentAuthGeneration === genBefore) {
        this.logger.debug('authedFetch: 401, re-authenticating and retrying once');
        await this.auth.reauthenticateIfCurrent(genBefore);
      } else {
        this.logger.debug('authedFetch: 401 but auth already rotated, retrying');
      }
      res = await this.rawAuthedFetch(path, init);
    }
    return res;
  }

  private async rawAuthedFetch(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith('http') ? path : this.mobileApiBase + path;
    const headers: Record<string, string> = {
      accept: 'application/json, */*',
      'content-type': 'application/json',
      'user-agent': this.mobileUA,
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

  /**
   * Ensure a usable session, then return the customer id. `ensureValid()`
   * bootstraps a fresh login from stored credentials + the trusted device when
   * no tokens are held yet (e.g. after a full token wipe), so an authed command
   * self-heals instead of throwing "Not authenticated" before it can log in.
   */
  private async ensureCustomerId(): Promise<number> {
    await this.auth.ensureValid();
    return this.requireCustomerId();
  }

  // =====================
  // Generic request core — every catalogue endpoint routes through here.
  // =====================

  private baseUrl(base: Base): string {
    if (base === 'search') return this.searchApiBase;
    return this.mobileApiBase;
  }

  /** Build the query string, supporting repeated keys (array values). */
  private buildQuery(query?: Record<string, unknown>): string {
    if (!query) return '';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v) p.append(k, String(item));
      else p.append(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  /** Encode the body + content-type for the request. */
  private encodeBody(encoding: Encoding, body: unknown): { body?: string; contentType?: string } {
    switch (encoding) {
      case 'json':
      case 'delete-body':
        return { body: JSON.stringify(body ?? {}), contentType: 'application/json' };
      case 'form': {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) {
          if (v !== undefined && v !== null) p.append(k, String(v));
        }
        return { body: p.toString(), contentType: 'application/x-www-form-urlencoded' };
      }
      case 'text':
        return { body: String(body ?? ''), contentType: 'text/plain' };
      case 'none':
      default:
        return {};
    }
  }

  /** Parse a response by content-type; 204/empty → null; non-2xx → ApiError. */
  private async parseResponse(res: Response, path: string): Promise<unknown> {
    if (res.status === 204) return res.ok ? null : this.throwApi(res, null, path);
    const text = await res.text().catch(() => '');
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    let data: unknown = null;
    if (text) {
      if (ctype.includes('application/json') || (!ctype && text.trim().startsWith('{'))) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      } else {
        data = text;
      }
    }
    if (!res.ok) return this.throwApi(res, data, path);
    return data;
  }

  private throwApi(res: Response, body: unknown, path: string): never {
    const anyBody = body as any;
    const message =
      (anyBody && (anyBody.message ?? anyBody.error?.message ?? anyBody.error)) || res.statusText || `HTTP ${res.status}`;
    const rateLimited = res.status === 429 || anyBody?.otp_status?.status === 'cooldown';
    const retryAfterHdr = Number(res.headers.get('retry-after'));
    throw new ApiError({
      status: res.status,
      code: rateLimited ? 'rate_limited' : `http_${res.status}`,
      message: redactText(String(message)),
      path: safeUrlPath(path),
      body: redact(body),
      retryAfter: Number.isFinite(retryAfterHdr) ? retryAfterHdr : anyBody?.otp_status?.cooldown_seconds,
    });
  }

  /** Public (unauthenticated) fetch: device UA/headers, no bearer. */
  private async publicFetch(url: string, init: RequestInit, base: Base): Promise<Response> {
    const ua = base === 'search' ? this.browserUA : this.mobileUA;
    const headers: Record<string, string> = {
      accept: 'application/json, */*',
      'user-agent': ua,
      ...this.auth.deviceHeaders(),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    this.logger.debug(`${init.method ?? 'GET'} ${url}`);
    return fetch(url, { ...init, headers });
  }

  /** Contained absolute-URL fetch (address validation): static allowlist, HTTPS,
   *  no auth/device headers, manual redirect re-validated per hop. */
  private async absoluteFetch(url: string, init: RequestInit): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      if (!hostAllowed(current, ABSOLUTE_ALLOWLIST)) {
        // Drop the query/fragment before reporting — a blocked URL may carry
        // tokens we must not leak into the error message/path.
        const safe = safeUrlPath(current);
        throw new ApiError({
          status: 0,
          code: 'blocked_url',
          message: `refusing absolute URL (host not on the static allowlist): ${safe}`,
          path: safe,
        });
      }
      const res = await fetch(current, {
        ...init,
        redirect: 'manual',
        headers: {
          accept: 'application/json, */*',
          'user-agent': this.mobileUA,
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return res;
        current = new URL(loc, current).toString();
        continue; // re-validate the next hop at the top of the loop
      }
      return res;
    }
    throw new ApiError({ status: 0, code: 'too_many_redirects', message: 'too many redirects', path: safeUrlPath(url) });
  }

  /**
   * The one request primitive all endpoints use. Resolves body encoding,
   * content-type-driven parsing, timeouts, bounded GET retry, and error shaping.
   * Authed paths inherit 401-refresh + rotation from `authedFetch`.
   */
  async apiRequest(method: HttpMethod, pathOrUrl: string, opts: ApiRequestOpts = {}): Promise<unknown> {
    const base: Base = opts.base ?? 'mobile';
    const encoding: Encoding = opts.encoding ?? 'none';
    const { body, contentType } = this.encodeBody(encoding, opts.body);
    const headers: Record<string, string> = {};
    if (contentType) headers['content-type'] = contentType;

    const url =
      base === 'absolute'
        ? pathOrUrl + this.buildQuery(opts.query)
        : this.baseUrl(base) + '/' + pathOrUrl.replace(/^\//, '') + this.buildQuery(opts.query);

    const timeoutMs = opts.timeoutMs ?? 20_000;
    const maxAttempts = opts.idempotent && method === 'GET' ? 3 : 1;

    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = body;
      try {
        let res: Response;
        if (base === 'absolute') res = await this.absoluteFetch(url, init);
        else if (opts.auth) res = await this.authedFetch(url, init);
        else res = await this.publicFetch(url, init, base);
        if (res.status >= 500 && attempt < maxAttempts) {
          await sleep(150 * attempt);
          continue;
        }
        return await this.parseResponse(res, url);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        const aborted = (e as any)?.name === 'AbortError';
        if (!aborted && attempt < maxAttempts) {
          await sleep(150 * attempt);
          continue;
        }
        throw new ApiError({
          status: 0,
          code: aborted ? 'timeout' : 'network',
          message: aborted ? `request timed out after ${timeoutMs}ms` : redactText(String((e as Error)?.message ?? e)),
          path: safeUrlPath(url),
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Invoke a catalogue endpoint by id. Substitutes `{customerId}` from auth and
   * other `{param}`s from `params`, wires the body per the row's encoding, and
   * returns the raw parsed response (commands redact before display).
   */
  private resolvePath(row: EndpointRow, params: Record<string, string | number>): string {
    if (row.base === 'absolute') return String(params.absoluteUrl ?? '');
    return row.path.replace(/\{(\w+)\}/g, (_m, name: string) => {
      if (name in params) return encodeURIComponent(String(params[name]));
      if (name === 'customerId') return String(this.requireCustomerId());
      throw new Error(`missing path param {${name}} for ${row.id}`);
    });
  }

  async call(
    id: string,
    args: { params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<unknown> {
    const row = endpoint(id);
    if (row.excluded) throw new Error(`endpoint ${id} is excluded: ${row.reason}`);
    // Bootstrap a session first so an authed endpoint whose path needs
    // {customerId} self-heals from a full token wipe (login via trusted device).
    if (row.auth) await this.auth.ensureValid();
    const path = this.resolvePath(row, args.params ?? {});
    return this.apiRequest(row.method, path, {
      base: row.base,
      auth: row.auth,
      encoding: row.encoding,
      query: args.query,
      body: args.body,
      idempotent: row.method === 'GET',
    });
  }

  /** Resolve (without executing) the request a `call` would send — for dry-run preview. */
  describeCall(
    id: string,
    args: { params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown } = {},
  ): { method: HttpMethod; url: string; body?: unknown } {
    const row = endpoint(id);
    const path = this.resolvePath(row, args.params ?? {});
    const url =
      row.base === 'absolute'
        ? path + this.buildQuery(args.query)
        : this.baseUrl(row.base) + '/' + path.replace(/^\//, '') + this.buildQuery(args.query);
    return { method: row.method, url, body: redact(args.body) };
  }

  /** Read the catalogue row for a command (used for gating + docs). */
  endpointRow(id: string): EndpointRow {
    return endpoint(id);
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
    // Real total lives in paging.total_num_found; the old `.total` path never
    // existed, so every search reported "0 results".
    const total: number =
      data?.sections?.products?.paging?.total_num_found ?? results.length;

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

    // core.id is the PLID (the product-listing id used in links + product-card
    // API); buybox_summary.product_id is the buyable/SKU id used for add-to-cart.
    // They are DIFFERENT numbers — /PLID{bb.product_id} 404s, /PLID{core.id} 200s.
    const productId: number | null = core?.id ?? bb?.product_id ?? null;
    if (!productId) return null;
    const skuId: number | undefined = bb?.product_id ?? core?.id ?? undefined;

    return {
      productId,
      skuId,
      url: productUrl(productId, core?.slug),
      title: core?.title || pv?.title || '',
      brand: core?.brand || undefined,
      price: Array.isArray(bb?.prices) && bb.prices.length ? bb.prices[0] : 0,
      prettyPrice: bb?.pretty_price || '',
      inStock: this.isInStock(bb, pv),
      delivery:
        pv?.stock_availability_summary?.estimated_delivery?.estimated_dates ||
        pv?.stock_availability_summary?.delivery_date ||
        '',
      rating: core?.star_rating || 0,
      reviewCount: core?.reviews ?? pv?.review_summary?.review_count ?? 0,
      // Already a formatted string like "23%" — do not append another %.
      saving: bb?.saving || undefined,
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
    const customerId = await this.ensureCustomerId();
    const data = await this.authedJson(`/customers/${customerId}/cart`);
    // The cart response carries two parallel arrays keyed by product_id:
    //   products[]   → title, plid (the PLID), selling_price (unit, in Rand)
    //   cart_items[] → quantity, sub_total (line total), allocations[].unit_price
    // Neither alone is enough, so join them on product_id.
    const products: any[] = data?.products ?? [];
    const cartItems: any[] = data?.cart_items ?? data?.cart?.items ?? [];
    const qtyById = new Map<number, any>();
    for (const ci of cartItems) qtyById.set(ci.product_id ?? ci.id, ci);

    const items: CartItem[] = products.map((p) => {
      const skuId = p.product_id ?? p.id;
      const ci = qtyById.get(skuId) ?? {};
      const plid = plidToId(p.plid);
      return {
        productId: plid ?? skuId, // PLID for display/link; sku id as fallback
        skuId, // buyable id — used for cart add/remove
        url: productUrl(plid ?? skuId, p.slug),
        title: p.title ?? '',
        quantity: ci.quantity ?? 1,
        price: toRand(p.selling_price ?? p.web_selling_price ?? p.price),
      };
    });
    // Prefer the server-computed cart total; fall back to summing line totals.
    const total =
      toRand(data?.cart_summary?.total?.value ?? data?.total ?? data?.sub_total) ||
      cartItems.reduce((sum, ci) => sum + toRand(ci.sub_total), 0) ||
      items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    return { items, total };
  }

  async addToCart(productId: number, quantity = 1): Promise<AddToCartResult> {
    const customerId = await this.ensureCustomerId();
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

    // Add-to-cart expects the buyable/SKU id, not the PLID.
    const res = await this.addToCart(match.product.skuId ?? match.product.productId, quantity);
    return { ...res, title: res.title ?? match.product.title, match };
  }

  /** Add an exact buyable SKU id to the cart (no search / preference pick). */
  async addSkuToCart(skuId: number, quantity = 1): Promise<AddToCartResult> {
    return this.addToCart(skuId, quantity);
  }

  /** Resolve a PLID to its buyable SKU id via product-details. */
  async skuForPlid(plid: number): Promise<number> {
    const data: any = await this.call('product.details', {
      params: { plid },
      query: { platform: DEFAULTS.platform, offer_opt: true },
    });
    const pv = data?.product_views ?? data?.product ?? data ?? {};
    const sku = pv?.buybox_summary?.product_id ?? data?.buybox_summary?.product_id;
    if (!sku) throw new Error(`could not resolve a buyable SKU for PLID${plid}`);
    return Number(sku);
  }

  /** Update a cart line's quantity (PUT /cart/items). */
  async setCartItemQuantity(skuId: number, quantity: number): Promise<unknown> {
    const customerId = await this.ensureCustomerId();
    return this.apiRequest('PUT', `/customers/${customerId}/cart/items`, {
      auth: true,
      encoding: 'json',
      body: { products: [{ id: skuId, quantity }] },
    });
  }

  /** Remove one cart line by its buyable SKU id (DELETE with body). */
  async removeCartItem(skuId: number): Promise<unknown> {
    const customerId = await this.ensureCustomerId();
    return this.apiRequest('DELETE', `/customers/${customerId}/cart/items`, {
      auth: true,
      encoding: 'delete-body',
      body: { products: [{ id: skuId }] },
    });
  }

  async clearCart(): Promise<{ removed: number }> {
    const customerId = await this.ensureCustomerId();
    const cart = await this.getCart();
    if (!cart.items.length) return { removed: 0 };

    // Takealot expects a DELETE on /cart/items with a JSON body listing ids.
    const res = await this.authedFetch(`/customers/${customerId}/cart/items`, {
      method: 'DELETE',
      body: JSON.stringify({ products: cart.items.map((i) => ({ id: i.skuId ?? i.productId })) }),
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
    const customerId = await this.ensureCustomerId();
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
            // The PLID lives in sku.plid ("PLID91974312"); product_id / sku_id
            // is the buyable SKU id (404s as a PLID).
            const skuId = item.product_id ?? item?.sku?.sku_id ?? 0;
            const plid = plidToId(item?.sku?.plid) ?? skuId;
            items.push({
              orderId: order.order_id,
              orderDate: order.order_date,
              productId: plid,
              skuId,
              url: productUrl(plid, item.slug ?? item?.sku?.slug),
              title: item.title ?? item?.sku?.title ?? '',
              brand: item.brand || undefined,
              quantity: item.quantity || 1,
              unitPrice: toRand(item.unit_price),
            });
          }
        }
        summaries.push({
          orderId: order.order_id,
          orderDate: order.order_date,
          status: orderStatus(order),
          total: order.total_amount !== undefined ? toRand(order.total_amount) : undefined,
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