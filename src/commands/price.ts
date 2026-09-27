import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '../lib/context.js';
import { atomicWriteJson } from '../lib/config.js';
import { ServalError, UsageError } from '../lib/errors.js';
import {
  LockLostError,
  withDirectoryLock,
  type DirectoryLockHandle,
} from '../lib/directory-lock.js';
import { parsePlidRef } from '../lib/product-ref.js';
import {
  cleanServalPoints,
  cleanServalTitle,
  fetchServalPage,
  parseServalPage,
  type ServalPoint,
} from '../lib/serval.js';
import { c, rand } from '../lib/ui.js';

interface PriceHistoryOptions {
  since: string;
  series: boolean;
  cache: boolean;
  verbose: boolean;
  version: string;
}

export interface OkCacheRecord {
  schema: 1;
  status: 'ok';
  plid: number;
  fetchedAt: string;
  title: string | null;
  current: ServalPoint[];
  listing: ServalPoint[];
}

export interface NotTrackedCacheRecord {
  schema: 1;
  status: 'not_tracked';
  plid: number;
  fetchedAt: string;
}

export type ServalHistoryRecord = OkCacheRecord | NotTrackedCacheRecord;

interface FailureMarker {
  failedAt: string;
  code: string;
}

export interface LoadServalHistoryOptions {
  cache: boolean;
  version: string;
  verbose: boolean;
  ctx: Context;
  beforeFetch?: () => Promise<void>;
  onAttempt?: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  lockTimeoutMs?: number;
  requireCache?: boolean;
}

export interface LoadedServalHistory {
  record: ServalHistoryRecord;
  cached: boolean;
}

interface PriceHistoryResult {
  plid: number;
  title: string | null;
  source: 'servaltracker.com';
  url: string;
  fetchedAt: string;
  cached: boolean;
  window: string;
  points: number;
  firstDate: string;
  lastDate: string;
  stale: boolean;
  current: number;
  currentDate: string;
  min: number;
  minDate: string;
  max: number;
  maxDate: string;
  average: number;
  median: number;
  lastChange: { date: string; from: number; to: number } | null;
  listingPrice: number | null;
  listingPriceDate: string | null;
  series?: { date: string; price: number }[];
}

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const dateOf = (point: ServalPoint): string => new Date(point[0]).toISOString().slice(0, 10);
const roundPrice = (price: number): number => Math.round(price * 100) / 100;
const servalUrl = (plid: number): string => `https://www.servaltracker.com/products/PLID${plid}/`;

export function parsePriceWindow(value: string): number | null {
  if (value === 'all') return null;
  const match = /^(\d+)([dwmy])$/.exec(value);
  if (!match) throw new UsageError(`invalid --since: ${value}`);
  const count = Number(match[1]);
  const multiplier = { d: 1, w: 7, m: 30, y: 365 }[match[2]!]!;
  const days = count * multiplier;
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new UsageError(`invalid --since: ${value}`);
  }
  return days;
}

function cacheBase(): string {
  const root = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(root, 'takealot-cli');
}

export function servalCachePath(plid: number): string {
  return path.join(cacheBase(), 'serval', `PLID${plid}.json`);
}

export function servalLockPath(plid: number): string {
  return path.join(cacheBase(), 'serval', `PLID${plid}.lock`);
}

const servalFailurePath = (plid: number): string =>
  path.join(cacheBase(), 'serval', `PLID${plid}.failure.json`);

function validIsoTime(value: unknown, now: number): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now) return false;
  return new Date(time).toISOString() === value;
}

function samePoints(left: unknown, right: ServalPoint[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readCache(plid: number, now: number): ServalHistoryRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(servalCachePath(plid), 'utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== 1 ||
    record.plid !== plid ||
    !validIsoTime(record.fetchedAt, now) ||
    now - Date.parse(record.fetchedAt) > CACHE_TTL_MS
  ) {
    return null;
  }
  if (record.status === 'not_tracked') {
    return {
      schema: 1,
      status: 'not_tracked',
      plid,
      fetchedAt: record.fetchedAt,
    };
  }
  if (
    record.status !== 'ok' ||
    (record.title !== null && typeof record.title !== 'string') ||
    !Array.isArray(record.current) ||
    !Array.isArray(record.listing)
  ) {
    return null;
  }
  const current = cleanServalPoints(record.current, now);
  const listing = cleanServalPoints(record.listing, now);
  if (
    current.length === 0 ||
    !samePoints(record.current, current) ||
    !samePoints(record.listing, listing)
  ) {
    return null;
  }
  return {
    schema: 1,
    status: 'ok',
    plid,
    fetchedAt: record.fetchedAt,
    title: cleanServalTitle(record.title ?? ''),
    current,
    listing,
  };
}

function ensureCacheDirectory(): void {
  const base = cacheBase();
  const directory = path.join(base, 'serval');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeCache(
  record: ServalHistoryRecord,
  verbose: boolean,
  ctx: Context,
  lock: DirectoryLockHandle,
): void {
  try {
    ensureCacheDirectory();
    lock.assertHeld();
    atomicWriteJson(servalCachePath(record.plid), record, 0o600);
  } catch (error) {
    if (error instanceof LockLostError) throw error;
    if (verbose) {
      ctx.logger.warn(
        `could not write the Serval cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function readFailure(plid: number, now: number): FailureMarker | null {
  try {
    const value = JSON.parse(fs.readFileSync(servalFailurePath(plid), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const marker = value as Record<string, unknown>;
    if (typeof marker.failedAt !== 'string' || typeof marker.code !== 'string') return null;
    const failedAt = Date.parse(marker.failedAt);
    if (!Number.isFinite(failedAt) || failedAt > now || now - failedAt >= 10 * 60 * 1000) return null;
    return { failedAt: marker.failedAt, code: marker.code };
  } catch {
    return null;
  }
}

function writeFailure(
  plid: number,
  marker: FailureMarker,
  verbose: boolean,
  ctx: Context,
  lock: DirectoryLockHandle,
): void {
  try {
    ensureCacheDirectory();
    lock.assertHeld();
    atomicWriteJson(servalFailurePath(plid), marker, 0o600);
  } catch (error) {
    if (error instanceof LockLostError) throw error;
    if (verbose) ctx.logger.warn(`could not write the Serval failure marker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearFailure(plid: number, lock: DirectoryLockHandle): void {
  lock.assertHeld();
  try {
    fs.rmSync(servalFailurePath(plid), { force: true });
  } catch {}
}

function failureFromMarker(marker: FailureMarker): ServalError {
  return new ServalError(`Serval request recently failed with ${marker.code}`, marker.code);
}

export async function loadServalHistory(
  plid: number,
  options: LoadServalHistoryOptions,
): Promise<LoadedServalHistory> {
  const fetchFresh = async (
    now: number,
    lock?: DirectoryLockHandle,
  ): Promise<LoadedServalHistory> => {
    await options.beforeFetch?.();
    let fetched;
    try {
      fetched = await fetchServalPage(plid, {
        version: options.version,
        fetchImpl: options.fetchImpl,
        now: options.now,
        wait: options.wait,
        onAttempt: options.onAttempt,
      });
    } catch (error) {
      if (lock && error instanceof ServalError) {
        writeFailure(
          plid,
          { failedAt: new Date((options.now ?? Date.now)()).toISOString(), code: error.code },
          options.verbose,
          options.ctx,
          lock,
        );
      }
      throw error;
    }
    if (fetched.status === 'not_tracked') {
      const missing: NotTrackedCacheRecord = {
        schema: 1,
        status: 'not_tracked',
        plid,
        fetchedAt: fetched.fetchedAt,
      };
      if (lock) {
        writeCache(missing, options.verbose, options.ctx, lock);
        clearFailure(plid, lock);
      }
      return { record: missing, cached: false };
    }
    const parsed = parseServalPage(fetched.html, now);
    if (parsed.current.length === 0) {
      throw new UsageError(`Serval has no usable price data for PLID${plid}`, 'no_data');
    }
    const loaded: OkCacheRecord = {
      schema: 1,
      status: 'ok',
      plid,
      fetchedAt: fetched.fetchedAt,
      title: parsed.title,
      current: parsed.current,
      listing: parsed.listing,
    };
    if (lock) {
      writeCache(loaded, options.verbose, options.ctx, lock);
      clearFailure(plid, lock);
    }
    return { record: loaded, cached: false };
  };
  try {
    ensureCacheDirectory();
  } catch (error) {
    if (options.requireCache) {
      throw new ServalError(
        `Serval cache directory is not available: ${error instanceof Error ? error.message : String(error)}`,
        'serval_cache_unavailable',
      );
    }
    if (options.verbose) {
      options.ctx.logger.warn(
        `could not write the Serval cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return fetchFresh((options.now ?? Date.now)());
  }
  return withDirectoryLock(
    servalLockPath(plid),
    {
      timeoutMs: options.lockTimeoutMs ?? 20_000,
      error: () => new ServalError(`Serval cache is busy for PLID${plid}`, 'serval_busy'),
    },
    async (lock) => {
      const now = (options.now ?? Date.now)();
      const record = options.cache ? readCache(plid, now) : null;
      if (record) return { record, cached: true };
      const failure = options.cache ? readFailure(plid, now) : null;
      if (failure) throw failureFromMarker(failure);
      return fetchFresh(now, lock);
    },
  );
}

function notTracked(plid: number): UsageError {
  return new UsageError(`Serval does not track PLID${plid}; see ${servalUrl(plid)}`, 'not_tracked');
}

function windowPoints(points: ServalPoint[], days: number | null): ServalPoint[] {
  if (days === null) return points;
  const lastDate = Date.parse(`${dateOf(points[points.length - 1]!)}T00:00:00.000Z`);
  const firstDate = lastDate - (days - 1) * DAY_MS;
  return points.filter((point) => point[0] >= firstDate);
}

export function buildPriceHistory(
  record: OkCacheRecord,
  window: string,
  includeSeries: boolean,
  cached: boolean,
  now = Date.now(),
): PriceHistoryResult {
  const days = parsePriceWindow(window);
  const selected = windowPoints(record.current, days);
  if (selected.length === 0) {
    throw new UsageError(`Serval has no usable price data for PLID${record.plid}`, 'no_data');
  }
  const first = selected[0]!;
  const last = selected[selected.length - 1]!;
  let minimum = first;
  let maximum = first;
  let total = 0;
  for (const point of selected) {
    total += point[1];
    if (point[1] <= minimum[1]) minimum = point;
    if (point[1] >= maximum[1]) maximum = point;
  }
  const orderedPrices = selected.map((point) => point[1]).sort((left, right) => left - right);
  const middle = Math.floor(orderedPrices.length / 2);
  const median =
    orderedPrices.length % 2 === 1
      ? orderedPrices[middle]!
      : (orderedPrices[middle - 1]! + orderedPrices[middle]!) / 2;
  let lastChange: PriceHistoryResult['lastChange'] = null;
  for (let index = selected.length - 1; index > 0; index -= 1) {
    const previous = selected[index - 1]!;
    const point = selected[index]!;
    if (point[1] !== previous[1]) {
      lastChange = {
        date: dateOf(point),
        from: roundPrice(previous[1]),
        to: roundPrice(point[1]),
      };
      break;
    }
  }
  const listing = record.listing.at(-1);
  const today = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const lastDay = Date.parse(`${dateOf(last)}T00:00:00.000Z`);
  return {
    plid: record.plid,
    title: cleanServalTitle(record.title ?? ''),
    source: 'servaltracker.com',
    url: servalUrl(record.plid),
    fetchedAt: record.fetchedAt,
    cached,
    window,
    points: selected.length,
    firstDate: dateOf(first),
    lastDate: dateOf(last),
    stale: lastDay < today - 7 * DAY_MS,
    current: roundPrice(last[1]),
    currentDate: dateOf(last),
    min: roundPrice(minimum[1]),
    minDate: dateOf(minimum),
    max: roundPrice(maximum[1]),
    maxDate: dateOf(maximum),
    average: roundPrice(total / selected.length),
    median: roundPrice(median),
    lastChange,
    listingPrice: listing ? roundPrice(listing[1]) : null,
    listingPriceDate: listing ? dateOf(listing) : null,
    ...(includeSeries
      ? { series: selected.map((point) => ({ date: dateOf(point), price: roundPrice(point[1]) })) }
      : {}),
  };
}

function sparkline(points: ServalPoint[]): string {
  const count = Math.min(points.length, 60);
  const sampled = Array.from(
    { length: count },
    (_, index) =>
      points[count === 1 ? 0 : Math.round((index * (points.length - 1)) / (count - 1))]!,
  );
  const prices = sampled.map((point) => point[1]);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const bars = '▁▂▃▄▅▆▇█';
  return prices
    .map(
      (price) =>
        bars[maximum === minimum ? 0 : Math.round(((price - minimum) / (maximum - minimum)) * 7)],
    )
    .join('');
}

function renderHuman(result: PriceHistoryResult, points: ServalPoint[]): void {
  process.stdout.write(`${c.bold(result.title ?? `PLID${result.plid}`)}\n`);
  process.stdout.write(
    `${c.bold(rand(result.current))} on ${result.currentDate}${result.stale ? ' (stale)' : ''}\n`,
  );
  process.stdout.write(
    `Low ${rand(result.min)} on ${result.minDate} · High ${rand(result.max)} on ${result.maxDate} · Average ${rand(result.average)}\n`,
  );
  process.stdout.write(
    result.lastChange
      ? `Last change ${result.lastChange.date}: ${rand(result.lastChange.from)} → ${rand(result.lastChange.to)}\n`
      : 'Last change: none\n',
  );
  process.stdout.write(`${sparkline(points)}\n${result.url}\n`);
}

export async function priceHistoryCommand(
  ctx: Context,
  product: string,
  options: PriceHistoryOptions,
): Promise<void> {
  const plid = parsePlidRef(product);
  const days = parsePriceWindow(options.since);
  const now = Date.now();
  const loaded = await loadServalHistory(plid, { ...options, ctx });
  const { record, cached } = loaded;
  if (record?.status === 'not_tracked') throw notTracked(plid);
  const result = buildPriceHistory(record, options.since, options.series, cached, now);
  const selected = windowPoints(record.current, days);
  ctx.logger.result(() => renderHuman(result, selected), result);
}
