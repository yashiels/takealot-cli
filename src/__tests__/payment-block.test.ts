import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE, PAYMENT_BLOCKED, type EndpointRow } from '../lib/catalogue.js';
import { PaymentBlockedError, UnsafeUrlError } from '../lib/errors.js';
import { mkClient } from './mkclient.js';

const PAYMENT_BLOCKED_IDS = [
  'checkout.complete',
  'checkout.order',
  'checkout.order.update',
  'checkout.payment',
  'checkout.payment.complete',
  'checkout.payhost',
  'ebucks.requestotp',
  'ebucks.login',
  'ebucks.pay',
  'plus.pay',
  'plus.card.add',
  'plus.card.payment',
  'plus.manage.card',
  'plus.manage.card.form',
  'plus.signup',
  'plus.signup.form',
  'plus.reactivate',
  'plus.reactivate.form',
  'plus.manage.upgrade',
  'plus.manage.upgrade.form',
  'plus.manage.downgrade',
  'plus.manage.downgrade.form',
];

const resolveSamplePath = (row: EndpointRow): string =>
  row.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = row.sample?.params?.[name] ?? (name === 'customerId' ? 12345 : name);
    return encodeURIComponent(String(value));
  });

describe('payment transport block', () => {
  it('matches the independently specified blocked endpoint classification', () => {
    expect([...PAYMENT_BLOCKED].sort()).toEqual([...PAYMENT_BLOCKED_IDS].sort());
    const registeredIds = new Set(
      CATALOGUE.filter((row) => !row.excluded && row.command !== null).map((row) => row.id),
    );
    for (const id of PAYMENT_BLOCKED_IDS) {
      const row = CATALOGUE.find((candidate) => candidate.id === id)!;
      expect(row.excluded, id).toBe(true);
      expect(row.command, id).toBeNull();
      expect(row.reason, id).toBe('payment: pay in the Takealot app');
      expect(registeredIds.has(id), id).toBe(false);
    }
  });

  it('blocks every payment endpoint by id before auth or fetch', async () => {
    for (const id of PAYMENT_BLOCKED_IDS) {
      const { client, fetchMock } = mkClient({ body: {} });
      const row = CATALOGUE.find((candidate) => candidate.id === id)!;
      await expect(client.call(id, row.sample)).rejects.toBeInstanceOf(PaymentBlockedError);
      expect(fetchMock, id).not.toHaveBeenCalled();
    }
  });

  it('blocks every payment endpoint by its resolved raw path', async () => {
    for (const id of PAYMENT_BLOCKED_IDS) {
      const { client, fetchMock } = mkClient({ body: {} });
      const row = CATALOGUE.find((candidate) => candidate.id === id)!;
      await expect(
        client.apiRequest(row.method, resolveSamplePath(row), {
          encoding: row.encoding,
          body: row.sample?.body,
        }),
      ).rejects.toBeInstanceOf(PaymentBlockedError);
      expect(fetchMock, id).not.toHaveBeenCalled();
    }
  });

  it('blocks every HTTP method and lowercase variant on every payment path through both transports', async () => {
    const blockedRows = PAYMENT_BLOCKED_IDS.map((id) => CATALOGUE.find((row) => row.id === id)!);
    const paths = [...new Set(blockedRows.map(resolveSamplePath))];
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    for (const path of paths) {
      for (const method of [...methods, ...methods.map((value) => value.toLowerCase())]) {
        const api = mkClient({ body: {} });
        await expect(
          api.client.apiRequest(method as any, path, { auth: true }),
        ).rejects.toBeInstanceOf(PaymentBlockedError);
        expect(api.fetchMock, `apiRequest ${method} ${path}`).not.toHaveBeenCalled();

        const authed = mkClient({ body: {} });
        await expect(authed.client.authedFetch(`/${path}`, { method })).rejects.toBeInstanceOf(
          PaymentBlockedError,
        );
        expect(authed.fetchMock, `authedFetch ${method} ${path}`).not.toHaveBeenCalled();
      }
    }
  });

  it.each([
    ['https://api.takealot.com/rest/v-1-18-0/order/9/payment', 'POST'],
    ['https://api.takealot.com//rest/v-1-18-0/checkout/1/complete', 'POST'],
    ['https://api.takealot.com/rest/v-1-18-0//checkout/1/complete', 'POST'],
    ['https://api.takealot.com/order%2F9%2Fpayment', 'POST'],
    ['https://api.takealot.com/order%252F9%252Fpayment', 'POST'],
  ])('blocks canonicalized payment URL %s', async (url, method) => {
    const { client, fetchMock } = mkClient({ body: {} });
    await expect(client.apiRequest(method as 'POST', url, { base: 'absolute' })).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks authedFetch and lowercase method games before fetch', async () => {
    const { client, fetchMock } = mkClient({ body: {} });
    await expect(client.authedFetch('/checkout/1/complete', { method: 'post' })).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://api.takealot.com/order%5C9%5Cpayment',
    'https://api.takealot.com/%E0%A4%A',
    'https://api.takealot.com/a/../checkout/1',
    'http://api.takealot.com/checkout/1',
    'https://api.takealot.com:444/checkout/1',
    'https://x:y@api.takealot.com/checkout/1',
    'https://secure.takealot.com/checkout/1',
  ])('rejects unsafe URL %s', async (url) => {
    const { client, fetchMock } = mkClient({ body: {} });
    await expect(client.authedFetch(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects redirects instead of following them', async () => {
    const { client, fetchMock } = mkClient({ status: 302, headers: { location: 'https://secure.takealot.com/pay' } });
    await expect(client.apiRequest('GET', 'safe')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps checkout preview, start, and submit available', async () => {
    const { client, fetchMock } = mkClient({ body: {} });
    await client.call('checkout.get');
    await client.call('checkout.create', { body: {} });
    await client.call('checkout.update', { body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('fetch source boundary', () => {
  it('keeps client fetch calls inside send and auth', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
    for (const name of fs.readdirSync(root).filter((file) => file.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(root, name), 'utf8');
      const matches = [...source.matchAll(/\b(?:globalThis\.)?fetch\s*\(/g)];
      if (name === 'auth.ts') continue;
      if (name === 'api-client.ts') {
        expect(matches).toHaveLength(1);
        expect(matches[0]!.index).toBeGreaterThan(source.indexOf('private async send'));
      } else {
        expect(matches, name).toHaveLength(0);
      }
    }
  });
});
