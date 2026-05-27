/**
 * Per-invocation context: loads config + credentials, wires up the AuthManager
 * (with token persistence) and the TakealotClient, and exposes helpers commands
 * use to obtain credentials (prompting + saving on first run).
 */

import { AuthManager } from './auth.js';
import { DEFAULTS, TakealotClient } from './api-client.js';
import { Logger } from './ui.js';
import { promptPassword, promptText } from './prompt.js';
import {
  loadConfig,
  loadCredentials,
  loadPreferences,
  saveCredentials,
} from './config.js';
import type { Config, Credentials, TokenSet } from '../types.js';

export interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
}

export class Context {
  readonly logger: Logger;
  readonly config: Config;
  readonly client: TakealotClient;
  private creds: Credentials | null;
  private readonly auth: AuthManager;

  constructor(opts: GlobalOptions) {
    this.logger = new Logger({ json: opts.json ?? false, verbose: opts.verbose ?? false });
    this.config = loadConfig();
    this.creds = loadCredentials();

    this.auth = new AuthManager(
      {
        apiBase: this.config.mobileApiBase ?? DEFAULTS.mobileApiBase,
        userAgent: this.config.mobileUserAgent ?? DEFAULTS.mobileUserAgent,
        platform: this.config.platform ?? DEFAULTS.platform,
        getCredentials: () => this.creds,
        persist: (tokens) => this.persistTokens(tokens),
        log: (msg) => this.logger.debug(msg),
      },
      this.creds?.tokens ?? null,
    );

    this.client = new TakealotClient({
      auth: this.auth,
      logger: this.logger,
      searchApiBase: this.config.searchApiBase,
      mobileApiBase: this.config.mobileApiBase,
      browserUserAgent: this.config.browserUserAgent,
      history: loadPreferences(),
      preferredBrands: this.config.preferredBrands ?? [],
    });
  }

  get credentials(): Credentials | null {
    return this.creds;
  }

  private persistTokens(tokens: TokenSet): void {
    if (!this.creds) return; // no stored login to attach tokens to
    this.creds = { ...this.creds, tokens };
    saveCredentials(this.creds);
  }

  /** Set new email/password in memory. Call persistCredentials() after login succeeds. */
  setCredentials(email: string, password: string): void {
    this.creds = { ...(this.creds ?? {}), email, password } as Credentials;
  }

  /** Persist the current credentials to disk (call after login succeeds). */
  persistCredentials(): void {
    if (this.creds) saveCredentials(this.creds);
  }

  /**
   * Ensure we have stored credentials, prompting interactively on first run.
   * Throws in --json mode (non-interactive) if none are stored.
   */
  async ensureCredentials(): Promise<Credentials> {
    if (this.creds?.email && this.creds.password) return this.creds;

    if (this.logger.isJson || !process.stdin.isTTY) {
      throw new Error('No saved credentials. Run `takealot login` in an interactive terminal first.');
    }

    this.logger.info('No saved Takealot credentials found — let’s set them up.');
    const email = await promptText('Takealot email: ');
    const password = await promptPassword('Takealot password: ');
    if (!email || !password) throw new Error('Email and password are required.');
    this.setCredentials(email, password);
    return this.creds!;
  }

  /** Log in fresh, ensuring credentials exist first. Returns the customer id. */
  async login(): Promise<number> {
    const { email, password } = await this.ensureCredentials();
    const tokens = await this.auth.login(email, password);
    this.persistCredentials();
    this.logger.debug('Credentials persisted after successful login.');
    return tokens.customerId;
  }
}
