import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * End-to-end headless flow at the Context layer against a throwaway
 * XDG_CONFIG_HOME with a scripted fetch. Exercises the real persisted PendingOtp,
 * the credentials transaction, device-did replay, and the trusted-re-login bar.
 */

let tmpDir: string;
let prevXdg: string | undefined;
let calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
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

function script(handler: (url: string, body: any) => Response) {
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body });
    return handler(String(url), body);
  }) as any;
}

async function freshContext() {
  vi.resetModules();
  const { Context } = await import('../lib/context.js');
  return new Context({ json: true, verbose: false });
}

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-otp-'));
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.TAKEALOT_EMAIL = 'shopper@example.com';
  process.env.TAKEALOT_PASSWORD = 'sekret';
  delete process.env.TAKEALOT_OTP;
  delete process.env.TAKEALOT_CHALLENGE;
  calls = [];
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

const credsFile = () => path.join(tmpDir, 'takealot-cli', 'credentials.json');
const readCreds = () => JSON.parse(fs.readFileSync(credsFile(), 'utf-8'));

describe('headless two-step OTP', () => {
  it('non-2FA account: startLogin returns ok directly', async () => {
    script(() => resp(authInfo('jwt-direct', 'DID-direct')));
    const ctx = await freshContext();
    const out = await ctx.startLogin();
    expect(out).toMatchObject({ status: 'ok', customerId: 4242 });
    expect(readCreds().device.did).toBe('DID-direct');
  });

  it('startLogin persists a challenge (did first), completeLogin replays it and never re-fires req-1', async () => {
    let loginPosts = 0;
    script((_url, body) => {
      if (_url.includes('/customers/login')) {
        loginPosts++;
        const hasOtp = body?.sections?.some((s: any) => s.section_id === 'two_step_verification');
        if (!hasOtp) {
          return resp(
            { two_step_verification: 'enabled_untrusted', otp_status: { valid_millis: 300000 }, otp_sent_to: '•••1234' },
            ['__cf_bm=CFTOKEN; Path=/', 'did=DID-REQ1; Path=/'],
          );
        }
        return resp(authInfo('jwt-otp', 'DID-REQ1'));
      }
      return resp({}, [], 500);
    });

    const ctx = await freshContext();
    const start = await ctx.startLogin();
    expect(start.status).toBe('otp_required');
    // did persisted to the device record BEFORE the pending file references it.
    expect(readCreds().device.did).toBe('DID-REQ1');
    const pending = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'takealot-cli', fs.readdirSync(path.join(tmpDir, 'takealot-cli')).find((f) => f.startsWith('pending-otp-'))!), 'utf-8'),
    );
    expect(pending.did).toBe('DID-REQ1');
    expect(pending.cfBm).toContain('__cf_bm=CFTOKEN');

    const nonce = (start as any).challenge;
    const done = await ctx.finishLogin('54321', nonce);
    expect(done).toMatchObject({ status: 'ok', customerId: 4242 });

    // Exactly two login POSTs total (req-1 then req-2) — completeLogin didn't re-fire req-1.
    expect(loginPosts).toBe(2);
    const req2 = calls.filter((c) => c.url.includes('/customers/login'))[1]!;
    expect(req2.headers['tal-did']).toBe('DID-REQ1');
    expect(req2.headers['cookie']).toContain('__cf_bm=CFTOKEN');
    expect(req2.headers['cookie']).toContain('did=DID-REQ1');
    const otpSection = req2.body.sections.find((s: any) => s.section_id === 'two_step_verification');
    expect(otpSection.fields.find((f: any) => f.field_id === 'trust_this_device').value).toBe(true);
    // Pending file consumed on success.
    expect(fs.readdirSync(path.join(tmpDir, 'takealot-cli')).some((f) => f.startsWith('pending-otp-'))).toBe(false);
  });

  it('finishLogin refuses a wrong/missing challenge nonce (otp_state_mismatch)', async () => {
    script((_url, body) => {
      const hasOtp = body?.sections?.some((s: any) => s.section_id === 'two_step_verification');
      if (!hasOtp) {
        return resp({ two_step_verification: 'enabled_untrusted', otp_status: { valid_millis: 300000 } }, ['__cf_bm=CF; Path=/', 'did=D; Path=/']);
      }
      return resp(authInfo());
    });
    const ctx = await freshContext();
    await ctx.startLogin();
    const { OtpFlowError } = await import('../lib/context.js');
    await expect(ctx.finishLogin('11111', 'not-the-nonce')).rejects.toBeInstanceOf(OtpFlowError);
    await expect(ctx.finishLogin('11111', undefined)).rejects.toMatchObject({ code: 'otp_state_mismatch' });
  });

  it('finishLogin with no pending challenge → otp_required error', async () => {
    const ctx = await freshContext();
    const { OtpFlowError } = await import('../lib/context.js');
    await expect(ctx.finishLogin('11111', 'x')).rejects.toBeInstanceOf(OtpFlowError);
    await expect(ctx.finishLogin('11111', 'x')).rejects.toMatchObject({ code: 'otp_required' });
  });

  it('expired pending challenge → otp_expired and the file is cleared', async () => {
    script((_url, body) => {
      const hasOtp = body?.sections?.some((s: any) => s.section_id === 'two_step_verification');
      if (!hasOtp) return resp({ two_step_verification: 'enabled_untrusted', otp_status: { valid_millis: 1 }, }, ['__cf_bm=CF; Path=/', 'did=D; Path=/']);
      return resp(authInfo());
    });
    const ctx = await freshContext();
    const start = await ctx.startLogin();
    await new Promise((r) => setTimeout(r, 5)); // let validMs:1 elapse
    await expect(ctx.finishLogin('11111', (start as any).challenge)).rejects.toMatchObject({ code: 'otp_expired' });
    expect(fs.readdirSync(path.join(tmpDir, 'takealot-cli')).some((f) => f.startsWith('pending-otp-'))).toBe(false);
  });

  it('per-account pending files do not collide', async () => {
    const { emailHash } = await import('../lib/config.js');
    script((_url, body) => {
      const hasOtp = body?.sections?.some((s: any) => s.section_id === 'two_step_verification');
      if (!hasOtp) return resp({ two_step_verification: 'enabled_untrusted', otp_status: { valid_millis: 300000 } }, ['__cf_bm=CF; Path=/', 'did=D; Path=/']);
      return resp(authInfo());
    });
    process.env.TAKEALOT_EMAIL = 'a@x.com';
    const ctxA = await freshContext();
    await ctxA.startLogin();
    process.env.TAKEALOT_EMAIL = 'b@x.com';
    const ctxB = await freshContext();
    await ctxB.startLogin();
    const dir = path.join(tmpDir, 'takealot-cli');
    expect(fs.existsSync(path.join(dir, `pending-otp-${emailHash('a@x.com')}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `pending-otp-${emailHash('b@x.com')}.json`))).toBe(true);
  });
});

describe('acceptance: trusted credentials-only re-login skips OTP', () => {
  it('establishes did via 2FA, then a creds-only login (all tokens wiped) needs no OTP', async () => {
    // Phase 1: 2FA login establishes device trust.
    script((_url, body) => {
      const hasOtp = body?.sections?.some((s: any) => s.section_id === 'two_step_verification');
      if (!hasOtp) {
        return resp({ two_step_verification: 'enabled_untrusted', otp_status: { valid_millis: 300000 } }, ['__cf_bm=CF; Path=/', 'did=TRUSTED-DID; Path=/']);
      }
      // trust_this_device honoured — subsequent logins won't be challenged.
      return resp(authInfo('jwt-first', 'TRUSTED-DID'));
    });
    let ctx = await freshContext();
    const start = await ctx.startLogin();
    expect(start.status).toBe('otp_required');
    await ctx.finishLogin('99999', (start as any).challenge);
    expect(readCreds().device.did).toBe('TRUSTED-DID');

    // Phase 2: wipe ALL tokens, KEEP the device record.
    const creds = readCreds();
    delete creds.tokens;
    fs.writeFileSync(credsFile(), JSON.stringify(creds));
    expect(readCreds().tokens).toBeUndefined();
    expect(readCreds().device.did).toBe('TRUSTED-DID');

    // Phase 3: a fresh creds-only login. Because the trusted did rides on the
    // request, the server does NOT challenge — no otp_required.
    calls = [];
    script((url) => {
      if (url.includes('/customers/login')) return resp(authInfo('jwt-second', 'TRUSTED-DID'));
      return resp({}, [], 500);
    });
    ctx = await freshContext();
    const out = await ctx.startLogin();
    expect(out).toMatchObject({ status: 'ok' });

    // And it presented the trusted did on request-1.
    const req1 = calls.find((c) => c.url.includes('/customers/login'))!;
    expect(req1.headers['tal-did']).toBe('TRUSTED-DID');
    expect(req1.headers['cookie']).toContain('did=TRUSTED-DID');
  });
});
