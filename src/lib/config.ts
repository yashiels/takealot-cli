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
import * as crypto from 'node:crypto';
import type { Config, Credentials, PendingOrder, PendingOtp, PreferenceItem } from '../types.js';

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

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* directory fsync is best-effort (unsupported on some platforms) */
  }
}

/**
 * Crash-durable JSON write: write to a temp file, fsync it, atomically rename
 * into place, then fsync the directory so the rename itself is durable. Callers
 * that publish several files in a required order can rely on the directory
 * fsync to keep that order across a crash.
 */
export function atomicWriteJson(file: string, data: unknown, mode = 0o600): void {
  ensureDir();
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`,
  );
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

function writeJson(file: string, data: unknown, mode = 0o600): void {
  atomicWriteJson(file, data, mode);
}

// =====================
// Account identity
// =====================

/** Stable per-account id: sha256 of the lowercased, trimmed email. */
export function emailHash(email: string): string {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

// =====================
// Cross-process credentials lock + transaction
//
// The config dir is host-local (one logical device per ~/.config/takealot-cli),
// so real contention is many processes on one host. The lock is a DIRECTORY
// published atomically WITH its owner.json (never observable empty); mutual
// exclusion is "rename onto a non-empty dir fails". A held lock is reclaimed
// only when its readable owner.json proves the owner is a dead same-host pid,
// via an atomic rename-steal exactly one contender can win.
// =====================

const HOSTNAME = os.hostname();
/** Cross-host (network-FS) best-effort staleness — the normal path never uses it. */
const LOCK_TTL_MS = 120_000;

interface LockOwner {
  pid: number;
  nonce: string;
  host: string;
  acquiredAt: number;
}

const lockDir = (): string => path.join(configDir(), 'credentials.lock');
const ownerFile = (dir: string): string => path.join(dir, 'owner.json');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH → no such process (dead). EPERM → alive but not ours (still alive).
    return e?.code === 'EPERM';
  }
}

function readOwner(dir: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(dir), 'utf-8')) as LockOwner;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Publish a fresh lock atomically (staging dir + owner.json → rename). */
function tryPublishLock(nonce: string): boolean {
  ensureDir();
  const staging = path.join(configDir(), `credentials.lock.new.${process.pid}.${nonce}`);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const owner: LockOwner = { pid: process.pid, nonce, host: HOSTNAME, acquiredAt: Date.now() };
    // fsync owner.json BEFORE the directory rename so a power-loss can't leave a
    // lock dir with missing/corrupt metadata that reclaim would refuse to steal.
    const fd = fs.openSync(ownerFile(staging), 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDir(staging);
    fs.renameSync(staging, lockDir()); // fails (ENOTEMPTY/EEXIST) if a non-empty lock is held
    fsyncDir(configDir());
    return true;
  } catch {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

/** Reclaim a lock ONLY when readable metadata proves it dead; atomic rename-steal. */
function tryReclaim(nonce: string): boolean {
  const dir = lockDir();
  const owner = readOwner(dir);
  if (!owner) return false; // metadata-less lock is never auto-reclaimed
  const eligible =
    (owner.host === HOSTNAME && !pidAlive(owner.pid)) ||
    (owner.host !== HOSTNAME && Date.now() - owner.acquiredAt > LOCK_TTL_MS);
  if (!eligible) return false;
  const reclaimDir = path.join(configDir(), `credentials.lock.reclaim.${process.pid}.${nonce}`);
  try {
    fs.rmSync(reclaimDir, { recursive: true, force: true });
    fs.renameSync(dir, reclaimDir); // atomic steal — only one contender wins this inode
  } catch {
    return false; // lost the steal (someone released/reclaimed first)
  }
  const published = tryPublishLock(nonce); // EEXIST here ⇒ a third party acquired: we lost
  try {
    fs.rmSync(reclaimDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  return published;
}

async function acquireLock(timeoutMs: number): Promise<string> {
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let delay = 20;
  for (;;) {
    if (tryPublishLock(nonce)) return nonce;
    if (tryReclaim(nonce)) return nonce;
    if (Date.now() >= deadline) {
      const owner = readOwner(lockDir());
      throw new Error(
        `another takealot process holds the credentials lock` +
          (owner ? ` (pid ${owner.pid} on ${owner.host})` : '') +
          `; retry shortly or remove ${lockDir()} if it is stale`,
      );
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 200);
  }
}

function releaseLock(nonce: string): void {
  const dir = lockDir();
  const owner = readOwner(dir);
  if (owner && owner.nonce !== nonce) return; // never remove someone else's lock
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function lockTimeoutMs(): number {
  const raw = Number(process.env.TAKEALOT_LOCK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/** Run `fn` while holding the exclusive credentials lock. */
export async function withCredentialsLock<T>(fn: () => Promise<T>): Promise<T> {
  const nonce = await acquireLock(lockTimeoutMs());
  try {
    return await fn();
  } finally {
    releaseLock(nonce);
  }
}

/** Shallow, field-aware merge of a credentials patch onto a fresh snapshot. */
function mergeCredentials(base: Credentials | null, patch: Partial<Credentials>): Credentials {
  return { ...(base ?? {}), ...patch } as Credentials;
}

/**
 * The one serialized transaction over credentials.json. Acquires the lock, hands
 * the callback a FRESH on-disk snapshot plus a `save(patch)` that field-merges
 * onto that snapshot and atomically writes it back. Callers must not re-enter
 * (no self-locking persist inside `fn`).
 */
export async function withCredentials<T>(
  fn: (snapshot: Credentials | null, save: (patch: Partial<Credentials>) => Credentials) => Promise<T>,
): Promise<T> {
  return withCredentialsLock(async () => {
    let current = loadCredentials();
    const snapshot = current;
    const save = (patch: Partial<Credentials>): Credentials => {
      current = mergeCredentials(current, patch);
      atomicWriteJson(credentialsPath(), current, 0o600);
      return current;
    };
    return fn(snapshot, save);
  });
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

// =====================
// Pending 2FA challenge (per-account, so two accounts never collide)
// =====================

export const pendingOtpPath = (emailHashHex: string): string =>
  path.join(configDir(), `pending-otp-${emailHashHex}.json`);

export function loadPendingOtp(emailHashHex: string): PendingOtp | null {
  return readJson<PendingOtp>(pendingOtpPath(emailHashHex));
}

/**
 * Atomically write the pending challenge (0600). Holds no lock itself — callers
 * that need the did→pending ordering guarantee wrap this in `withCredentials`
 * so the device did is persisted first (see context beginLogin).
 */
export function writePendingOtp(pending: PendingOtp): void {
  atomicWriteJson(pendingOtpPath(pending.emailHash), pending, 0o600);
}

export function clearPendingOtp(emailHashHex: string): void {
  try {
    fs.rmSync(pendingOtpPath(emailHashHex), { force: true });
  } catch {
    /* best effort */
  }
}

// =====================
// Data-section form cache (per-account, per-flow) — used for LOCAL submit binding
// =====================

const flowSlug = (flow: string): string => flow.replace(/[^a-zA-Z0-9]+/g, '-');

export const formCachePath = (emailHashHex: string, flow: string): string =>
  path.join(configDir(), `form-${emailHashHex}-${flowSlug(flow)}.json`);

export function saveFormCache(emailHashHex: string, flow: string, layout: unknown): void {
  atomicWriteJson(formCachePath(emailHashHex, flow), { flow, savedAt: Date.now(), layout }, 0o600);
}

export function loadFormCache(emailHashHex: string, flow: string): { flow: string; savedAt: number; layout: unknown } | null {
  return readJson(formCachePath(emailHashHex, flow));
}

// =====================
// Pending checkout order (per-account) — ambiguous-result recovery
// =====================

export const pendingOrderPath = (emailHashHex: string): string =>
  path.join(configDir(), `pending-order-${emailHashHex}.json`);

export function loadPendingOrder(emailHashHex: string): PendingOrder | null {
  return readJson<PendingOrder>(pendingOrderPath(emailHashHex));
}

export function writePendingOrder(order: PendingOrder): void {
  atomicWriteJson(pendingOrderPath(order.emailHash), order, 0o600);
}

export function clearPendingOrder(emailHashHex: string): void {
  try {
    fs.rmSync(pendingOrderPath(emailHashHex), { force: true });
  } catch {
    /* best effort */
  }
}
