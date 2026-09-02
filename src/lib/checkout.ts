/**
 * Pure-API checkout (no browser).
 *
 * The full 7-step flow captured via MITM (see reference MOBILE-API.md):
 *   1. POST /checkout/{cid}/complete          (text/plain "android")  → creates order
 *   2. GET  /checkout/{cid}/order/{order_id}                          → order details
 *   3. GET  /checkout/order/{order_id}/payhost                        → amount due
 *      GET  /customers/card                                           → saved cards
 *   4. POST /order/{order_id}/payment         (form-urlencoded)       → redirect + tal_initiation_id
 *   5. Follow the PayGate redirect chain                              → frictionless 3DS (saved cards)
 *   6. POST /order/{order_id}/payment/complete (json)                 → confirmation
 *
 * A dry run does NOT touch steps 1-6: it only inspects the cart and saved cards
 * and reports the card that would be charged, so it has no side effects.
 */

import * as crypto from 'node:crypto';
import type { TakealotClient } from './api-client.js';
import { DEFAULTS } from './api-client.js';
import type { Logger } from './ui.js';
import { rand } from './ui.js';
import { clearPendingOrder, loadPendingOrder, writePendingOrder } from './config.js';
import type { CheckoutPlan, CheckoutResult, Config, DeliveryInfo, SavedCard } from '../types.js';

/** Choose which saved card to charge: explicit ref → default flag → first enabled. */
export function selectCard(cards: SavedCard[], preferredRef?: string): SavedCard | undefined {
  if (!cards.length) return undefined;
  if (preferredRef) {
    const byRef = cards.find((c) => c.reference === preferredRef);
    if (byRef) return byRef;
  }
  return (
    cards.find((c) => c.isDefault && c.enabled) ??
    cards.find((c) => c.enabled) ??
    cards[0]
  );
}

export function describeCard(card: SavedCard | undefined): string {
  if (!card) return 'no saved card';
  const scheme = card.cardScheme ?? 'card';
  const last4 = card.lastFourDigits ? `••${card.lastFourDigits}` : card.reference.slice(0, 8);
  const bank = card.bank ? ` (${card.bank})` : '';
  return `${scheme} ${last4}${bank}`;
}

/**
 * Best-effort delivery extraction from the (untyped) checkout state. Scans for
 * the selected address, delivery options, ETA, and fee under the common keys the
 * mobile API uses; whatever it can't find is simply omitted (raw state stays in
 * the --json output).
 */
export function extractDelivery(state: any): DeliveryInfo | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const d: DeliveryInfo = {};
  const addr = state.delivery_address ?? state.selected_address ?? state.address;
  if (addr) {
    d.address =
      typeof addr === 'string'
        ? addr
        : [addr.recipient, addr.address, addr.suburb, addr.city, addr.postal_code].filter(Boolean).join(', ') || undefined;
  }
  const opts = state.delivery_options ?? state.delivery_methods ?? state.shipping_options;
  if (Array.isArray(opts)) {
    d.options = opts.map((o: any) => o?.title ?? o?.name ?? o?.label).filter(Boolean);
  }
  d.eta = state.estimated_delivery ?? state.delivery_eta ?? state.estimated_dates;
  const fee = state.delivery_fee ?? state.delivery_charge ?? state.shipping_fee;
  if (fee !== undefined) d.fee = Number(fee);
  return d.address || d.options?.length || d.eta || d.fee !== undefined ? d : undefined;
}

/** Build a side-effect-free checkout plan (used for the dry run). */
export async function buildCheckoutPlan(client: TakealotClient, config: Config): Promise<CheckoutPlan> {
  const [cart, cards] = await Promise.all([client.getCart(), client.getSavedCards()]);
  const selectedCard = selectCard(cards, config.defaultCardReference);
  // Fetch the checkout state to surface the delivery address/options/ETA/fee.
  let delivery: DeliveryInfo | undefined;
  try {
    const state = await client.call('checkout.get');
    delivery = extractDelivery(state);
  } catch {
    /* delivery preview is best-effort; the dry run still shows cart + card + total */
  }
  return { cart, cards, selectedCard, amountDue: cart.total, delivery };
}

// =====================
// Live checkout steps
// =====================

interface PaymentInitResponse {
  authorized: boolean;
  action?: string;
  url?: string;
  talInitiationId?: string;
}

/** Step 1: initialize checkout and return the created order id. */
async function initCheckout(client: TakealotClient, logger: Logger): Promise<string> {
  const customerId = client.auth.customerId!;
  const data = await postJson(client, `/checkout/${customerId}/complete`, {
    headers: { 'content-type': 'text/plain' },
    body: DEFAULTS.platform,
  });
  const orderId =
    data?.order_id ?? data?.response?.order_id ?? data?.checkout_id ?? data?.id ?? data?.response?.id;
  if (!orderId) {
    throw new Error('Checkout init did not return an order id');
  }
  logger.debug(`checkout: order ${orderId} created`);
  return String(orderId);
}

/** Step 3 (payhost): amount due for the order, in Rand. */
async function getAmountDue(client: TakealotClient, orderId: string): Promise<number | undefined> {
  try {
    const data = await getJson(client, `/checkout/order/${orderId}/payhost`);
    // The API returns Rand, not cents — do not divide by 100.
    const amount = data?.amount_due ?? data?.response?.amount_due ?? data?.total;
    return amount !== undefined ? Number(amount) : undefined;
  } catch {
    return undefined;
  }
}

/** Step 4: submit a saved-card token payment. */
async function submitPayment(
  client: TakealotClient,
  orderId: string,
  cardRef: string,
  logger: Logger,
): Promise<PaymentInitResponse> {
  const form = new URLSearchParams({
    method: 'Credit Card Token',
    token_reference: cardRef,
    budget_period: 'Straight',
  });
  const data = await postJson(client, `/order/${orderId}/payment`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const response = data?.response ?? data;
  const result: PaymentInitResponse = {
    authorized: Boolean(response?.authorized),
    action: response?.action,
    url: response?.url,
    talInitiationId: response?.tal_initiation_id,
  };
  logger.debug(
    `payment: authorized=${result.authorized} action=${result.action ?? '-'} init=${result.talInitiationId ?? '-'}`,
  );
  return result;
}

/**
 * Step 5: drive the PayGate 3DS redirect chain. For tokenized saved cards this
 * is frictionless (auto-approved, no OTP), so following redirects to the
 * completion URL is enough. Returns the final URL reached.
 */
async function followPaygate(url: string, logger: Logger): Promise<string> {
  logger.debug(`paygate: following ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': DEFAULTS.mobileUserAgent, accept: 'text/html,application/json,*/*' },
  });
  // Drain the body so the connection closes cleanly.
  await res.text().catch(() => '');
  logger.debug(`paygate: settled at ${res.url} (HTTP ${res.status})`);
  return res.url;
}

/** Step 6: confirm payment completion. */
async function completePayment(
  client: TakealotClient,
  orderId: string,
  talInitiationId: string,
): Promise<boolean> {
  const redirectUrl = `https://secure.takealot.com/buy/payment/${orderId}/confirmation/success?platform=${DEFAULTS.platform}&tal_initiation_id=${talInitiationId}&status=success`;
  const data = await postJson(client, `/order/${orderId}/payment/complete`, {
    body: JSON.stringify({
      tal_initiation_id: talInitiationId,
      platform: DEFAULTS.platform,
      status: 'success',
      redirect_url: redirectUrl,
    }),
  });
  return Boolean(data?.is_success ?? data?.response?.is_success);
}

/** Hash the cart contents so a lost order-create response can be correlated. */
function hashCart(items: { skuId?: number; productId: number; quantity: number }[]): string {
  const key = items
    .map((i) => `${i.skuId ?? i.productId}x${i.quantity}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Order payment status — THREE-valued. A lookup FAILURE is `unknown`, never
 * silently `unpaid`: submitting a payment under an unknown status could double-
 * charge, so callers must only submit a first payment when this CONFIRMS `unpaid`.
 */
async function orderPaidStatus(client: TakealotClient, orderId: string): Promise<'paid' | 'unpaid' | 'unknown'> {
  try {
    const data: any = await getJson(client, `/order/${orderId}/detail`);
    const o = data?.response ?? data;
    return o?.is_authorized || o?.auth_status === 'authorized' || o?.is_paid ? 'paid' : 'unpaid';
  } catch {
    return 'unknown';
  }
}

/**
 * Run the full checkout — persists a per-account pending-order at every stage so
 * an interrupted/ambiguous run is reconciled (never re-charged). Only call after
 * the caller confirmed. `accountHash` keys the pending-order file.
 */
export async function runCheckout(
  client: TakealotClient,
  config: Config,
  logger: Logger,
  accountHash: string,
): Promise<CheckoutResult> {
  // Reconcile any interrupted prior attempt BEFORE creating a new order.
  const prior = loadPendingOrder(accountHash);
  if (prior) {
    if (prior.orderId) {
      // An order already exists — reconcile against server status and act
      // idempotently (complete an initiated payment, or make the FIRST payment
      // attempt on that order). Never creates a duplicate order.
      return reconcileOrder(client, config, logger, accountHash, prior.orderId, prior);
    }
    // stage 'creating' with no orderId — the create response was lost. Do NOT
    // re-POST. Distinguish match / unknown-lookup-failure / confident-no-match,
    // and NEVER auto-create a fresh order while the outcome is uncertain.
    const scan = await recentOrderForCart(client, prior.cartHash);
    if (scan.status === 'match') {
      // The order WAS created (create succeeded, response lost) → adopt + reconcile
      // it (pay if unpaid), never create a duplicate.
      const updated = { ...prior, orderId: scan.orderId, stage: 'created' as const };
      writePendingOrder(updated);
      return reconcileOrder(client, config, logger, accountHash, scan.orderId, updated);
    }
    if (scan.status === 'unknown') {
      // The order-history lookup itself failed — we cannot know if an order
      // exists. Keep the pending marker; do NOT create (avoids a duplicate).
      return {
        success: false,
        status: 'ambiguous',
        message:
          'Could not verify whether a prior checkout created an order (lookup failed). ' +
          'Check `takealot orders`: resume it (`takealot checkout resume <orderId>`), or if none exists run `takealot checkout reset`, then retry.',
      };
    }
    // Confident no match. Only safe to clear + proceed once past a short
    // propagation window (a just-created order may not be visible yet).
    if (Date.now() - prior.createdAt > PROPAGATION_WINDOW_MS) {
      logger.info('→ Clearing a stale checkout marker (confirmed no order was created)…');
      clearPendingOrder(accountHash);
      // fall through to a fresh checkout
    } else {
      return {
        success: false,
        status: 'ambiguous',
        message:
          'A prior checkout may still be settling — check `takealot orders` or retry shortly. ' +
          'If nothing appears, run `takealot checkout reset`.',
      };
    }
  }

  const cards = await client.getSavedCards();
  const card = selectCard(cards, config.defaultCardReference);
  if (!card) return { success: false, status: 'failed', message: 'No saved card available to complete payment.' };

  const cart = await client.getCart();
  const correlationId = crypto.randomUUID();
  const cartHash = hashCart(cart.items);
  // Persist intent BEFORE the create POST so a lost response is recoverable.
  writePendingOrder({ emailHash: accountHash, correlationId, cartHash, stage: 'creating', createdAt: Date.now() });

  logger.info('→ Initializing checkout…');
  const orderId = await initCheckout(client, logger);
  writePendingOrder({ emailHash: accountHash, correlationId, cartHash, stage: 'created', orderId, createdAt: Date.now() });

  const result = await payOrder(client, logger, accountHash, orderId, card, { correlationId, cartHash });
  return result;
}

/** Short window after a create in which a just-placed order may not be visible yet. */
const PROPAGATION_WINDOW_MS = 30_000;

/** Outcome of scanning recent orders for one that matches the pre-create cartHash. */
type ReconcileScan = { status: 'match'; orderId: string } | { status: 'none' } | { status: 'unknown' };

/**
 * Scan recent order history (several pages) for an order whose item set matches
 * the pre-create cartHash. A lookup FAILURE is reported as `unknown` (NOT
 * collapsed into `none`) so the caller never auto-creates a duplicate under
 * uncertainty. A successful scan with no match is a confident `none`.
 */
async function recentOrderForCart(client: TakealotClient, cartHash: string): Promise<ReconcileScan> {
  if (!cartHash) return { status: 'none' };
  try {
    const orders = await client.fetchOrders(5, 'all'); // more than page 1
    for (const o of orders) {
      const items = o.items.map((it) => ({ skuId: it.skuId, productId: it.productId, quantity: it.quantity }));
      if (hashCart(items) === cartHash) return { status: 'match', orderId: String(o.orderId) };
    }
    return { status: 'none' };
  } catch {
    return { status: 'unknown' };
  }
}

/** Submit + confirm payment for an already-created order, tracking pending state. */
async function payOrder(
  client: TakealotClient,
  logger: Logger,
  accountHash: string,
  orderId: string,
  card: SavedCard,
  corr: { correlationId: string; cartHash: string },
): Promise<CheckoutResult> {
  const amountDue = await getAmountDue(client, orderId);
  // Persist the payment INTENT (stage:'paying', no tal yet) BEFORE the network
  // submit. A crash between submit and the tal-persist then leaves stage:'paying'
  // with no tal, which reconcileOrder treats as "payment possibly in flight — do
  // NOT blindly re-submit", closing the double-initiation window.
  writePendingOrder({ emailHash: accountHash, ...corr, stage: 'paying', orderId, createdAt: Date.now() });
  logger.info(`→ Submitting payment with ${describeCard(card)}…`);
  const payment = await submitPayment(client, orderId, card.reference, logger);
  writePendingOrder({
    emailHash: accountHash,
    ...corr,
    stage: 'paying',
    orderId,
    talInitiationId: payment.talInitiationId,
    createdAt: Date.now(),
  });

  if (!payment.talInitiationId) {
    return { success: false, status: 'failed', orderId, message: 'Payment did not return a tal_initiation_id.' };
  }

  // Frictionless (authorized) → confirm. Otherwise attempt completion once; if it
  // is NOT confirmed, surface a structured action_required (no auto-retry, no
  // double charge) with the challenge URL, leaving the pending-order to resume.
  if (!payment.authorized && payment.action === 'redirect' && payment.url) {
    logger.info('→ Settling 3DS…');
    await followPaygate(payment.url, logger).catch(() => '');
  }
  const ok = await completePayment(client, orderId, payment.talInitiationId).catch(() => false);
  if (ok) {
    clearPendingOrder(accountHash);
    return { success: true, status: 'placed', orderId, amountPaid: amountDue, message: `Order ${orderId} placed (${rand(amountDue)}).` };
  }
  return {
    success: false,
    status: 'action_required',
    orderId,
    talInitiationId: payment.talInitiationId,
    challengeUrl: payment.url,
    amountPaid: amountDue,
    message: `3DS challenge required — open the challengeUrl, then run \`takealot checkout resume ${orderId}\`.`,
  };
}

type PendingOrder = import('../types.js').PendingOrder;

/** What a reconcile WOULD do — computed from read-only status, for gating/dry-run. */
type ReconcileDecision =
  | { kind: 'already_paid' }
  | { kind: 'complete'; tal: string }
  | { kind: 'in_flight' } // payment possibly initiated (stage:'paying', tal unknown) — never re-submit
  | { kind: 'first_payment' };

/** Decide the reconcile action for an order using only READ status (no writes). */
async function decideReconcile(
  client: TakealotClient,
  orderId: string,
  pending: PendingOrder | null,
): Promise<ReconcileDecision> {
  const status = await orderPaidStatus(client, orderId);
  if (status === 'paid') return { kind: 'already_paid' };
  const forThis = pending && pending.orderId === orderId ? pending : null;
  // Completing an already-initiated payment is safe even if the paid-status
  // lookup is inconclusive (it finalises, it does not charge anew).
  if (forThis?.talInitiationId) return { kind: 'complete', tal: forThis.talInitiationId };
  // A pending marked 'paying' with no tal means submitPayment was (or may have
  // been) called — never re-submit; reconcile by status only.
  if (forThis?.stage === 'paying') return { kind: 'in_flight' };
  // Only submit a FIRST payment when status CONFIRMS the order is unpaid. If the
  // status lookup failed (`unknown`), do NOT submit — a payment may exist.
  if (status === 'unknown') return { kind: 'in_flight' };
  return { kind: 'first_payment' };
}

function describeDecision(d: ReconcileDecision, orderId: string): string {
  switch (d.kind) {
    case 'already_paid':
      return `report order ${orderId} as already paid (no payment sent)`;
    case 'complete':
      return `COMPLETE the already-initiated payment for order ${orderId} (no new payment initiated)`;
    case 'in_flight':
      return `NOT re-submit — a payment may already be in flight for order ${orderId}; reconcile by status only`;
    case 'first_payment':
      return `submit the FIRST payment for order ${orderId} with your saved card`;
  }
}

/**
 * Reconcile-then-act for an EXISTING order (shared by `checkout --confirm`'s prior
 * branch and `checkout resume`). Idempotent, NEVER creates a second order, and
 * NEVER re-initiates an already-initiated payment. With `dryRun` it performs only
 * the read-only status check and reports what it WOULD do.
 */
async function reconcileOrder(
  client: TakealotClient,
  config: Config,
  logger: Logger,
  accountHash: string,
  orderId: string,
  pending: PendingOrder | null,
  opts: { dryRun?: boolean } = {},
): Promise<CheckoutResult> {
  const decision = await decideReconcile(client, orderId, pending);

  if (opts.dryRun) {
    return { success: false, status: 'action_required', orderId, message: `DRY RUN — would ${describeDecision(decision, orderId)}. Re-run with --confirm.` };
  }

  switch (decision.kind) {
    case 'already_paid':
      clearPendingOrder(accountHash);
      return { success: true, status: 'already_paid', orderId, message: `Order ${orderId} is already paid.` };
    case 'complete': {
      logger.info('→ Confirming the already-initiated payment…');
      const ok = await completePayment(client, orderId, decision.tal).catch(() => false);
      if (ok) {
        clearPendingOrder(accountHash);
        return { success: true, status: 'placed', orderId, message: `Order ${orderId} placed.` };
      }
      return {
        success: false,
        status: 'action_required',
        orderId,
        talInitiationId: decision.tal,
        message: `Payment still not confirmed for ${orderId}. Complete the 3DS challenge and retry \`checkout resume ${orderId}\`.`,
      };
    }
    case 'in_flight':
      // Do NOT re-submit — the payment may already be in flight. Reconcile by
      // status: it isn't paid yet (checked above), so surface for the user.
      return {
        success: false,
        status: 'action_required',
        orderId,
        message:
          `A payment may already be in flight for order ${orderId} — not re-submitting. ` +
          `Complete any pending 3DS, check \`takealot orders\`, or if it never completed run \`takealot checkout reset\`.`,
      };
    case 'first_payment': {
      const cards = await client.getSavedCards();
      const card = selectCard(cards, config.defaultCardReference);
      if (!card) return { success: false, status: 'failed', orderId, message: 'No saved card available to complete payment.' };
      return payOrder(client, logger, accountHash, orderId, card, {
        correlationId: pending?.correlationId ?? crypto.randomUUID(),
        cartHash: pending?.cartHash ?? '',
      });
    }
  }
}

/**
 * Resume a checkout for `orderId`. Delegates to the same reconcile-then-act logic
 * as `checkout --confirm`. With `dryRun` it only inspects status and reports the
 * plan (used by the ungated `checkout resume` preview); the write path runs only
 * under `--confirm`.
 */
export async function resumeCheckout(
  client: TakealotClient,
  config: Config,
  logger: Logger,
  accountHash: string,
  orderId: string,
  opts: { dryRun?: boolean } = {},
): Promise<CheckoutResult> {
  const pending = loadPendingOrder(accountHash);
  return reconcileOrder(client, config, logger, accountHash, orderId, pending ?? null, opts);
}

// =====================
// Small JSON helpers over the client's authed transport
// =====================

async function getJson(client: TakealotClient, path: string): Promise<any> {
  return parse(await client.authedFetch(path), path);
}

async function postJson(client: TakealotClient, path: string, init: RequestInit): Promise<any> {
  return parse(await client.authedFetch(path, { method: 'POST', ...init }), path);
}

async function parse(res: Response, path: string): Promise<any> {
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${data?.message ?? res.statusText} (${path})`);
  }
  return data;
}
