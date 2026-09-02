import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let prev: Record<string, string | undefined> = {};

beforeEach(() => {
  prev = { xdg: process.env.XDG_CONFIG_HOME, e: process.env.TAKEALOT_EMAIL, p: process.env.TAKEALOT_PASSWORD };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-co-'));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.TAKEALOT_EMAIL = 'shopper@example.com';
  process.env.TAKEALOT_PASSWORD = 'pw';
});
afterEach(() => {
  process.env.XDG_CONFIG_HOME = prev.xdg;
  process.env.TAKEALOT_EMAIL = prev.e;
  process.env.TAKEALOT_PASSWORD = prev.p;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    url: 'u',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

/** Route the mocked fetch by URL substring → response body (or a fn(url,init)). */
function router(routes: Array<[RegExp, unknown | ((url: string, init: RequestInit) => unknown)]>) {
  return vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    for (const [re, body] of routes) {
      if (re.test(u)) {
        const b = typeof body === 'function' ? (body as any)(u, init) : body;
        return jsonRes(b, (b && (b as any).__status) || 200);
      }
    }
    return jsonRes({}, 200);
  });
}

async function seededContext() {
  vi.resetModules();
  const cfg = await import('../lib/config.js');
  cfg.saveCredentials({
    email: 'shopper@example.com',
    password: 'pw',
    tokens: { jwt: 'j', idToken: 'i', refreshToken: 'r', csrfToken: 'c', trackingId: 't', customerId: 12345, jwtExpiresAt: Date.now() + 3_600_000 },
    device: { profile: (await import('../lib/device.js')).resolveDeviceProfile({}), did: 'DID' },
  } as any);
  const { Context } = await import('../lib/context.js');
  return new Context({ json: true, verbose: false });
}

function grabJson(): { get: () => any; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => {
    chunks.push(String(s));
    return true;
  });
  return {
    get: () => {
      const txt = chunks.join('');
      const start = txt.indexOf('{');
      return JSON.parse(txt.slice(start));
    },
    restore: () => spy.mockRestore(),
  };
}

describe('checkout dry-run surfaces delivery', () => {
  it('shows the delivery address/options/eta/fee from the checkout state', async () => {
    globalThis.fetch = router([
      [/\/customers\/12345\/cart$/, { products: [{ product_id: 1, title: 'X', selling_price: 100, plid: 'PLID9' }], cart_items: [{ product_id: 1, quantity: 1 }], cart_summary: { total: { value: 100 } } }],
      [/\/customers\/card$/, { saved_cards: [{ reference: 'ref', last_four_digits: '4242', enabled: true, is_default: true }] }],
      [/\/checkout\/12345$/, { delivery_address: { recipient: 'Yash', address: '1 Main', city: 'CPT' }, delivery_options: [{ title: 'Standard' }], estimated_delivery: 'Tomorrow', delivery_fee: 60 }],
    ]) as any;
    const ctx = await seededContext();
    const { checkoutCommand } = await import('../commands/checkout.js');
    const g = grabJson();
    await checkoutCommand(ctx, { confirm: false, yes: false });
    const out = g.get();
    g.restore();
    expect(out.dryRun).toBe(true);
    expect(out.delivery.address).toContain('1 Main');
    expect(out.delivery.options).toContain('Standard');
    expect(out.delivery.fee).toBe(60);
  });
});

describe('checkout payment idempotency + recovery', () => {
  it('non-confirmed completion returns action_required, persists pending-order, and does not double-create', async () => {
    let completeCalls = 0;
    let createCalls = 0;
    globalThis.fetch = router([
      [/\/customers\/card$/, { saved_cards: [{ reference: 'ref', enabled: true, is_default: true }] }],
      [/\/customers\/12345\/cart$/, { products: [{ product_id: 1, title: 'X', selling_price: 100 }], cart_items: [{ product_id: 1, quantity: 1 }] }],
      [/\/checkout\/12345\/complete$/, () => { createCalls++; return { order_id: 'O99' }; }],
      [/\/checkout\/order\/O99\/payhost$/, { amount_due: 100 }],
      [/\/order\/O99\/payment$/, { response: { authorized: false, action: 'redirect', url: 'https://pay.takealot.com/i/1?PAY_REQUEST_ID=abc', tal_initiation_id: 'INIT9' } }],
      [/\/order\/O99\/payment\/complete$/, () => { completeCalls++; return { is_success: false }; }],
      [/pay\.takealot\.com/, {}],
    ]) as any;
    const ctx = await seededContext();
    const { runCheckout } = await import('../lib/checkout.js');
    const cfg = await import('../lib/config.js');
    const acct = ctx.accountHash();

    const res = await runCheckout(ctx.client, ctx.config, ctx.logger, acct);
    expect(res.status).toBe('action_required');
    expect(res.orderId).toBe('O99');
    expect(res.challengeUrl).toContain('PAY_REQUEST_ID=abc');
    expect(createCalls).toBe(1);
    // Pending-order persisted so a rerun can reconcile instead of re-charging.
    const pending = cfg.loadPendingOrder(acct);
    expect(pending?.orderId).toBe('O99');
    expect(pending?.talInitiationId).toBe('INIT9');
  });

  it('resume completes the initiated payment without creating a new order', async () => {
    let createCalls = 0;
    // Seed a pending order at the paying stage.
    const ctx0 = await seededContext();
    const cfg = await import('../lib/config.js');
    const acct = ctx0.accountHash();
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c1', cartHash: 'h1', stage: 'paying', orderId: 'O99', talInitiationId: 'INIT9', createdAt: Date.now() });

    globalThis.fetch = router([
      [/\/order\/O99\/detail$/, { response: { is_authorized: false } }],
      [/\/checkout\/12345\/complete$/, () => { createCalls++; return { order_id: 'NEW' }; }],
      [/\/order\/O99\/payment\/complete$/, { is_success: true }],
    ]) as any;
    const ctx = await seededContext();
    const { resumeCheckout } = await import('../lib/checkout.js');
    const res = await resumeCheckout(ctx.client, ctx.config, ctx.logger, acct, 'O99');
    expect(res.status).toBe('placed');
    expect(createCalls).toBe(0); // never re-created the order
    expect(cfg.loadPendingOrder(acct)).toBeNull(); // cleared on success
  });

  it('resume of an order with no prior payment makes the FIRST payment on THAT order (no new order)', async () => {
    const ctx0 = await seededContext();
    const cfg = await import('../lib/config.js');
    const acct = ctx0.accountHash();
    // Order created, awaiting payment, but payment was never initiated (no tal).
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c1', cartHash: 'h1', stage: 'created', orderId: 'O77', createdAt: Date.now() });

    let paymentCalls = 0;
    let createCalls = 0;
    globalThis.fetch = router([
      [/\/order\/O77\/detail$/, { response: { is_authorized: false } }],
      [/\/customers\/card$/, { saved_cards: [{ reference: 'ref', enabled: true, is_default: true }] }],
      [/\/checkout\/order\/O77\/payhost$/, { amount_due: 100 }],
      [/\/order\/O77\/payment$/, () => { paymentCalls++; return { response: { authorized: true, tal_initiation_id: 'INITX' } }; }],
      [/\/order\/O77\/payment\/complete$/, { is_success: true }],
      [/\/checkout\/12345\/complete$/, () => { createCalls++; return { order_id: 'NEW' }; }],
    ]) as any;
    const ctx = await seededContext();
    const { resumeCheckout } = await import('../lib/checkout.js');
    const res = await resumeCheckout(ctx.client, ctx.config, ctx.logger, acct, 'O77');
    expect(res.status).toBe('placed'); // first payment succeeded, no dead-end
    expect(paymentCalls).toBe(1); // initiated payment on the EXISTING order
    expect(createCalls).toBe(0); // never created a second order
  });

  it('(i) create succeeded but visible only on a LATER page → adopts it, no duplicate order', async () => {
    const cfg = await import('../lib/config.js');
    const crypto = await import('node:crypto');
    const emptyHash = crypto.createHash('sha256').update('').digest('hex').slice(0, 16); // hashCart([])
    const ctx0 = await seededContext();
    const acct = ctx0.accountHash();
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c', cartHash: emptyHash, stage: 'creating', createdAt: Date.now() });

    let createCalls = 0;
    let payCalls = 0;
    globalThis.fetch = router([
      [/orders\?.*page_number=0/, { response: { orders: [{ order_id: 'OTHER', order_date: 't', consignments: [{ order_items: [{ product_id: 5, quantity: 1, sku: { plid: 'PLID5' } }] }] }] } }],
      [/orders\?.*page_number=1/, { response: { orders: [{ order_id: 'OMATCH', order_date: 't', consignments: [] }] } }],
      [/orders\?.*page_number=[2-9]/, { response: { orders: [] } }],
      [/\/order\/OMATCH\/detail$/, { response: { is_authorized: false } }],
      [/\/customers\/card$/, { saved_cards: [{ reference: 'ref', enabled: true, is_default: true }] }],
      [/\/checkout\/order\/OMATCH\/payhost$/, { amount_due: 10 }],
      [/\/order\/OMATCH\/payment$/, () => { payCalls++; return { response: { authorized: true, tal_initiation_id: 'I' } }; }],
      [/\/order\/OMATCH\/payment\/complete$/, { is_success: true }],
      [/\/checkout\/12345\/complete$/, () => { createCalls++; return { order_id: 'DUP' }; }],
    ]) as any;
    const ctx = await seededContext();
    const { runCheckout } = await import('../lib/checkout.js');
    const res = await runCheckout(ctx.client, ctx.config, ctx.logger, acct);
    expect(createCalls).toBe(0); // adopted the existing order — no duplicate
    expect(payCalls).toBe(1); // paid the existing order
    expect(res.orderId).toBe('OMATCH');
    expect(res.status).toBe('placed');
  });

  it('(ii) reconcile lookup FAILURE → ambiguous, pending kept, never creates', async () => {
    const cfg = await import('../lib/config.js');
    const ctx0 = await seededContext();
    const acct = ctx0.accountHash();
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c', cartHash: 'h', stage: 'creating', createdAt: Date.now() });
    let createCalls = 0;
    globalThis.fetch = router([
      [/orders/, { __status: 500, message: 'server error' }],
      [/\/checkout\/12345\/complete$/, () => { createCalls++; return { order_id: 'NEW' }; }],
    ]) as any;
    const ctx = await seededContext();
    const { runCheckout } = await import('../lib/checkout.js');
    const res = await runCheckout(ctx.client, ctx.config, ctx.logger, acct);
    expect(res.status).toBe('ambiguous');
    expect(createCalls).toBe(0); // uncertain → never auto-created
    expect(cfg.loadPendingOrder(acct)).not.toBeNull(); // pending kept
  });

  it('(iii) confident no-match + STALE pending → clears and proceeds with a fresh checkout', async () => {
    const cfg = await import('../lib/config.js');
    const ctx0 = await seededContext();
    const acct = ctx0.accountHash();
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c', cartHash: 'nomatch', stage: 'creating', createdAt: Date.now() - 120_000 });
    let createCalls = 0;
    globalThis.fetch = router([
      [/orders/, { response: { orders: [] } }],
      [/\/customers\/card$/, { saved_cards: [{ reference: 'ref', enabled: true, is_default: true }] }],
      [/\/customers\/12345\/cart$/, { products: [{ product_id: 1, title: 'X', selling_price: 10 }], cart_items: [{ product_id: 1, quantity: 1 }] }],
      [/\/checkout\/12345\/complete$/, () => { createCalls++; return { order_id: 'FRESH' }; }],
      [/\/checkout\/order\/FRESH\/payhost$/, { amount_due: 10 }],
      [/\/order\/FRESH\/payment$/, { response: { authorized: true, tal_initiation_id: 'I' } }],
      [/\/order\/FRESH\/payment\/complete$/, { is_success: true }],
    ]) as any;
    const ctx = await seededContext();
    const { runCheckout } = await import('../lib/checkout.js');
    const res = await runCheckout(ctx.client, ctx.config, ctx.logger, acct);
    expect(createCalls).toBe(1); // stale + confident-none → fresh checkout
    expect(res.orderId).toBe('FRESH');
  });

  it('(iv) confident no-match + FRESH pending → ambiguous (may still be settling), no create', async () => {
    const cfg = await import('../lib/config.js');
    const ctx0 = await seededContext();
    const acct = ctx0.accountHash();
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c', cartHash: 'nomatch', stage: 'creating', createdAt: Date.now() });
    let createCalls = 0;
    globalThis.fetch = router([
      [/orders/, { response: { orders: [] } }],
      [/\/checkout\/12345\/complete$/, () => { createCalls++; return { order_id: 'NEW' }; }],
    ]) as any;
    const ctx = await seededContext();
    const { runCheckout } = await import('../lib/checkout.js');
    const res = await runCheckout(ctx.client, ctx.config, ctx.logger, acct);
    expect(res.status).toBe('ambiguous');
    expect(createCalls).toBe(0); // within propagation window → do not create yet
    expect(cfg.loadPendingOrder(acct)).not.toBeNull();
  });
});

describe('checkout resume gating + payment-intent crash window', () => {
  it('(#4) a pending at stage:paying with NO tal does NOT auto-resubmit — reconciles by status', async () => {
    const cfg = await import('../lib/config.js');
    const ctx0 = await seededContext();
    const acct = ctx0.accountHash();
    // Crash after pre-persisting 'paying' intent but before the tal was recorded.
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c', cartHash: 'h', stage: 'paying', orderId: 'O88', createdAt: Date.now() });

    let paymentCalls = 0;
    let completeCalls = 0;
    globalThis.fetch = router([
      [/\/order\/O88\/detail$/, { response: { is_authorized: false } }],
      [/\/order\/O88\/payment$/, () => { paymentCalls++; return { response: { tal_initiation_id: 'X' } }; }],
      [/\/order\/O88\/payment\/complete$/, () => { completeCalls++; return { is_success: true }; }],
    ]) as any;
    const ctx = await seededContext();
    const { resumeCheckout } = await import('../lib/checkout.js');
    const res = await resumeCheckout(ctx.client, ctx.config, ctx.logger, acct, 'O88');
    expect(res.status).toBe('action_required');
    expect(paymentCalls).toBe(0); // never re-submitted a possibly-in-flight payment
    expect(completeCalls).toBe(0);
  });

  it('(#1) `checkout resume` is gated — dry-run pays nothing; --confirm performs the payment', async () => {
    const cfg = await import('../lib/config.js');
    const ctx0 = await seededContext();
    const acct = ctx0.accountHash();
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c', cartHash: 'h', stage: 'created', orderId: 'O99', createdAt: Date.now() });

    let payCalls = 0;
    const routes: any = [
      [/\/order\/O99\/detail$/, { response: { is_authorized: false } }],
      [/\/customers\/card$/, { saved_cards: [{ reference: 'ref', enabled: true, is_default: true }] }],
      [/\/checkout\/order\/O99\/payhost$/, { amount_due: 10 }],
      [/\/order\/O99\/payment$/, () => { payCalls++; return { response: { authorized: true, tal_initiation_id: 'I' } }; }],
      [/\/order\/O99\/payment\/complete$/, { is_success: true }],
    ];
    const { checkoutResume } = await import('../commands/checkout.js');

    // dry-run (no --confirm): read-only preview, NO payment
    globalThis.fetch = router(routes) as any;
    let ctx = await seededContext();
    let g = grabJson();
    await checkoutResume(ctx, 'O99', { confirm: false });
    const out = g.get();
    g.restore();
    expect(payCalls).toBe(0);
    expect(out.dryRun).toBe(true);

    // --confirm: performs the first payment
    payCalls = 0;
    globalThis.fetch = router(routes) as any;
    ctx = await seededContext();
    g = grabJson();
    await checkoutResume(ctx, 'O99', { confirm: true, yes: true });
    g.restore();
    expect(payCalls).toBe(1);
  });
});

describe('checkout reconcile — never pays under unknown status', () => {
  it('(#1) a FAILING order-status lookup → action_required, never submits a payment', async () => {
    const cfg = await import('../lib/config.js');
    const ctx0 = await seededContext();
    const acct = ctx0.accountHash();
    // A created order, no tal — would normally be a first_payment, but the status
    // lookup FAILS, so we must not submit under uncertainty.
    cfg.writePendingOrder({ emailHash: acct, correlationId: 'c', cartHash: 'h', stage: 'created', orderId: 'OU', createdAt: Date.now() });
    let paymentCalls = 0;
    globalThis.fetch = router([
      [/\/order\/OU\/detail$/, { __status: 500, message: 'status lookup failed' }],
      [/\/customers\/card$/, { saved_cards: [{ reference: 'ref', enabled: true, is_default: true }] }],
      [/\/order\/OU\/payment$/, () => { paymentCalls++; return { response: { authorized: true, tal_initiation_id: 'I' } }; }],
    ]) as any;
    const ctx = await seededContext();
    const { resumeCheckout } = await import('../lib/checkout.js');
    const res = await resumeCheckout(ctx.client, ctx.config, ctx.logger, acct, 'OU');
    expect(res.status).toBe('action_required');
    expect(paymentCalls).toBe(0); // no submit while paid-status is unknown
  });
});
