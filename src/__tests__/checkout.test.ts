import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { PaymentBlockedError, UsageError } from '../lib/errors.js';
import { authFailure } from '../lib/auth.js';
import { ApiError } from '../lib/api-client.js';

let tmp: string;
let previous: Record<string, string | undefined>;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  previous = {
    xdg: process.env.XDG_CONFIG_HOME,
    email: process.env.TAKEALOT_EMAIL,
    password: process.env.TAKEALOT_PASSWORD,
  };
  previousExitCode = process.exitCode;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takealot-checkout-'));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.TAKEALOT_EMAIL = 'shopper@example.com';
  process.env.TAKEALOT_PASSWORD = 'pw';
  process.exitCode = undefined;
});

afterEach(() => {
  process.env.XDG_CONFIG_HOME = previous.xdg;
  process.env.TAKEALOT_EMAIL = previous.email;
  process.env.TAKEALOT_PASSWORD = previous.password;
  process.exitCode = previousExitCode;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function response(body: unknown = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    url: 'https://api.takealot.com/test',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

async function seededContext(json = true) {
  const config = await import('../lib/config.js');
  config.saveCredentials({
    email: 'shopper@example.com',
    password: 'pw',
    tokens: {
      jwt: 'jwt',
      idToken: 'id',
      refreshToken: 'refresh',
      csrfToken: 'csrf',
      trackingId: 'tracking',
      customerId: 12345,
      jwtExpiresAt: Date.now() + 3_600_000,
    },
    device: { profile: (await import('../lib/device.js')).resolveDeviceProfile({}), did: 'did' },
  });
  const { Context } = await import('../lib/context.js');
  return new Context({ json, verbose: false });
}

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('checkout preview', () => {
  it('maps checkout state to the stable read-only DTO', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        products: [{ product_id: 10, title: 'Milk', selling_price: 42.5 }],
        cart_items: [{ product_id: 10, quantity: 2 }],
        summary: {
          subtotal: { price: { amount: 85, currency: 'ZAR' } },
          discount: { price: { amount: 5 } },
          shipping_discount: { price: { amount: 10 } },
          customer_credits: { price: { amount: 2 } },
          total: { price: { amount: 70, currency: 'ZAR' } },
          amount_due: { price: { amount: 68, currency: 'ZAR' } },
        },
        shipping_method: 'delivery',
        data_sections: [
          { section_id: 'courier_address', is_complete: false },
          { section_id: 'shipping_method', is_complete: true },
        ],
      }),
    ) as any;
    const ctx = await seededContext();
    const { checkoutCommand } = await import('../commands/checkout.js');
    const output = captureStdout();
    await checkoutCommand(ctx, { confirm: false });
    const result = JSON.parse(output.text());
    output.restore();
    expect(result).toEqual({
      items: [{ title: 'Milk', quantity: 2, price: 42.5 }],
      subtotal: 85,
      discount: 5,
      shippingDiscount: 10,
      credits: 2,
      total: 70,
      amountDue: 68,
      shippingMethod: 'delivery',
      currency: 'ZAR',
      sectionsIncomplete: ['courier_address'],
      payInApp: true,
    });
  });

  it('uses null for missing or malformed money and prints n/a', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        products: [{ product_id: 10, title: 'Milk' }],
        cart_items: [{ product_id: 10, quantity: 1 }],
        summary: {
          subtotal: { price: {} },
          discount: { price: { amount: 'invalid' } },
          total: null,
          amount_due: {},
        },
      }),
    ) as any;
    const ctx = await seededContext();
    const { checkoutCommand } = await import('../commands/checkout.js');
    const jsonOutput = captureStdout();
    await checkoutCommand(ctx, { confirm: false });
    expect(JSON.parse(jsonOutput.text())).toMatchObject({
      items: [{ price: null }],
      subtotal: null,
      discount: null,
      shippingDiscount: null,
      credits: null,
      total: null,
      amountDue: null,
    });
    jsonOutput.restore();

    const humanCtx = await seededContext(false);
    const humanOutput = captureStdout();
    await checkoutCommand(humanCtx, { confirm: false });
    expect(humanOutput.text()).toContain('n/a');
    humanOutput.restore();
  });

  it('refuses --confirm before authentication or network access', async () => {
    globalThis.fetch = vi.fn() as any;
    const ctx = await seededContext();
    const { checkoutCommand } = await import('../commands/checkout.js');
    await expect(checkoutCommand(ctx, { confirm: true })).rejects.toThrow('orders are placed in the Takealot app');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('emits a clear empty-cart message', async () => {
    globalThis.fetch = vi.fn(async () => response({ products: [], cart_items: [], summary: {} })) as any;
    const ctx = await seededContext(false);
    const { checkoutCommand } = await import('../commands/checkout.js');
    const output = captureStdout();
    await checkoutCommand(ctx, { confirm: false });
    expect(output.text()).toContain('Cart is empty');
    output.restore();
  });
});

describe('account-security gate', () => {
  it('requires --i-know for every security write', async () => {
    const { CATALOGUE } = await import('../lib/catalogue.js');
    const { SECURITY_WRITES, mutateEndpoint } = await import('../commands/generic.js');
    const ctx = await seededContext();
    for (const id of SECURITY_WRITES) {
      const row = CATALOGUE.find((candidate) => candidate.id === id)!;
      const fetchMock = vi.fn(async () => response({}));
      globalThis.fetch = fetchMock as any;
      await expect(
        mutateEndpoint(ctx, id, { params: row.sample?.params, body: row.sample?.body ?? {} }, { confirm: true, yes: true }),
      ).rejects.toThrow(UsageError);
      expect(fetchMock).not.toHaveBeenCalled();
      const output = captureStdout();
      await mutateEndpoint(
        ctx,
        id,
        { params: row.sample?.params, body: row.sample?.body ?? {} },
        { confirm: true, yes: true, iKnow: true },
      );
      output.restore();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe('saved cards', () => {
  it('emits only the exact safe DTO keys even with --unsafe-raw', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        saved_cards: [
          {
            reference: 'secret-reference',
            customer_id: 12345,
            cardholder: 'Secret Name',
            bank: 'Bank',
            card_scheme: 'Visa',
            last_four_digits: '4242',
            card_expires: '12/30',
            is_default: true,
            enabled: true,
          },
        ],
      }),
    ) as any;
    const ctx = await seededContext();
    const { cardsCommand } = await import('../commands/cards.js');
    const output = captureStdout();
    await cardsCommand(ctx);
    const cards = JSON.parse(output.text());
    output.restore();
    expect(Object.keys(cards[0])).toEqual(['bank', 'scheme', 'last4', 'expires', 'selected', 'enabled']);
    expect(JSON.stringify(cards)).not.toMatch(/secret-reference|Secret Name|customer_id/);
  });

  it.each([
    { savedCards: [] },
    { savedCards: [{ reference: 'a', last_four_digits: '4242' }, { reference: 'b', last_four_digits: '4242' }] },
  ])('refuses zero or ambiguous --last4 matches without sending the removal', async ({ savedCards }) => {
    const fetchMock = vi.fn(async () => response({ saved_cards: savedCards }));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext();
    const { cardsRemove } = await import('../commands/cards.js');
    await expect(cardsRemove(ctx, '4242', { confirm: true, yes: true })).rejects.toThrow(UsageError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('usage inputs', () => {
  it('wraps missing, unreadable, and invalid JSON files as UsageError', async () => {
    const { readBodyFromFlags } = await import('../commands/generic.js');
    expect(() => readBodyFromFlags({}, true)).toThrow(UsageError);
    expect(() => readBodyFromFlags({ file: path.join(tmp, 'missing.json') })).toThrow(UsageError);
    const invalid = path.join(tmp, 'invalid.json');
    fs.writeFileSync(invalid, '{invalid');
    expect(() => readBodyFromFlags({ file: invalid })).toThrow(UsageError);
  });
});

describe('run exit contract', () => {
  it.each([
    ['usage', new UsageError('bad input'), 4],
    ['blocked', new PaymentBlockedError(), 4],
    ['auth', authFailure('login failed'), 3],
    ['http 401', new ApiError({ status: 401, code: 'http_401', message: 'expired', path: '/x' }), 3],
    ['runtime', new Error('boom'), 1],
  ])('maps %s errors to exit %i', async (_name, error, expected) => {
    const { run } = await import('../cli.js');
    const command = new Command().option('--json');
    command.setOptionValue('json', true);
    const output = captureStdout();
    await run(command, async () => {
      throw error;
    });
    const envelope = JSON.parse(output.text());
    output.restore();
    expect(process.exitCode).toBe(expected);
    expect(envelope).toMatchObject({ error: (error as Error).message });
  });
});
