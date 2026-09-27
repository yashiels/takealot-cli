import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '../lib/context.js';
import { withDirectoryLock } from '../lib/directory-lock.js';
import { WatchError } from '../lib/errors.js';
import {
  loadWatchlist,
  newWatchItem,
  saveWatchlist,
  validateWatchlist,
  watchlistLockPath,
  watchlistPath,
  withWatchlistLock,
  type Watchlist,
} from '../lib/watchlist.js';
import {
  watchAddCommand,
  watchCheckCommand,
  watchListCommand,
  watchRemoveCommand,
} from '../commands/watch.js';

const NOW = Date.UTC(2026, 8, 27, 8);
const ISO_NOW = new Date(NOW).toISOString();
let temporaryDirectory: string;
let originalConfigHome: string | undefined;
let originalCacheHome: string | undefined;

function context(response: unknown = { items: [] }) {
  let result: unknown;
  const call = vi.fn().mockResolvedValue(response);
  const ctx = {
    logger: {
      result: (_human: () => void, value: unknown) => {
        result = value;
      },
      warn: vi.fn(),
    },
    ensureCredentials: vi.fn().mockResolvedValue({}),
    client: { call },
  } as unknown as Context;
  return {
    ctx,
    call,
    get result() {
      return result;
    },
  };
}

function validWatchlist(): Watchlist {
  return {
    schema: 1,
    items: [
      {
        ...newWatchItem(42, ISO_NOW, 99.99, 5),
        title: 'Product',
        referencePrice: 120,
        referenceDate: '2026-09-26',
        lastCheckedAt: ISO_NOW,
        lastPrice: 110,
        lastPriceDate: '2026-09-27',
        lastStatus: 'ok',
        lastAlert: { price: 110, date: '2026-09-27', reasons: ['drop'] },
      },
    ],
  };
}

beforeEach(() => {
  originalConfigHome = process.env.XDG_CONFIG_HOME;
  originalCacheHome = process.env.XDG_CACHE_HOME;
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'takealot-watchlist-test-'));
  process.env.XDG_CONFIG_HOME = path.join(temporaryDirectory, 'config');
  process.env.XDG_CACHE_HOME = path.join(temporaryDirectory, 'cache');
});

afterEach(() => {
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
});

describe('watchlist file', () => {
  it('treats a missing file as an empty list', () => {
    expect(loadWatchlist(NOW)).toEqual({ schema: 1, items: [] });
  });

  it('writes mode 0600 and reads the file', () => {
    const watchlist = validWatchlist();
    saveWatchlist(watchlist);
    expect(loadWatchlist(NOW)).toEqual(watchlist);
    expect(fs.statSync(watchlistPath()).mode & 0o777).toBe(0o600);
  });

  const invalidCases: Array<[string, (value: any) => void]> = [
    ['root object', (value) => Object.assign(value, { extra: true })],
    ['schema', (value) => (value.schema = 2)],
    ['items array', (value) => (value.items = {})],
    ['50 item limit', (value) => (value.items = Array.from({ length: 51 }, (_, index) => newWatchItem(index + 1, ISO_NOW, null, 5)))],
    ['item object', (value) => (value.items[0] = null)],
    ['item keys', (value) => (value.items[0].extra = true)],
    ['positive plid', (value) => (value.items[0].plid = 0)],
    ['unique plid', (value) => value.items.push({ ...value.items[0] })],
    ['title', (value) => (value.items[0].title = 'x'.repeat(201))],
    ['addedAt', (value) => (value.items[0].addedAt = '2026-09-27')],
    ['future addedAt', (value) => (value.items[0].addedAt = new Date(NOW + 1).toISOString())],
    ['lastCheckedAt', (value) => (value.items[0].lastCheckedAt = 'bad')],
    ['referenceDate', (value) => (value.items[0].referenceDate = '2026-02-30')],
    ['lastPriceDate', (value) => (value.items[0].lastPriceDate = '2026-13-01')],
    ['target positive', (value) => (value.items[0].target = 0)],
    ['target decimals', (value) => (value.items[0].target = 1.001)],
    ['target maximum', (value) => (value.items[0].target = 10_000_001)],
    ['drop percent', (value) => (value.items[0].dropPercent = 91)],
    ['reference price', (value) => (value.items[0].referencePrice = -1)],
    ['last price', (value) => (value.items[0].lastPrice = Number.NaN)],
    ['last status', (value) => (value.items[0].lastStatus = 'skipped')],
    ['alert armed', (value) => (value.items[0].alertArmed = 1)],
    ['last alert object', (value) => (value.items[0].lastAlert = [])],
    ['last alert keys', (value) => (value.items[0].lastAlert.extra = true)],
    ['last alert price', (value) => (value.items[0].lastAlert.price = 0)],
    ['last alert date', (value) => (value.items[0].lastAlert.date = 'bad')],
    ['last alert reasons', (value) => (value.items[0].lastAlert.reasons = [])],
    ['last alert reason values', (value) => (value.items[0].lastAlert.reasons = ['sale'])],
    ['last alert unique reasons', (value) => (value.items[0].lastAlert.reasons = ['drop', 'drop'])],
    ['reference pair', (value) => (value.items[0].referenceDate = null)],
    ['last price pair', (value) => (value.items[0].lastPriceDate = null)],
  ];

  it.each(invalidCases)('rejects invalid %s', (_name, change) => {
    const value = structuredClone(validWatchlist());
    change(value);
    expect(() => validateWatchlist(value, NOW)).toThrowError(
      expect.objectContaining({ code: 'watchlist_invalid' }),
    );
  });

  it('does not change an invalid file', () => {
    fs.mkdirSync(path.dirname(watchlistPath()), { recursive: true });
    fs.writeFileSync(watchlistPath(), '{"schema":2}\n');
    const before = fs.readFileSync(watchlistPath(), 'utf8');
    expect(() => loadWatchlist(NOW)).toThrow(WatchError);
    expect(fs.readFileSync(watchlistPath(), 'utf8')).toBe(before);
  });

  it('creates, updates, lists, and removes products without a Serval request', async () => {
    const captured = context();
    await watchAddCommand(captured.ctx, 'PLID42', { target: 100 });
    await watchAddCommand(captured.ctx, '42', { drop: 10 });
    await watchListCommand(captured.ctx);
    expect(loadWatchlist().items[0]).toMatchObject({ plid: 42, target: 100, dropPercent: 10 });
    expect(fetch).toBeDefined();
    await watchRemoveCommand(captured.ctx, '42');
    expect(loadWatchlist().items).toEqual([]);
  });

  it('keeps state on duplicate add and updates only supplied fields', async () => {
    const watchlist = validWatchlist();
    saveWatchlist(watchlist);
    const captured = context();
    await watchAddCommand(captured.ctx, '42', { drop: 12 });
    expect(loadWatchlist().items[0]).toEqual({
      ...watchlist.items[0],
      dropPercent: 12,
    });
  });

  it('rejects a missing remove', async () => {
    await expect(watchRemoveCommand(context().ctx, '42')).rejects.toMatchObject({
      code: 'not_watched',
    });
  });

  it('rejects the fifty-first direct add', async () => {
    saveWatchlist({
      schema: 1,
      items: Array.from({ length: 50 }, (_, index) => newWatchItem(index + 1, ISO_NOW, null, 5)),
    });
    await expect(watchAddCommand(context().ctx, '100', {})).rejects.toMatchObject({
      code: 'watchlist_full',
    });
  });

  it('waits for the watchlist lock and then writes', async () => {
    let release = (): void => undefined;
    const held = withWatchlistLock(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
      1_000,
    );
    await vi.waitFor(() => expect(fs.existsSync(watchlistLockPath())).toBe(true));
    const add = watchAddCommand(context().ctx, '42', {});
    setTimeout(release, 30);
    await Promise.all([held, add]);
    expect(loadWatchlist().items).toHaveLength(1);
  });

  it('times out with watchlist_locked', async () => {
    let release = (): void => undefined;
    const held = withWatchlistLock(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
      1_000,
    );
    await vi.waitFor(() => expect(fs.existsSync(watchlistLockPath())).toBe(true));
    await expect(withWatchlistLock(async () => undefined, 5)).rejects.toMatchObject({
      code: 'watchlist_locked',
    });
    release();
    await held;
  });

  it('takes the lock for no-update and writes nothing', async () => {
    saveWatchlist({ schema: 1, items: [] });
    const before = fs.readFileSync(watchlistPath(), 'utf8');
    let release = (): void => undefined;
    const held = withDirectoryLock(
      watchlistLockPath(),
      { timeoutMs: 1_000, error: () => new Error('locked') },
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await vi.waitFor(() => expect(fs.existsSync(watchlistLockPath())).toBe(true));
    await expect(
      watchCheckCommand(context().ctx, {
        update: false,
        maxRequests: 50,
        verbose: false,
        version: 'test',
        lockTimeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'watchlist_locked' });
    release();
    await held;
    await watchCheckCommand(context().ctx, {
      update: false,
      maxRequests: 50,
      verbose: false,
      version: 'test',
    });
    expect(fs.readFileSync(watchlistPath(), 'utf8')).toBe(before);
  });
});

describe('wishlist import', () => {
  it('adds valid PLIDs, skips missing ones, and makes no Serval request', async () => {
    const captured = context({ items: [{ plid: 42 }, { title: 'missing' }, { plid: 'PLID43' }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await watchAddCommand(captured.ctx, undefined, { fromWishlist: 7, drop: 8 });
    expect(loadWatchlist().items.map((item) => [item.plid, item.dropPercent])).toEqual([
      [42, 8],
      [43, 8],
    ]);
    expect(captured.result).toMatchObject({ skipped: [{ plid: null, reason: 'invalid_plid' }] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops at the limit and reports the rest', async () => {
    saveWatchlist({
      schema: 1,
      items: Array.from({ length: 49 }, (_, index) => newWatchItem(index + 1, ISO_NOW, null, 5)),
    });
    const captured = context({ items: [{ plid: 100 }, { plid: 101 }] });
    await watchAddCommand(captured.ctx, undefined, { fromWishlist: 7 });
    expect(loadWatchlist().items).toHaveLength(50);
    expect(captured.result).toMatchObject({
      added: [100],
      skipped: [{ plid: 101, reason: 'watchlist_full' }],
    });
  });

  it.each([
    ['both sources', '42', { fromWishlist: 7 }],
    ['neither source', undefined, {}],
    ['target import', undefined, { fromWishlist: 7, target: 10 }],
  ])('rejects %s', async (_name, product, options) => {
    await expect(watchAddCommand(context().ctx, product, options)).rejects.toBeInstanceOf(Error);
  });
});
