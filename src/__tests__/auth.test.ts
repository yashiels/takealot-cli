import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager, extractCfBmCookie } from '../lib/auth.js';
import { TakealotClient } from '../lib/api-client.js';
import type { Credentials, TokenSet } from '../types.js';

const API_BASE = 'https://api.takealot.com/rest/v-1-16-0';
const UA = 'TAL-Android/3.51.0';
const PLATFORM = 'android';

function makeTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    jwt: 'jwt-old',
    idToken: 'id-old',
    refreshToken: 'refresh-old',
    csrfToken: 'csrf-old',
    trackingId: 'track-1',
    did: 'did-1',
    customerId: 12345,
    jwtExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makeCreds(overrides: Partial<Credentials> = {}): Credentials {
  return {
    email: 'test@example.com',
    password: 'pass123',
    ...overrides,
  };
}

function mockAuthInfoResponse(tokens: Partial<TokenSet> = {}) {
  const t = makeTokens(tokens);
  return {
    auth_info: {
      jwt: t.jwt,
      id_token: t.idToken,
      refresh_token: t.refreshToken,
      csrf_token: t.csrfToken,
      tracking_id: t.trackingId,
      customer_id: t.customerId,
      did: t.did,
      max_age: 3600,
    },
  };
}

function mockRefreshResponse(tokens: Partial<TokenSet> = {}) {
  return mockAuthInfoResponse(tokens);
}

function mock2faChallengeResponse() {
  return {
    two_step_verification: 'enabled_untrusted',
    otp_status: { remaining_retries: 2, status: 'unverified', valid_millis: 300000 },
    data_sections: [
      { section_id: 'customer_login', is_complete: true },
      {
        section_id: 'two_step_verification',
        data_fields: [
          { field_id: 'otp', title: 'Enter OTP' },
          { field_id: 'trust_this_device', data_type: 'boolean' },
        ],
      },
    ],
  };
}

function makeMockResponse(body: unknown, opts: { status?: number; setCookie?: string[]; ok?: boolean } = {}) {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const headers = new Headers();
  if (opts.setCookie) {
    for (const c of opts.setCookie) headers.append('set-cookie', c);
  }
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Response mock where getSetCookie() is intentionally absent so the regex fallback is exercised. */
function makeMockResponseNoSetCookie(body: unknown, opts: { status?: number; setCookieRaw?: string; ok?: boolean } = {}) {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const headers = new Headers();
  if (opts.setCookieRaw) {
    headers.set('set-cookie', opts.setCookieRaw);
  }
  // No getSetCookie() on this headers object — forces fallback path
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeAuthManager(opts: {
  tokens?: TokenSet | null;
  creds?: Credentials | null;
  otpProvider?: () => Promise<string>;
}) {
  const persist = vi.fn();
  const log = vi.fn();
  const getCredentials = () => opts.creds ?? null;
  return {
    auth: new AuthManager(
      {
        apiBase: API_BASE,
        userAgent: UA,
        platform: PLATFORM,
        getCredentials,
        persist,
        log,
        otpProvider: opts.otpProvider,
      },
      opts.tokens ?? null,
    ),
    persist,
    log,
  };
}

function makeClient(opts: {
  tokens?: TokenSet | null;
  creds?: Credentials | null;
  otpProvider?: () => Promise<string>;
}) {
  const { auth, persist, log } = makeAuthManager(opts);
  const client = new TakealotClient({
    auth,
    logger: { debug: vi.fn() },
  });
  return { client, auth, persist, log };
}

describe('AuthManager concurrency', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // 1. concurrent refresh success: two ensureValid calls when tokens near expiry, only one refresh fetch
  it('concurrent refresh: coalesces two ensureValid calls into one refresh', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const { auth, persist } = makeAuthManager({ tokens });

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return makeMockResponse(mockRefreshResponse({ jwt: 'jwt-new' }));
    }) as any;

    await Promise.all([auth.ensureValid(), auth.ensureValid()]);

    expect(fetchCalls.filter((u) => u.includes('/auth/refresh'))).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-new');
  });

  // 2. refresh failure with one fallback OTP login
  it('refresh failure falls back to loginWithOtp when otpProvider is set', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const creds = makeCreds();
    const otpProvider = vi.fn().mockResolvedValue('123456');
    const { auth, persist } = makeAuthManager({ tokens, creds, otpProvider });

    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      callCount++;
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        return makeMockResponse({ message: 'expired' }, { status: 401 });
      }
      if (u.includes('/customers/login')) {
        if (callCount === 2) {
          return makeMockResponse(mock2faChallengeResponse(), {
            setCookie: ['__cf_bm=cfcookie123; Path=/; Domain=takealot.com'],
          });
        }
        return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-after-otp' }));
      }
      return makeMockResponse({}, { status: 500 });
    }) as any;

    await auth.ensureValid();

    expect(otpProvider).toHaveBeenCalledTimes(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-after-otp');
    expect(persist).toHaveBeenCalled();
  });

  // 3. retry after failure: lock clears after rejection, next ensureValid succeeds
  it('lock clears after rejection so next ensureValid can succeed', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    let loginAttempted = false;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        return makeMockResponse({ message: 'fail' }, { status: 401 });
      }
      if (u.includes('/customers/login')) {
        if (!loginAttempted) {
          loginAttempted = true;
          return makeMockResponse({ message: 'login fail' }, { status: 401 });
        }
        return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-retry-ok' }));
      }
      return makeMockResponse({}, { status: 500 });
    }) as any;

    await expect(auth.ensureValid()).rejects.toThrow();
    await auth.ensureValid();
    expect(auth.currentTokens?.jwt).toBe('jwt-retry-ok');
  });

  // 4. null-token concurrent login: two ensureValid calls with no tokens, one login
  it('null-token concurrent login: coalesces two ensureValid calls into one login', async () => {
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens: null, creds });

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-login' }));
    }) as any;

    await Promise.all([auth.ensureValid(), auth.ensureValid()]);

    expect(fetchCalls.filter((u) => u.includes('/customers/login'))).toHaveLength(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-login');
  });

  // 5. ensureValid with valid tokens overlapping reauthenticate: no extra transition
  it('ensureValid awaits in-flight reauthenticate then fast-paths on valid tokens', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 3_600_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    const fetchCalls: string[] = [];
    const reauthBlocking = new Promise<void>((r) => setTimeout(r, 30));

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      await reauthBlocking;
      return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-reauth-first' }));
    }) as any;

    const gen = auth.currentAuthGeneration;
    // Start reauthenticate (will block until we resolve)
    const reauthP = auth.reauthenticateIfCurrent(gen);
    // Give it a tick to enter the lock
    await new Promise((r) => setTimeout(r, 10));
    // ensureValid should await the in-flight reauth, then fast-path
    await Promise.all([reauthP, auth.ensureValid()]);

    // Only one login call from reauthenticate; ensureValid fast-pathed
    expect(fetchCalls.filter((u) => u.includes('/customers/login'))).toHaveLength(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-reauth-first');
  });

  // 6. concurrent 401s via authedFetch: one underlying auth transition
  it('concurrent authedFetch 401s trigger one reauthentication', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 3_600_000 });
    const creds = makeCreds();
    const { client } = makeClient({ tokens, creds });

    let authFetchCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/customers/login')) {
        return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-reauth' }));
      }
      // Data endpoint: 401 on first call, 200 on retry
      authFetchCount++;
      if (authFetchCount <= 2) {
        return makeMockResponse({ message: 'unauthorized' }, { status: 401 });
      }
      return makeMockResponse({ data: 'ok' });
    }) as any;

    // Two concurrent authedFetch calls that both get 401
    await Promise.all([
      client.authedFetch('/some/path'),
      client.authedFetch('/some/path'),
    ]);

    // Only one login call
    const fetchCalls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(fetchCalls.filter((u: string) => u.includes('/customers/login'))).toHaveLength(1);
  });

  // 7. refresh-to-reauth overlap: ensureValid triggers refresh, fails, one fallback login; reauthenticate joins
  it('refresh-to-reauth overlap: ensureValid refresh fails and falls back to login; reauthenticate joins', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        return makeMockResponse({ message: 'expired' }, { status: 401 });
      }
      return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-overlap' }));
    }) as any;

    const gen = auth.currentAuthGeneration;
    await Promise.all([
      auth.ensureValid(),
      auth.reauthenticateIfCurrent(gen),
    ]);

    expect(fetchCalls.filter((u) => u.includes('/auth/refresh'))).toHaveLength(1);
    expect(fetchCalls.filter((u) => u.includes('/customers/login'))).toHaveLength(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-overlap');
  });

  // 8. reauth-to-ensure overlap: reauthenticate in progress, ensureValid awaits then fast-paths
  it('reauth-to-ensure overlap: ensureValid awaits in-flight reauthenticate then fast-paths', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 3_600_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-reauth-first' }));
    }) as any;

    const gen = auth.currentAuthGeneration;
    const reauthP = auth.reauthenticateIfCurrent(gen);
    await Promise.all([reauthP, auth.ensureValid()]);

    expect(fetchCalls.filter((u) => u.includes('/customers/login'))).toHaveLength(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-reauth-first');
  });

  // 9. assert max simultaneous auth requests is 1
  it('never runs more than one auth transition simultaneously', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    let activeCount = 0;
    let maxActive = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise((r) => setTimeout(r, 50));
      activeCount--;
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        return makeMockResponse(mockRefreshResponse({ jwt: 'jwt-concurrent' }));
      }
      return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-concurrent' }));
    }) as any;

    await Promise.all([
      auth.ensureValid(),
      auth.ensureValid(),
      auth.ensureValid(),
      auth.reauthenticateIfCurrent(auth.currentAuthGeneration),
      auth.ensureValid(),
    ]);

    expect(maxActive).toBe(1);
  });

  // 10. assert retry via authedFetch sends rotated JWT
  it('authedFetch retry after 401 carries rotated JWT', async () => {
    const tokens = makeTokens({ jwt: 'jwt-original', jwtExpiresAt: Date.now() + 3_600_000 });
    const creds = makeCreds();
    const { client, auth } = makeClient({ tokens, creds });

    const authHeadersSeen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/customers/login')) {
        return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-rotated' }));
      }
      // Capture the Authorization header on each data request
      const headers = init?.headers as Record<string, string>;
      if (headers?.authorization) authHeadersSeen.push(headers.authorization);
      // First data call: 401. Second: 200.
      if (authHeadersSeen.length === 1) {
        return makeMockResponse({ message: 'unauthorized' }, { status: 401 });
      }
      return makeMockResponse({ data: 'ok' });
    }) as any;

    await client.authedFetch('/some/path');

    // First attempt used original JWT, retry used rotated JWT
    expect(authHeadersSeen).toContain('Bearer jwt-original');
    expect(authHeadersSeen).toContain('Bearer jwt-rotated');
    expect(auth.currentAuthGeneration).toBeGreaterThan(0);
  });

  // 11. all waiters observe rejection, then successful retry works
  it('all waiters observe rejection then a successful retry works', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    let refreshFail = true;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        if (refreshFail) {
          return makeMockResponse({ message: 'fail' }, { status: 401 });
        }
        return makeMockResponse(mockRefreshResponse({ jwt: 'jwt-recovered' }));
      }
      return makeMockResponse({ message: 'login fail' }, { status: 401 });
    }) as any;

    const results = await Promise.allSettled([
      auth.ensureValid(),
      auth.ensureValid(),
      auth.ensureValid(),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    refreshFail = false;
    await auth.ensureValid();
    expect(auth.currentTokens?.jwt).toBe('jwt-recovered');
  });

  // 12. waiter test: refreshed tokens remain inside skew, generation check returns (no infinite loop)
  it('refreshed tokens within skew: generation check prevents infinite loop', async () => {
    // Tokens near expiry so ensureValid triggers a refresh.
    // The refresh returns max_age: 1 (1s), so the refreshed tokens are STILL within REFRESH_SKEW_MS.
    // The generation check (authGeneration !== generationAtEntry) must break the loop
    // after the refresh completes, preventing an infinite refresh cycle.
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const { auth, persist } = makeAuthManager({ tokens });

    let refreshCallCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        refreshCallCount++;
        const t = makeTokens({ jwt: 'jwt-fresh' });
        return makeMockResponse({
          auth_info: {
            jwt: t.jwt,
            id_token: t.idToken,
            refresh_token: t.refreshToken,
            csrf_token: t.csrfToken,
            tracking_id: t.trackingId,
            customer_id: t.customerId,
            did: t.did,
            max_age: 1,  // 1 second — still within REFRESH_SKEW_MS (60s)
          },
        });
      }
      return makeMockResponse({});
    }) as any;

    // Single ensureValid call: triggers refresh, generation changes, loop exits
    // even though tokens are still within skew. Without the generation check,
    // the loop would keep refreshing forever.
    await auth.ensureValid();

    expect(refreshCallCount).toBe(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-fresh');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  // 13. combined Set-Cookie with Expires date containing comma (fallback path)
  it('extractCfBmCookie parses __cf_bm from combined Set-Cookie with Expires date via fallback', () => {
    // __cf_bm is NOT first; another cookie with Expires=Thu, 13 Aug 2026 comes before it
    const raw = 'other_cookie=xyz; Path=/; Expires=Thu, 13 Aug 2026 12:00:00 GMT; HttpOnly, __cf_bm=abc123; Path=/; Domain=takealot.com; HttpOnly; Secure';
    const res = makeMockResponseNoSetCookie({}, { setCookieRaw: raw });

    const result = extractCfBmCookie(res);
    expect(result).toBe('__cf_bm=abc123');
  });
});
