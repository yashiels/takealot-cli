import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager, extractCfBmCookie } from '../lib/auth.js';
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
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 }); // near expiry
    const { auth, persist } = makeAuthManager({ tokens });

    const fetchCalls: string[] = [];
    const refreshPromise = Promise.resolve(mockRefreshResponse({ jwt: 'jwt-new' }));
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return makeMockResponse(refreshPromise as any);
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
          // First login call: 2FA challenge
          const res = makeMockResponse(mock2faChallengeResponse(), {
            setCookie: ['__cf_bm=cfcookie123; Path=/; Domain=takealot.com'],
          });
          return res;
        }
        // Second login call: OTP submission success
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

    let refreshAttempted = false;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        if (!refreshAttempted) {
          refreshAttempted = true;
          return makeMockResponse({ message: 'fail' }, { status: 401 });
        }
        return makeMockResponse(mockRefreshResponse({ jwt: 'jwt-retry' }));
      }
      if (u.includes('/customers/login')) {
        return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-login-fallback' }));
      }
      return makeMockResponse({}, { status: 500 });
    }) as any;

    // First ensureValid should reject (refresh fails, no creds for login fallback... wait creds exist)
    // Actually creds exist, so it will fall back to login. Let's make login fail too on first pass.
    // Re-adjust: make login also fail first time
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

    // First call should throw
    await expect(auth.ensureValid()).rejects.toThrow();

    // Second call should succeed (lock cleared)
    // Need fresh creds since login failed - creds still exist
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

  // 5. ensureValid with valid tokens overlapping reauthenticate: no transition triggered
  it('ensureValid with valid tokens does not trigger any transition', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 3_600_000 }); // far from expiry
    const { auth, persist } = makeAuthManager({ tokens });

    globalThis.fetch = vi.fn(async () => {
      return makeMockResponse({});
    }) as any;

    await auth.ensureValid();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  // 6. concurrent 401s for same auth generation: one underlying auth transition
  it('concurrent 401s for same generation trigger one reauthenticate', async () => {
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 3_600_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      fetchCalls.push(String(url));
      return makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-reauth' }));
    }) as any;

    const gen = auth.currentAuthGeneration;
    await Promise.all([
      auth.reauthenticateIfCurrent(gen),
      auth.reauthenticateIfCurrent(gen),
    ]);

    // Only one login call should have happened
    expect(fetchCalls.filter((u) => u.includes('/customers/login'))).toHaveLength(1);
    expect(auth.currentTokens?.jwt).toBe('jwt-reauth');
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

    // Should have done one refresh (failed) + one login (success)
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
    // Start reauthenticate first
    const reauthP = auth.reauthenticateIfCurrent(gen);
    // ensureValid should wait for it, then fast-path (tokens valid now)
    await Promise.all([reauthP, auth.ensureValid()]);

    // Only one login call from reauthenticate
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
      // Small delay to increase chance of overlap
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

  // 10. assert retry sends rotated JWT (new auth generation)
  it('retry after reauth uses rotated JWT from new generation', async () => {
    const tokens = makeTokens({ jwt: 'jwt-original', jwtExpiresAt: Date.now() + 3_600_000 });
    const creds = makeCreds();
    const { auth } = makeAuthManager({ tokens, creds });

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/customers/login')) {
        const res = makeMockResponse(mockAuthInfoResponse({ jwt: 'jwt-rotated' }));
        return res;
      }
      return makeMockResponse({});
    }) as any;

    expect(auth.authHeaders()['authorization']).toBe('Bearer jwt-original');

    await auth.reauthenticateIfCurrent(auth.currentAuthGeneration);

    expect(auth.authHeaders()['authorization']).toBe('Bearer jwt-rotated');
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
      // Login also fails on first pass
      return makeMockResponse({ message: 'login fail' }, { status: 401 });
    }) as any;

    // Three concurrent ensureValid calls should all reject
    const results = await Promise.allSettled([
      auth.ensureValid(),
      auth.ensureValid(),
      auth.ensureValid(),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    // Now fix refresh and retry
    refreshFail = false;
    await auth.ensureValid();
    expect(auth.currentTokens?.jwt).toBe('jwt-recovered');
  });

  // 12. waiter test: refreshed tokens remain inside skew, generation check returns (no infinite loop)
  it('refreshed tokens within skew: ensureValid returns without infinite loop', async () => {
    // Tokens near expiry but will be refreshed to far-future expiry
    const tokens = makeTokens({ jwtExpiresAt: Date.now() + 10_000 });
    const { auth, persist } = makeAuthManager({ tokens });

    let refreshCalled = false;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/auth/refresh')) {
        refreshCalled = true;
        return makeMockResponse(mockRefreshResponse({
          jwt: 'jwt-fresh',
          jwtExpiresAt: Date.now() + 3_600_000,
        }));
      }
      return makeMockResponse({});
    }) as any;

    await auth.ensureValid();

    expect(refreshCalled).toBe(true);
    expect(auth.currentTokens?.jwt).toBe('jwt-fresh');
    expect(persist).toHaveBeenCalledTimes(1);

    // Second call should NOT trigger another refresh (tokens are valid, generation changed)
    refreshCalled = false;
    await auth.ensureValid();
    expect(refreshCalled).toBe(false);
  });

  // 13. combined Set-Cookie with Expires date containing comma
  it('extractCfBmCookie parses __cf_bm from combined Set-Cookie with Expires date', () => {
    const raw = '__cf_bm=abc123; Path=/; Domain=takealot.com; Expires=Thu, 13 Aug 2026 12:00:00 GMT; HttpOnly; Secure, other_cookie=xyz; Path=/';
    const headers = new Headers();
    headers.append('set-cookie', raw);

    const res = {
      headers,
    } as unknown as Response;

    const result = extractCfBmCookie(res);
    expect(result).toBe('__cf_bm=abc123');
  });
});
