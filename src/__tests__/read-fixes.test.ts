import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../lib/context.js';
import { Logger } from '../lib/ui.js';
import { UsageError } from '../lib/errors.js';
import { parseProductDetails } from '../lib/api-client.js';
import { infoCommand } from '../commands/info.js';
import { cartAdd } from '../commands/cart.js';
import { reviewsCommand } from '../commands/reviews.js';
import { recommendCommand, recommendLayout } from '../commands/recommend.js';
import { registerCatalogue } from '../commands/register.js';
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

  it('rejects pdp and unknown locations before any request', async () => {
    const { client, fetchMock } = mkClient({ body: recoHome });
    await expect(
      recommendCommand(context(client), 'pdp', { model: 'x', limit: 3 }),
    ).rejects.toThrow('pdp recommendations are not supported by the API yet');
    await expect(
      recommendCommand(context(client), 'other', { model: 'x', limit: 3 }),
    ).rejects.toThrow(/valid values: home-page, add-to-cart, landing-page, domain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('subcommand options reach the subcommand', () => {
  it('passes --file and --confirm to wishlist add group even though the parent defines them', async () => {
    const { client, calls } = mkClient({ body: {} });
    const ctx = context(client, true);
    const pending: Promise<void>[] = [];
    const program = new Command().enablePositionalOptions();
    registerCatalogue(
      program,
      (command) => command,
      (_command, fn) => {
        pending.push(fn(ctx));
      },
      () => ({ json: true }),
    );
    const dir = mkdtempSync(path.join(tmpdir(), 'takealot-positional-'));
    const file = path.join(dir, 'body.json');
    writeFileSync(file, JSON.stringify({ products: [{ id: 7 }] }));
    const stdout = captureStdout();
    await program.parseAsync([
      'node',
      'takealot',
      'wishlist',
      'add',
      'group',
      '42',
      '--file',
      file,
      '--confirm',
      '--yes',
    ]);
    await Promise.all(pending);
    stdout.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/customers\/12345\/wishlists\/42\/items$/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ products: [{ id: 7 }] });
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

  it('resolves a single SKU and rejects a multi-variant PLID with choices', async () => {
    const single = mkClient({ body: productSingle });
    await expect(single.client.skuForPlid(52580339)).resolves.toBe(82448522);
    const multi = mkClient({ body: productMulti });
    await expect(multi.client.skuForPlid(90255552)).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('PLID90255552 has variants; pick one: Colour: Apple Red'),
    } satisfies Partial<UsageError>);
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
