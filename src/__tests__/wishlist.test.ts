import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { wishlistAdd, wishlistMove, wishlistRemoveItems } from '../commands/wishlist.js';
import type { Context } from '../lib/context.js';
import { DEFAULTS, type TakealotClient } from '../lib/api-client.js';
import { mkClient } from './mkclient.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/4.3.0');
const fixturePath = (name: string) => path.join(fixtureDir, name);
const fixture = (name: string) =>
  JSON.parse(readFileSync(fixturePath(name), 'utf8')) as Record<string, any>;

function context(client: TakealotClient): Context {
  return {
    client,
    ensureCredentials: async () => undefined,
    logger: { isJson: true, result: () => undefined },
  } as unknown as Context;
}

function expectRequest(
  call: { url: string; init: RequestInit },
  method: string,
  pathName: string,
  body: unknown,
): void {
  expect(call.init.method).toBe(method);
  expect(call.url).toBe(`${DEFAULTS.mobileApiBase}/${pathName}`);
  expect(JSON.parse(String(call.init.body))).toEqual(body);
}

describe('typed wishlist writes', () => {
  it('rejects malformed ids before any request, including a resolved PLID sku', async () => {
    const plidClient = mkClient({ body: { buybox: { items: [{ sku: 7, price: 1 }] }, core: { id: 46639928 } } });
    await expect(
      wishlistAdd(context(plidClient.client), '27948686', undefined, { plid: 46639928, confirm: true, yes: true }),
    ).rejects.toThrow('--sku must be a Takealot id');
    expect(plidClient.calls.every((call) => (call.init.method ?? 'GET') === 'GET')).toBe(true);

    const writes: Array<(c: Context) => Promise<void>> = [
      (c) => wishlistMove(c, { from: 27948686, to: 27948687, tsin: [9], confirm: true, yes: true }),
      (c) => wishlistMove(c, { from: -1, to: 27948687, tsin: [104146086], confirm: true, yes: true }),
      (c) => wishlistMove(c, { from: 27948686, to: 27948686, tsin: [104146086], confirm: true, yes: true }),
      (c) => wishlistRemoveItems(c, 0, { tsin: [104146086], confirm: true, yes: true }),
      (c) => wishlistRemoveItems(c, 27948686, { tsin: [5], confirm: true, yes: true }),
    ];
    for (const write of writes) {
      const { client, calls } = mkClient({ body: {} });
      await expect(write(context(client))).rejects.toMatchObject({ name: 'UsageError' });
      expect(calls).toHaveLength(0);
    }
  });

  it('adds repeated SKUs with the app request schema and keeps --file', async () => {
    const body = fixture('wishlist-add-body.json');
    const typed = mkClient({ body: {} });
    await wishlistAdd(context(typed.client), '27948686', undefined, {
      sku: body.products.map((product: { sku: number }) => product.sku),
      confirm: true,
      yes: true,
    });
    expectRequest(typed.calls[0]!, 'POST', 'customers/12345/wishlists/27948686/items', body);

    const file = mkClient({ body: {} });
    await wishlistAdd(context(file.client), '27948686', undefined, {
      file: fixturePath('wishlist-add-body.json'),
      confirm: true,
      yes: true,
    });
    expectRequest(file.calls[0]!, 'POST', 'customers/12345/wishlists/27948686/items', body);

    const lastUsed = mkClient({ body: {} });
    await wishlistAdd(context(lastUsed.client), undefined, undefined, {
      file: fixturePath('wishlist-add-body.json'),
      confirm: true,
      yes: true,
    });
    expectRequest(lastUsed.calls[0]!, 'POST', 'customers/12345/wishlists/last_used/items', body);

    const legacy = mkClient({ body: {} });
    await wishlistAdd(context(legacy.client), 'group', '27948686', {
      file: fixturePath('wishlist-add-body.json'),
      confirm: true,
      yes: true,
    });
    expectRequest(legacy.calls[0]!, 'POST', 'customers/12345/wishlists/27948686/items', body);
  });

  it('resolves a PLID through skuForPlid before adding it', async () => {
    const body = fixture('wishlist-add-body.json');
    const resolved = mkClient({ body: {} });
    const skuForPlid = vi
      .spyOn(resolved.client, 'skuForPlid')
      .mockResolvedValue(body.products[0].sku);
    await wishlistAdd(context(resolved.client), '27948686', undefined, {
      plid: 52580339,
      confirm: true,
      yes: true,
    });
    expect(skuForPlid).toHaveBeenCalledWith(52580339);
    expectRequest(resolved.calls[0]!, 'POST', 'customers/12345/wishlists/27948686/items', {
      products: [body.products[0]],
    });
  });

  it.each([1, 0, -1, 999])('rejects unsafe SKU %s before sending', async (sku) => {
    const rejected = mkClient({ body: {} });
    await expect(
      wishlistAdd(context(rejected.client), '27948686', undefined, {
        sku: [sku],
        confirm: true,
        yes: true,
      }),
    ).rejects.toThrow('--sku must be a Takealot id (a positive integer of at least 4 digits)');
    expect(rejected.calls).toHaveLength(0);
  });

  it.each([
    ['other', undefined],
    ['group', undefined],
    ['42', '43'],
  ])('rejects invalid add target %s %s', async (target, groupId) => {
    const rejected = mkClient({ body: {} });
    await expect(
      wishlistAdd(context(rejected.client), target, groupId, {
        file: fixturePath('wishlist-add-body.json'),
        confirm: true,
        yes: true,
      }),
    ).rejects.toThrow('wishlist add target must be <groupId> or group <groupId>');
    expect(rejected.calls).toHaveLength(0);
  });

  it('moves TSINs with vn2 and keeps --file', async () => {
    const body = fixture('wishlist-move-body.json');
    const typed = mkClient({ body: {} });
    await wishlistMove(context(typed.client), {
      from: body.from,
      to: body.to[0],
      tsin: body.products.map((product: { tsin: number }) => product.tsin),
      confirm: true,
      yes: true,
    });
    expectRequest(typed.calls[0]!, 'PUT', 'customers/12345/wishlists/items/move', body);

    const file = mkClient({ body: {} });
    await wishlistMove(context(file.client), {
      file: fixturePath('wishlist-move-body.json'),
      confirm: true,
      yes: true,
    });
    expectRequest(file.calls[0]!, 'PUT', 'customers/12345/wishlists/items/move', body);
  });

  it('bulk-removes TSINs with the app request schema and keeps --file', async () => {
    const body = fixture('wishlist-remove-body.json');
    const typed = mkClient({ body: {} });
    await wishlistRemoveItems(context(typed.client), 27948686, {
      tsin: body.products.map((product: { tsin: number }) => product.tsin),
      confirm: true,
      yes: true,
    });
    expectRequest(typed.calls[0]!, 'DELETE', 'customers/12345/wishlists/27948686/items', body);

    const file = mkClient({ body: {} });
    await wishlistRemoveItems(context(file.client), 27948686, {
      file: fixturePath('wishlist-remove-body.json'),
      confirm: true,
      yes: true,
    });
    expectRequest(file.calls[0]!, 'DELETE', 'customers/12345/wishlists/27948686/items', body);
  });
});
