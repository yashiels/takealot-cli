import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('skuForPlid resolves the buyable sku from product-details', async () => {
    const { client } = mkClient({ body: { product_views: { buybox_summary: { product_id: 777 } } } });
    await expect(client.skuForPlid(52341565)).resolves.toBe(777);
  });
});

// ── renderRaw is total (never throws) ───────────────────────────────────────
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

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevEmail = process.env.TAKEALOT_EMAIL;
  prevPw = process.env.TAKEALOT_PASSWORD;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-shop-'));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.TAKEALOT_EMAIL = 'shopper@example.com';
  process.env.TAKEALOT_PASSWORD = 'pw';
});
afterEach(() => {
  process.env.XDG_CONFIG_HOME = prevXdg;
  process.env.TAKEALOT_EMAIL = prevEmail;
  process.env.TAKEALOT_PASSWORD = prevPw;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function seededContext() {
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
  return new Context({ json: true, verbose: false });
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => {
    chunks.push(String(s));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

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
      await mutateEndpoint(ctx, row.id, args, { confirm: true, yes: true });
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
