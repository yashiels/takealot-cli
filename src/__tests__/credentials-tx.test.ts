import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthManager } from '../lib/auth.js';
import type { Credentials, TokenSet } from '../types.js';

/**
 * These tests exercise the REAL cross-process primitives against a throwaway
 * XDG_CONFIG_HOME, so the directory lock, atomic writes, and reload-and-skip are
 * all under test — not a mock. Modules are imported fresh per test so
 * configDir() re-resolves the temp dir.
 */

const API_BASE = 'https://api.takealot.com/rest/v-1-16-0';

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

function makeMockResponse(body: unknown, opts: { status?: number } = {}) {
  const status = opts.status ?? 200;
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let tmpDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-tx-'));
  process.env.XDG_CONFIG_HOME = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  vi.restoreAllMocks();
  delete process.env.TAKEALOT_LOCK_TIMEOUT_MS;
});

describe('credentials transaction primitives', () => {
  it('emailHash is case/whitespace-insensitive and stable', async () => {
    const { emailHash } = await import('../lib/config.js');
    expect(emailHash('  Foo@Example.COM ')).toBe(emailHash('foo@example.com'));
    expect(emailHash('a@b.com')).not.toBe(emailHash('c@d.com'));
  });

  it('atomicWriteJson writes 0600 and leaves no temp files', async () => {
    const cfg = await import('../lib/config.js');
    const file = cfg.credentialsPath();
    cfg.atomicWriteJson(file, { hello: 'world' }, 0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ hello: 'world' });
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const leftovers = fs.readdirSync(cfg.configDir()).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('withCredentials serializes and field-merges (no clobber)', async () => {
    const cfg = await import('../lib/config.js');
    cfg.saveCredentials({ email: 'a@b.com', password: 'pw' } as Credentials);
    // Two concurrent transactions: one writes tokens, one writes a device did.
    await Promise.all([
      cfg.withCredentials(async (_s, save) => {
        save({ tokens: makeTokens({ jwt: 'jwt-A' }) });
      }),
      cfg.withCredentials(async (_s, save) => {
        save({ device: { did: 'did-XYZ', profile: {} as any } });
      }),
    ]);
    const final = cfg.loadCredentials()!;
    expect(final.email).toBe('a@b.com');
    expect(final.tokens?.jwt).toBe('jwt-A');
    expect(final.device?.did).toBe('did-XYZ');
  });

  it('lock times out fast with a clear error when held by a live foreign pid', async () => {
    const cfg = await import('../lib/config.js');
    // Manufacture a lock owned by a PID that is alive but not ours (PID 1 / init).
    const lockPath = path.join(cfg.configDir(), 'credentials.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 1, nonce: 'foreign', host: os.hostname(), acquiredAt: Date.now() }),
    );
    process.env.TAKEALOT_LOCK_TIMEOUT_MS = '150';
    await expect(cfg.withCredentialsLock(async () => 'never')).rejects.toThrow(
      /another takealot process holds the credentials lock/,
    );
  });

  it('reclaims a lock left by a dead same-host pid', async () => {
    const cfg = await import('../lib/config.js');
    const lockPath = path.join(cfg.configDir(), 'credentials.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    // PID 2^31-1 is (practically) never a live process — treated as dead → reclaimable.
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 2147483646, nonce: 'dead', host: os.hostname(), acquiredAt: Date.now() }),
    );
    const got = await cfg.withCredentialsLock(async () => 'acquired');
    expect(got).toBe('acquired');
  });

  it('never reclaims a metadata-less lock (times out instead)', async () => {
    const cfg = await import('../lib/config.js');
    const lockPath = path.join(cfg.configDir(), 'credentials.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    // Non-empty but no readable owner.json → unknown owner, must NOT be stolen.
    fs.writeFileSync(path.join(lockPath, 'sentinel'), 'x');
    process.env.TAKEALOT_LOCK_TIMEOUT_MS = '150';
    await expect(cfg.withCredentialsLock(async () => 'never')).rejects.toThrow(
      /holds the credentials lock/,
    );
  });
});

describe('cross-process reload-and-skip', () => {
  it('two AuthManagers over one rotating store: exactly one refresh, both adopt', async () => {
    const cfg = await import('../lib/config.js');
    const nearExpiry = makeTokens({ jwt: 'jwt-old', jwtExpiresAt: Date.now() + 10_000 });
    cfg.saveCredentials({ email: 'a@b.com', password: 'pw', tokens: nearExpiry } as Credentials);

    let refreshCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        refreshCount++;
        return makeMockResponse(
          mockAuthInfoResponse({ jwt: 'jwt-fresh', refreshToken: 'refresh-rotated' }),
        );
      }
      return makeMockResponse({}, { status: 500 });
    }) as any;

    const mk = () =>
      new AuthManager(
        {
          apiBase: API_BASE,
          userAgent: 'ua',
          platform: 'android',
          getCredentials: () => cfg.loadCredentials(),
          persist: () => {},
          log: () => {},
          transaction: (fn) => cfg.withCredentials(fn),
        },
        nearExpiry,
      );

    const a = mk();
    const b = mk();
    await Promise.all([a.ensureValid(), b.ensureValid()]);

    expect(refreshCount).toBe(1);
    expect(a.currentTokens?.jwt).toBe('jwt-fresh');
    expect(b.currentTokens?.jwt).toBe('jwt-fresh');
    // The rotated refresh token was persisted atomically.
    expect(cfg.loadCredentials()?.tokens?.refreshToken).toBe('refresh-rotated');
  });

  it('adopting process refreshes its in-memory did to the rotated one', async () => {
    const cfg = await import('../lib/config.js');
    const { resolveDeviceProfile } = await import('../lib/device.js');
    const profile = resolveDeviceProfile({});
    const nearExpiry = makeTokens({ jwt: 'jwt-old', did: 'did-OLD', jwtExpiresAt: Date.now() + 10_000 });
    cfg.saveCredentials({
      email: 'a@b.com',
      password: 'pw',
      tokens: nearExpiry,
      device: { profile, did: 'did-OLD' },
    } as Credentials);

    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/auth/refresh')) {
        return makeMockResponse(
          mockAuthInfoResponse({ jwt: 'jwt-fresh', refreshToken: 'refresh-rot', did: 'did-NEW' }),
        );
      }
      return makeMockResponse({}, { status: 500 });
    }) as any;

    const mk = () => {
      const device: { profile: typeof profile; did?: string } = { profile, did: 'did-OLD' };
      const am = new AuthManager(
        {
          apiBase: API_BASE,
          userAgent: 'ua',
          platform: 'android',
          getCredentials: () => cfg.loadCredentials(),
          persist: () => {},
          getDevice: () => device,
          onDid: (d: string) => {
            device.did = d;
          },
          log: () => {},
          transaction: (fn) => cfg.withCredentials(fn),
        },
        nearExpiry,
      );
      return { am, device };
    };

    const A = mk();
    const B = mk();
    await A.am.ensureValid(); // A refreshes, rotates did → did-NEW, persists it
    await B.am.ensureValid(); // B adopts A's fresh tokens AND the rotated did

    expect(A.device.did).toBe('did-NEW');
    expect(B.device.did).toBe('did-NEW'); // the fix: adopt updates in-memory device did
    expect(B.am.deviceHeaders()['tal-did']).toBe('did-NEW'); // no stale TAL-Did emitted
  });
});
