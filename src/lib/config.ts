/**
 * XDG-style config and credential management.
 *
 * Layout (under $XDG_CONFIG_HOME/takealot-cli, default ~/.config/takealot-cli):
 *   config.json       — non-secret settings (API overrides, preferred brands, default card)
 *   credentials.json  — email/password + cached token set (chmod 0600)
 *   preferences.json  — products learned from order history
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Config, Credentials, PreferenceItem } from '../types.js';

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'takealot-cli');
}

export const configPath = (): string => path.join(configDir(), 'config.json');
export const credentialsPath = (): string => path.join(configDir(), 'credentials.json');
export const preferencesPath = (): string => path.join(configDir(), 'preferences.json');

function ensureDir(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown, mode = 0o600): void {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode });
  // writeFileSync only applies mode on create; enforce it for existing files too.
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* best effort */
  }
}

// =====================
// Config (non-secret)
// =====================

const DEFAULT_CONFIG: Config = {
  preferredBrands: [],
};

export function loadConfig(): Config {
  return { ...DEFAULT_CONFIG, ...(readJson<Config>(configPath()) ?? {}) };
}

export function saveConfig(config: Config): void {
  writeJson(configPath(), config, 0o644);
}

// =====================
// Credentials (secret)
// =====================

export function loadCredentials(): Credentials | null {
  return readJson<Credentials>(credentialsPath());
}

export function saveCredentials(creds: Credentials): void {
  writeJson(credentialsPath(), creds, 0o600);
}

/** Persist just the token set, leaving stored email/password intact. */
export function saveTokens(creds: Credentials | null, tokens: Credentials['tokens']): void {
  const base = creds ?? loadCredentials();
  if (!base) return; // nothing to attach tokens to (no stored login)
  saveCredentials({ ...base, tokens: tokens ?? undefined });
}

// =====================
// Preferences (order-history cache)
// =====================

interface PreferencesFile {
  items: PreferenceItem[];
  count: number;
  updatedAt: string;
}

export function loadPreferences(): PreferenceItem[] {
  const data = readJson<PreferencesFile>(preferencesPath());
  return data?.items ?? [];
}

export function savePreferences(items: PreferenceItem[]): void {
  const data: PreferencesFile = {
    items,
    count: items.length,
    updatedAt: new Date().toISOString(),
  };
  writeJson(preferencesPath(), data, 0o600);
}
