import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../lib/api-client.js';
import { mkClient } from './mkclient.js';

describe('apiRequest semantics', () => {
  it('builds repeated query keys from array values', async () => {
    const { client, calls } = mkClient({ body: {} });
    await client.apiRequest('GET', 'x', { query: { f: ['a', 'b'], g: 1 } });
    expect(calls[0]!.url).toContain('f=a&f=b');
    expect(calls[0]!.url).toContain('g=1');
  });

  it('encodes json, form, text, and delete-body correctly', async () => {
    const cases = [
      { enc: 'json' as const, ct: 'application/json', check: (b: string) => JSON.parse(b).a === 1 },
      { enc: 'form' as const, ct: 'application/x-www-form-urlencoded', check: (b: string) => b === 'a=1' },
      { enc: 'text' as const, ct: 'text/plain', check: (b: string) => b === 'android' },
      { enc: 'delete-body' as const, ct: 'application/json', check: (b: string) => JSON.parse(b).a === 1 },
    ];
    for (const cse of cases) {
      const { client, calls } = mkClient({ body: {} });
      const body = cse.enc === 'text' ? 'android' : { a: 1 };
      await client.apiRequest(cse.enc === 'delete-body' ? 'DELETE' : 'POST', 'x', { encoding: cse.enc, body });
      const init = calls[0]!.init as any;
      expect((init.headers['content-type'] as string)).toBe(cse.ct);
      expect(cse.check(init.body)).toBe(true);
    }
  });

  it('204 / empty body → null (no throw)', async () => {
    const { client } = mkClient({ status: 204 });
    await expect(client.apiRequest('GET', 'x')).resolves.toBeNull();
  });

  it('non-2xx → structured ApiError with a redacted body', async () => {
    const { client } = mkClient({ status: 403, body: { message: 'no', jwt: 'secret.tok.en' } });
    await expect(client.apiRequest('GET', 'x')).rejects.toMatchObject({ name: 'ApiError' });
    try {
      await client.apiRequest('GET', 'x');
    } catch (e) {
      const err = e as ApiError;
      expect(err.info.status).toBe(403);
      expect(err.info.code).toBe('http_403');
      expect(JSON.stringify(err.info.body)).not.toContain('secret.tok.en');
    }
  });

  it('(#3) ApiError.path is sanitized — no query/fragment tokens leak on non-2xx', async () => {
    const { client } = mkClient({ status: 403, body: { message: 'no' } });
    try {
      await client.apiRequest('GET', 'orders', { query: { access_token: 'SEKRIT' } });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err.info.path).not.toContain('SEKRIT');
      expect(err.info.path).not.toContain('?'); // query stripped entirely
      expect(err.info.path).toContain('/orders'); // path preserved for debugging
    }
  });

  it('429 → rate_limited code with retry_after', async () => {
    const { client } = mkClient({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '30' } });
    try {
      await client.apiRequest('GET', 'x');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err.info.code).toBe('rate_limited');
      expect(err.info.retryAfter).toBe(30);
    }
  });

  it('retries idempotent GET on 5xx but never a POST', async () => {
    // GET: first 500 then 200 → 2 attempts.
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      const ok = n >= 2;
      return {
        ok,
        status: ok ? 200 : 500,
        statusText: 'x',
        url: 'u',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{}',
      } as unknown as Response;
    }) as any;
    const { client } = mkClient({ body: {} }); // resets fetch — re-set below
    // re-install the counting mock (mkClient overwrote it)
    n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      const ok = n >= 2;
      return { ok, status: ok ? 200 : 500, statusText: 'x', url: 'u', headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{}' } as unknown as Response;
    }) as any;
    await client.apiRequest('GET', 'x', { idempotent: true });
    expect(n).toBe(2);

    // POST: 500 → single attempt, surfaces the error.
    let m = 0;
    globalThis.fetch = vi.fn(async () => {
      m++;
      return { ok: false, status: 500, statusText: 'x', url: 'u', headers: new Headers(), text: async () => '{}' } as unknown as Response;
    }) as any;
    await expect(client.apiRequest('POST', 'x', { encoding: 'json', body: {}, idempotent: true })).rejects.toBeInstanceOf(ApiError);
    expect(m).toBe(1);
  });

  it('absolute-url refuses a host not on the static allowlist and REDACTS the url in the error', async () => {
    const { client } = mkClient({ body: {} });
    try {
      await client.apiRequest('POST', 'https://evil.example/x?access_token=SEKRIT&token=ALSO', {
        base: 'absolute',
        encoding: 'json',
        body: {},
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err.info.code).toBe('blocked_url');
      // The query (and any tokens in it) must NOT leak into message or path.
      expect(err.info.message).not.toContain('SEKRIT');
      expect(err.info.message).not.toContain('ALSO');
      expect(err.info.path).not.toContain('SEKRIT');
      expect(err.info.path).not.toContain('?');
    }
  });

  it('(#3) too_many_redirects error redacts the url (no query token in path)', async () => {
    const { client } = mkClient({ body: {} });
    // Always 302 to another allowlisted URL carrying a token → exhausts the hop cap.
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 302,
      statusText: '',
      url: 'u',
      headers: new Headers({ location: 'https://api.takealot.com/next?access_token=SEKRIT' }),
      text: async () => '',
    } as unknown as Response)) as any;
    try {
      await client.apiRequest('POST', 'https://api.takealot.com/start?access_token=SEKRIT', {
        base: 'absolute',
        encoding: 'json',
        body: {},
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err.info.code).toBe('too_many_redirects');
      expect(err.info.path).not.toContain('SEKRIT');
      expect(err.info.path).not.toContain('?');
    }
  });

  it('absolute-url to an allowlisted host suppresses auth/device headers', async () => {
    const { client, calls } = mkClient({ body: {} });
    await client.apiRequest('POST', 'https://api.takealot.com/validate', { base: 'absolute', encoding: 'json', body: { a: 1 } });
    const headers = calls[0]!.init.headers as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower['authorization']).toBeUndefined();
    expect(lower['tal-did']).toBeUndefined();
    expect((calls[0]!.init as any).redirect).toBe('manual');
  });
});
