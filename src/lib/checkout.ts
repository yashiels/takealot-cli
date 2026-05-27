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

import type { TakealotClient } from './api-client.js';
import { DEFAULTS } from './api-client.js';
import type { Logger } from './ui.js';
import { rand } from './ui.js';
import type { CheckoutPlan, CheckoutResult, Config, SavedCard } from '../types.js';

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

/** Build a side-effect-free checkout plan (used for the dry run). */
export async function buildCheckoutPlan(client: TakealotClient, config: Config): Promise<CheckoutPlan> {
  const [cart, cards] = await Promise.all([client.getCart(), client.getSavedCards()]);
  const selectedCard = selectCard(cards, config.defaultCardReference);
  return { cart, cards, selectedCard, amountDue: cart.total };
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
    const cents = data?.amount_due ?? data?.response?.amount_due ?? data?.total;
    return cents !== undefined ? Number(cents) / 100 : undefined;
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

/** Run the full checkout. Only call this when the user has confirmed. */
export async function runCheckout(
  client: TakealotClient,
  config: Config,
  logger: Logger,
): Promise<CheckoutResult> {
  const cards = await client.getSavedCards();
  const card = selectCard(cards, config.defaultCardReference);
  if (!card) {
    return { success: false, message: 'No saved card available to complete payment.' };
  }

  logger.info('→ Initializing checkout…');
  const orderId = await initCheckout(client, logger);

  // Step 2: order details (fetched for completeness / validation).
  await getJson(client, `/checkout/${client.auth.customerId}/order/${orderId}`).catch(() => ({}));

  const amountDue = await getAmountDue(client, orderId);

  logger.info(`→ Submitting payment with ${describeCard(card)}…`);
  const payment = await submitPayment(client, orderId, card.reference, logger);

  if (!payment.authorized && payment.action === 'redirect' && payment.url) {
    logger.info('→ Completing 3DS (frictionless)…');
    await followPaygate(payment.url, logger);
  }

  if (!payment.talInitiationId) {
    return {
      success: false,
      orderId,
      message: 'Payment did not return a tal_initiation_id; cannot confirm completion.',
    };
  }

  logger.info('→ Confirming payment…');
  const ok = await completePayment(client, orderId, payment.talInitiationId);

  return {
    success: ok,
    orderId,
    amountPaid: amountDue,
    message: ok ? `Order ${orderId} placed (${rand(amountDue)}).` : 'Payment completion was not confirmed.',
  };
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
