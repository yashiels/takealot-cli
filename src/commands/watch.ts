import type { Context } from '../lib/context.js';
import { LockLostError } from '../lib/directory-lock.js';
import { ServalError, UsageError } from '../lib/errors.js';
import { parsePlidRef } from '../lib/product-ref.js';
import type { ServalPoint } from '../lib/serval.js';
import { cleanServalTitle } from '../lib/serval.js';
import { rand } from '../lib/ui.js';
import {
  loadWatchlist,
  newWatchItem,
  saveWatchlist,
  withWatchlistLock,
  type WatchItem,
  type WatchReason,
  type Watchlist,
} from '../lib/watchlist.js';
import { loadServalHistory, type OkCacheRecord } from './price.js';

interface WatchAddOptions {
  target?: number;
  drop?: number;
  fromWishlist?: number;
}

interface WatchCheckOptions {
  update: boolean;
  maxRequests: number;
  verbose: boolean;
  version: string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  lockTimeoutMs?: number;
  servalLockTimeoutMs?: number;
}

interface WatchItemResult {
  plid: number;
  title: string | null;
  status: 'ok' | 'stale' | 'not_newer' | 'not_tracked' | 'error' | 'skipped';
  current: number | null;
  currentDate: string | null;
  reference: number | null;
  skipped?: 'request_limit' | 'serval_blocked';
  error?: { code: string; message: string };
}

interface WatchAlert {
  plid: number;
  title: string | null;
  url: string;
  current: number;
  currentDate: string;
  reference: number;
  target: number | null;
  dropPercent: number;
  changePercent: number;
  reasons: WatchReason[];
  historyMin: number | null;
  historyMinDate: string | null;
}

interface WatchCheckResult {
  checkedAt: string;
  attempts: number;
  cacheHits: number;
  runError: { code: string; message: string } | null;
  alerts: WatchAlert[];
  items: WatchItemResult[];
  errors: Array<{ plid: number; code: string; message: string }>;
}

class SkippedFetch extends Error {
  constructor(readonly reason: 'request_limit' | 'serval_blocked') {
    super(reason);
  }
}

const DAY_MS = 86_400_000;
const roundPrice = (value: number): number => Math.round(value * 100) / 100;
const dateOf = (point: ServalPoint): string => new Date(point[0]).toISOString().slice(0, 10);

function validateTarget(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) ||
      value <= 0 ||
      value > 10_000_000 ||
      Math.abs(value * 100 - Math.round(value * 100)) >= 1e-7)
  ) {
    throw new UsageError('--target must be a positive amount with at most 2 decimals');
  }
}

function validateDrop(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 90)) {
    throw new UsageError('--drop must be an integer from 1 to 90');
  }
}

function wishlistRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['items', 'products', 'results']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return wishlistRows(record.data);
}

function wishlistPlid(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).plid;
  try {
    if (typeof raw === 'number') return parsePlidRef(String(raw));
    if (typeof raw === 'string') return parsePlidRef(raw);
  } catch {}
  return null;
}

function addProducts(
  watchlist: Watchlist,
  plids: Array<number | null>,
  options: WatchAddOptions,
  addedAt: string,
): { added: number[]; updated: number[]; skipped: Array<{ plid: number | null; reason: string }> } {
  const added: number[] = [];
  const updated: number[] = [];
  const skipped: Array<{ plid: number | null; reason: string }> = [];
  for (const plid of plids) {
    if (plid === null) {
      skipped.push({ plid, reason: 'invalid_plid' });
      continue;
    }
    const existing = watchlist.items.find((item) => item.plid === plid);
    if (existing) {
      if (options.target !== undefined) existing.target = options.target;
      if (options.drop !== undefined) existing.dropPercent = options.drop;
      updated.push(plid);
      continue;
    }
    if (watchlist.items.length >= 50) {
      if (options.fromWishlist !== undefined) {
        skipped.push({ plid, reason: 'watchlist_full' });
        continue;
      }
      throw new UsageError('the watchlist can contain at most 50 products', 'watchlist_full');
    }
    watchlist.items.push(
      newWatchItem(plid, addedAt, options.target ?? null, options.drop ?? 5),
    );
    added.push(plid);
  }
  return { added, updated, skipped };
}

export async function watchAddCommand(
  ctx: Context,
  product: string | undefined,
  options: WatchAddOptions,
): Promise<void> {
  validateTarget(options.target);
  validateDrop(options.drop);
  if ((product === undefined) === (options.fromWishlist === undefined)) {
    throw new UsageError('provide either <product> or --from-wishlist <groupId>');
  }
  if (options.fromWishlist !== undefined && options.target !== undefined) {
    throw new UsageError('--target cannot be used with --from-wishlist');
  }
  let directPlids: Array<number | null> | null = null;
  if (options.fromWishlist !== undefined) {
    if (!Number.isSafeInteger(options.fromWishlist) || options.fromWishlist <= 0) {
      throw new UsageError('--from-wishlist must be a positive integer');
    }
  } else {
    directPlids = [parsePlidRef(product!)];
  }
  const result = await withWatchlistLock(async (lock) => {
    let plids = directPlids;
    if (options.fromWishlist !== undefined) {
      await ctx.ensureCredentials();
      const response = await ctx.client.call('wishlist.items', {
        params: { groupId: options.fromWishlist },
      });
      plids = wishlistRows(response).map(wishlistPlid);
    }
    const watchlist = loadWatchlist();
    const changes = addProducts(watchlist, plids!, options, new Date().toISOString());
    lock.assertHeld();
    saveWatchlist(watchlist);
    return { ...changes, count: watchlist.items.length, items: watchlist.items };
  });
  ctx.logger.result(
    () => process.stdout.write(`Watchlist now has ${result.count} item${result.count === 1 ? '' : 's'}.\n`),
    result,
  );
}

export async function watchRemoveCommand(ctx: Context, product: string): Promise<void> {
  const plid = parsePlidRef(product);
  const result = await withWatchlistLock(async (lock) => {
    const watchlist = loadWatchlist();
    const index = watchlist.items.findIndex((item) => item.plid === plid);
    if (index < 0) throw new UsageError(`PLID${plid} is not watched`, 'not_watched');
    watchlist.items.splice(index, 1);
    lock.assertHeld();
    saveWatchlist(watchlist);
    return { removed: plid, count: watchlist.items.length };
  });
  ctx.logger.result(() => process.stdout.write(`Removed PLID${plid} from the watchlist.\n`), result);
}

export async function watchListCommand(ctx: Context): Promise<void> {
  const watchlist = loadWatchlist();
  ctx.logger.result(
    () => {
      if (watchlist.items.length === 0) {
        process.stdout.write('The watchlist is empty.\n');
        return;
      }
      for (const item of watchlist.items) {
        process.stdout.write(`${item.title ?? `PLID${item.plid}`} · ${item.lastPrice === null ? 'not checked' : rand(item.lastPrice)}\n`);
      }
    },
    { count: watchlist.items.length, items: watchlist.items },
  );
}

function priorMinimum(points: ServalPoint[]): { price: number; date: string } | null {
  if (points.length < 2) return null;
  let minimum = points[0]!;
  for (const point of points.slice(1, -1)) {
    if (point[1] <= minimum[1]) minimum = point;
  }
  return { price: minimum[1], date: dateOf(minimum) };
}

export function applyWatchHistory(
  item: WatchItem,
  record: OkCacheRecord,
  checkedAt: string,
): { item: WatchItemResult; alert: WatchAlert | null } {
  const points = record.current;
  const last = points.at(-1)!;
  const current = last[1];
  if (current <= 0) throw new ServalError('Serval returned a non-positive current price', 'no_data');
  const currentDate = dateOf(last);
  const previousReference = item.referencePrice;
  const outputBase = {
    plid: item.plid,
    title: item.title,
    current: roundPrice(current),
    currentDate,
    reference: previousReference === null ? null : roundPrice(previousReference),
  };
  const checkedTime = Date.parse(checkedAt);
  const today = Date.UTC(
    new Date(checkedTime).getUTCFullYear(),
    new Date(checkedTime).getUTCMonth(),
    new Date(checkedTime).getUTCDate(),
  );
  if (Date.parse(`${currentDate}T00:00:00.000Z`) < today - 7 * DAY_MS) {
    item.lastCheckedAt = checkedAt;
    item.lastStatus = 'stale';
    return { item: { ...outputBase, status: 'stale' }, alert: null };
  }
  if (item.lastPriceDate !== null && currentDate <= item.lastPriceDate) {
    item.lastCheckedAt = checkedAt;
    item.lastStatus = 'ok';
    return { item: { ...outputBase, status: 'not_newer' }, alert: null };
  }
  const title = cleanServalTitle(record.title ?? '') ?? item.title;
  if (item.referencePrice === null) {
    item.referencePrice = current;
    item.referenceDate = currentDate;
    item.alertArmed = true;
    item.lastPrice = current;
    item.lastPriceDate = currentDate;
    item.lastCheckedAt = checkedAt;
    item.lastStatus = 'ok';
    item.title = title;
    return { item: { ...outputBase, title, status: 'ok' }, alert: null };
  }
  const reference = previousReference!;
  const historyMinimum = priorMinimum(points);
  const reasons: WatchReason[] = [];
  if (item.target !== null && current <= item.target) reasons.push('target');
  if (current <= item.referencePrice * (1 - item.dropPercent / 100)) reasons.push('drop');
  if (points.length >= 30 && historyMinimum !== null && current <= historyMinimum.price) reasons.push('low');
  const fired = reasons.length > 0 && item.alertArmed;
  let alert: WatchAlert | null = null;
  if (fired) {
    item.alertArmed = false;
    item.lastAlert = { price: current, date: currentDate, reasons };
    alert = {
      plid: item.plid,
      title,
      url: `https://www.takealot.com/x/PLID${item.plid}`,
      current: roundPrice(current),
      currentDate,
      reference: roundPrice(reference),
      target: item.target === null ? null : roundPrice(item.target),
      dropPercent: item.dropPercent,
      changePercent: Math.round(((current - reference) / reference) * 1000) / 10,
      reasons,
      historyMin: historyMinimum === null ? null : roundPrice(historyMinimum.price),
      historyMinDate: historyMinimum?.date ?? null,
    };
  }
  if (reasons.length === 0) item.alertArmed = true;
  if (fired && reasons.includes('drop')) {
    item.referencePrice = current;
    item.referenceDate = currentDate;
  } else if (current > item.referencePrice) {
    item.referencePrice = current;
    item.referenceDate = currentDate;
  }
  item.lastPrice = current;
  item.lastPriceDate = currentDate;
  item.lastCheckedAt = checkedAt;
  item.lastStatus = 'ok';
  item.title = title;
  return { item: { ...outputBase, title, status: 'ok' }, alert };
}

function errorCode(error: unknown): string {
  if (
    error instanceof ServalError ||
    error instanceof UsageError ||
    error instanceof LockLostError
  ) {
    return error.code;
  }
  return 'runtime_error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chooseRunError(
  blocked: boolean,
  usable: number,
  limited: boolean,
  count: number,
): WatchCheckResult['runError'] {
  if (blocked) return { code: 'serval_blocked', message: 'Serval stopped further requests' };
  if (count > 0 && usable === 0) return { code: 'no_results', message: 'No watched item returned usable price data' };
  if (limited) return { code: 'request_limit', message: 'The Serval request limit stopped some checks' };
  return null;
}

function renderCheck(result: WatchCheckResult): void {
  if (result.alerts.length === 0) {
    process.stdout.write('No price drops.\n');
  } else {
    for (const alert of result.alerts) {
      process.stdout.write(`${alert.title ?? `PLID${alert.plid}`}: ${rand(alert.current)} · ${alert.reasons.join(', ')} · ${alert.changePercent.toFixed(1)}%\n`);
    }
  }
  const skipped = result.items.filter((item) => item.status === 'skipped').length;
  process.stdout.write(`${result.alerts.length} alerts, ${result.items.length} items checked, ${skipped} skipped, ${result.errors.length} errors\n`);
}

export async function watchCheckCommand(ctx: Context, options: WatchCheckOptions): Promise<void> {
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 50) {
    throw new UsageError('--max-requests must be an integer from 1 to 50');
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const result = await withWatchlistLock(async (lock) => {
    const checkedAt = new Date(now()).toISOString();
    const watchlist = loadWatchlist(now());
    const items: WatchItemResult[] = [];
    const alerts: WatchAlert[] = [];
    const errors: WatchCheckResult['errors'] = [];
    let attempts = 0;
    let cacheHits = 0;
    let fetches = 0;
    let blocked = false;
    let limited = false;
    let usable = 0;
    for (const item of watchlist.items) {
      try {
        const loaded = await loadServalHistory(item.plid, {
          cache: true,
          version: options.version,
          verbose: options.verbose,
          ctx,
          fetchImpl: options.fetchImpl,
          now,
          wait,
          lockTimeoutMs: options.servalLockTimeoutMs,
          requireCache: true,
          onAttempt: () => {
            attempts += 1;
          },
          beforeFetch: async () => {
            if (blocked) throw new SkippedFetch('serval_blocked');
            if (attempts + 2 > options.maxRequests) {
              limited = true;
              throw new SkippedFetch('request_limit');
            }
            if (fetches > 0) await wait(3_000);
            fetches += 1;
          },
        });
        if (loaded.cached) cacheHits += 1;
        if (loaded.record.status === 'not_tracked') {
          item.lastCheckedAt = checkedAt;
          item.lastStatus = 'not_tracked';
          items.push({
            plid: item.plid,
            title: item.title,
            status: 'not_tracked',
            current: null,
            currentDate: null,
            reference: item.referencePrice === null ? null : roundPrice(item.referencePrice),
          });
          continue;
        }
        const applied = applyWatchHistory(item, loaded.record, checkedAt);
        items.push(applied.item);
        if (applied.alert) alerts.push(applied.alert);
        usable += 1;
      } catch (error) {
        if (error instanceof SkippedFetch) {
          items.push({
            plid: item.plid,
            title: item.title,
            status: 'skipped',
            current: null,
            currentDate: null,
            reference: item.referencePrice === null ? null : roundPrice(item.referencePrice),
            skipped: error.reason,
          });
          continue;
        }
        const code = errorCode(error);
        const message = errorMessage(error);
        if (code === 'serval_rate_limited' || code === 'serval_forbidden') blocked = true;
        item.lastCheckedAt = checkedAt;
        item.lastStatus = 'error';
        const failure = { plid: item.plid, code, message };
        errors.push(failure);
        items.push({
          plid: item.plid,
          title: item.title,
          status: 'error',
          current: null,
          currentDate: null,
          reference: item.referencePrice === null ? null : roundPrice(item.referencePrice),
          error: { code, message },
        });
      }
    }
    const completed = {
      checkedAt,
      attempts,
      cacheHits,
      runError: chooseRunError(blocked, usable, limited, watchlist.items.length),
      alerts,
      items,
      errors,
    } satisfies WatchCheckResult;
    if (options.update) {
      try {
        lock.assertHeld();
      } catch (error) {
        if (!(error instanceof LockLostError)) throw error;
        return {
          ...completed,
          runError: { code: error.code, message: error.message },
        } satisfies WatchCheckResult;
      }
      saveWatchlist(watchlist);
    }
    return completed;
  }, options.lockTimeoutMs);
  ctx.logger.result(() => renderCheck(result), result);
  if (
    result.runError?.code === 'serval_blocked' ||
    result.runError?.code === 'no_results' ||
    result.runError?.code === 'lock_lost'
  ) {
    process.exitCode = 1;
  }
}
