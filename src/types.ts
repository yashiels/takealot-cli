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

/** Stored login credentials plus the most recent token set. */
export interface Credentials {
  email: string;
  password: string;
  tokens?: TokenSet;
}

// =====================
// Config
// =====================

export interface Config {
  /** Override the search API base (default: the desktop v-1-14-0 endpoint). */
  searchApiBase?: string;
  /** Override the authenticated mobile API base (default: v-1-16-0). */
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
}

// =====================
// Domain models
// =====================

export interface SearchProduct {
  productId: number;
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
  productId: number;
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
  productId: number;
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

export interface CheckoutPlan {
  cart: CartResult;
  cards: SavedCard[];
  selectedCard?: SavedCard;
  /** Total to be charged in Rand, if known. */
  amountDue?: number;
}

export interface CheckoutResult {
  success: boolean;
  orderId?: string;
  amountPaid?: number;
  message?: string;
}
