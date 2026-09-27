import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPriceHistory,
  parsePriceWindow,
  priceHistoryCommand,
  servalCachePath,
} from '../commands/price.js';
import { UsageError } from '../lib/errors.js';
import { parsePlidRef } from '../lib/product-ref.js';
import {
  cleanServalPoints,
  cleanServalTitle,
  fetchServalPage,
  parseServalPage,
  type ServalPoint,
} from '../lib/serval.js';
import type { Context } from '../lib/context.js';
import { run } from '../cli.js';
import { ServalError } from '../lib/errors.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'serval');
const fixture = (name: string): string => fs.readFileSync(path.join(fixtures, name), 'utf8');
const NOW = Date.UTC(2026, 8, 28, 0, 0, 0);
const fetchedAt = new Date(NOW).toISOString();
const temporaryDirectories: string[] = [];
const originalCacheHome = process.env.XDG_CACHE_HOME;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

function tempHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takealot-serval-test-'));
  temporaryDirectories.push(directory);
  process.env.XDG_CACHE_HOME = path.join(directory, 'cache');
  process.env.XDG_CONFIG_HOME = path.join(directory, 'config');
  return directory;
}

function okRecord(current: ServalPoint[], listing: ServalPoint[] = []) {
  return {
    schema: 1 as const,
    status: 'ok' as const,
    plid: 42,
    fetchedAt,
    title: 'Test product',
    current,
    listing,
  };
}

function fakeContext() {
  let result: unknown;
  const warnings: string[] = [];
  const ctx = {
    logger: {
      result: (_human: () => void, data: unknown) => {
        result = data;
      },
      warn: (message: string) => warnings.push(message),
    },
  } as unknown as Context;
  return {
    ctx,
    warnings,
    get result() {
      return result;
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
});

describe('product references and windows', () => {
  it.each([
    ['46639928', 46639928],
    ['PLID46639928', 46639928],
    ['plid46639928', 46639928],
    ['https://www.takealot.com/a-product/PLID46639928', 46639928],
    ['https://takealot.com/a-product/PLID46639928/', 46639928],
  ])('accepts %s', (input, expected) => {
    expect(parsePlidRef(input)).toBe(expected);
  });

  it.each([
    '0',
    '-1',
    '1.5',
    '12x',
    'https://example.com/a/PLID46639928',
    'https://www.takealot.com/no-product',
    'http://www.takealot.com/a/PLID46639928',
  ])('rejects %s', (input) => {
    expect(() => parsePlidRef(input)).toThrow(UsageError);
  });

  it.each([
    ['all', null],
    ['30d', 30],
    ['2w', 14],
    ['3m', 90],
    ['1y', 365],
    ['10y', 3650],
  ])('parses %s', (input, expected) => {
    expect(parsePriceWindow(input)).toBe(expected);
  });

  it.each(['0d', '5x', '11y', '3651d', 'alll', '-1d'])('rejects window %s', (input) => {
    expect(() => parsePriceWindow(input)).toThrow(UsageError);
  });
});

describe('Serval page parser', () => {
  it('parses a tracked page with at least 60 current points and a listing price', () => {
    const parsed = parseServalPage(fixture('tracked.html'), NOW);
    expect(parsed.title).toBe('PS Vita Charger Power Supply with Power Cord - Black');
    expect(parsed.current).toHaveLength(60);
    expect(parsed.listing.at(-1)?.[1]).toBe(249);
  });

  it('accepts an empty annotation and empty listing series', () => {
    const parsed = parseServalPage(fixture('stale.html'), NOW);
    expect(parsed.current.length).toBeGreaterThan(50);
    expect(parsed.listing).toEqual([]);
    expect(parsed.current.at(-1)?.[0]).toBe(1747917116377);
  });

  it('keeps a valid outlier instead of using annotations', () => {
    const parsed = parseServalPage(fixture('outlier.html'), NOW);
    expect(Math.max(...parsed.current.map((point) => point[1]))).toBe(1000);
  });

  it.each(['no-data-line.html', 'length-mismatch.html'])('rejects %s', (name) => {
    expect(() => parseServalPage(fixture(name), NOW)).toThrowError(
      expect.objectContaining({ code: 'serval_format_changed' }),
    );
  });

  it('cleans times before prices, sorts, and resolves duplicate dates by source order', () => {
    const morning = Date.UTC(2026, 0, 2, 8);
    const evening = Date.UTC(2026, 0, 2, 18);
    const nextDay = Date.UTC(2026, 0, 3, 8);
    const values: unknown[] = [
      [evening, 10],
      [morning, 20],
      [evening, 30],
      [nextDay, 40.1234],
      [Date.UTC(1999, 11, 31), 1],
      [NOW + 86_400_001, 1],
      [1.5, 1],
      ['bad', 1],
      [nextDay + 1, null],
      [nextDay + 2, '5'],
      [nextDay + 3, -1],
      [nextDay + 4, 10_000_001],
      [nextDay + 5, Infinity],
    ];
    expect(cleanServalPoints(values, NOW)).toEqual([
      [evening, 30],
      [nextDay, 40.1234],
    ]);
  });

  it('applies the same cleaning to the listing series', () => {
    const time = Date.UTC(2026, 0, 2, 8);
    const html = `<h2>Item</h2>\ndata = {"labels":[${time}],"datasets":[{"label":"Current Price","data":[1]},{"label":"Listing Price","data":[{"x":${time},"y":null},{"x":${time + 1},"y":99.999}]}]};`;
    expect(parseServalPage(html, NOW).listing).toEqual([[time + 1, 99.999]]);
  });

  it('decodes entities before removing controls and limits the title', () => {
    const title = cleanServalTitle(
      `<span>A&amp;B &#27; &#x202E; &lt;x&gt; &quot;q&quot; &#39;s&#39;</span>${'z'.repeat(250)}`,
    );
    expect(title).not.toMatch(/[\u001b\u202e]/);
    expect(title).toContain(`A&B <x> "q" 's'`);
    expect(title).toHaveLength(200);
  });
});

describe('price calculations', () => {
  const point = (date: string, price: number): ServalPoint => [
    Date.parse(`${date}T12:00:00Z`),
    price,
  ];
  const history = [
    point('2025-01-01', 10.004),
    point('2025-06-01', 30.006),
    point('2026-09-01', 20.005),
    point('2026-09-20', 20.005),
    point('2026-09-27', 40.004),
  ];

  it('calculates all output from unrounded points and uses recent dates for ties', () => {
    const result = buildPriceHistory(
      okRecord(history, [point('2026-01-01', 55.555)]),
      'all',
      true,
      false,
      NOW,
    );
    expect(result).toMatchObject({
      points: 5,
      firstDate: '2025-01-01',
      lastDate: '2026-09-27',
      stale: false,
      current: 40,
      min: 10,
      minDate: '2025-01-01',
      max: 40,
      maxDate: '2026-09-27',
      average: 24,
      median: 20.01,
      lastChange: { date: '2026-09-27', from: 20.01, to: 40 },
      listingPrice: 55.56,
      listingPriceDate: '2026-01-01',
    });
    expect(result.series).toHaveLength(5);
  });

  it.each([
    ['30d', 3, '2026-09-01'],
    ['1y', 3, '2026-09-01'],
    ['all', 5, '2025-01-01'],
  ])('uses the %s window anchored to the last point', (window, points, firstDate) => {
    expect(buildPriceHistory(okRecord(history), window, false, false, NOW)).toMatchObject({
      points,
      firstDate,
      window,
    });
  });

  it('uses the most recent date for tied minima and maxima', () => {
    const result = buildPriceHistory(
      okRecord([point('2026-09-25', 5), point('2026-09-26', 10), point('2026-09-27', 5)]),
      'all',
      false,
      false,
      NOW,
    );
    expect(result.minDate).toBe('2026-09-27');
    expect(result.maxDate).toBe('2026-09-26');
  });

  it('returns null when the price never changes and marks old data stale', () => {
    const result = buildPriceHistory(
      okRecord([point('2025-01-01', 5), point('2025-01-02', 5)]),
      'all',
      false,
      true,
      NOW,
    );
    expect(result.lastChange).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.cached).toBe(true);
    expect(result).not.toHaveProperty('series');
  });

  it('rejects an empty cleaned history', () => {
    expect(() => buildPriceHistory(okRecord([]), 'all', false, false, NOW)).toThrowError(
      expect.objectContaining({ code: 'no_data' }),
    );
  });
});

describe('Serval fetch boundary', () => {
  it.skipIf(process.env['CI'] === 'true')(
    'reads PLID46639928 from Serval without account access',
    async () => {
      const response = await fetchServalPage(46639928, { version: 'test' });
      expect(response.status).toBe('ok');
      if (response.status === 'ok') {
        expect(parseServalPage(response.html).current.length).toBeGreaterThan(0);
      }
    },
    40_000,
  );

  it('sends only the fixed URL, method, redirect mode, and literal public headers', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(fixture('tracked.html'), { status: 200 }),
    );
    await fetchServalPage(46639928, { version: '1.2.3', fetchImpl, now: () => NOW });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.servaltracker.com/products/PLID46639928/',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': 'takealot-cli/1.2.3 (+https://github.com/yashiels/takealot-cli)',
          accept: 'text/html',
        },
      }),
    );
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('cookie');
    expect(headers).not.toHaveProperty('tal-did');
    expect(headers).not.toHaveProperty('x-csrf-token');
  });

  it('returns a typed 404 result without reading account state', async () => {
    const fetchImpl = vi.fn(async () => new Response(fixture('not-tracked.html'), { status: 404 }));
    await expect(
      fetchServalPage(1, { version: 'test', fetchImpl, now: () => NOW }),
    ).resolves.toEqual({
      status: 'not_tracked',
      url: 'https://www.servaltracker.com/products/PLID1/',
      fetchedAt,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [302, 'serval_redirect', 1],
    [401, 'serval_forbidden', 1],
    [403, 'serval_forbidden', 1],
    [429, 'serval_rate_limited', 1],
    [418, 'serval_http_418', 1],
    [500, 'serval_http_500', 2],
  ])('maps HTTP %i to %s after %i request(s)', async (status, code, calls) => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status, headers: { 'retry-after': '4' } }),
    );
    await expect(
      fetchServalPage(1, { version: 'test', fetchImpl, retryDelayMs: 0 }),
    ).rejects.toEqual(expect.objectContaining({ code }));
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('retries one network failure and reports the second', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      fetchServalPage(1, { version: 'test', fetchImpl, retryDelayMs: 0 }),
    ).rejects.toEqual(expect.objectContaining({ code: 'network' }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries one timeout and reports the second', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(
      fetchServalPage(1, { version: 'test', fetchImpl, timeoutMs: 1, retryDelayMs: 0 }),
    ).rejects.toEqual(expect.objectContaining({ code: 'timeout' }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops after 2 MB without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(fetchServalPage(1, { version: 'test', fetchImpl })).rejects.toEqual(
      expect.objectContaining({ code: 'serval_too_large' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a body read network failure one time', async () => {
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('body failed'));
        },
      });
      return new Response(body);
    });
    await expect(
      fetchServalPage(1, { version: 'test', fetchImpl, retryDelayMs: 0 }),
    ).rejects.toEqual(expect.objectContaining({ code: 'network' }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Serval cache', () => {
  const options = {
    since: 'all',
    series: false,
    cache: true,
    verbose: false,
    version: 'test',
  };

  it('writes a private cache and serves the next call without a request', async () => {
    tempHome();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(fixture('tracked.html'), { status: 200 }))
      .mockRejectedValue(new Error('must not fetch'));
    const first = fakeContext();
    await priceHistoryCommand(first.ctx, '46639928', options);
    expect(first.result).toMatchObject({ cached: false, points: 60 });
    const cacheFile = servalCachePath(46639928);
    expect(fs.statSync(path.dirname(cacheFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);

    const second = fakeContext();
    await priceHistoryCommand(second.ctx, '46639928', options);
    expect(second.result).toMatchObject({ cached: true, points: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches not-tracked results and returns the same exit-4 error without a request', async () => {
    tempHome();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));
    const first = fakeContext();
    await expect(priceHistoryCommand(first.ctx, '1', options)).rejects.toEqual(
      expect.objectContaining({ code: 'not_tracked' }),
    );
    const second = fakeContext();
    await expect(priceHistoryCommand(second.ctx, '1', options)).rejects.toEqual(
      expect.objectContaining({ code: 'not_tracked' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['schema mismatch', { schema: 2, status: 'ok', plid: 46639928, fetchedAt }],
    ['PLID mismatch', { schema: 1, status: 'not_tracked', plid: 2, fetchedAt }],
    [
      'future fetch',
      {
        schema: 1,
        status: 'not_tracked',
        plid: 46639928,
        fetchedAt: new Date(NOW + 1).toISOString(),
      },
    ],
    [
      'expired fetch',
      {
        schema: 1,
        status: 'not_tracked',
        plid: 46639928,
        fetchedAt: new Date(NOW - 86_400_001).toISOString(),
      },
    ],
  ])('ignores a cache with %s', async (_label, cached) => {
    tempHome();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    fs.mkdirSync(path.dirname(servalCachePath(46639928)), { recursive: true });
    fs.writeFileSync(servalCachePath(46639928), JSON.stringify(cached));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(fixture('tracked.html')));
    await priceHistoryCommand(fakeContext().ctx, '46639928', options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores corrupt JSON and invalid point arrays', async () => {
    tempHome();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    fs.mkdirSync(path.dirname(servalCachePath(46639928)), { recursive: true });
    fs.writeFileSync(servalCachePath(46639928), '{');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(fixture('tracked.html')));
    await priceHistoryCommand(fakeContext().ctx, '46639928', options);
    fs.writeFileSync(
      servalCachePath(46639928),
      JSON.stringify({
        schema: 1,
        status: 'ok',
        plid: 46639928,
        fetchedAt,
        title: 'Bad cache',
        current: [[Date.UTC(1999, 0, 1), 1]],
        listing: [],
      }),
    );
    await priceHistoryCommand(fakeContext().ctx, '46639928', options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('--no-cache skips a valid read and still writes the fetched result', async () => {
    tempHome();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    fs.mkdirSync(path.dirname(servalCachePath(46639928)), { recursive: true });
    fs.writeFileSync(
      servalCachePath(46639928),
      JSON.stringify({ schema: 1, status: 'not_tracked', plid: 46639928, fetchedAt }),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(fixture('tracked.html')));
    const invocation = fakeContext();
    await priceHistoryCommand(invocation.ctx, '46639928', { ...options, cache: false });
    expect(invocation.result).toMatchObject({ cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(servalCachePath(46639928), 'utf8')).status).toBe('ok');
  });

  it('warns only in verbose mode when the cache cannot be written', async () => {
    const directory = tempHome();
    const blocked = path.join(directory, 'blocked');
    fs.writeFileSync(blocked, 'file');
    process.env.XDG_CACHE_HOME = blocked;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(fixture('tracked.html')),
    );
    const quiet = fakeContext();
    await priceHistoryCommand(quiet.ctx, '46639928', options);
    expect(quiet.warnings).toEqual([]);
    const verbose = fakeContext();
    await priceHistoryCommand(verbose.ctx, '46639928', { ...options, verbose: true });
    expect(verbose.warnings).toHaveLength(1);
    expect(verbose.result).toMatchObject({ points: 60 });
  });
});

describe('CLI error exits', () => {
  function jsonCommand(): Command {
    const command = new Command('history').option('--json');
    command.setOptionValue('json', true);
    return command;
  }

  it.each([
    'serval_format_changed',
    'serval_redirect',
    'serval_forbidden',
    'serval_rate_limited',
    'serval_http_418',
    'serval_http_500',
    'network',
    'timeout',
    'serval_too_large',
  ])('maps runtime code %s to exit 1', async (code) => {
    tempHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await run(jsonCommand(), async () => {
      throw new ServalError('failed', code);
    });
    expect(process.exitCode).toBe(1);
  });

  it('maps the 404 fixture to not_tracked and exit 4', async () => {
    tempHome();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(fixture('not-tracked.html'), { status: 404 }),
    );
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      output += String(value);
      return true;
    });
    await run(jsonCommand(), (ctx) =>
      priceHistoryCommand(ctx, '1', {
        since: 'all',
        series: false,
        cache: true,
        verbose: false,
        version: 'test',
      }),
    );
    expect(process.exitCode).toBe(4);
    expect(JSON.parse(output)).toMatchObject({ code: 'not_tracked' });
  });

  it.each([
    ['abc', 'all'],
    ['1', '5x'],
  ])('maps invalid input %s with window %s to exit 4', async (product, since) => {
    tempHome();
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      output += String(value);
      return true;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await run(jsonCommand(), (ctx) =>
      priceHistoryCommand(ctx, product, {
        since,
        series: false,
        cache: true,
        verbose: false,
        version: 'test',
      }),
    );
    expect(process.exitCode).toBe(4);
    expect(JSON.parse(output)).toMatchObject({ code: 'usage_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
