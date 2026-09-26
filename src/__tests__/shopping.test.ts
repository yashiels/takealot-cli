import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { mkClient } from './mkclient.js';
import { renderRaw } from '../lib/ui.js';

// ── Cart: exact-id add / set-qty / remove issue the right requests ──────────
describe('cart edit (typed core)', () => {
  it('addSkuToCart POSTs the exact sku, no search', async () => {
    const { client, calls } = mkClient({ body: { products: [{ product_id: 80226511, title: 'Batteries' }] } });
    await client.addSkuToCart(80226511, 3);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/customers\/12345\/cart\/items$/);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ products: [{ id: 80226511, quantity: 3 }] });
  });

  it('setCartItemQuantity PUTs the quantity', async () => {
    const { client, calls } = mkClient({ body: {} });
    await client.setCartItemQuantity(999, 5);
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ products: [{ id: 999, quantity: 5 }] });
  });

  it('removeCartItem DELETEs with a body', async () => {
    const { client, calls } = mkClient({ body: {} });
    await client.removeCartItem(999);
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ products: [{ id: 999 }] });
  });

});

// ── renderRaw is total (never throws) ───────────────────────────────────────
describe('typed cart errors', () => {
  it('raises ApiError with the server message instead of [object Object]', async () => {
    const { client } = mkClient({
      status: 400,
      body: { error: { code: 'unavailable' }, errors: [{ field: 'products', message: 'Product in cart is not available anymore.' }] },
    });
    const err = await client.addToCart(1).catch((e: unknown) => e);
    const { ApiError } = await import('../lib/api-client.js');
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).message).toBe('Product in cart is not available anymore.');
    expect((err as InstanceType<typeof ApiError>).status).toBe(400);
    expect((err as InstanceType<typeof ApiError>).method).toBe('POST');
  });
});

describe('renderRaw', () => {
  it('summarises arbitrary shapes without throwing', () => {
    for (const v of [null, undefined, 1, 'x', [1, 2, 3], { a: 1, b: [1] }, { deep: { deeper: { x: 1 } } }]) {
      expect(() => renderRaw(v)).not.toThrow();
      expect(typeof renderRaw(v)).toBe('string');
    }
  });
});

// ── Context-driven: gating, form binding, checkout ──────────────────────────
let tmp: string;
let prevXdg: string | undefined;
let prevEmail: string | undefined;
let prevPw: string | undefined;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevEmail = process.env.TAKEALOT_EMAIL;
  prevPw = process.env.TAKEALOT_PASSWORD;
  previousExitCode = process.exitCode;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-shop-'));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.TAKEALOT_EMAIL = 'shopper@example.com';
  process.env.TAKEALOT_PASSWORD = 'pw';
  process.exitCode = undefined;
});
afterEach(() => {
  process.env.XDG_CONFIG_HOME = prevXdg;
  process.env.TAKEALOT_EMAIL = prevEmail;
  process.env.TAKEALOT_PASSWORD = prevPw;
  process.exitCode = previousExitCode;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function seededContext(verbose = false) {
  vi.resetModules();
  const cfg = await import('../lib/config.js');
  cfg.saveCredentials({
    email: 'shopper@example.com',
    password: 'pw',
    tokens: {
      jwt: 'jwt',
      idToken: 'id',
      refreshToken: 'r',
      csrfToken: 'c',
      trackingId: 't',
      customerId: 12345,
      jwtExpiresAt: Date.now() + 3_600_000,
    },
    device: { profile: (await import('../lib/device.js')).resolveDeviceProfile({}), did: 'DID' },
  } as any);
  const { Context } = await import('../lib/context.js');
  return new Context({ json: true, verbose });
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => {
    chunks.push(String(s));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => {
    chunks.push(String(s));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

const cartBody = (lines: Array<{ skuId: number; quantity: number; title: string }>) => ({
  products: lines.map((line) => ({ product_id: line.skuId, title: line.title, selling_price: 10 })),
  cart_items: lines.map((line) => ({ product_id: line.skuId, quantity: line.quantity, sub_total: line.quantity * 10 })),
});

const response = (body: unknown): Response => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
  json: async () => body,
}) as unknown as Response;

const threeLines = [
  { skuId: 101, quantity: 1, title: 'One' },
  { skuId: 202, quantity: 2, title: 'Two' },
  { skuId: 303, quantity: 3, title: 'Three' },
];

describe('cart mutation guard', () => {
  it('detects a vanished duplicate line of the same non-target SKU', async () => {
    const before = [...threeLines, { skuId: 202, quantity: 2, title: 'Two again' }];
    const after = [threeLines[1]!, threeLines[2]!];
    const replies = [cartBody(before), {}, cartBody(after)];
    globalThis.fetch = vi.fn(async () => response(replies.shift())) as any;
    const ctx = await seededContext(false);
    const { cartRemove } = await import('../commands/cart.js');
    const stdout = captureStdout();
    const stderr = captureStderr();
    await cartRemove(ctx, 101, { confirm: true, yes: true });
    const result = JSON.parse(stdout.chunks.join(''));
    stdout.restore();
    stderr.restore();
    expect(result.unexpectedRemovals).toEqual([{ skuId: 202, quantity: 2, title: 'Two' }]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('removes one SKU while preserving the other lines and logs all three auth contexts', async () => {
    const replies = [cartBody(threeLines), {}, cartBody(threeLines.slice(1))];
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => response(replies.shift()));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext(true);
    const { cartRemove } = await import('../commands/cart.js');
    const stdout = captureStdout();
    const stderr = captureStderr();
    await cartRemove(ctx, 101, { confirm: true, yes: true });
    const result = JSON.parse(stdout.chunks.join(''));
    stdout.restore();
    stderr.restore();
    expect(result).toMatchObject({ removed: true, remaining: 2 });
    expect(result).not.toHaveProperty('unexpectedRemovals');
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).method ?? 'GET')).toEqual(['GET', 'DELETE', 'GET']);
    const verbose = stderr.chunks.join('');
    expect(verbose.match(/customerId=12345 authGeneration=0/g)).toHaveLength(3);
    expect(verbose).toContain('DELETE body {"products":[{"id":101}]}');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports unexpectedRemovals and exits 1 when the server wipes the cart', async () => {
    const replies = [cartBody(threeLines), {}, cartBody([])];
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => response(replies.shift()));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext();
    const { cartRemove } = await import('../commands/cart.js');
    const stdout = captureStdout();
    const stderr = captureStderr();
    await cartRemove(ctx, 101, { confirm: true, yes: true });
    const result = JSON.parse(stdout.chunks.join(''));
    stdout.restore();
    stderr.restore();
    expect(result.unexpectedRemovals).toEqual(threeLines.slice(1));
    expect(stderr.chunks.join('')).toContain('CART SAFETY CHECK FAILED');
    expect(process.exitCode).toBe(1);
  });

  it('guards set-qty against collateral cart changes', async () => {
    const changed = [{ ...threeLines[0]!, quantity: 4 }, { ...threeLines[1]!, quantity: 1 }, threeLines[2]!];
    const replies = [cartBody(threeLines), {}, cartBody(changed)];
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => response(replies.shift()));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext();
    const { cartSetQty } = await import('../commands/cart.js');
    const stdout = captureStdout();
    const stderr = captureStderr();
    await cartSetQty(ctx, 101, 4, { confirm: true, yes: true });
    const result = JSON.parse(stdout.chunks.join(''));
    stdout.restore();
    stderr.restore();
    expect(result.unexpectedRemovals).toEqual([threeLines[1]]);
    expect(process.exitCode).toBe(1);
  });

  it('rejects a missing SKU with exit 4 and sends no DELETE', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => response(cartBody(threeLines)));
    globalThis.fetch = fetchMock as any;
    await seededContext();
    const { run } = await import('../cli.js');
    const { cartRemove } = await import('../commands/cart.js');
    const command = new Command().option('--json');
    command.setOptionValue('json', true);
    const stdout = captureStdout();
    await run(command, (ctx) => cartRemove(ctx, 404, { confirm: true, yes: true }));
    const result = JSON.parse(stdout.chunks.join(''));
    stdout.restore();
    expect(result).toMatchObject({ code: 'usage_error', error: 'SKU 404 is not in the current cart' });
    expect(process.exitCode).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method ?? 'GET').toBe('GET');
  });

  it('lists the cart lines that would remain in a remove dry run', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => response(cartBody(threeLines)));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext();
    const { cartRemove } = await import('../commands/cart.js');
    const stdout = captureStdout();
    await cartRemove(ctx, 101);
    const result = JSON.parse(stdout.chunks.join(''));
    stdout.restore();
    expect(result.request.remaining).toEqual(threeLines.slice(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('mutation gating', () => {
  it('a mutating command is a NO-OP under default dry-run (no write fetch)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{}' } as unknown as Response));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext();
    const { mutateEndpoint } = await import('../commands/generic.js');
    const out = captureStdout();
    await mutateEndpoint(ctx, 'address.select', { body: { address_id: 'A1' } }, { confirm: false });
    out.restore();
    expect(fetchMock).not.toHaveBeenCalled(); // dry run performed no write
    expect(out.chunks.join('')).toContain('dryRun');
  });

  it('(#2) dry-run redacts auth tokens in the previewed URL', async () => {
    globalThis.fetch = vi.fn() as any; // must not be called in a dry run
    const ctx = await seededContext();
    const { mutateEndpoint } = await import('../commands/generic.js');
    const out = captureStdout();
    await mutateEndpoint(
      ctx,
      'address.validate',
      { params: { absoluteUrl: 'https://api.takealot.com/validate?access_token=SEKRIT#id_token=ALSO' }, body: {} },
      { confirm: false },
    );
    out.restore();
    const text = out.chunks.join('');
    expect(text).toContain('dryRun');
    expect(text).not.toContain('SEKRIT'); // query token redacted in the preview
    expect(text).not.toContain('ALSO'); // fragment token redacted too
  });

  it('the same command issues the write with --confirm', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{}' } as unknown as Response));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext();
    const { mutateEndpoint } = await import('../commands/generic.js');
    const out = captureStdout();
    await mutateEndpoint(ctx, 'address.select', { body: { address_id: 'A1' } }, { confirm: true, yes: true });
    out.restore();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('mutation gating — behavioral, every mutating endpoint', () => {
  it('each mutating non-exempt endpoint no-ops under dry-run and writes only with --confirm', async () => {
    const { CATALOGUE, GATE_EXEMPT_MUTATIONS } = await import('../lib/catalogue.js');
    const { mutateEndpoint } = await import('../commands/generic.js');
    const rows = CATALOGUE.filter(
      (e) => !e.excluded && e.mutating && !GATE_EXEMPT_MUTATIONS.has(e.id) && e.base !== 'absolute',
    );
    expect(rows.length).toBeGreaterThan(50); // the whole mutating surface, not a sample

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{}' } as unknown as Response));
    globalThis.fetch = fetchMock as any;
    const ctx = await seededContext();

    for (const row of rows) {
      const args = { params: row.sample?.params, body: row.sample?.body ?? {} };
      // dry-run: NO write fetch
      fetchMock.mockClear();
      const o1 = captureStdout();
      await mutateEndpoint(ctx, row.id, args, { confirm: false });
      o1.restore();
      expect(fetchMock, `${row.id} must NOT write under dry-run`).not.toHaveBeenCalled();

      // --confirm: exactly the write fetch
      fetchMock.mockClear();
      const o2 = captureStdout();
      await mutateEndpoint(ctx, row.id, args, { confirm: true, yes: true, iKnow: true });
      o2.restore();
      expect(fetchMock.mock.calls.length, `${row.id} must write once with --confirm`).toBe(1);
    }
  });
});

describe('data-section local binding', () => {
  it('submit rejects a field_id the fetched form did not contain', async () => {
    // form GET returns a layout with one section/field.
    const layout = { data_sections: [{ section_id: 'sec1', data_fields: [{ field_id: 'ok_field' }] }] };
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(layout) } as unknown as Response)) as any;
    const ctx = await seededContext();
    const { fetchForm, submitForm } = await import('../commands/generic.js');
    const out = captureStdout();
    await fetchForm(ctx, 'account password', 'account.password.get', {}, {});
    out.restore();

    // A payload with a foreign field id must be rejected LOCALLY (no request).
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ sections: [{ section_id: 'sec1', fields: [{ field_id: 'FOREIGN', value: 'x' }] }] }));
    await expect(
      submitForm(ctx, 'account password', 'account.password.set', {}, { file: bad, confirm: true, yes: true }),
    ).rejects.toThrow(/unknown field_id/);

    // A payload matching the form passes local binding (write gated → confirm).
    const good = path.join(tmp, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ sections: [{ section_id: 'sec1', fields: [{ field_id: 'ok_field', value: 'x' }] }] }));
    const out2 = captureStdout();
    await submitForm(ctx, 'account password', 'account.password.set', {}, { file: good, confirm: false });
    out2.restore();
    expect(out2.chunks.join('')).toContain('dryRun'); // reached the gate, not rejected
  });
});
