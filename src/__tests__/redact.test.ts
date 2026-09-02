import { describe, it, expect } from 'vitest';
import { redact, redactText, REDACTED } from '../lib/redact.js';

describe('redaction', () => {
  it('masks credential keys anywhere in a nested structure', () => {
    const input = {
      jwt: 'header.payload.signature-aaaaaaaa',
      nested: { refresh_token: 'r-secret', csrf_token: 'c', a: [{ password: 'p' }, { otp: '123456' }] },
      cookie: 'tal_jwt=x; did=y',
      last_four_digits: '4242',
      bank: 'FNB',
    };
    const out = redact(input) as any;
    expect(out.jwt).toBe(REDACTED);
    expect(out.nested.refresh_token).toBe(REDACTED);
    expect(out.nested.csrf_token).toBe(REDACTED);
    expect(out.nested.a[0].password).toBe(REDACTED);
    expect(out.nested.a[1].otp).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    // Non-secret card metadata is kept (needed to choose a card).
    expect(out.last_four_digits).toBe('4242');
    expect(out.bank).toBe('FNB');
    // No credential substring survives.
    expect(JSON.stringify(out)).not.toContain('r-secret');
    expect(JSON.stringify(out)).not.toContain('123456');
  });

  it('masks bearer/JWT/sk- shaped values even under innocuous keys', () => {
    const out = redact({ note: 'Bearer abcdefgh12345678', k: 'sk-abcdefgh12345', j: 'aaaaaaaa.bbbbbbbb.cccccccc' }) as any;
    expect(out.note).toBe(REDACTED);
    expect(out.k).toBe(REDACTED);
    expect(out.j).toBe(REDACTED);
  });

  it('strips auth-credential params from EVERY url but preserves signature params', () => {
    const input = {
      random_url: 'https://x.example/cb?access_token=SEKRIT&token=ALSO&keep=1',
      // functional signed url that ALSO carries an access_token: signature kept, auth dropped
      pdf_url: 'https://secure.takealot.com/order/1/invoice.pdf?PAY_REQUEST_ID=abc&CHECKSUM=def&access_token=SEKRIT',
      challengeUrl: 'https://pay.takealot.com/initiation/1?PAY_REQUEST_ID=xyz&CHECKSUM=qqq&token=CHSIG',
    };
    const out = redact(input) as any;
    // ordinary url: auth params stripped, benign param kept
    expect(out.random_url).toContain('keep=1');
    expect(out.random_url).not.toContain('SEKRIT');
    expect(out.random_url).not.toContain('ALSO');
    // functional url: SIGNATURE params survive, but a bearer/access_token does NOT
    expect(out.pdf_url).toContain('PAY_REQUEST_ID=abc');
    expect(out.pdf_url).toContain('CHECKSUM=def');
    expect(out.pdf_url).not.toContain('SEKRIT'); // access_token stripped even here
    expect(out.challengeUrl).toContain('PAY_REQUEST_ID=xyz');
    expect(out.challengeUrl).toContain('CHECKSUM=qqq');
    expect(out.challengeUrl).not.toContain('CHSIG'); // `token` stripped even on functional urls
  });

  it('strips auth tokens from the URL FRAGMENT, keeping a fragment signature param', () => {
    const out = redact({
      cb: 'https://x.example/done#access_token=SEKRIT&PAY_REQUEST_ID=keepme',
      cb2: 'https://x.example/app#/route?id_token=SEKRIT2&sig=OK',
    }) as any;
    expect(out.cb).not.toContain('SEKRIT');
    expect(out.cb).toContain('PAY_REQUEST_ID=keepme');
    expect(out.cb2).not.toContain('SEKRIT2');
    expect(out.cb2).toContain('sig=OK');
  });

  it('(#2) masks data-section field VALUES by their field_id, keeping non-secret values', () => {
    const payload = {
      platform: 'android',
      sections: [
        {
          section_id: 'sec',
          fields: [
            { field_id: 'password', value: 'hunter2' },
            { field_id: 'otp', value: '123456' },
            { field_id: 'card_number', value: '4111111111111111' },
            { field_id: 'cvv', value: '999' },
            { field_id: 'id_number', value: '8001015009087' },
            { field_id: 'email', value: 'keep@me.com' },
          ],
        },
      ],
    };
    const out = redact(payload) as any;
    const f = out.sections[0].fields as any[];
    expect(f[0].value).toBe(REDACTED); // password
    expect(f[1].value).toBe(REDACTED); // otp
    expect(f[2].value).toBe(REDACTED); // card_number
    expect(f[3].value).toBe(REDACTED); // cvv
    expect(f[4].value).toBe(REDACTED); // id_number
    expect(f[5].value).toBe('keep@me.com'); // non-secret field value intact
    // field_id labels themselves are preserved (they're not secrets)
    expect(f[0].field_id).toBe('password');
    const s = JSON.stringify(out);
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain('4111111111111111');
    expect(s).not.toContain('123456');
  });

  it('never throws on cyclic / weird shapes', () => {
    const a: any = { x: 1 };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect(() => redact([1, null, undefined, () => 1, Symbol('s') as any])).not.toThrow();
  });

  it('--unsafe-raw bypasses redaction', () => {
    const input = { jwt: 'secret.token.here' };
    expect((redact(input, { unsafe: true }) as any).jwt).toBe('secret.token.here');
  });

  it('redactText masks secrets embedded in an error message', () => {
    const msg = redactText('failed with Bearer abcdef123456 and aaaaaaaa.bbbbbbbb.cccccccc');
    expect(msg).not.toContain('abcdef123456');
    expect(msg).toContain(REDACTED);
  });
});
