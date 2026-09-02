/**
 * Shared types for takealot-cli.
 */

// =====================
// Auth / tokens
// =====================

/** The full token set returned by login / refresh, persisted to credentials.json. */
export interface TokenSet {
  /** Bearer JWT (the mobile API calls this `jwt`, the desktop API `access_token`). */
  jwt: string;
  /** Long-lived id token (~30 days). Sent as the `taid` cookie. */
  idToken: string;
  /** Rotating refresh token (~31 days). A new one is issued on every refresh. */
  refreshToken: string;
  /** CSRF token, sent as `x-csrf-token` header and `tal_csrf` cookie. */
  csrfToken: string;
  /** Tracking id, required by the refresh call. */
  trackingId: string;
  /** Device id, sent as `tal-did` header and `did` cookie. */
  did?: string;
  /** Numeric customer id used in most authenticated paths. */
  customerId: number;
  /** Epoch ms when the jwt should be considered expired (~1h after issue). */
  jwtExpiresAt: number;
}

/**
 * A mocked-but-stable Android device fingerprint. Generated once and reused
 * verbatim so the device stays recognisable to Takealot's trust store — a
 * shifting fingerprint risks de-trusting the device and re-triggering 2FA.
 */
export interface DeviceProfile {
  androidRelease: string;
  brand: string;
  model: string;
  appVersion: string;
  appBuild: string;
}

/**
 * The device identity persisted alongside credentials. `did` is the server-
 * assigned device id (the trust anchor) — never minted locally, only captured
 * from a login/refresh response and echoed back as `TAL-Did` + `did` cookie.
 * It lives at device scope so it survives a token clear.
 */
export interface DeviceRecord {
  did?: string;
  profile: DeviceProfile;
}

/** Stored login credentials plus the most recent token set and device identity. */
export interface Credentials {
  email: string;
  password: string;
  tokens?: TokenSet;
  device?: DeviceRecord;
}

/**
 * A persisted 2FA challenge, written by `beginLogin` so a separate headless
 * process can complete it with `completeLogin`. Bound to one account + device
 * so it can never be hijacked or replayed against another challenge.
 */
export interface PendingOtp {
  /** sha256 of the lowercased account email this challenge belongs to. */
  emailHash: string;
  /** did captured from request-1 (replayed verbatim in request-2). */
  did?: string;
  /** The Cloudflare `__cf_bm=...` cookie required by request-2. */
  cfBm: string;
  /** Where the OTP was sent (e.g. a masked phone number), if the server said. */
  otpSentTo?: string;
  /** Server-stated validity window (otp_status.valid_millis, ~300000). */
  validMs: number;
  /** Epoch ms when the challenge was created. */
  createdAt: number;
  /** Mobile API base in force when the challenge was started. */
  apiBase: string;
  /** Hash of the device profile in force (UA must match to complete). */
  uaProfileHash: string;
  /** Caller-bound nonce; completion must present it (`--challenge`). */
  nonce: string;
}

// =====================
// Config
// =====================

export interface Config {
  /** Override the search API base (default: the desktop v-1-14-0 endpoint). */
  searchApiBase?: string;
  /** Override the authenticated mobile API base (default: v-1-18-0). */
  mobileApiBase?: string;
  /** Override the User-Agent used for unauthenticated search. */
  browserUserAgent?: string;
  /** Override the User-Agent used for authenticated calls (mobile app UA). */
  mobileUserAgent?: string;
  /** Login platform string sent to /customers/login (default: android). */
  platform?: string;
  /** Brands to prefer when no exact order-history match exists. */
  preferredBrands?: string[];
  /** Saved-card reference (UUID) to use by default at checkout. */
  defaultCardReference?: string;
  /** Override any field of the mocked Android device profile. */
  deviceProfile?: Partial<DeviceProfile>;
}

/**
 * A persisted checkout-in-progress, so an ambiguous/interrupted `checkout
 * --confirm` can be reconciled instead of blindly re-charging. 0600, per-account.
 */
export interface PendingOrder {
  emailHash: string;
  /** Client-generated correlation id, written before the create POST. */
  correlationId: string;
  /** Hash of the cart at creation, to correlate a lost create response. */
  cartHash: string;
  stage: 'creating' | 'created' | 'paying';
  orderId?: string;
  talInitiationId?: string;
  createdAt: number;
}

// =====================
// Domain models
// =====================

export interface SearchProduct {
  /** PLID — the product-listing id used in links and the product-card API. */
  productId: number;
  /** Buyable/SKU id (buybox product_id) — the id add-to-cart expects. */
  skuId?: number;
  /** Canonical product-detail URL (www.takealot.com/<slug>/PLID<id>). */
  url: string;
  title: string;
  brand?: string;
  price: number;
  prettyPrice: string;
  inStock: boolean;
  delivery?: string;
  rating?: number;
  reviewCount?: number;
  saving?: string;
}

export interface SearchResult {
  products: SearchProduct[];
  total: number;
}

export interface CartItem {
  /** PLID — for links/display. */
  productId: number;
  /** Buyable/SKU id — used to add/remove the item from the cart. */
  skuId?: number;
  /** Canonical product-detail URL. */
  url: string;
  title: string;
  quantity: number;
  /** Unit selling price in Rand (already converted from cents where needed). */
  price: number;
}

export interface CartResult {
  items: CartItem[];
  /** Cart total in Rand. */
  total: number;
}

export interface AddToCartResult {
  productId: number;
  title?: string;
}

export interface OrderItem {
  orderId: string;
  orderDate: string;
  /** PLID — for links/display. */
  productId: number;
  /** Buyable/SKU id (sku.sku_id). */
  skuId?: number;
  /** Canonical product-detail URL. */
  url: string;
  title: string;
  brand?: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderSummary {
  orderId: string;
  orderDate: string;
  status?: string;
  total?: number;
  items: OrderItem[];
}

/** A single product remembered from order history, used for preference matching. */
export interface PreferenceItem {
  productId: number;
  title: string;
  brand?: string;
}

export interface SavedCard {
  reference: string;
  lastFourDigits?: string;
  bank?: string;
  cardScheme?: string;
  cardExpires?: string;
  enabled: boolean;
  isDefault?: boolean;
}

// =====================
// Checkout
// =====================

/** Delivery detail surfaced from the checkout state for the dry-run preview. */
export interface DeliveryInfo {
  address?: string;
  options?: string[];
  eta?: string;
  fee?: number;
}

export interface CheckoutPlan {
  cart: CartResult;
  cards: SavedCard[];
  selectedCard?: SavedCard;
  /** Total to be charged in Rand, if known. */
  amountDue?: number;
  delivery?: DeliveryInfo;
}

export interface CheckoutResult {
  success: boolean;
  /** Machine-readable outcome an agent branches on. */
  status?: 'placed' | 'action_required' | 'already_paid' | 'ambiguous' | 'failed';
  orderId?: string;
  talInitiationId?: string;
  /** 3DS challenge URL (preserved by the redactor) when status is action_required. */
  challengeUrl?: string;
  amountPaid?: number;
  message?: string;
}
