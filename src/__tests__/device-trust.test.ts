import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager, extractSetCookie, cookieValue } from '../lib/auth.js';
import { buildUserAgent, DEFAULT_DEVICE_PROFILE } from '../lib/device.js';
import type { Credentials, DeviceRecord, TokenSet } from '../types.js';

const API_BASE = 'https://api.takealot.com/rest/v-1-16-0';

function makeTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    jwt: 'jwt-1',
    idToken: 'id-1',
    refreshToken: 'refresh-1',
    csrfToken: 'csrf-1',
    trackingId: 'track-1',
    did: undefined,
    customerId: 1,
    jwtExpiresAt: Date.now() + 10_000,
    ...overrides,
  };
}

function authInfoBody(tokens: Partial<TokenSet> = {}) {
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

function mockResponse(body: unknown, setCookie: string[] = [], status = 200) {
  const ok = status >= 200 && status < 300;
  const headers = new Headers();
  for (const c of setCookie) headers.append('set-cookie', c);
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function noGetSetCookieResponse(body: unknown, raw: string) {
  const headers = new Headers();
  headers.set('set-cookie', raw);
  Object.defineProperty(headers, 'getSetCookie', { value: undefined });
  return { ok: true, status: 200, statusText: 'OK', headers, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function makeAuth(opts: {
  tokens?: TokenSet | null;
  device?: DeviceRecord;
  creds?: Credentials | null;
  onDid?: (did: string) => void;
}) {
  return new AuthManager(
    {
      apiBase: API_BASE,
      userAgent: buildUserAgent(DEFAULT_DEVICE_PROFILE),
      platform: 'android',
      getCredentials: () => opts.creds ?? null,
      persist: () => {},
      log: () => {},
      getDevice: () => opts.device,
      onDid: opts.onDid,
    },
    opts.tokens ?? null,
  );
}

let capturedHeaders: Array<Record<string, string>> = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  capturedHeaders = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function scriptFetch(handler: (url: string) => Response) {
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return handler(String(url));
  }) as any;
}

describe('device profile + UA', () => {
  it('buildUserAgent renders the mobile UA from the profile', () => {
    expect(buildUserAgent(DEFAULT_DEVICE_PROFILE)).toBe(
      'TAL-Android/4.2.2 (fi.android.takealot; build:800750; 14; samsung; SM-S928B; Phone)',
    );
    expect(
      buildUserAgent({ androidRelease: '15', brand: 'google', model: 'Pixel 9', appVersion: '4.2.2', appBuild: '800750' }),
    ).toBe('TAL-Android/4.2.2 (fi.android.takealot; build:800750; 15; google; Pixel 9; Phone)');
  });
});

describe('extractSetCookie / cookieValue', () => {
  it('parses did from a getSetCookie() array', () => {
    const res = mockResponse({}, ['did=DID123; Path=/; HttpOnly', '__cf_bm=cf1; Path=/']);
    expect(extractSetCookie(res, 'did')).toBe('did=DID123');
    expect(cookieValue(res, 'did')).toBe('DID123');
    expect(cookieValue(res, '__cf_bm')).toBe('cf1');
  });

  it('parses did from a combined set-cookie header with an Expires comma (fallback)', () => {
    const raw =
      'other=x; Expires=Thu, 13 Aug 2026 12:00:00 GMT; HttpOnly, did=DID_after_comma; Path=/; Secure';
    const res = noGetSetCookieResponse({}, raw);
    expect(cookieValue(res, 'did')).toBe('DID_after_comma');
  });
});

describe('TAL-Did on every request', () => {
  it('login sends TAL-Did header + did cookie when a did exists; none when absent', async () => {
    // With a did.
    scriptFetch(() => mockResponse(authInfoBody()));
    const withDid = makeAuth({ tokens: null, device: { did: 'DID-XYZ', profile: DEFAULT_DEVICE_PROFILE } });
    await withDid.login('a@b.com', 'pw');
    expect(capturedHeaders[0]!['tal-did']).toBe('DID-XYZ');
    expect(capturedHeaders[0]!['cookie']).toContain('did=DID-XYZ');

    // Without a did (first ever contact).
    capturedHeaders = [];
    scriptFetch(() => mockResponse(authInfoBody()));
    const noDid = makeAuth({ tokens: null, device: { profile: DEFAULT_DEVICE_PROFILE } });
    await noDid.login('a@b.com', 'pw');
    expect(capturedHeaders[0]!['tal-did']).toBeUndefined();
    expect(capturedHeaders[0]!['cookie']).toBeUndefined();
  });

  it('refresh sends TAL-Did header + did cookie', async () => {
    scriptFetch(() => mockResponse(authInfoBody()));
    const auth = makeAuth({
      tokens: makeTokens({ jwtExpiresAt: Date.now() + 10_000 }),
      device: { did: 'DID-R', profile: DEFAULT_DEVICE_PROFILE },
    });
    await auth.refresh();
    expect(capturedHeaders[0]!['tal-did']).toBe('DID-R');
    expect(capturedHeaders[0]!['cookie']).toContain('did=DID-R');
  });

  it('OTP request-2 merges __cf_bm AND did into ONE cookie header', async () => {
    let call = 0;
    scriptFetch(() => {
      call++;
      if (call === 1) {
        return mockResponse(
          { two_step_verification: 'enabled_untrusted', otp_status: { valid_millis: 300000 } },
          ['__cf_bm=CF-COOKIE; Path=/', 'did=DID-1; Path=/'],
        );
      }
      return mockResponse(authInfoBody({ jwt: 'jwt-otp' }));
    });
    const auth = makeAuth({ tokens: null, device: { profile: DEFAULT_DEVICE_PROFILE } });
    await auth.loginWithOtp('a@b.com', 'pw', async () => '12345');
    // Second request's cookie must carry both, once.
    const secondCookie = capturedHeaders[1]!['cookie'] ?? '';
    expect(secondCookie).toContain('__cf_bm=CF-COOKIE');
    // did was captured from request-1's Set-Cookie and replayed in request-2.
    expect(secondCookie).toContain('did=DID-1');
    expect(capturedHeaders[1]!['tal-did']).toBe('DID-1');
    expect(auth.currentTokens?.jwt).toBe('jwt-otp');
  });
});

describe('did capture', () => {
  it('captures did from Set-Cookie when the body omits it', async () => {
    const seen: string[] = [];
    scriptFetch(() => mockResponse(authInfoBody({ did: undefined }), ['did=FROM_COOKIE; Path=/']));
    const auth = makeAuth({ tokens: null, device: { profile: DEFAULT_DEVICE_PROFILE }, onDid: (d) => seen.push(d) });
    await auth.login('a@b.com', 'pw');
    expect(seen).toEqual(['FROM_COOKIE']);
  });

  it('captures did from the body when Set-Cookie omits it', async () => {
    const seen: string[] = [];
    scriptFetch(() => mockResponse(authInfoBody({ did: 'FROM_BODY' }), []));
    const auth = makeAuth({ tokens: null, device: { profile: DEFAULT_DEVICE_PROFILE }, onDid: (d) => seen.push(d) });
    await auth.login('a@b.com', 'pw');
    expect(seen).toEqual(['FROM_BODY']);
  });

  it('prefers the Set-Cookie did over the body did on conflict', async () => {
    const seen: string[] = [];
    scriptFetch(() => mockResponse(authInfoBody({ did: 'FROM_BODY' }), ['did=FROM_COOKIE; Path=/']));
    const auth = makeAuth({ tokens: null, device: { profile: DEFAULT_DEVICE_PROFILE }, onDid: (d) => seen.push(d) });
    await auth.login('a@b.com', 'pw');
    expect(seen).toEqual(['FROM_COOKIE']);
  });

  it('adopts a rotated did on refresh', async () => {
    const seen: string[] = [];
    scriptFetch(() => mockResponse(authInfoBody(), ['did=ROTATED; Path=/']));
    const auth = makeAuth({
      tokens: makeTokens({ jwtExpiresAt: Date.now() + 10_000 }),
      device: { did: 'OLD', profile: DEFAULT_DEVICE_PROFILE },
      onDid: (d) => seen.push(d),
    });
    await auth.refresh();
    expect(seen).toEqual(['ROTATED']);
  });

  it('does not re-fire onDid when the did is unchanged', async () => {
    const seen: string[] = [];
    scriptFetch(() => mockResponse(authInfoBody(), ['did=SAME; Path=/']));
    const auth = makeAuth({
      tokens: makeTokens({ jwtExpiresAt: Date.now() + 10_000 }),
      device: { did: 'SAME', profile: DEFAULT_DEVICE_PROFILE },
      onDid: (d) => seen.push(d),
    });
    await auth.refresh();
    expect(seen).toEqual([]);
  });
});
