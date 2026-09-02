/**
 * Per-invocation context: loads config + credentials, wires up the AuthManager
 * (with token persistence) and the TakealotClient, and exposes helpers commands
 * use to obtain credentials (prompting + saving on first run).
 */

import * as crypto from 'node:crypto';
import { AuthManager } from './auth.js';
import { DEFAULTS, TakealotClient } from './api-client.js';
import { Logger } from './ui.js';
import { promptPassword, promptText } from './prompt.js';
import { buildUserAgent, profileHash, resolveDeviceProfile } from './device.js';
import {
  clearPendingOtp,
  emailHash,
  loadConfig,
  loadCredentials,
  loadPendingOtp,
  loadPreferences,
  withCredentials,
  writePendingOtp,
} from './config.js';
import type { Config, Credentials, DeviceRecord, PendingOtp, TokenSet } from '../types.js';

export interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
}

/** Machine-readable outcome of a login step (headless orchestrators branch on `status`). */
export type LoginOutcome =
  | { status: 'ok'; customerId: number }
  | { status: 'otp_required'; challenge: string; otpSentTo?: string; expiresInSec: number };

/** A structured 2FA-flow error whose `code` the login command surfaces under --json. */
export class OtpFlowError extends Error {
  constructor(
    readonly code: 'otp_required' | 'otp_state_mismatch' | 'otp_expired',
    message: string,
  ) {
    super(message);
    this.name = 'OtpFlowError';
  }
}

const mobileApiBaseOf = (config: Config): string => config.mobileApiBase ?? DEFAULTS.mobileApiBase;

export class Context {
  readonly logger: Logger;
  readonly config: Config;
  readonly client: TakealotClient;
  private creds: Credentials | null;
  private device: DeviceRecord;
  private readonly auth: AuthManager;

  constructor(opts: GlobalOptions) {
    this.logger = new Logger({ json: opts.json ?? false, verbose: opts.verbose ?? false });
    this.config = loadConfig();
    this.creds = loadCredentials();

    // The device profile is stable-once; the did is carried across token clears.
    const profile = this.creds?.device?.profile ?? resolveDeviceProfile(this.config);
    this.device = { profile, did: this.creds?.device?.did };
    const mobileUA = this.config.mobileUserAgent ?? buildUserAgent(profile);

    this.auth = new AuthManager(
      {
        apiBase: this.config.mobileApiBase ?? DEFAULTS.mobileApiBase,
        userAgent: mobileUA,
        platform: this.config.platform ?? DEFAULTS.platform,
        getCredentials: () => this.creds,
        persist: (tokens) => this.persistTokens(tokens),
        log: (msg) => this.logger.debug(msg),
        // Wire the OTP provider so ensureValid() and reauthenticateIfCurrent() can
        // handle 2FA on re-login when the account has it enabled.
        otpProvider: () => this.promptOtp(),
        // Serialize token rotation across processes: parallel invocations sharing
        // one credentials.json won't invalidate each other's rotating refresh token.
        transaction: (fn) => withCredentials(fn),
        // Device trust: present the server-assigned did on every request, and
        // adopt (in memory) any did captured from a response.
        getDevice: () => this.device,
        onDid: (did) => this.adoptDid(did),
      },
      this.creds?.tokens ?? null,
    );

    this.client = new TakealotClient({
      auth: this.auth,
      logger: this.logger,
      searchApiBase: this.config.searchApiBase,
      mobileApiBase: this.config.mobileApiBase,
      browserUserAgent: this.config.browserUserAgent,
      mobileUserAgent: mobileUA,
      history: loadPreferences(),
      preferredBrands: this.config.preferredBrands ?? [],
    });
  }

  get credentials(): Credentials | null {
    return this.creds;
  }

  /** Stable per-account hash for the acting account (form cache / pending order keys). */
  accountHash(): string {
    const email = process.env.TAKEALOT_EMAIL?.trim() || this.creds?.email;
    if (!email) throw new Error('No account — set TAKEALOT_EMAIL or run `takealot login`.');
    return emailHash(email);
  }

  /** Adopt a captured did into memory only (disk persistence rides the normal save paths). */
  private adoptDid(did: string): void {
    this.device = { ...this.device, did };
    if (this.creds) this.creds = { ...this.creds, device: this.device };
  }

  /**
   * Persist the acting account's tokens (and device) under the credentials
   * transaction — the SAME locked, atomic, account-gated merge the refresh path
   * uses — so concurrent login/re-login never clobbers a newer rotating token
   * set. Called (awaited) by the AuthManager's persist hook; never from inside
   * an already-held transaction, so it can't self-deadlock.
   */
  private async persistTokens(tokens: TokenSet): Promise<void> {
    if (!this.creds) return; // no stored login to attach tokens to
    const email = this.creds.email;
    const password = this.creds.password;
    await withCredentials(async (snapshot, save) => {
      // Account-gated device merge. The profile is stable-once. For the `did`,
      // prefer the value we hold in memory — this login/refresh just captured it
      // from the server, so it is the freshest — and fall back to the on-disk
      // did only when we hold none AND the record is the same account. Preferring
      // `snapshot.device` wholesale would roll a freshly rotated server `did` back
      // to the stale on-disk one and break device-trust continuity.
      const sameAccount =
        !!snapshot && (!snapshot.email || snapshot.email.toLowerCase() === email.toLowerCase());
      const keepDevice = {
        profile: this.device.profile,
        did: this.device.did ?? (sameAccount ? snapshot?.device?.did : undefined),
      };
      this.device = keepDevice;
      this.creds = save({ email, password, tokens, device: keepDevice });
    });
  }

  /** Set new email/password in memory. Persisted only after a successful login. */
  setCredentials(email: string, password: string): void {
    this.creds = { ...(this.creds ?? {}), email, password } as Credentials;
  }

  /**
   * Resolve the acting credentials. Explicit env (`TAKEALOT_EMAIL` +
   * `TAKEALOT_PASSWORD`) OVERRIDES stored credentials so an operator (e.g. via
   * op-sa) can replace a stale/wrong pair; a different env email is treated as a
   * different account (stored tokens are dropped, the device record is kept).
   * Otherwise fall back to stored, then an interactive prompt (TTY only).
   */
  async ensureCredentials(): Promise<Credentials> {
    const envEmail = process.env.TAKEALOT_EMAIL?.trim();
    const envPassword = process.env.TAKEALOT_PASSWORD;
    if (envEmail && envPassword) {
      const sameAccount = this.creds?.email?.toLowerCase() === envEmail.toLowerCase();
      this.creds = {
        email: envEmail,
        password: envPassword,
        tokens: sameAccount ? this.creds?.tokens : undefined,
        device: this.creds?.device ?? { profile: this.device.profile },
      } as Credentials;
      return this.creds;
    }

    if (this.creds?.email && this.creds.password) return this.creds;

    if (this.logger.isJson || !process.stdin.isTTY) {
      throw new Error(
        'No saved credentials. Set TAKEALOT_EMAIL + TAKEALOT_PASSWORD, or run `takealot login` in an interactive terminal first.',
      );
    }

    this.logger.info('No saved Takealot credentials found — let\'s set them up.');
    const email = await promptText('Takealot email: ');
    const password = await promptPassword('Takealot password: ');
    if (!email || !password) throw new Error('Email and password are required.');
    this.setCredentials(email, password);
    return this.creds!;
  }

  /**
   * Request-1 of login. Returns `{ status: 'ok' }` when the (trusted / non-2FA)
   * device logs straight in, or `{ status: 'otp_required', challenge, … }` after
   * persisting the challenge — the caller hands the OTP + `challenge` nonce back
   * to `finishLogin`. Never fires a fresh challenge while an unexpired one for
   * this account already exists.
   */
  async startLogin(): Promise<LoginOutcome> {
    const { email } = await this.ensureCredentials();
    const eh = emailHash(email);
    const apiBase = mobileApiBaseOf(this.config);
    const uaHash = profileHash(this.device.profile);

    // Pre-network fast path: a live, matching challenge → reuse it, don't fire a
    // fresh one (avoids accelerating OTP cooldown). A stale one (expired, or wrong
    // account/UA/did) is NOT reused — we re-challenge and overwrite it below.
    const existing = loadPendingOtp(eh);
    if (existing && this.pendingIsLive(existing, eh, apiBase, uaHash)) {
      return this.otpRequired(existing);
    }

    const password = this.creds!.password;
    const started = await this.auth.beginLogin(email, password);
    if ('tokens' in started) {
      // beginLogin's setTokens already persisted (locked) via persistTokens.
      this.logger.debug('Credentials persisted after successful login.');
      return { status: 'ok', customerId: started.tokens.customerId };
    }

    const ch = started.challenge;
    // Publish the challenge ATOMICALLY under the credentials lock so two
    // concurrent startLogin() for the same account can't race to write different
    // nonces. Re-check inside the lock: if a live challenge now exists (another
    // process won), return THAT one (a completable nonce) instead of overwriting.
    const published = await withCredentials(async (_snapshot, save): Promise<PendingOtp> => {
      const live = loadPendingOtp(eh);
      if (live && this.pendingIsLive(live, eh, apiBase, uaHash)) return live;
      // Crash-safe ordering: persist the request-1 did to the device record FIRST
      // (atomic + dir fsync, same lock), THEN publish the pending file, so
      // completion never sees pending pointing at an unpersisted did.
      if (ch.did) save({ device: { profile: this.device.profile, did: ch.did } });
      const pending: PendingOtp = {
        emailHash: eh,
        did: ch.did,
        cfBm: ch.cfBm,
        otpSentTo: ch.otpSentTo,
        validMs: ch.validMs,
        createdAt: Date.now(),
        apiBase,
        uaProfileHash: uaHash,
        nonce: crypto.randomUUID(),
      };
      writePendingOtp(pending);
      return pending;
    });
    return this.otpRequired(published);
  }

  /** True when a persisted challenge is unexpired AND bound to THIS account/device/UA. */
  private pendingIsLive(p: PendingOtp, eh: string, apiBase: string, uaHash: string): boolean {
    return (
      Date.now() < p.createdAt + p.validMs &&
      p.emailHash === eh &&
      p.apiBase === apiBase &&
      p.uaProfileHash === uaHash &&
      (!p.did || !this.device.did || p.did === this.device.did)
    );
  }

  /**
   * Request-2 of login: complete a persisted challenge. Requires the `challenge`
   * nonce (from the `otp_required` output) and verifies account/device/UA/expiry
   * binding before submitting, so it can never be replayed against a different
   * challenge.
   */
  async finishLogin(otp: string, challengeNonce: string | undefined): Promise<LoginOutcome> {
    const { email, password } = await this.ensureCredentials();
    const eh = emailHash(email);
    const pending = loadPendingOtp(eh);
    if (!pending) {
      throw new OtpFlowError(
        'otp_required',
        'No pending 2FA challenge for this account — run `takealot login` first.',
      );
    }
    if (!challengeNonce || challengeNonce !== pending.nonce) {
      // A wrong/absent nonce might be a typo — do NOT clear a possibly-valid
      // challenge that the correct caller still needs.
      throw new OtpFlowError(
        'otp_state_mismatch',
        'Missing or wrong --challenge — pass the `challenge` value from the otp_required output.',
      );
    }
    if (
      pending.emailHash !== eh ||
      pending.apiBase !== mobileApiBaseOf(this.config) ||
      pending.uaProfileHash !== profileHash(this.device.profile) ||
      (pending.did && this.device.did && pending.did !== this.device.did)
    ) {
      // The challenge is genuinely stale for this device/account/UA and can never
      // complete — clear it so the next `login` re-challenges cleanly (no dead-loop).
      clearPendingOtp(eh);
      throw new OtpFlowError(
        'otp_state_mismatch',
        'Pending challenge no longer matches this account/device/UA — it was cleared; run `takealot login` again.',
      );
    }
    if (Date.now() > pending.createdAt + pending.validMs) {
      clearPendingOtp(eh);
      throw new OtpFlowError('otp_expired', 'The 2FA challenge expired — run `takealot login` again.');
    }

    const tokens = await this.auth.completeLogin(email, password, otp, {
      cfBm: pending.cfBm,
      did: pending.did,
      otpSentTo: pending.otpSentTo,
      validMs: pending.validMs,
    });
    // completeLogin's setTokens already persisted (locked) via persistTokens.
    clearPendingOtp(eh);
    return { status: 'ok', customerId: tokens.customerId };
  }

  /** Log in fresh (interactive convenience). Returns the customer id. */
  async login(): Promise<number> {
    const outcome = await this.startLogin();
    if (outcome.status === 'ok') return outcome.customerId;
    // Interactive: we just created the challenge — prompt inline and complete.
    if (this.logger.isJson || !process.stdin.isTTY) {
      throw new OtpFlowError(
        'otp_required',
        'Two-step verification required. Re-run: `takealot login --otp <code> --challenge ' +
          outcome.challenge +
          '` (or set TAKEALOT_OTP + TAKEALOT_CHALLENGE).',
      );
    }
    const otp = await promptPassword('Enter OTP sent to your phone: ');
    const done = await this.finishLogin(otp, outcome.challenge);
    return done.status === 'ok' ? done.customerId : 0;
  }

  /**
   * OTP provider for the AuthManager's background re-login (ensureValid / reauth).
   * A trusted device never reaches here; an untrusted device in a non-interactive
   * context throws a structured `otp_required` telling the agent to run `login`.
   */
  private async promptOtp(): Promise<string> {
    if (this.logger.isJson || !process.stdin.isTTY) {
      throw new OtpFlowError(
        'otp_required',
        'Two-step verification required but stdin is not interactive. Run `takealot login` to establish device trust.',
      );
    }
    return promptPassword('Enter OTP sent to your phone: ');
  }

  private otpRequired(pending: PendingOtp): LoginOutcome {
    return {
      status: 'otp_required',
      challenge: pending.nonce,
      otpSentTo: pending.otpSentTo,
      expiresInSec: Math.max(0, Math.round((pending.createdAt + pending.validMs - Date.now()) / 1000)),
    };
  }
}
