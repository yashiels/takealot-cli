import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE, type EndpointRow } from '../lib/catalogue.js';
import { DEFAULTS } from '../lib/api-client.js';
import { mkClient } from './mkclient.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOGUE_JSON = path.join(repoRoot, 'docs/endpoints-catalogue.json');

describe('endpoint catalogue — coverage', () => {
  it('the frozen docs/endpoints-catalogue.json matches the runtime CATALOGUE', () => {
    const onDisk = JSON.parse(fs.readFileSync(CATALOGUE_JSON, 'utf-8'));
    expect(onDisk).toEqual(CATALOGUE);
  });

  it('every non-excluded row has a command + sample; every excluded row has a reason and no command', () => {
    for (const row of CATALOGUE) {
      if (row.excluded) {
        expect(row.command, `${row.id} excluded ⇒ command null`).toBeNull();
        expect(row.reason, `${row.id} excluded ⇒ has reason`).toBeTruthy();
      } else {
        expect(row.command, `${row.id} ⇒ has a command`).toBeTruthy();
        expect(row.sample, `${row.id} ⇒ has a sample invocation`).toBeTruthy();
      }
    }
  });

  it('only telemetry/ads/auth-internal endpoints are excluded', () => {
    const excluded = CATALOGUE.filter((e) => e.excluded).map((e) => e.id).sort();
    expect(excluded).toEqual(
      ['ads.sponsoredDisplay', 'ads.sponsoredProducts', 'auth.refresh', 'config.abtest', 'ute.collect'].sort(),
    );
  });

});

function expectedUrl(row: EndpointRow): string {
  const params = row.sample?.params ?? {};
  const sub = (p: string) =>
    p.replace(/\{(\w+)\}/g, (_m, name: string) =>
      name in params ? encodeURIComponent(String(params[name])) : name === 'customerId' ? '12345' : `{${name}}`,
    );
  const base = row.base === 'search' ? DEFAULTS.searchApiBase : DEFAULTS.mobileApiBase;
  let url = row.base === 'absolute' ? String(params.absoluteUrl) : `${base}/${sub(row.path).replace(/^\//, '')}`;
  const q = row.sample?.query;
  if (q && Object.keys(q).length) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) usp.append(k, String(v));
    url += `?${usp.toString()}`;
  }
  return url;
}

const CTYPE: Record<string, string> = {
  json: 'application/json',
  'delete-body': 'application/json',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain',
};

describe('endpoint catalogue — contract (every non-excluded row issues the exact request)', () => {
  for (const row of CATALOGUE.filter((e) => !e.excluded)) {
    it(`${row.id} → ${row.method} ${row.path}`, async () => {
      const { client, calls } = mkClient({ body: {} });
      await client.call(row.id, row.sample ?? {});
      expect(calls.length).toBe(1);
      const { url, init } = calls[0]!;
      expect(init.method).toBe(row.method);
      expect(url).toBe(expectedUrl(row));

      const headers = (init.headers ?? {}) as Record<string, string>;
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      // Auth presence: authed rows carry a bearer; public/absolute rows do not.
      if (row.auth) expect(lower['authorization']).toBe('Bearer test-jwt');
      else expect(lower['authorization']).toBeUndefined();
      // Body encoding content-type (only when there is a body).
      if (CTYPE[row.encoding]) expect(lower['content-type']).toBe(CTYPE[row.encoding]);
    });
  }
});
