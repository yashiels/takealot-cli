import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../lib/context.js';
import { Logger } from '../lib/ui.js';
import { UsageError } from '../lib/errors.js';
import { parseProductDetails } from '../lib/api-client.js';
import { infoCommand } from '../commands/info.js';
import { cartAdd } from '../commands/cart.js';
import { wishlistAdd } from '../commands/wishlist.js';
import { reviewsCommand } from '../commands/reviews.js';
import { recommendCommand, recommendLayout } from '../commands/recommend.js';
import { registerCatalogue } from '../commands/register.js';
import { fetchForm, readEndpoint } from '../commands/generic.js';
import { mkClient } from './mkclient.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', '4.3.0');
const fixture = (name: string): any =>
  JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
const productSingle = fixture('product-single.json');
const productMulti = fixture('product-multi.json');
const reviews = fixture('reviews.json');
const recoLayout = fixture('reco-layout.json');
const recoHome = fixture('reco-home.json');
const orders = fixture('orders.json');

function context(client: ReturnType<typeof mkClient>['client'], json = false): Context {
  return {
    client,
    logger: new Logger({ json, verbose: false }),
    ensureCredentials: async () => ({}),
  } as Context;
}

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((value: any) => {
    chunks.push(String(value));
    return true;
  });
  return { output: () => chunks.join(''), restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe('reviews against app 4.3.0', () => {
  it('uses the numeric PLID path with page and sort and renders review snippets', async () => {
    const { client, calls } = mkClient({ body: reviews });
    const stdout = captureStdout();
    await reviewsCommand(context(client), 90255552, { page: 1, sort: 'SO_LATEST' });
    const output = stdout.output();
    stdout.restore();
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toMatch(/\/product-reviews\/plid\/90255552$/);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('sort')).toBe('SO_LATEST');
    expect(output).toContain('2161 reviews');
    expect(output).toContain('★ 5');
    expect(output).toContain('Perfect cable');
  });
});

describe('recommendations against app 4.3.0', () => {
  it('builds the layout query and prints model keys with display titles', async () => {
    const { client, calls } = mkClient({ body: recoLayout });
    const stdout = captureStdout();
    await recommendLayout(context(client), 'home-page');
    const output = stdout.output();
    stdout.restore();
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toMatch(/\/recommendations\/home-page\/layout$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      platform: 'android',
      number_of_slots: '5',
      has_customer_id: 'true',
    });
    expect(output).toContain('rfy  Recommended For You');
    expect(output).toContain('trending_by_department_29  Trending In Beauty');
  });

  it('builds a product query with customer id and renders title, price, and PLID', async () => {
    const { client, calls } = mkClient({ body: recoHome });
    const stdout = captureStdout();
    await recommendCommand(context(client), 'home-page', { model: 'trending', limit: 2 });
    const output = stdout.output();
    stdout.restore();
    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      platform: 'android',
      model: 'trending',
      limit: '2',
      display_type: 'product',
      customer_id: '12345',
    });
    expect(output).toContain('Hisense 20L 700W Digital Microwave Oven');
    expect(output).toContain('R 949');
    expect(output).toContain('PLID98632941');
    expect(output).not.toContain('Samsung 65');
  });

  it('requires a model and points at the layout command', async () => {
    const { client, fetchMock } = mkClient({ body: recoHome });
    await expect(recommendCommand(context(client), 'home-page', { limit: 3 })).rejects.toThrow(
      /recommend layout/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds pdp layout context from the numeric PLID', async () => {
    const { client, calls } = mkClient({ body: recoLayout });
    await recommendLayout(context(client), 'pdp', { plid: 52580339 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toMatch(/\/recommendations\/pdp\/layout$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      platform: 'android',
      number_of_slots: '5',
      has_customer_id: 'true',
      context: 'PLID:52580339',
    });
  });

  it('builds pdp product context from the numeric PLID', async () => {
    const { client, calls } = mkClient({ body: recoHome });
    await recommendCommand(context(client), 'pdp', { model: 'ymal', limit: 3, plid: 52580339 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toMatch(/\/recommendations\/pdp$/);
    expect(url.searchParams.get('context')).toBe('PLID:52580339');
  });

  it('requires pdp context and rejects unknown locations before any request', async () => {
    const { client, fetchMock } = mkClient({ body: recoHome });
    await expect(
      recommendCommand(context(client), 'pdp', { model: 'x', limit: 3 }),
    ).rejects.toThrow('--plid is required for pdp recommendations');
    await expect(recommendLayout(context(client), 'pdp')).rejects.toThrow(
      '--plid is required for pdp recommendations',
    );
    await expect(
      recommendCommand(context(client), 'other', { model: 'x', limit: 3 }),
    ).rejects.toThrow(/valid values: home-page, pdp, add-to-cart, landing-page, domain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('wishlist add compatibility', () => {
  it('accepts the legacy group target with --file and --confirm', async () => {
    const { client, calls } = mkClient({ body: {} });
    const ctx = context(client, true);
    const dir = mkdtempSync(path.join(tmpdir(), 'takealot-positional-'));
    const file = path.join(dir, 'body.json');
    writeFileSync(file, JSON.stringify({ products: [{ id: 7 }] }));
    const stdout = captureStdout();
    await wishlistAdd(ctx, 'group', '42', { file, confirm: true, yes: true });
    stdout.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/customers\/12345\/wishlists\/42\/items$/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ products: [{ id: 7 }] });
  });
});

describe('catalogue command request parameters against app 4.3.0', () => {
  it.each([
    {
      argv: ['config', 'app-version'],
      path: '/app-version',
      query: { platform: 'android', app_version: '4.3.0' },
    },
    {
      argv: ['cms', 'page', 'mobile-homepage'],
      path: '/cms/pages/mobile-homepage',
      query: { platform: 'android' },
    },
    {
      argv: ['cms', 'route', 'https://www.takealot.com/PLID52580339'],
      path: '/cms/route',
      query: { link: 'https://www.takealot.com/PLID52580339' },
    },
    {
      argv: ['help', 'search', 'refund'],
      path: '/help/search',
      query: { page: '1', page_size: '20', search: 'refund' },
    },
    {
      argv: ['help', 'search', 'ref', '--autocomplete'],
      path: '/help/search/autocomplete',
      query: { search: 'ref' },
    },
  ])('builds $path from positional and default query parameters', async ({ argv, path: expectedPath, query }) => {
    const { client, calls } = mkClient({ body: {} });
    const ctx = context(client, true);
    const pending: Promise<void>[] = [];
    const program = new Command();
    registerCatalogue(
      program,
      (command) => command,
      (_command, fn) => {
        pending.push(fn(ctx));
      },
      () => ({}),
    );
    await program.parseAsync(['node', 'takealot', ...argv]);
    await Promise.all(pending);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/rest/v-1-18-0${expectedPath}`);
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
  });
});

describe('state-dependent read errors', () => {
  const notSubscribed = (description: string) => ({
    notifications: [{ type: 'error', code: 'generic-error', title: 'Bad Request', description }],
  });

  it.each([
    ['plus.cancel.form', 404, 'No active subscription found', 'active subscription', true],
    ['plus.claimDiscount.form', 400, 'This customer is not subscribed', 'active eligible subscription', true],
    ['plus.manage.plan', 400, 'This customer is not subscribed', 'active subscription', false],
  ] as const)('explains why %s is unavailable', async (id, status, description, message, form) => {
    const { client } = mkClient({ status, body: notSubscribed(description) });
    const ctx = context(client);
    const request = form ? fetchForm(ctx, 'conditional', id) : readEndpoint(ctx, id);
    await expect(request).rejects.toMatchObject({ code: 'unavailable_state', message: expect.stringContaining(message) });
  });

  it.each([
    ['plus.manage.plan', 400, notSubscribed('Invalid plan id')],
    ['plus.manage.plan', 500, notSubscribed('This customer is not subscribed')],
    ['plus.cancel.form', 404, {}],
    ['returns.checkout.pickupPoints', 500, { message: 'Server Error', status: 500 }],
  ] as const)('keeps the raw API error for %s %s without the not-subscribed signal', async (id, status, body) => {
    const { client } = mkClient({ status, body });
    await expect(readEndpoint(context(client), id)).rejects.toMatchObject({ name: 'ApiError' });
  });
});

describe('id options', () => {
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
  it.each(['abc', '1.5', '0', '-4', '9007199254740993', '12x'])('rejects --plid %s before any request', (value) => {
    const res = spawnSync('node', [cliPath, 'recommend', 'pdp', '--plid', value, '--model', 'ymal', '--json'], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(4);
    expect(res.stdout).toContain('expected a positive integer id');
  });
});

describe('invoice order id resolution against app 4.3.0', () => {
  it('routes a numeric invoice id through catalogue wiring to the obfuscated path', async () => {
    const { client, calls } = mkClient({ body: orders });
    const ctx = context(client, true);
    const pending: Promise<void>[] = [];
    const program = new Command();
    registerCatalogue(
      program,
      (command) => command,
      (_command, fn) => {
        pending.push(fn(ctx));
      },
      () => ({}),
    );
    const stdout = captureStdout();
    await program.parseAsync(['node', 'takealot', 'invoices', '900000001']);
    await Promise.all(pending);
    stdout.restore();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/customer/12345/orders?period=all&page_number=0');
    expect(calls[1]!.url).toMatch(/\/order\/T0JGVVNDQVRFRDE\/invoices$/);
  });

  it('resolves a numeric order id and uses the obfuscated id in the invoice path', async () => {
    const { client, calls } = mkClient({ body: orders });
    const resolved = await client.resolveObfuscatedOrderId('900000001');
    await client.call('invoices.list', { params: { obfuscatedOrderId: resolved } });
    expect(resolved).toBe('T0JGVVNDQVRFRDE');
    expect(calls[0]!.url).toContain('/customer/12345/orders?period=all&page_number=0');
    expect(calls[1]!.url).toMatch(/\/order\/T0JGVVNDQVRFRDE\/invoices$/);
  });

  it('passes an obfuscated id through without loading orders', async () => {
    const { client, calls } = mkClient({ body: orders });
    const resolved = await client.resolveObfuscatedOrderId('OBFUSCATED/ID');
    await client.call('invoices.list', { params: { obfuscatedOrderId: resolved } });
    expect(resolved).toBe('OBFUSCATED/ID');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/order\/OBFUSCATED%2FID\/invoices$/);
  });

  it('follows page_summary until it finds the first numeric order match', async () => {
    const firstPage = {
      response: {
        orders: [],
        page_summary: { page_number: 0, page_count: 2 },
      },
    };
    const responses = [firstPage, orders];
    const { client, calls } = mkClient({ body: firstPage });
    globalThis.fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const body = responses[calls.length] ?? orders;
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: String(url),
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(body),
      } as Response;
    }) as typeof fetch;
    await expect(client.resolveObfuscatedOrderId('900000002')).resolves.toBe('T0JGVVNDQVRFRDI');
    expect(calls.map((call) => new URL(call.url).searchParams.get('page_number'))).toEqual([
      '0',
      '1',
    ]);
  });

  it('reports a numeric order id that is not present', async () => {
    const missing = { response: { orders: [], page_summary: { page_number: 0, page_count: 1 } } };
    const { client } = mkClient({ body: missing });
    await expect(client.resolveObfuscatedOrderId('123')).rejects.toThrow('order 123 not found');
  });
});

describe('product details against app 4.3.0', () => {
  it('parses a single-SKU product and emits only the typed info shape', async () => {
    const parsed = parseProductDetails(productSingle, 52580339);
    expect(parsed).toMatchObject({
      plid: 52580339,
      skuId: 82448522,
      title: 'Powerade - Mountainblast - 24 x 500ml',
      brand: 'Powerade',
      price: 359,
      prettyPrice: 'R 359',
      inStock: true,
      addToCart: true,
      rating: 4.9,
      reviewCount: 58,
      variants: [],
      unavailableReason: null,
    });
    const { client } = mkClient({ body: productSingle });
    const stdout = captureStdout();
    await infoCommand(context(client, true), 52580339);
    const output = JSON.parse(stdout.output());
    stdout.restore();
    expect(Object.keys(output)).toEqual([
      'plid',
      'skuId',
      'title',
      'brand',
      'price',
      'prettyPrice',
      'inStock',
      'addToCart',
      'rating',
      'reviewCount',
      'variants',
      'unavailableReason',
    ]);
  });

  it('parses a multi-variant product without guessing a SKU', () => {
    const parsed = parseProductDetails(productMulti, 90255552);
    expect(parsed.skuId).toBeNull();
    expect(parsed.price).toBe(99);
    expect(parsed.prettyPrice).toBe('From R 99');
    expect(parsed.variants[0]).toMatchObject({
      title: 'Colour',
      value: 'Apple Red',
      plid: 90255552,
    });
    expect(
      parsed.variants.some((variant) => variant.title === 'Size' && variant.value === '3.0 m'),
    ).toBe(true);
  });

  it('keeps buybox pricing when the item has no SKU id', () => {
    const noSku = structuredClone(productSingle);
    delete noSku.buybox.items[0].sku;
    delete noSku.event_data.documents.product.sku_id;
    const parsed = parseProductDetails(noSku, 52580339);
    expect(parsed.skuId).toBeNull();
    expect(parsed.price).toBe(359);
    expect(parsed.prettyPrice).toBe('R 359');
    expect(parsed.unavailableReason).toBeNull();
  });

  it('resolves a single SKU and rejects a multi-variant PLID with choices', async () => {
    const single = mkClient({ body: productSingle });
    await expect(single.client.skuForPlid(52580339)).resolves.toBe(82448522);
    const multi = mkClient({ body: productMulti });
    await expect(multi.client.skuForPlid(90255552)).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('PLID90255552 has variants; pick one: Colour: Apple Red'),
    } satisfies Partial<UsageError>);
  });

  it('retries a missing buybox once and returns a null price with its reason', async () => {
    const missingBuybox = { ...productSingle, buybox: { ...productSingle.buybox, items: [] } };
    const { client, fetchMock } = mkClient({ body: missingBuybox });
    const stdout = captureStdout();
    await infoCommand(context(client, true), 52580339);
    const output = JSON.parse(stdout.output());
    stdout.restore();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output).toMatchObject({ skuId: null, price: null, unavailableReason: 'buybox missing' });

    const human = mkClient({ body: missingBuybox });
    const humanStdout = captureStdout();
    await infoCommand(context(human.client), 52580339);
    const humanOutput = humanStdout.output();
    humanStdout.restore();
    expect(humanOutput).toContain('price unavailable (buybox missing)');
    expect(humanOutput).not.toContain('R—');
    expect(humanOutput).not.toContain('sku ?');
  });

  it('uses the buybox returned by the single authenticated retry', async () => {
    const missingBuybox = { ...productSingle, buybox: { ...productSingle.buybox, items: [] } };
    const { client, calls, fetchMock } = mkClient({ body: productSingle });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(missingBuybox), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(client.productDetails(52580339)).resolves.toMatchObject({
      skuId: 82448522,
      price: 359,
      unavailableReason: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer test-jwt' });
  });

  it('reports a missing buybox as a runtime error instead of a variant choice', async () => {
    const missingBuybox = { ...productSingle, buybox: { ...productSingle.buybox, items: [] } };
    const { client, fetchMock } = mkClient({ body: missingBuybox });
    await expect(client.skuForPlid(52580339)).rejects.toMatchObject({
      name: 'Error',
      message: 'PLID52580339: price unavailable (buybox missing)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('cart PLID dry runs against app 4.3.0', () => {
  it('resolves a single variant before gating and previews the exact SKU request', async () => {
    const { client, calls } = mkClient({ body: productSingle });
    const stdout = captureStdout();
    await cartAdd(context(client, true), '', { plid: 52580339 });
    const preview = JSON.parse(stdout.output());
    stdout.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/product-details\/PLID52580339/);
    expect(preview.action).toContain(
      'add 1× SKU 82448522 (Powerade - Mountainblast - 24 x 500ml) to the cart',
    );
    expect(preview.request).toMatchObject({
      method: 'POST',
      body: { products: [{ id: 82448522, quantity: 1 }] },
    });
  });

  it('rejects a multi-variant PLID before the mutation gate or cart request', async () => {
    const { client, calls } = mkClient({ body: productMulti });
    await expect(cartAdd(context(client), '', { plid: 90255552 })).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('PLID90255552 has variants; pick one: Colour: Apple Red'),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/product-details\/PLID90255552/);
  });
});
