import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson, configDir } from './config.js';
import { withDirectoryLock, type DirectoryLockHandle } from './directory-lock.js';
import { WatchError } from './errors.js';

export type WatchStatus = 'ok' | 'not_tracked' | 'stale' | 'error';
export type WatchReason = 'target' | 'drop' | 'low';

export interface WatchItem {
  plid: number;
  title: string | null;
  addedAt: string;
  target: number | null;
  dropPercent: number;
  referencePrice: number | null;
  referenceDate: string | null;
  lastCheckedAt: string | null;
  lastPrice: number | null;
  lastPriceDate: string | null;
  lastStatus: WatchStatus | null;
  alertArmed: boolean;
  lastAlert: { price: number; date: string; reasons: WatchReason[] } | null;
}

export interface Watchlist {
  schema: 1;
  items: WatchItem[];
}

const LIST_KEYS = ['schema', 'items'];
const ITEM_KEYS = [
  'plid',
  'title',
  'addedAt',
  'target',
  'dropPercent',
  'referencePrice',
  'referenceDate',
  'lastCheckedAt',
  'lastPrice',
  'lastPriceDate',
  'lastStatus',
  'alertArmed',
  'lastAlert',
];
const ALERT_KEYS = ['price', 'date', 'reasons'];
const REASONS = new Set<WatchReason>(['target', 'drop', 'low']);
const STATUSES = new Set<WatchStatus>(['ok', 'not_tracked', 'stale', 'error']);

export const watchlistPath = (): string => path.join(configDir(), 'watchlist.json');
export const watchlistLockPath = (): string => path.join(configDir(), 'watchlist.lock');

const sameKeys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));

function isoTime(value: unknown, now: number): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now && new Date(parsed).toISOString() === value;
}

function dateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

const positivePrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10_000_000;

const validTarget = (value: unknown): value is number =>
  positivePrice(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;

function invalid(rule: string): never {
  throw new WatchError(`${watchlistPath()}: ${rule}`, 'watchlist_invalid');
}

function validateItem(value: unknown, index: number, now: number): WatchItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`items[${index}] must be an object`);
  const item = value as Record<string, unknown>;
  if (!sameKeys(item, ITEM_KEYS)) invalid(`items[${index}] has missing or unknown keys`);
  if (!Number.isSafeInteger(item.plid) || (item.plid as number) <= 0) invalid(`items[${index}].plid must be a positive safe integer`);
  if (item.title !== null && (typeof item.title !== 'string' || item.title.length > 200)) invalid(`items[${index}].title must be null or at most 200 characters`);
  if (!isoTime(item.addedAt, now)) invalid(`items[${index}].addedAt must be a non-future ISO 8601 UTC time`);
  if (item.lastCheckedAt !== null && !isoTime(item.lastCheckedAt, now)) invalid(`items[${index}].lastCheckedAt must be null or a non-future ISO 8601 UTC time`);
  if (item.referenceDate !== null && !dateOnly(item.referenceDate)) invalid(`items[${index}].referenceDate must be null or YYYY-MM-DD`);
  if (item.lastPriceDate !== null && !dateOnly(item.lastPriceDate)) invalid(`items[${index}].lastPriceDate must be null or YYYY-MM-DD`);
  if (item.target !== null && !validTarget(item.target)) invalid(`items[${index}].target must be null or a positive price with at most 2 decimals`);
  if (!Number.isInteger(item.dropPercent) || (item.dropPercent as number) < 1 || (item.dropPercent as number) > 90) invalid(`items[${index}].dropPercent must be an integer from 1 to 90`);
  if (item.referencePrice !== null && !positivePrice(item.referencePrice)) invalid(`items[${index}].referencePrice must be null or a positive price`);
  if (item.lastPrice !== null && !positivePrice(item.lastPrice)) invalid(`items[${index}].lastPrice must be null or a positive price`);
  if (item.lastStatus !== null && !STATUSES.has(item.lastStatus as WatchStatus)) invalid(`items[${index}].lastStatus is invalid`);
  if (typeof item.alertArmed !== 'boolean') invalid(`items[${index}].alertArmed must be a boolean`);
  if (item.lastAlert !== null) {
    if (!item.lastAlert || typeof item.lastAlert !== 'object' || Array.isArray(item.lastAlert)) invalid(`items[${index}].lastAlert must be null or an object`);
    const alert = item.lastAlert as Record<string, unknown>;
    if (!sameKeys(alert, ALERT_KEYS)) invalid(`items[${index}].lastAlert has missing or unknown keys`);
    if (!positivePrice(alert.price)) invalid(`items[${index}].lastAlert.price must be a positive price`);
    if (!dateOnly(alert.date)) invalid(`items[${index}].lastAlert.date must be YYYY-MM-DD`);
    if (!Array.isArray(alert.reasons) || alert.reasons.length === 0 || alert.reasons.some((reason) => !REASONS.has(reason as WatchReason)) || new Set(alert.reasons).size !== alert.reasons.length) invalid(`items[${index}].lastAlert.reasons must contain unique alert reasons`);
  }
  if ((item.referencePrice === null) !== (item.referenceDate === null)) invalid(`items[${index}] must set referencePrice and referenceDate together`);
  if ((item.lastPrice === null) !== (item.lastPriceDate === null)) invalid(`items[${index}] must set lastPrice and lastPriceDate together`);
  return item as unknown as WatchItem;
}

export function validateWatchlist(value: unknown, now = Date.now()): Watchlist {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('root must be an object');
  const record = value as Record<string, unknown>;
  if (!sameKeys(record, LIST_KEYS)) invalid('root has missing or unknown keys');
  if (record.schema !== 1) invalid('schema must be 1');
  if (!Array.isArray(record.items)) invalid('items must be an array');
  if (record.items.length > 50) invalid('items must contain at most 50 products');
  const items = record.items.map((item, index) => validateItem(item, index, now));
  if (new Set(items.map((item) => item.plid)).size !== items.length) invalid('items must have unique plids');
  return { schema: 1, items };
}

export function loadWatchlist(now = Date.now()): Watchlist {
  let text: string;
  try {
    text = fs.readFileSync(watchlistPath(), 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { schema: 1, items: [] };
    throw error;
  }
  try {
    return validateWatchlist(JSON.parse(text), now);
  } catch (error) {
    if (error instanceof WatchError) throw error;
    invalid('file must contain valid JSON');
  }
}

export function saveWatchlist(watchlist: Watchlist): void {
  atomicWriteJson(watchlistPath(), watchlist, 0o600);
}

export async function withWatchlistLock<T>(
  fn: (lock: DirectoryLockHandle) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  return withDirectoryLock(
    watchlistLockPath(),
    {
      timeoutMs,
      error: () => new WatchError(`another takealot process holds ${watchlistLockPath()}`, 'watchlist_locked'),
    },
    fn,
  );
}

export function newWatchItem(
  plid: number,
  addedAt: string,
  target: number | null,
  dropPercent: number,
): WatchItem {
  return {
    plid,
    title: null,
    addedAt,
    target,
    dropPercent,
    referencePrice: null,
    referenceDate: null,
    lastCheckedAt: null,
    lastPrice: null,
    lastPriceDate: null,
    lastStatus: null,
    alertArmed: true,
    lastAlert: null,
  };
}
