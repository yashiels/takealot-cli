/**
 * AuthManager — owns the token lifecycle for the Takealot API.
 *
 * - login(): POST /customers/login, parse auth_info into a TokenSet.
 * - refresh(): POST /customers/auth/refresh using the (rotating) refresh_token.
 * - ensureValid(): refresh proactively when the jwt is near expiry, falling back
 *   to a full re-login with stored credentials if refresh fails.
 *
 * The jwt lives ~1h; the refresh_token rotates on every use, so the new one is
 * persisted immediately via the injected `persist` callback.
 */

import type { Credentials, TokenSet } from '../types.js';

/** Refresh the jwt this many ms before its stated expiry. */
const REFRESH_SKEW_MS = 60_000;
/** Default jwt lifetime when the server doesn't tell us (max_age: 3600). */
const DEFAULT_JWT_TTL_MS = 3_600_000;

export interface AuthManagerOptions {
  apiBase: string;
  userAgent: string;
  platform: string;
  /** Returns stored credentials for (re)login, or null if none saved. */
  getCredentials: () => Credentials | null;
  /** Called whenever the token set changes so callers can persist it. */
  persist: (tokens: TokenSet) => void;
  log: (msg: string) => void;
}

/** Pull a TokenSet out of a login/refresh response body. */
function parseAuthInfo(data: unknown): TokenSet {
  const root = (data ?? {}) as Record<string, any>;
  const info = (root.auth_info ?? root.response?.auth_info ?? root) as Record<string, any>;

  const jwt: string | undefined = info.jwt ?? info.access_token;
  const customerId: number | undefined = info.customer_id;

  if (!jwt || customerId === undefined || customerId === null) {
    const msg = root.message ?? info.message ?? 'invalid credentials or unexpected response';
    throw new Error(`Authentication failed: ${msg}`);
  }

  const ttlMs =
    typeof info.max_age === 'number' && info.max_age > 0
      ? info.max_age * 1000
      : DEFAULT_JWT_TTL_MS;

  return {
    jwt,
    idToken: info.id_token ?? '',
    refreshToken: info.refresh_token ?? '',
    csrfToken: info.csrf_token ?? '',
    trackingId: info.tracking_id ?? '',
    did: info.did ?? undefined,
    customerId,
    jwtExpiresAt: Date.now() + ttlMs,
  };
}

export class AuthManager {
  private tokens: TokenSet | null;

  constructor(
    private opts: AuthManagerOptions,
    tokens: TokenSet | null = null,
  ) {
    this.tokens = tokens;
  }

  get isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  get customerId(): number | null {
    return this.tokens?.customerId ?? null;
  }

  get trackingId(): string | null {
    return this.tokens?.trackingId ?? null;
  }

  get currentTokens(): TokenSet | null {
    return this.tokens;
  }

  /** Headers required for authenticated requests. */
  authHeaders(): Record<string, string> {
    const t = this.tokens;
    if (!t) return {};
    const headers: Record<string, string> = {
      authorization: `Bearer ${t.jwt}`,
    };
    if (t.csrfToken) headers['x-csrf-token'] = t.csrfToken;
    if (t.did) headers['tal-did'] = t.did;
    const cookie = this.cookieHeader();
    if (cookie) headers['cookie'] = cookie;
    return headers;
  }

  /** Cookie header mirroring the mobile app: taid / tal_jwt / tal_csrf / did. */
  cookieHeader(): string {
    const t = this.tokens;
    if (!t) return '';
    const parts: string[] = [];
    if (t.idToken) parts.push(`taid=${t.idToken}`);
    parts.push(`tal_jwt=${t.jwt}`);
    if (t.csrfToken) parts.push(`tal_csrf=${t.csrfToken}`);
    if (t.did) parts.push(`did=${t.did}`);
    return parts.join('; ');
  }

  private setTokens(tokens: TokenSet): TokenSet {
    this.tokens = tokens;
    this.opts.persist(tokens);
    return tokens;
  }

  async login(email: string, password: string): Promise<TokenSet> {
    this.opts.log('auth: login');
    const body = {
      platform: this.opts.platform,
      sections: [
        {
          section_id: 'customer_login',
          fields: [
            { field_id: 'email', value: email },
            { field_id: 'password', value: password },
            { field_id: 'captcha', value: '' },
          ],
        },
      ],
    };

    const res = await fetch(`${this.opts.apiBase}/customers/login`, {
      method: 'POST',
      headers: {
        accept: 'application/json, */*',
        'content-type': 'application/json',
        'user-agent': this.opts.userAgent,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(data as any)?.auth_info) {
      throw new Error(`Login failed (HTTP ${res.status}): ${(data as any)?.message ?? res.statusText}`);
    }
    return this.setTokens(parseAuthInfo(data));
  }

  async refresh(): Promise<TokenSet> {
    const t = this.tokens;
    if (!t?.refreshToken) throw new Error('No refresh token available');
    this.opts.log('auth: refresh');

    const res = await fetch(`${this.opts.apiBase}/customers/auth/refresh`, {
      method: 'POST',
      headers: {
        accept: 'application/json, */*',
        'content-type': 'application/json',
        'user-agent': this.opts.userAgent,
        authorization: `Bearer ${t.jwt}`,
      },
      body: JSON.stringify({
        platform: this.opts.platform,
        refresh_token: t.refreshToken,
        tracking_id: t.trackingId,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(data as any)?.auth_info) {
      throw new Error(`Token refresh failed (HTTP ${res.status})`);
    }
    return this.setTokens(parseAuthInfo(data));
  }

  /** Ensure we hold a usable jwt, logging in or refreshing as needed. */
  async ensureValid(): Promise<void> {
    if (!this.tokens) {
      const creds = this.opts.getCredentials();
      if (!creds) {
        throw new Error('Not authenticated. Run `takealot login` first.');
      }
      await this.login(creds.email, creds.password);
      return;
    }

    if (Date.now() >= this.tokens.jwtExpiresAt - REFRESH_SKEW_MS) {
      try {
        await this.refresh();
      } catch (err) {
        this.opts.log(`auth: refresh failed (${(err as Error).message}); trying re-login`);
        const creds = this.opts.getCredentials();
        if (!creds) throw err;
        await this.login(creds.email, creds.password);
      }
    }
  }

  /** Force a fresh login + token rotation after an unexpected 401. */
  async reauthenticate(): Promise<void> {
    const creds = this.opts.getCredentials();
    if (creds) {
      await this.login(creds.email, creds.password);
      return;
    }
    await this.refresh();
  }
}
