import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Regression tests for the Oracle code-gate findings:
 *  #1 concurrent startLogin for one account → a single completable nonce
 *  #2 stale pending is cleared and re-challenged (no otp_state_mismatch dead-loop)
 *  #3 concurrent login persists don't corrupt / lose the record (locked path)
 *  #5 config show / logs never emit a did fragment
 */

let tmpDir: string;
let prevXdg: string | undefined;
let originalFetch: typeof globalThis.fetch;

function authInfo(jwt = 'jwt-1', did?: string) {
  return {
    auth_info: {
      jwt,
      id_token: 'id-1',
      refresh_token: 'refresh-1',
      csrf_token: 'csrf-1',
      tracking_id: 'track-1',
      customer_id: 4242,
      did,
      max_age: 3600,
    },
  };
}

function resp(body: unknown, setCookie: string[] = [], status = 200) {
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

async function freshContext() {
  vi.resetModules();
  const { Context } = await import('../lib/context.js');
  return new Context({ json: true, verbose: false });
}

const cfgDir = () => path.join(tmpDir, 'takealot-cli');

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-hard-'));
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.TAKEALOT_EMAIL = 'shopper@example.com';
  process.env.TAKEALOT_PASSWORD = 'sekret';
  delete process.env.TAKEALOT_OTP;
  delete process.env.TAKEALOT_CHALLENGE;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  delete process.env.TAKEALOT_EMAIL;
  delete process.env.TAKEALOT_PASSWORD;
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  vi.restoreAllMocks();
});

const pendingFiles = () => fs.readdirSync(cfgDir()).filter((f) => f.startsWith('pending-otp-'));

describe('#1 concurrent startLogin for one account', () => {
  it('yields a single pending challenge and both callers get the SAME nonce', async () => {
    globalThis.fetch = vi.fn(async () =>
      resp(
        { two_step_verification: 'enabled_untrusted', otp_status: { valid_millis: 300000 } },
        ['__cf_bm=CF; Path=/', 'did=DID-1; Path=/'],
      ),
    ) as any;

    // Two independent Context instances (same account, same config dir).
    const a = await freshContext();
    const b = await freshContext();
    const [ra, rb] = await Promise.all([a.startLogin(), b.startLogin()]);

    expect(ra.status).toBe('otp_required');
    expect(rb.status).toBe('otp_required');
    // Exactly one pending file, and both callers reference its nonce.
    expect(pendingFiles()).toHaveLength(1);
    expect((ra as any).challenge).toBe((rb as any).challenge);
    const stored = JSON.parse(fs.readFileSync(path.join(cfgDir(), pendingFiles()[0]!), 'utf-8'));
    expect((ra as any).challenge).toBe(stored.nonce);
  });
});

describe('#2 stale pending is cleared and re-challenged', () => {
  it('startLogin does not reuse a pending whose did no longer matches the device', async () => {
    const { emailHash, writePendingOtp, saveCredentials } = await import('../lib/config.js');
    const { resolveDeviceProfile } = await import('../lib/device.js');
    const { profileHash } = await import('../lib/device.js');
    const profile = resolveDeviceProfile({});
    const eh = emailHash('shopper@example.com');
    // Device is trusted with NEW did; a leftover pending still references OLD did.
    saveCredentials({ email: 'shopper@example.com', password: 'sekret', device: { profile, did: 'NEW-DID' } } as any);
    writePendingOtp({
      emailHash: eh, did: 'OLD-DID', cfBm: '__cf_bm=OLD', validMs: 300000, createdAt: Date.now(),
      apiBase: 'https://api.takealot.com/rest/v-1-18-0', uaProfileHash: profileHash(profile), nonce: 'stale-nonce',
    } as any);

    // beginLogin re-challenges (trusted did present → server returns tokens directly here).
    globalThis.fetch = vi.fn(async () => resp(authInfo('jwt-new', 'NEW-DID'))) as any;
    const ctx = await freshContext();
    const out = await ctx.startLogin();
    // Trusted device → straight ok, and the stale pending was overwritten/gone.
    expect(out.status).toBe('ok');
  });

  it('finishLogin clears a stale (UA-mismatched) pending instead of dead-looping', async () => {
    const { emailHash, writePendingOtp } = await import('../lib/config.js');
    const eh = emailHash('shopper@example.com');
    writePendingOtp({
      emailHash: eh, did: 'D', cfBm: '__cf_bm=X', validMs: 300000, createdAt: Date.now(),
      apiBase: 'https://api.takealot.com/rest/v-1-18-0', uaProfileHash: 'STALE-UA-HASH', nonce: 'n1',
    } as any);
    globalThis.fetch = vi.fn(async () => resp({}, [], 500)) as any;

    const ctx = await freshContext();
    const { OtpFlowError } = await import('../lib/context.js');
    await expect(ctx.finishLogin('12345', 'n1')).rejects.toBeInstanceOf(OtpFlowError);
    // Stale pending must be gone so the next login can re-challenge cleanly.
    expect(pendingFiles()).toHaveLength(0);
  });
});

describe('#3 concurrent login persists are locked (no corruption/lost record)', () => {
  it('two concurrent non-2FA logins leave a single valid credentials record', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      return resp(authInfo(`jwt-${n}`, 'DID-TRUST'));
    }) as any;

    const a = await freshContext();
    const b = await freshContext();
    await Promise.all([a.startLogin(), b.startLogin()]);

    const creds = JSON.parse(fs.readFileSync(path.join(cfgDir(), 'credentials.json'), 'utf-8'));
    expect(creds.email).toBe('shopper@example.com');
    expect(typeof creds.tokens.jwt).toBe('string');
    expect(creds.tokens.jwt).toMatch(/^jwt-\d$/); // one valid set, not a corrupt merge
    expect(creds.device.did).toBe('DID-TRUST');
    // No temp/partial files left behind by the atomic writes.
    expect(fs.readdirSync(cfgDir()).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

describe('#6 a freshly captured did is not rolled back to the stale on-disk did', () => {
  it('persistTokens keeps the newly returned server did, not the prior one on disk', async () => {
    const { saveCredentials } = await import('../lib/config.js');
    const { resolveDeviceProfile } = await import('../lib/device.js');
    // Seed disk with a prior device did so the transaction snapshot carries one.
    saveCredentials({
      email: 'shopper@example.com',
      password: 'sekret',
      device: { profile: resolveDeviceProfile({}), did: 'OLD-DID' },
    } as any);

    // A login that returns a rotated did.
    globalThis.fetch = vi.fn(async () => resp(authInfo('jwt-new', 'NEW-DID'))) as any;

    const ctx = await freshContext();
    await ctx.startLogin();

    const creds = JSON.parse(fs.readFileSync(path.join(cfgDir(), 'credentials.json'), 'utf-8'));
    // Must be the fresh server did — not rolled back to OLD-DID by the snapshot merge.
    expect(creds.device.did).toBe('NEW-DID');
    expect(creds.tokens.jwt).toBe('jwt-new');
  });
});

describe('#5 no did fragment leaks', () => {
  it('config show (--json and human) contains no part of the raw did', async () => {
    const { saveCredentials } = await import('../lib/config.js');
    const { resolveDeviceProfile } = await import('../lib/device.js');
    // Opaque token (like a real server did) so 6-char slices can't coincide with UI labels.
    const DID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    saveCredentials({
      email: 'shopper@example.com',
      password: 'sekret',
      device: { profile: resolveDeviceProfile({}), did: DID },
    } as any);

    // Capture stdout across both render paths.
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => {
      chunks.push(String(s));
      return true;
    });
    try {
      const { configShow } = await import('../commands/config.js');
      const jsonCtx = await freshContext();
      await configShow(jsonCtx as any);
      // Force the human path too.
      vi.resetModules();
      const { Context } = await import('../lib/context.js');
      const humanCtx = new Context({ json: false, verbose: false });
      const { configShow: configShowHuman } = await import('../commands/config.js');
      await configShowHuman(humanCtx as any);
    } finally {
      spy.mockRestore();
    }

    const out = chunks.join('');
    expect(out).toContain('didPresent');
    // Neither the whole did nor any 6+ char fragment of it may appear.
    expect(out).not.toContain(DID);
    for (let i = 0; i + 6 <= DID.length; i++) {
      expect(out).not.toContain(DID.slice(i, i + 6));
    }
  });
});
