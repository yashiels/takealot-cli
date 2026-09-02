/**
 * AuthManager — owns the token lifecycle for the Takealot API.
 *
 * - login(): POST /customers/login, parse auth_info into a TokenSet.
 * - loginWithOtp(): two-step login with OTP support.
 * - refresh(): POST /customers/auth/refresh using the (rotating) refresh_token.
 * - ensureValid(): refresh proactively when the jwt is near expiry, falling back
 *   to a full re-login with stored credentials if refresh fails.
 *
 * The jwt lives ~1h; the refresh_token rotates on every use, so the new one is
 * persisted immediately via the injected `persist` callback.
 */

import type { Credentials, DeviceRecord, TokenSet } from '../types.js';

/** Refresh the jwt this many ms before its stated expiry. */
const REFRESH_SKEW_MS = 60_000;
/** Default jwt lifetime when the server doesn't tell us (max_age: 3600). */
const DEFAULT_JWT_TTL_MS = 3_600_000;

/**
 * The one serialized cross-process credentials transaction (see config.ts
 * `withCredentials`). Hands the callback a fresh on-disk snapshot plus a
 * `save(patch)` that field-merges and atomically writes it back.
 */
export type CredentialsTransaction = <T>(
  fn: (snapshot: Credentials | null, save: (patch: Partial<Credentials>) => Credentials) => Promise<T>,
) => Promise<T>;

export interface AuthManagerOptions {
  apiBase: string;
  userAgent: string;
  platform: string;
  /** Returns stored credentials for (re)login, or null if none saved. */
  getCredentials: () => Credentials | null;
  /** Called (and awaited) whenever the token set changes so callers can persist it. */
  persist: (tokens: TokenSet) => void | Promise<void>;
  log: (msg: string) => void;
  /** Optional OTP provider for 2FA. When set, ensureValid() and reauthenticateIfCurrent()
   *  use loginWithOtp() so re-login can complete 2FA challenges. */
  otpProvider?: () => Promise<string>;
  /**
   * Optional serialized credentials transaction. When provided, the refresh
   * path runs inside it with reload-and-skip so two processes sharing one
   * credentials file never invalidate each other's rotating refresh token —
   * whichever refreshes first wins, the other adopts its result and skips the
   * network. When absent (unit tests, in-process-only use) behaviour is
   * unchanged.
   */
  transaction?: CredentialsTransaction;
  /** Returns the current device record (server-assigned did + mocked profile). */
  getDevice?: () => DeviceRecord | undefined;
  /**
   * Called (memory-only, never takes the credentials lock) when a `did` is
   * captured from a response, so the caller can adopt it in-memory. Disk
   * persistence happens through the normal persist / transaction save paths.
   */
  onDid?: (did: string) => void;
}

/** A 2FA challenge captured by `beginLogin`, replayed verbatim by `completeLogin`. */
export interface OtpChallenge {
  /** The Cloudflare `__cf_bm=...` cookie required by request-2. */
  cfBm: string;
  /** did captured from request-1 (replayed in request-2). */
  did?: string;
  /** Masked destination the OTP was sent to, if the server said. */
  otpSentTo?: string;
  /** Server validity window (otp_status.valid_millis), ms. */
  validMs: number;
}

export type BeginLoginResult = { tokens: TokenSet } | { challenge: OtpChallenge };

/** Same-account guard for reload-and-skip: an unknown acting account assumes the stored one. */
function sameAccount(snapshot: Credentials | null, email: string | undefined): boolean {
  if (!snapshot) return false;
  if (!email) return true;
  return !snapshot.email || snapshot.email.toLowerCase() === email.toLowerCase();
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

/** Build the login request body sections, with optional OTP section. */
function loginBody(
  platform: string,
  email: string,
  password: string,
  otp?: string,
  trustDevice?: boolean,
) {
  const sections: Array<{
    section_id: string;
    fields: Array<{ field_id: string; value: string | boolean }>;
  }> = [
    {
      section_id: 'customer_login',
      fields: [
        { field_id: 'email', value: email },
        { field_id: 'password', value: password },
        { field_id: 'captcha', value: '' },
      ],
    },
  ];
  if (otp !== undefined) {
    sections.push({
      section_id: 'two_step_verification',
      fields: [
        { field_id: 'otp', value: otp },
        { field_id: 'trust_this_device', value: trustDevice ?? true },
      ],
    });
  }
  return { platform, sections };
}

/**
 * Extract a named cookie from a fetch Response's Set-Cookie header(s), returning
 * `name=value` (or '' if absent). Handles both `getSetCookie()` (Node 18.14+)
 * and the combined `set-cookie` header where Expires dates contain commas.
 */
export function extractSetCookie(res: Response, name: string): string {
  const prefix = `${name}=`;
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) {
      const semi = cookie.indexOf(';');
      return semi > 0 ? cookie.substring(0, semi) : cookie;
    }
  }
  const raw = res.headers.get('set-cookie');
  if (raw) {
    // Anchor on a cookie boundary (start or ", ") so an Expires date's comma
    // (e.g. "Expires=Thu, 13 Aug 2026") is never mistaken for a boundary.
    const re = new RegExp(`(?:^|,\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;,]*)`);
    const match = raw.match(re);
    if (match && match[1]) return `${name}=${match[1].trim()}`;
  }
  return '';
}

/** The value of a named Set-Cookie (without the `name=`), or '' if absent. */
export function cookieValue(res: Response, name: string): string {
  const kv = extractSetCookie(res, name);
  return kv ? kv.slice(name.length + 1) : '';
}

/** Backwards-compatible helper: the `__cf_bm=...` cookie from a 2FA challenge. */
export function extractCfBmCookie(res: Response): string {
  return extractSetCookie(res, '__cf_bm');
}

export class AuthManager {
  private tokens: TokenSet | null;
  private authGeneration = 0;
  private authInFlight: Promise<void> | null = null;
  /** did captured this process — used immediately (e.g. OTP req1→req2) even before onDid propagates. */
  private capturedDid?: string;

  constructor(
    private opts: AuthManagerOptions,
    tokens: TokenSet | null = null,
  ) {
    this.tokens = tokens;
  }

  get currentAuthGeneration(): number { return this.authGeneration; }

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

  /** The device id to present: persisted device did → did captured this run → token's. */
  private currentDid(): string | undefined {
    return this.opts.getDevice?.()?.did ?? this.capturedDid ?? this.tokens?.did;
  }

  /**
   * `TAL-Did` header + `did` cookie fragment to attach to EVERY request — login,
   * refresh, and authed calls alike — so the server recognises the (trusted)
   * device and skips the 2FA challenge. `extraCookies` are merged into the single
   * `cookie` header (e.g. the `__cf_bm` cookie during the OTP handshake).
   */
  deviceHeaders(extraCookies: string[] = []): Record<string, string> {
    const did = this.currentDid();
    const headers: Record<string, string> = {};
    if (did) headers['tal-did'] = did;
    const cookieParts = [...extraCookies.filter(Boolean)];
    if (did) cookieParts.push(`did=${did}`);
    if (cookieParts.length) headers['cookie'] = cookieParts.join('; ');
    return headers;
  }

  /** Capture a server-assigned `did` from a response (Set-Cookie wins over body). */
  private captureDid(res: Response, data: any): string | undefined {
    const info = data?.auth_info ?? data?.response?.auth_info ?? data ?? {};
    const did = cookieValue(res, 'did') || info?.did || data?.did || undefined;
    if (did && did !== this.currentDid()) {
      this.opts.log('auth: captured device did'); // never log any did fragment
      this.capturedDid = did;
      this.opts.onDid?.(did);
    }
    return did || undefined;
  }

  /** Headers required for authenticated requests. */
  authHeaders(): Record<string, string> {
    const t = this.tokens;
    if (!t) return {};
    const headers: Record<string, string> = {
      authorization: `Bearer ${t.jwt}`,
    };
    if (t.csrfToken) headers['x-csrf-token'] = t.csrfToken;
    const did = this.currentDid();
    if (did) headers['tal-did'] = did;
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
    const did = this.currentDid();
    if (did) parts.push(`did=${did}`);
    return parts.join('; ');
  }

  private async setTokens(tokens: TokenSet): Promise<TokenSet> {
    this.tokens = tokens;
    this.authGeneration++;
    // Persist is awaited (locked, cross-process safe in Context); never called
    // from inside the credentials transaction, so it cannot self-deadlock.
    await this.opts.persist(tokens);
    return tokens;
  }

  /** Adopt a token set into memory WITHOUT persisting (the transaction's save() writes). */
  private adoptTokens(tokens: TokenSet): TokenSet {
    this.tokens = tokens;
    this.authGeneration++;
    return tokens;
  }

  private isFresh(tokens: TokenSet): boolean {
    return Date.now() < tokens.jwtExpiresAt - REFRESH_SKEW_MS;
  }

  /**
   * Single-step login (email + password only). For accounts without 2FA.
   * For accounts with 2FA, use loginWithOtp() instead.
   */
  async login(email: string, password: string): Promise<TokenSet> {
    this.opts.log('auth: login');
    const body = loginBody(this.opts.platform, email, password);

    const res = await fetch(`${this.opts.apiBase}/customers/login`, {
      method: 'POST',
      headers: {
        accept: 'application/json, */*',
        'content-type': 'application/json',
        'user-agent': this.opts.userAgent,
        ...this.deviceHeaders(),
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(data as any)?.auth_info) {
      throw new Error(`Login failed (HTTP ${res.status}): ${(data as any)?.message ?? res.statusText}`);
    }
    this.captureDid(res, data);
    return this.setTokens(parseAuthInfo(data));
  }

  /**
   * Request-1 of the two-step login: submit credentials (with the device's
   * TAL-Did). Returns `{ tokens }` when the device is trusted / the account has
   * no 2FA, or `{ challenge }` carrying the __cf_bm cookie and the request-1 did
   * for a separate `completeLogin`. Captures + adopts the server did either way.
   */
  async beginLogin(email: string, password: string): Promise<BeginLoginResult> {
    this.opts.log('auth: login request-1');
    const body = loginBody(this.opts.platform, email, password);

    const res = await fetch(`${this.opts.apiBase}/customers/login`, {
      method: 'POST',
      headers: {
        accept: 'application/json, */*',
        'content-type': 'application/json',
        'user-agent': this.opts.userAgent,
        ...this.deviceHeaders(),
      },
      body: JSON.stringify(body),
    });

    const cfBmCookie = extractCfBmCookie(res);
    this.opts.log(`auth: __cf_bm cookie ${cfBmCookie ? 'captured' : 'not found'}`);

    const data = await res.json().catch(() => ({}));

    // A trusted device is recognised by its TAL-Did, so request-1 already carries
    // the server's did — capture it before anything else.
    const did = this.captureDid(res, data);

    const twoStepVerification = (data as any)?.two_step_verification as string | undefined;
    if (twoStepVerification !== 'enabled_untrusted') {
      if (!res.ok && !(data as any)?.auth_info) {
        throw new Error(
          `Login failed (HTTP ${res.status}): ${(data as any)?.message ?? res.statusText}`,
        );
      }
      return { tokens: await this.setTokens(parseAuthInfo(data)) };
    }

    this.opts.log(`auth: 2FA required (${twoStepVerification})`);

    // Exhausted OTP budget → HTTP 400 with otp_status.status 'cooldown', no SMS.
    const otpStatus = (data as any)?.otp_status as
      | { status?: string; cooldown_end_timestamp?: string; valid_millis?: number }
      | undefined;
    if (otpStatus?.status === 'cooldown') {
      const until = otpStatus.cooldown_end_timestamp
        ? ` Try again after ${otpStatus.cooldown_end_timestamp}.`
        : '';
      throw new Error(
        `Two-step verification is in cooldown — too many OTP attempts and no new code was sent.${until}`,
      );
    }

    if (!cfBmCookie) {
      throw new Error(
        'Two-step verification started, but the required __cf_bm cookie was not returned.',
      );
    }

    const otpSentTo =
      (data as any)?.otp_sent_to ??
      (data as any)?.otp_status?.destination ??
      undefined;
    return {
      challenge: {
        cfBm: cfBmCookie,
        did,
        otpSentTo,
        validMs: typeof otpStatus?.valid_millis === 'number' ? otpStatus.valid_millis : 300_000,
      },
    };
  }

  /**
   * Request-2 of the two-step login: submit creds + OTP + trust_this_device,
   * replaying the exact `did` and `__cf_bm` from the challenge in ONE cookie
   * header. Safe to call in a fresh process (nothing but the challenge is
   * needed). Never re-fires request-1.
   */
  async completeLogin(
    email: string,
    password: string,
    otp: string,
    challenge: OtpChallenge,
  ): Promise<TokenSet> {
    if (!otp || !/^\d+$/.test(otp)) {
      throw new Error('Invalid OTP: must be numeric digits only');
    }
    // Ensure the challenge's did is what we present (this process may hold none).
    if (challenge.did) this.capturedDid = challenge.did;

    const otpBody = loginBody(this.opts.platform, email, password, otp, true);
    const headers: Record<string, string> = {
      accept: 'application/json, */*',
      'content-type': 'application/json',
      'user-agent': this.opts.userAgent,
      ...this.deviceHeaders(challenge.cfBm ? [challenge.cfBm] : []),
    };

    this.opts.log('auth: submitting OTP (request-2)');
    const res = await fetch(`${this.opts.apiBase}/customers/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify(otpBody),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(data as any)?.auth_info) {
      throw new Error(
        `OTP login failed (HTTP ${res.status}): ${(data as any)?.message ?? res.statusText}`,
      );
    }
    this.captureDid(res, data);
    this.opts.log('auth: OTP accepted, login complete');
    return this.setTokens(parseAuthInfo(data));
  }

  /**
   * Two-step login that resolves the OTP inline via `otpPromise` (interactive /
   * background otpProvider path). A trusted device returns tokens without ever
   * calling `otpPromise`.
   */
  async loginWithOtp(
    email: string,
    password: string,
    otpPromise: () => Promise<string>,
  ): Promise<TokenSet> {
    const started = await this.beginLogin(email, password);
    if ('tokens' in started) return started.tokens;
    const otp = await otpPromise();
    return this.completeLogin(email, password, otp, started.challenge);
  }

  /** Pure network refresh using the given base tokens; does not persist or adopt. */
  private async refreshNetwork(base: TokenSet): Promise<{ tokens: TokenSet; did?: string }> {
    if (!base.refreshToken) throw new Error('No refresh token available');
    this.opts.log('auth: refresh');

    const res = await fetch(`${this.opts.apiBase}/customers/auth/refresh`, {
      method: 'POST',
      headers: {
        accept: 'application/json, */*',
        'content-type': 'application/json',
        'user-agent': this.opts.userAgent,
        authorization: `Bearer ${base.jwt}`,
        ...this.deviceHeaders(),
      },
      body: JSON.stringify({
        platform: this.opts.platform,
        refresh_token: base.refreshToken,
        tracking_id: base.trackingId,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(data as any)?.auth_info) {
      throw new Error(`Token refresh failed (HTTP ${res.status})`);
    }
    const did = this.captureDid(res, data);
    const tokens = parseAuthInfo(data);
    // Keep the token's did in step with the device's (server may echo/rotate it).
    if (did) tokens.did = did;
    else if (this.currentDid()) tokens.did = this.currentDid();
    return { tokens, did };
  }

  async refresh(): Promise<TokenSet> {
    const t = this.tokens;
    if (!t?.refreshToken) throw new Error('No refresh token available');
    const { tokens } = await this.refreshNetwork(t);
    return this.setTokens(tokens);
  }

  /**
   * Refresh under the credentials transaction with reload-and-skip: if another
   * process already produced a fresh jwt for this account, adopt it instead of
   * refreshing (which would spend our now-rotated refresh token). Falls back to
   * a plain refresh when no transaction is wired.
   */
  private async refreshOrAdopt(): Promise<void> {
    const tx = this.opts.transaction;
    if (!tx) {
      await this.refresh();
      return;
    }
    await tx(async (snapshot, save) => {
      const acct = this.opts.getCredentials()?.email;
      const snapTokens = sameAccount(snapshot, acct) ? snapshot?.tokens : undefined;
      if (snapTokens && this.isFresh(snapTokens) && snapTokens.jwt !== this.tokens?.jwt) {
        this.opts.log('auth: adopting fresh tokens from another process (skip refresh)');
        this.adoptTokens(snapTokens);
        // Also adopt the device did the other process rotated + persisted, or we
        // would keep emitting a stale TAL-Did/did cookie — currentDid() prefers
        // getDevice().did, which onDid() refreshes. Prefer the persisted
        // device-level did; fall back to the adopted token's did.
        const adoptedDid = snapshot?.device?.did ?? snapTokens.did;
        if (adoptedDid && adoptedDid !== this.currentDid()) {
          this.capturedDid = adoptedDid;
          this.opts.onDid?.(adoptedDid);
        }
        return;
      }
      // Refresh from the freshest refresh token on disk (it may have rotated).
      const base = snapTokens ?? this.tokens ?? undefined;
      if (!base?.refreshToken) throw new Error('No refresh token available');
      const { tokens: newTokens, did } = await this.refreshNetwork(base);
      // Persist a rotated did into the device record in the SAME atomic write.
      const patch: Partial<Credentials> = { tokens: newTokens };
      if (did) {
        const profile = (snapshot?.device ?? this.opts.getDevice?.())?.profile;
        if (profile) patch.device = { profile, did };
      }
      save(patch);
      this.adoptTokens(newTokens);
    });
  }

  /**
   * Re-login helper: uses loginWithOtp when an otpProvider is available,
   * falling back to the single-step login() for non-2FA accounts.
   */
  private doLogin(creds: Credentials): Promise<TokenSet> {
    if (this.opts.otpProvider) {
      return this.loginWithOtp(creds.email, creds.password, this.opts.otpProvider);
    }
    return this.login(creds.email, creds.password);
  }

  /** Ensure we hold a usable jwt, logging in or refreshing as needed. */
  async ensureValid(): Promise<void> {
    const generationAtEntry = this.authGeneration;

    while (true) {
      // If a transition completed since we entered, we're done
      if (this.authGeneration !== generationAtEntry) return;
      // If a transition is in flight, await it then loop back to recheck
      if (this.authInFlight) {
        await this.authInFlight;
        continue;
      }
      // Fast path: tokens valid and no transition needed
      if (
        this.tokens &&
        Date.now() < this.tokens.jwtExpiresAt - REFRESH_SKEW_MS
      ) {
        return;
      }
      // Start a new transition
      this.authInFlight = this.doEnsureValid()
        .finally(() => { this.authInFlight = null; });
      await this.authInFlight;
      // If doEnsureValid threw, the await rejects and the error propagates
      // If it succeeded, generation changed and the loop will return
    }
  }

  private async doEnsureValid(): Promise<void> {
    if (!this.tokens) {
      const creds = this.opts.getCredentials();
      if (!creds) throw new Error('Not authenticated. Run `takealot login` first.');
      await this.doLogin(creds);
      return;
    }
    if (Date.now() >= this.tokens.jwtExpiresAt - REFRESH_SKEW_MS) {
      try {
        await this.refreshOrAdopt();
      } catch (err) {
        this.opts.log(`auth: refresh failed (${(err as Error).message}); trying re-login`);
        const creds = this.opts.getCredentials();
        if (!creds) throw err;
        await this.doLogin(creds);
      }
    }
  }

  /** Force a fresh login + token rotation after an unexpected 401.
   *  Only reauthenticates if the auth generation hasn't already changed. */
  async reauthenticateIfCurrent(expectedGeneration: number): Promise<void> {
    // Fast path: generation already changed
    if (this.authGeneration !== expectedGeneration) return;

    while (true) {
      if (this.authGeneration !== expectedGeneration) return;
      if (this.authInFlight) {
        await this.authInFlight;
        continue;
      }
      this.authInFlight = this.doReauthenticate()
        .finally(() => { this.authInFlight = null; });
      await this.authInFlight;
      return;  // generation changed, or it threw
    }
  }

  private async doReauthenticate(): Promise<void> {
    const creds = this.opts.getCredentials();
    if (creds) {
      await this.doLogin(creds);
      return;
    }
    await this.refresh();
  }
}