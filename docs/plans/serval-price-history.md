# Plan v2: `takealot price history` via Serval (#51)

## Goal

Give an agent the past prices of a Takealot product in one command, from the history that servaltracker.com already holds. The owner has verbal permission from the Serval operator to fetch Serval product pages from the CLI.

## Evidence (probed 2026-09-27, 7 requests total)

- `GET https://www.servaltracker.com/products/PLID<n>/` returns HTML from gunicorn. No cache headers. About 2 s. 20 to 95 KB.
- The page has one line that starts `data = {"plugins"` and ends `};`. The value is JSON (Python `json.dumps`), not JavaScript:
  - `labels`: epoch milliseconds (UTC), about one per day. Gaps of up to 41 days occur.
  - `datasets[0]`, label `Current Price`: numbers in Rand, same length as `labels`.
  - `datasets[1]`, label `Listing Price`: `{x: epochMs, y: price}` points. It can be empty.
  - `plugins.annotation.annotations.{min_price,max_price,current_price}.yMin`. The whole `annotations` object can be absent (`annotation: {}`).
- A known product: 200 with the data line. An unknown PLID: 404 with the text "Product does not exist." A tracked product can stop updating (PLID1: last point 2025-05-22).
- Outliers exist (max 1000 on a R189 cable).
- The title is the text of the first `<h1>` to `<h4>` element.

## Command

```
takealot price history <product> [--since <window>] [--series] [--no-cache] [--json] [--verbose]
```

- `<product>` is one of:
  - digits only (`46639928`)
  - `PLID` plus digits, any case (`PLID46639928`)
  - an `https://www.takealot.com/...` or `https://takealot.com/...` URL whose path contains `/PLID<digits>`
- Parse to a positive safe integer. Anything else, and any URL on another host, exits 4 with code `usage_error`. Put the parser in `src/lib/product-ref.ts` as `parsePlidRef(input: string): number`. `info` and `reviews` do not change in this work.
- `--since`: `all` (default), or `<n>d`, `<n>w`, `<n>m`, `<n>y` (1 to 3650 days after conversion; m = 30 days, y = 365 days). Any other value exits 4.
- `--series` adds `series` to JSON output and is ignored in human output. Unknown options exit 4 (Commander default).

## Output

All prices are Rand (ZAR) numbers, rounded to 2 decimals. All dates are UTC calendar dates `YYYY-MM-DD`. Timestamps are ISO 8601 UTC.

Point cleaning, applied in this order after validation. It is the same for the current series (`labels[i]` with `datasets[0].data[i]`) and the listing series (`{x, y}` points):

1. Drop a point if its time is not a number, is not a safe integer, or is outside 2000-01-01 to now plus 1 day (UTC). This makes every kept time a valid `Date`.
2. Drop a point if its price is not a number, is not finite, is negative, or is above 10,000,000.
3. Sort by time.
4. If two points share a UTC date, keep the one with the later time. If the times are equal, keep the one that comes later in the source array. Use a stable sort so this rule is exact.

Validation (see Parser rules) checks structure only. It never rejects a payload for a bad value inside a point. Cleaning drops those points. `JSON.parse` cannot produce `NaN`, so "not finite" covers `Infinity` from very large literals and non-number values such as `null` or strings.

Rounding: keep full precision for every calculation. Round only the output values (`current`, `min`, `max`, `average`, `median`, `lastChange.from`, `lastChange.to`, `listingPrice`, `series[].price`) to 2 decimals with `Math.round(value * 100) / 100`. `lastChange` compares the unrounded prices.

Window: points with a date on or after `lastDate - window + 1 day`. For `all`, use every point. The window is anchored to the last point, not to the time now.

JSON result:

```
{
  plid, title, source: "servaltracker.com", url, fetchedAt, cached,
  window, points, firstDate, lastDate, stale,
  current, currentDate,
  min, minDate, max, maxDate, average, median,
  lastChange,
  listingPrice, listingPriceDate,
  series
}
```

- `url`: the Serval page URL.
- `window`: the `--since` value.
- `points`, `firstDate`, `lastDate`: for the window.
- `stale`: true when `lastDate` is more than 7 days before today (UTC).
- `current`, `currentDate`: the last point in the window.
- `min`, `minDate`, `max`, `maxDate`: over the window. On a tie, give the most recent date.
- `average`: the mean over the window. `median`: the median over the window.
- `lastChange`: the most recent point whose price differs from the point before it, as `{date, from, to}`. It is `null` if the price never changed in the window.
- `listingPrice`, `listingPriceDate`: the last valid point of `datasets[1]` over the full history, or `null`. This is Takealot's "was" price.
- `series` (only with `--series`): `[{date, price}]` for the window.
- Serval's annotations are never used. The CLI computes all values from the points.
- If the window has no points after cleaning, exit 4 with code `no_data`.

Human output:

- title
- current price with its date, or "(stale)"
- low with its date, high with its date, average
- last change
- one sparkline line of at most 60 characters, sampled evenly from the window
- the Serval URL

## Network rules (hard limits)

- A fetch function in `src/lib/serval.ts`: `fetchServalPage(plid: number, opts)`. It builds the URL only from a fixed template and the parsed integer: `https://www.servaltracker.com/products/PLID${plid}/`.
- Just before `fetch`, verify that `new URL(url).origin === 'https://www.servaltracker.com'` and that the pathname matches `^/products/PLID\d+/$`. On failure, throw `UnsafeUrlError`.
- `fetch(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'takealot-cli/<version> (+https://github.com/yashiels/takealot-cli)', accept: 'text/html' }, signal })`. The headers object is a literal. No caller can add headers. The fetch does not use `TakealotClient`, the `Context` client, the auth manager, the cookie jar or the device record. Nothing from the credentials enters this function.
- `send()` in `api-client.ts` does not change and still rejects every origin except `https://api.takealot.com`.
- Maximum 2 HTTP requests per command: 1 request, plus 1 retry only after a network error, a timeout or a 5xx, with a 2 s wait. No other retry.
- Timeout 15 s per request. Read at most 2 MB of body. Over the limit: stop reading and fail.
- Never call the Serval search page or the submit form. That form makes Serval start to track a product.
- No bulk mode. No loop over wishlists, the cart or orders. Not for use from cron in this change.

## HTTP outcomes

```
200 with valid data         exit 0
200 without data line       exit 1  serval_format_changed
200 with invalid shape      exit 1  serval_format_changed
3xx                         exit 1  serval_redirect
404                         exit 4  not_tracked   (message gives the Serval link)
401, 403                    exit 1  serval_forbidden
429                         exit 1  serval_rate_limited  (no retry; message gives Retry-After when present)
other 4xx                   exit 1  serval_http_<status>
5xx after the retry         exit 1  serval_http_<status>
network error after retry   exit 1  network
timeout after retry         exit 1  timeout
body over 2 MB              exit 1  serval_too_large
```

This command never exits 3. It never prints partial or guessed numbers. Errors use the normal JSON envelope (`{error, code}`). Add `ServalError` (runtime, exit 1) and use `UsageError` for exit 4 cases, so `errorExitCode()` in `src/cli.ts` maps them without changes.

## Parser rules

- Never use `eval`, `Function`, `vm` or a JavaScript parser.
- Find the first line that starts with optional spaces and `data = {`. Take the text after `data = ` and remove one trailing `;`. Parse with `JSON.parse`.
- Validate the structure:
  - `labels` is an array.
  - `datasets` is an array.
  - `datasets[0].label === 'Current Price'`, and its `data` is an array with the same length as `labels`.
  - `datasets[1]`, when present, has `label === 'Listing Price'` and `data` is an array of `{x, y}` objects.
  - Any failure: `serval_format_changed`.
- Title: the text of the first `<h1>` to `<h4>`. Remove inner tags. Decode `&amp; &lt; &gt; &quot; &#39;` and numeric entities. Then remove every C0 and C1 control character (U+0000 to U+001F, U+007F to U+009F, which includes ESC) and the Unicode bidi controls (U+202A to U+202E, U+2066 to U+2069). Collapse whitespace. Limit to 200 characters. If nothing is left, use `null`.

## Cache

- Path: `$XDG_CACHE_HOME/takealot-cli/serval/PLID<n>.json`, default `~/.cache/takealot-cli/serval/`. Directories mode 0700, files mode 0600.
- Write atomically with the existing `atomicWriteJson()` from `src/lib/config.ts`.
- Two record shapes, with `schema: 1` in both:
  - `{ schema: 1, status: "ok", plid, fetchedAt, title, current: [[timeMs, price], ...], listing: [[timeMs, price], ...] }`. The arrays hold the points after cleaning. Store points, not the computed result, so `--since` works from the cache.
  - `{ schema: 1, status: "not_tracked", plid, fetchedAt }`. Write this after a 404.
- A cache hit on an `ok` record computes the output from the stored points, with `cached: true`. A cache hit on a `not_tracked` record gives the same exit 4 `not_tracked` result as a fresh 404, without a request.
- A record is valid only if: `schema` is 1, `plid` equals the requested PLID, `fetchedAt` is a valid ISO time not in the future, and, for `ok`, every point passes the cleaning rules again, `current` is not empty, and `title` is `null` or a string. Before output, apply the full title rules (control stripping, whitespace, 200-character limit, empty becomes `null`) to a cached title too. Other responses (3xx, 401, 403, 429, 5xx, format errors) are never cached.
- TTL 24 hours from `fetchedAt`. `--no-cache` skips the read and still writes.
- On read: if the file is missing, has another `schema`, fails the same validation as a fresh response, or cannot be read, ignore it and fetch. A cache write failure prints a warning under `--verbose` and does not change the exit code.

## Code map (existing conventions)

- Command registration: `src/cli.ts`, same shape as the `reviews` command (`withGlobals(program.command(...))`, `.allowExcessArguments(false)`, `.action((...) => run(command, (ctx) => ...))`). Add a `price` group with a `history` subcommand. The action is in a new file, `src/commands/price.ts`.
- Output: `ctx.logger.result(humanFn, jsonData)` (`src/lib/ui.ts`).
- Errors and exit codes: `errorDetails()` and `errorExitCode()` in `src/cli.ts`. Error classes are in `src/lib/errors.ts`.
- Atomic file write: `atomicWriteJson()` in `src/lib/config.ts`.
- Transport guard tests: `src/__tests__/payment-block.test.ts` (`UnsafeUrlError` cases).

## Tests

- Fixtures in `src/__tests__/fixtures/serval/`, trimmed from real pages:
  - tracked, with listing price
  - `annotation: {}` and empty listing price
  - 404 page
  - page without the data line
  - a mismatched-length shape
- Parser: cleaning order for both series, duplicate dates, non-finite, null, string, negative, too large and out-of-range time points dropped, rounding only on output, windows (`30d`, `1y`, `all`), empty window, stale flag, ties in min and max, `lastChange` null, listing price, title entity decoding, never uses annotations, outliers kept.
- Ref parser: every accepted form, and rejections (`0`, `-1`, `1.5`, `12x`, a URL on another host, a URL without `PLID`).
- Fetch (mocked `fetch`):
  - exact URL, method, `redirect: 'manual'`, the literal headers only
  - no `authorization`, `cookie`, `tal-did` or `x-csrf-token` header, even when a logged-in `Context` exists
  - retry count for each status in the outcome table
  - 2 MB limit
  - timeout
- Cache: `ok` hit, `not_tracked` hit (no request, exit 4), expiry, `--no-cache`, schema mismatch, PLID mismatch, future `fetchedAt`, corrupt file, file and directory modes, write failure ignored.
- Title: an entity that decodes to ESC or a bidi control does not reach the output.
- Guard: `send()` still throws `UnsafeUrlError` for `https://www.servaltracker.com/...`.
- Exit codes for every row of the outcome table.
- One live test, skipped in CI, for PLID46639928. It is read-only.

## Docs

README, `skill/SKILL.md` and `skill/references/commands.md` get a short section. It says:

- the data comes from Serval
- one price per day, with possible gaps
- the data can be stale
- 404 means Serval does not track the product

The docs follow ASD-STE100 and pass `ste-lint` with 0 hard violations.

## Out of scope

The live Takealot price in this command, local price snapshots, watchlists, alerts and cron. These stay in #51 as later work.
