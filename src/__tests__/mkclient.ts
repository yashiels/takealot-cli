import { vi } from 'vitest';
import { TakealotClient } from '../lib/api-client.js';
import type { AuthManager } from '../lib/auth.js';

/** A minimal fake AuthManager sufficient for the request core + contract tests. */
export function fakeAuth(customerId: number | null = 12345): AuthManager {
  return {
    customerId,
    trackingId: 'track-1',
    currentAuthGeneration: 0,
    async ensureValid() {},
    async reauthenticateIfCurrent() {},
    authHeaders: () => ({ authorization: 'Bearer test-jwt', 'x-csrf-token': 'csrf-1' }),
    deviceHeaders: () => ({ 'tal-did': 'DID-1' }),
  } as unknown as AuthManager;
}

/** Build a client + a mocked global fetch that returns `body` and records calls. */
export function mkClient(opts: { customerId?: number | null; body?: unknown; status?: number; headers?: Record<string, string> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const status = opts.status ?? 200;
  const headers = new Headers({ 'content-type': 'application/json', ...(opts.headers ?? {}) });
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      url: String(url),
      headers,
      text: async () => (opts.body === undefined ? '' : JSON.stringify(opts.body)),
      json: async () => opts.body,
    } as unknown as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const client = new TakealotClient({
    auth: fakeAuth(opts.customerId ?? 12345),
    logger: { debug() {} },
  });
  return { client, calls, fetchMock };
}
