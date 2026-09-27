import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '../lib/context.js';
import { withDirectoryLock } from '../lib/directory-lock.js';
import type { ServalPoint } from '../lib/serval.js';
import {
  loadWatchlist,
  newWatchItem,
  saveWatchlist,
  watchlistLockPath,
  watchlistPath,
  type WatchItem,
} from '../lib/watchlist.js';
import {
  loadServalHistory,
  servalCachePath,
  servalLockPath,
  type OkCacheRecord,
} from '../commands/price.js';
import { applyWatchHistory, watchAddCommand, watchCheckCommand } from '../commands/watch.js';
import { run } from '../cli.js';

const NOW = Date.UTC(2026, 8, 27, 8);
const ISO_NOW = new Date(NOW).toISOString();
let temporaryDirectory: string;
let originalConfigHome: string | undefined;
let originalCacheHome: string | undefined;

function context() {
  let result: any;
  const ctx = {
    logger: {
      result: (_human: () => void, value: unknown) => {
        result = value;
      },
      warn: vi.fn(),
    },
  } as unknown as Context;
  return {
    ctx,
    get result() {
      return result;
    },
  };
}

function point(day: number, price: number): ServalPoint {
  return [Date.UTC(2026, 8, day, 8), price];
}

function record(points: ServalPoint[], plid = 42, title = 'Tracked product'): OkCacheRecord {
  return {
    schema: 1,
    status: 'ok',
    plid,
    fetchedAt: ISO_NOW,
    title,
    current: points,
    listing: [],
  };
}

function item(overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    ...newWatchItem(42, new Date(NOW - 30 * 86_400_000).toISOString(), null, 5),
    ...overrides,
  };
}

function html(points: ServalPoint[], title = 'Tracked product'): string {
  const data = {
    labels: points.map(([time]) => time),
    datasets: [{ label: 'Current Price', data: points.map(([, price]) => price) }],
  };
  return `<h1>${title}</h1>\ndata = ${JSON.stringify(data)};\n`;
}

function response(points: ServalPoint[], status = 200): Response {
  return new Response(status === 200 ? html(points) : '', { status });
}

function seed(items: WatchItem[]): void {
  saveWatchlist({ schema: 1, items });
}

function writeOwner(
  directory: string,
  owner: { pid: number; nonce: string; host: string; acquiredAt: number },
): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(owner));
}

function checkOptions(fetchImpl?: typeof fetch) {
  return {
    update: true,
    maxRequests: 50,
    verbose: false,
    version: 'test',
    now: () => NOW,
    fetchImpl,
    wait: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  originalConfigHome = process.env.XDG_CONFIG_HOME;
  originalCacheHome = process.env.XDG_CACHE_HOME;
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'takealot-watch-test-'));
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

describe('Serval single-flight loader', () => {
  it('makes one fetch for two concurrent loaders', async () => {
    const captured = context();
    const fetchImpl = vi.fn(async () => response([point(26, 100), point(27, 90)]));
    const options = {
      cache: true,
      version: 'test',
      verbose: false,
      ctx: captured.ctx,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    };
    const [first, second] = await Promise.all([
      loadServalHistory(42, options),
      loadServalHistory(42, options),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([first.cached, second.cached].sort()).toEqual([false, true]);
  });

  it('never reclaims a lock owned by another host, however old', async () => {
    const lock = servalLockPath(42);
    writeOwner(lock, { pid: 1, nonce: 'other', host: 'another-host', acquiredAt: 0 });
    await expect(
      withDirectoryLock(lock, { timeoutMs: 100, error: () => new Error('held') }, async () => 'entered'),
    ).rejects.toThrow('held');
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).host).toBe('another-host');
  });

  it('fences a holder after another owner replaces the lock', async () => {
    const lock = servalLockPath(42);
    await withDirectoryLock(
      lock,
      { timeoutMs: 1_000, error: () => new Error('held') },
      async (held) => {
        expect(() => held.assertHeld()).not.toThrow();
        writeOwner(lock, {
          pid: process.pid,
          nonce: 'replacement',
          host: os.hostname(),
          acquiredAt: Date.now(),
        });
        expect(() => held.assertHeld()).toThrowError(
          expect.objectContaining({ code: 'lock_lost' }),
        );
      },
    );
  });

  it('lets exactly one of many contenders reclaim a dead same-host lock', async () => {
    const lock = servalLockPath(42);
    writeOwner(lock, {
      pid: 2 ** 31 - 1,
      nonce: 'dead',
      host: os.hostname(),
      acquiredAt: 0,
    });
    let inside = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withDirectoryLock(lock, { timeoutMs: 5_000, error: () => new Error('timeout') }, async () => {
          inside += 1;
          peak = Math.max(peak, inside);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inside -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('refuses to fetch outside the lock when the cache is required but unavailable', async () => {
    const captured = context();
    const fetchImpl = vi.fn(async () => response([point(27, 90)]));
    fs.mkdirSync(temporaryDirectory, { recursive: true });
    fs.writeFileSync(path.join(temporaryDirectory, 'cache'), 'not a directory');
    await expect(
      loadServalHistory(42, {
        cache: true,
        version: 'test',
        verbose: false,
        ctx: captured.ctx,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        requireCache: true,
      }),
    ).rejects.toMatchObject({ code: 'serval_cache_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out with serval_busy', async () => {
    let release = (): void => undefined;
    const held = withDirectoryLock(
      servalLockPath(42),
      { timeoutMs: 1_000, error: () => new Error('locked') },
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await vi.waitFor(() => expect(fs.existsSync(servalLockPath(42))).toBe(true));
    await expect(
      loadServalHistory(42, {
        cache: true,
        version: 'test',
        verbose: false,
        ctx: context().ctx,
        fetchImpl: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        lockTimeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'serval_busy' });
    release();
    await held;
  });

  it('uses a failure marker for ten minutes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const options = {
      cache: true,
      version: 'test',
      verbose: false,
      ctx: context().ctx,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    };
    await expect(loadServalHistory(42, options)).rejects.toMatchObject({
      code: 'serval_rate_limited',
    });
    await expect(loadServalHistory(42, options)).rejects.toMatchObject({
      code: 'serval_rate_limited',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('drop rules', () => {
  it('sets the first reference without an alert', () => {
    const watched = item();
    const applied = applyWatchHistory(watched, record([point(27, 100)]), ISO_NOW);
    expect(applied.alert).toBeNull();
    expect(watched).toMatchObject({ referencePrice: 100, lastPrice: 100, alertArmed: true });
  });

  it.each([
    ['exactly', 95, true],
    ['just under', 95.01, false],
  ])('alerts for a drop %s the threshold', (_name, current, alerts) => {
    const watched = item({ referencePrice: 100, referenceDate: '2026-09-26' });
    const applied = applyWatchHistory(watched, record([point(26, 100), point(27, current)]), ISO_NOW);
    expect(applied.alert?.reasons.includes('drop') ?? false).toBe(alerts);
  });

  it.each([
    ['equal', 85],
    ['below', 84],
  ])('alerts when the target is %s', (_name, current) => {
    const watched = item({ target: 85, referencePrice: 100, referenceDate: '2026-09-26' });
    expect(
      applyWatchHistory(watched, record([point(26, 100), point(27, current)]), ISO_NOW).alert?.reasons,
    ).toContain('target');
  });

  it.each([
    ['fewer than 30', 29, false],
    ['30', 30, true],
  ])('applies low with %s points', (_name, count, expected) => {
    const points = Array.from({ length: count }, (_, index) => [
      Date.UTC(2026, 7, 29 + index, 8),
      index === count - 1 ? 90 : 100,
    ] as ServalPoint);
    const watched = item({ dropPercent: 90, referencePrice: 100, referenceDate: '2026-09-01' });
    const applied = applyWatchHistory(watched, record(points), ISO_NOW);
    expect(applied.alert?.reasons.includes('low') ?? false).toBe(expected);
  });

  it('does not alert or change price state for stale data', () => {
    const watched = item({
      target: 200,
      referencePrice: 100,
      referenceDate: '2026-09-01',
      lastPrice: 100,
      lastPriceDate: '2026-09-01',
    });
    const before = { ...watched };
    const applied = applyWatchHistory(watched, record([point(1, 50)]), ISO_NOW);
    expect(applied.item.status).toBe('stale');
    expect(watched).toMatchObject({
      referencePrice: before.referencePrice,
      lastPrice: before.lastPrice,
      lastPriceDate: before.lastPriceDate,
      alertArmed: before.alertArmed,
    });
  });

  it('does not alert twice for the same date', () => {
    const watched = item({ target: 85, referencePrice: 100, referenceDate: '2026-09-26' });
    expect(applyWatchHistory(watched, record([point(27, 80)]), ISO_NOW).alert).not.toBeNull();
    expect(applyWatchHistory(watched, record([point(27, 80)]), ISO_NOW).alert).toBeNull();
  });

  it('re-arms after a recovery and alerts after a new fall', () => {
    const watched = item({ target: 85, dropPercent: 90, referencePrice: 100, referenceDate: '2026-09-24' });
    expect(applyWatchHistory(watched, record([point(25, 80)]), new Date(Date.UTC(2026, 8, 25, 8)).toISOString()).alert).not.toBeNull();
    expect(applyWatchHistory(watched, record([point(26, 100)]), new Date(Date.UTC(2026, 8, 26, 8)).toISOString()).alert).toBeNull();
    expect(applyWatchHistory(watched, record([point(27, 80)]), ISO_NOW).alert).not.toBeNull();
  });

  it('alerts once while a price stays below its target', () => {
    const watched = item({ target: 85, dropPercent: 90, referencePrice: 100, referenceDate: '2026-09-24' });
    const alerts = [80, 82, 79].map((price, index) =>
      applyWatchHistory(
        watched,
        record([point(25 + index, price)]),
        new Date(Date.UTC(2026, 8, 25 + index, 8)).toISOString(),
      ).alert,
    );
    expect(alerts.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ['target-only', { target: 99, dropPercent: 90 }, [point(26, 100), point(27, 98)]],
    ['low-only', { target: null, dropPercent: 90 }, Array.from({ length: 30 }, (_, index) => [Date.UTC(2026, 7, 29 + index, 8), index === 29 ? 99 : 100] as ServalPoint)],
  ])('does not move the reference for a %s alert', (_name, overrides, points) => {
    const watched = item({ referencePrice: 100, referenceDate: '2026-09-01', ...overrides });
    const applied = applyWatchHistory(watched, record(points), ISO_NOW);
    expect(applied.alert).not.toBeNull();
    expect(watched.referencePrice).toBe(100);
  });

  it('moves the reference up when a target-only alert is above it', () => {
    const watched = item({ referencePrice: 100, referenceDate: '2026-09-01', target: 120, dropPercent: 90 });
    const applied = applyWatchHistory(watched, record([point(26, 100), point(27, 110)]), ISO_NOW);
    expect(applied.alert?.reasons).toEqual(['target']);
    expect(applied.alert?.reference).toBe(100);
    expect(watched.referencePrice).toBe(110);
  });

  it('keeps the stored title when Serval has none', () => {
    const watched = item({ referencePrice: 100, referenceDate: '2026-09-01', title: 'Stored title' });
    applyWatchHistory(watched, { ...record([point(27, 100)]), title: null }, ISO_NOW);
    expect(watched.title).toBe('Stored title');
  });

  it('moves the reference up and keeps it after a small fall', () => {
    const watched = item({ referencePrice: 100, referenceDate: '2026-09-24' });
    applyWatchHistory(watched, record([point(25, 110)]), new Date(Date.UTC(2026, 8, 25, 8)).toISOString());
    expect(watched.referencePrice).toBe(110);
    applyWatchHistory(watched, record([point(26, 108)]), new Date(Date.UTC(2026, 8, 26, 8)).toISOString());
    expect(watched.referencePrice).toBe(110);
  });

  it('changes only check metadata for data that is not newer', () => {
    const watched = item({
      referencePrice: 100,
      referenceDate: '2026-09-26',
      lastPrice: 90,
      lastPriceDate: '2026-09-27',
      alertArmed: false,
    });
    const before = structuredClone(watched);
    const applied = applyWatchHistory(watched, record([point(27, 80)]), ISO_NOW);
    expect(applied.item.status).toBe('not_newer');
    expect({ ...watched, lastCheckedAt: before.lastCheckedAt, lastStatus: before.lastStatus }).toEqual(before);
  });

  it('uses array position for a duplicate-time low', () => {
    const points = Array.from({ length: 28 }, (_, index) => point(index + 1, 100));
    points.push(point(27, 90), point(27, 90));
    const watched = item({ dropPercent: 90, referencePrice: 100, referenceDate: '2026-08-01' });
    expect(applyWatchHistory(watched, record(points), ISO_NOW).alert?.reasons).toContain('low');
  });

  it('reports several reasons at once', () => {
    const points = Array.from({ length: 29 }, (_, index) => [Date.UTC(2026, 7, 29 + index, 8), 100] as ServalPoint);
    points.push(point(27, 80));
    const watched = item({ target: 85, referencePrice: 100, referenceDate: '2026-08-01' });
    expect(applyWatchHistory(watched, record(points), ISO_NOW).alert?.reasons).toEqual([
      'target',
      'drop',
      'low',
    ]);
  });
});

describe('watch check loop', () => {
  it('serves cache hits without attempts or waits', async () => {
    const captured = context();
    const fetchImpl = vi.fn(async () => response([point(27, 100)]));
    await loadServalHistory(42, {
      cache: true,
      version: 'test',
      verbose: false,
      ctx: captured.ctx,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    seed([item()]);
    fetchImpl.mockClear();
    const wait = vi.fn().mockResolvedValue(undefined);
    await watchCheckCommand(captured.ctx, { ...checkOptions(fetchImpl as unknown as typeof fetch), wait });
    expect(captured.result).toMatchObject({ attempts: 0, cacheHits: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits three seconds between fetches with fake timers', async () => {
    vi.useFakeTimers();
    seed([item({ plid: 42 }), item({ plid: 43 })]);
    const captured = context();
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      response([point(27, String(url).includes('PLID42') ? 100 : 90)]),
    );
    const promise = watchCheckCommand(captured.ctx, {
      ...checkOptions(fetchImpl as unknown as typeof fetch),
      wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('counts retry attempts and skips when only one request remains', async () => {
    seed([item({ plid: 42 }), item({ plid: 43 })]);
    const captured = context();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(response([point(27, 100)]));
    await watchCheckCommand(captured.ctx, {
      ...checkOptions(fetchImpl as unknown as typeof fetch),
      maxRequests: 3,
    });
    expect(captured.result).toMatchObject({
      attempts: 2,
      runError: { code: 'request_limit' },
      items: [{ plid: 42, status: 'ok' }, { plid: 43, status: 'skipped', skipped: 'request_limit' }],
    });
  });

  it.each([429, 403])('stops after HTTP %s and exits one', async (status) => {
    seed([item({ plid: 42 }), item({ plid: 43 })]);
    const captured = context();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status }));
    await watchCheckCommand(captured.ctx, checkOptions(fetchImpl as unknown as typeof fetch));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured.result).toMatchObject({
      attempts: 1,
      runError: { code: 'serval_blocked' },
      items: [{ status: 'error' }, { status: 'skipped', skipped: 'serval_blocked' }],
    });
    expect(process.exitCode).toBe(1);
  });

  it('continues after a per-item error', async () => {
    seed([item({ plid: 42 }), item({ plid: 43 })]);
    const captured = context();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 418 }))
      .mockResolvedValueOnce(response([point(27, 90)]));
    await watchCheckCommand(captured.ctx, checkOptions(fetchImpl as unknown as typeof fetch));
    expect(captured.result.items).toMatchObject([{ status: 'error' }, { status: 'ok' }]);
    expect(captured.result.runError).toBeNull();
  });

  it('does not write the watchlist after its lock is replaced', async () => {
    seed([item()]);
    const before = fs.readFileSync(watchlistPath(), 'utf8');
    const captured = context();
    const fetchImpl = vi.fn(async () => {
      writeOwner(watchlistLockPath(), {
        pid: process.pid,
        nonce: 'replacement',
        host: os.hostname(),
        acquiredAt: Date.now(),
      });
      return response([point(27, 100)]);
    });
    await watchCheckCommand(captured.ctx, checkOptions(fetchImpl as unknown as typeof fetch));
    expect(captured.result.runError).toMatchObject({ code: 'lock_lost' });
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(watchlistPath(), 'utf8')).toBe(before);
  });

  it('records a lost Serval lock and continues without its cache write', async () => {
    seed([item({ plid: 42 }), item({ plid: 43 })]);
    const captured = context();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('PLID42')) {
        writeOwner(servalLockPath(42), {
          pid: process.pid,
          nonce: 'replacement',
          host: os.hostname(),
          acquiredAt: Date.now(),
        });
      }
      return response([point(27, 100)]);
    });
    await watchCheckCommand(captured.ctx, checkOptions(fetchImpl as unknown as typeof fetch));
    expect(captured.result.items).toMatchObject([
      { plid: 42, status: 'error', error: { code: 'lock_lost' } },
      { plid: 43, status: 'ok' },
    ]);
    expect(captured.result.errors).toMatchObject([{ plid: 42, code: 'lock_lost' }]);
    expect(fs.existsSync(servalCachePath(42))).toBe(false);
    expect(fs.existsSync(servalCachePath(43))).toBe(true);
  });

  it('does not write the watchlist with no-update', async () => {
    seed([item()]);
    const before = fs.readFileSync(watchlistPath(), 'utf8');
    const captured = context();
    await watchCheckCommand(captured.ctx, {
      ...checkOptions(vi.fn(async () => response([point(27, 100)])) as unknown as typeof fetch),
      update: false,
    });
    expect(fs.readFileSync(watchlistPath(), 'utf8')).toBe(before);
    expect(fs.existsSync(servalCachePath(42))).toBe(true);
  });

  it('returns no_results and exits one when no item has usable data', async () => {
    seed([item()]);
    const captured = context();
    await watchCheckCommand(
      captured.ctx,
      checkOptions(vi.fn().mockResolvedValue(new Response('', { status: 404 })) as unknown as typeof fetch),
    );
    expect(captured.result.runError).toMatchObject({ code: 'no_results' });
    expect(process.exitCode).toBe(1);
    expect(loadWatchlist().items[0]?.lastStatus).toBe('not_tracked');
  });

  it('returns an empty successful result', async () => {
    seed([]);
    const captured = context();
    await watchCheckCommand(captured.ctx, checkOptions(vi.fn() as unknown as typeof fetch));
    expect(captured.result).toMatchObject({ attempts: 0, cacheHits: 0, runError: null, items: [] });
    expect(process.exitCode).toBeUndefined();
  });
});

it('watch add exits one without writing after its lock is replaced', async () => {
  seed([]);
  const before = fs.readFileSync(watchlistPath(), 'utf8');
  const captured = context();
  Object.assign(captured.ctx, {
    ensureCredentials: vi.fn().mockResolvedValue({}),
    client: {
      call: vi.fn(async () => {
        writeOwner(watchlistLockPath(), {
          pid: process.pid,
          nonce: 'replacement',
          host: os.hostname(),
          acquiredAt: Date.now(),
        });
        return { items: [{ plid: 42 }] };
      }),
    },
  });
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const command = new Command('add').option('--json');
  command.setOptionValue('json', true);
  await run(command, () =>
    watchAddCommand(captured.ctx, undefined, { fromWishlist: 7 }),
  );
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(output.join(''))).toMatchObject({ code: 'lock_lost' });
  expect(fs.readFileSync(watchlistPath(), 'utf8')).toBe(before);
});

it.skipIf(process.env.TAKEALOT_LIVE !== '1')('checks one live product without updating', async () => {
  seed([item({ plid: 46639928 })]);
  await watchCheckCommand(context().ctx, {
    update: false,
    maxRequests: 2,
    verbose: false,
    version: 'test',
  });
  expect(fs.readFileSync(watchlistPath(), 'utf8')).toContain('46639928');
});
