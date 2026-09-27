import { ServalError, UnsafeUrlError } from './errors.js';

export type ServalPoint = [timeMs: number, price: number];

export interface ParsedServalPage {
  title: string | null;
  current: ServalPoint[];
  listing: ServalPoint[];
}

export type ServalFetchResult =
  | { status: 'ok'; url: string; fetchedAt: string; html: string }
  | { status: 'not_tracked'; url: string; fetchedAt: string };

export interface ServalFetchOptions {
  version: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  onAttempt?: () => void;
}

const EARLIEST_TIME = Date.UTC(2000, 0, 1);
const MAX_PRICE = 10_000_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;

const formatChanged = (): ServalError =>
  new ServalError(
    'Serval page format changed; no price history was returned',
    'serval_format_changed',
  );

function dateKey(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

export function cleanServalPoints(values: unknown[], now = Date.now()): ServalPoint[] {
  const latestTime = now + DAY_MS;
  const candidates = values.flatMap((value, sourceIndex) => {
    if (!Array.isArray(value) || value.length !== 2) return [];
    const [timeMs, price] = value;
    if (
      typeof timeMs !== 'number' ||
      !Number.isSafeInteger(timeMs) ||
      timeMs < EARLIEST_TIME ||
      timeMs > latestTime
    ) {
      return [];
    }
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
      return [];
    }
    return [{ timeMs, price, sourceIndex }];
  });
  candidates.sort(
    (left, right) => left.timeMs - right.timeMs || left.sourceIndex - right.sourceIndex,
  );
  const byDate = new Map<string, ServalPoint>();
  for (const point of candidates) byDate.set(dateKey(point.timeMs), [point.timeMs, point.price]);
  return [...byDate.values()];
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  if (named[entity] !== undefined) return named[entity]!;
  const numeric = /^&#(x[0-9a-f]+|\d+);$/i.exec(entity);
  if (!numeric) return entity;
  const value = numeric[1]!.toLowerCase().startsWith('x')
    ? Number.parseInt(numeric[1]!.slice(1), 16)
    : Number.parseInt(numeric[1]!, 10);
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return '';
  return String.fromCodePoint(value);
}

export function cleanServalTitle(value: string): string | null {
  const title = value
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#\d+|#x[0-9a-f]+);/gi, decodeEntity)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return title || null;
}

export function parseServalPage(html: string, now = Date.now()): ParsedServalPage {
  const dataLine = html.split(/\r?\n/).find((line) => /^[ \t]*data = \{/.test(line));
  if (!dataLine) throw formatChanged();
  let source = dataLine.trim().slice('data = '.length).trim();
  if (source.endsWith(';')) source = source.slice(0, -1);

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw formatChanged();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw formatChanged();
  const chart = data as Record<string, unknown>;
  if (!Array.isArray(chart.labels) || !Array.isArray(chart.datasets)) throw formatChanged();
  const currentDataset = chart.datasets[0];
  if (!currentDataset || typeof currentDataset !== 'object' || Array.isArray(currentDataset)) {
    throw formatChanged();
  }
  const currentRecord = currentDataset as Record<string, unknown>;
  if (
    currentRecord.label !== 'Current Price' ||
    !Array.isArray(currentRecord.data) ||
    currentRecord.data.length !== chart.labels.length
  ) {
    throw formatChanged();
  }
  const currentValues = currentRecord.data;

  let listingValues: unknown[] = [];
  const listingDataset = chart.datasets[1];
  if (listingDataset !== undefined) {
    if (!listingDataset || typeof listingDataset !== 'object' || Array.isArray(listingDataset)) {
      throw formatChanged();
    }
    const listingRecord = listingDataset as Record<string, unknown>;
    if (listingRecord.label !== 'Listing Price' || !Array.isArray(listingRecord.data)) {
      throw formatChanged();
    }
    if (
      listingRecord.data.some(
        (point) =>
          !point ||
          typeof point !== 'object' ||
          Array.isArray(point) ||
          !('x' in point) ||
          !('y' in point),
      )
    ) {
      throw formatChanged();
    }
    listingValues = listingRecord.data.map((point) => {
      const record = point as Record<string, unknown>;
      return [record.x, record.y];
    });
  }

  const titleMatch = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(html);
  return {
    title: cleanServalTitle(titleMatch?.[1] ?? ''),
    current: cleanServalPoints(
      chart.labels.map((timeMs, index) => [timeMs, currentValues[index]]),
      now,
    ),
    listing: cleanServalPoints(listingValues, now),
  };
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ServalError('Serval response exceeded 2 MB', 'serval_too_large');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function statusError(response: Response, url: string): never {
  if (response.status >= 300 && response.status < 400) {
    throw new ServalError('Serval redirected the product request', 'serval_redirect');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ServalError('Serval refused the product request', 'serval_forbidden');
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    throw new ServalError(
      `Serval rate limited the product request${retryAfter ? `; retry after ${retryAfter}` : ''}`,
      'serval_rate_limited',
    );
  }
  throw new ServalError(
    `Serval returned HTTP ${response.status} for ${url}`,
    `serval_http_${response.status}`,
  );
}

export async function fetchServalPage(
  plid: number,
  options: ServalFetchOptions,
): Promise<ServalFetchResult> {
  const url = `https://www.servaltracker.com/products/PLID${plid}/`;
  const parsedUrl = new URL(url);
  if (
    parsedUrl.origin !== 'https://www.servaltracker.com' ||
    !/^\/products\/PLID\d+\/$/.test(parsedUrl.pathname)
  ) {
    throw new UnsafeUrlError('unsafe Serval URL');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryDelayMs = options.retryDelayMs ?? 2_000;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      options.onAttempt?.();
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': `takealot-cli/${options.version} (+https://github.com/yashiels/takealot-cli)`,
          accept: 'text/html',
        },
        signal: controller.signal,
      });
      const fetchedAt = new Date(now()).toISOString();
      if (response.status >= 500 && attempt === 0) {
        await response.body?.cancel().catch(() => undefined);
        clearTimeout(timer);
        await wait(retryDelayMs);
        continue;
      }
      if (response.status === 404) {
        clearTimeout(timer);
        return { status: 'not_tracked', url, fetchedAt };
      }
      if (response.status !== 200) statusError(response, url);
      const html = await readLimitedBody(response);
      clearTimeout(timer);
      return { status: 'ok', url, fetchedAt, html };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ServalError) throw error;
      if (attempt === 0) {
        await wait(retryDelayMs);
        continue;
      }
      if (controller.signal.aborted) throw new ServalError('Serval request timed out', 'timeout');
      throw new ServalError('Serval network request failed', 'network');
    }
  }
  throw new ServalError('Serval network request failed', 'network');
}
