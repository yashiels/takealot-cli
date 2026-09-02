import { describe, it, expect, vi, afterEach } from 'vitest';
import { TakealotClient } from '../lib/api-client.js';
import type { AuthManager } from '../lib/auth.js';

/**
 * A full token wipe (credentials.json with device + creds but no `tokens`) leaves
 * `auth.customerId` null. Authed commands must bootstrap a login (via the trusted
 * device) before requiring the customer id, instead of throwing "Not authenticated"
 * — proven live to be the one gap after the device-trust work.
 */

/** Auth whose customerId is null until ensureValid() "logs in" and sets it. */
function bootstrappingAuth() {
  let cid: number | null = null;
  let ensureCalls = 0;
  const auth = {
    get customerId() {
      return cid;
    },
    trackingId: 'track-1',
    currentAuthGeneration: 0,
    async ensureValid() {
      ensureCalls++;
      cid = 999; // trusted-device login succeeded, no OTP
    },
    async reauthenticateIfCurrent() {},
    authHeaders: () => ({ authorization: 'Bearer jwt', 'x-csrf-token': 'csrf' }),
    deviceHeaders: () => ({ 'tal-did': 'DID' }),
  };
  return { auth: auth as unknown as AuthManager, ensureCalls: () => ensureCalls };
}

function mockFetch(body: unknown) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: String(url),
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('session bootstrap from a full token wipe', () => {
  it('getCart() logs in first instead of throwing Not authenticated', async () => {
    const { auth, ensureCalls } = bootstrappingAuth();
    const calls = mockFetch({ products: [], cart_items: [] });
    const client = new TakealotClient({ auth, logger: { debug() {} } });

    await expect(client.getCart()).resolves.toBeDefined(); // no "Not authenticated"
    expect(ensureCalls()).toBeGreaterThan(0); // ensureValid ran before requiring the id
    // The resolved path used the id that login produced (999), not a throw.
    expect(calls.some((u) => u.includes('/customers/999/cart'))).toBe(true);
  });

  it('generic call() on an authed {customerId} endpoint bootstraps the session', async () => {
    const { auth, ensureCalls } = bootstrappingAuth();
    const calls = mockFetch({ ok: true });
    const client = new TakealotClient({ auth, logger: { debug() {} } });

    // credits.balance → GET customers/{customerId}/credits/balance (authed)
    await expect(client.call('credits.balance')).resolves.toBeDefined();
    expect(ensureCalls()).toBeGreaterThan(0);
    expect(calls.some((u) => u.includes('/customers/999/credits/balance'))).toBe(true);
  });
});
