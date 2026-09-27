# Plan: `takealot watch` watchlist and price-drop checks via Serval (#51)

## Goal

Let the owner keep a local list of Takealot products and find price drops once a day. The price data comes from servaltracker.com through the existing `price history` code (`src/lib/serval.ts`, `src/commands/price.ts`). The owner has verbal permission from the Serval operator. A Hermes cron job, outside this repository, runs the check once a day and posts drops to Discord.

## Commands

```
takealot watch add <product> [--target <rand>] [--drop <percent>]
takealot watch add --from-wishlist <groupId> [--drop <percent>]
takealot watch rm <product>
takealot watch list
takealot watch check [--no-update] [--max-requests <n>]
```

All commands accept `--json` and `--verbose`.

- `<product>` uses `parsePlidRef()` from `src/lib/product-ref.ts`. Anything else exits 4.
- `--target <rand>`: a positive number with at most 2 decimals, at most 10,000,000. Alert when the current price is at or below it.
- `--drop <percent>`: an integer from 1 to 90. Default 5. Alert when the price falls by at least this percent against the reference price (see Drop rules).
- `--from-wishlist <groupId>`: a positive integer. Read `wishlist items <groupId>` from Takealot (read-only, needs login) and add every item's `plid`. Items without a valid `plid` are skipped and reported. `<product>` and `--from-wishlist` together exit 4. `--target` with `--from-wishlist` exits 4.
- `watch add` on a PLID that is already in the list updates `target` and `drop` only when the caller gives them, and keeps its state.
- `watch add` makes no Serval request. The first `watch check` gets the data.
- `watch rm` on a PLID that is not in the list exits 4, code `not_watched`.
- `watch list` makes no network request. It prints what the list and the last check hold.
- `--max-requests <n>`: an integer from 1 to 50. Default 50. It counts **HTTP attempts** to Serval (a retry counts as one attempt). Cache hits do not count.
- `--no-update`: run the check but do not write `watchlist.json`. The Serval cache is still read and written, exactly as `price history` does. `--no-update` changes only the watchlist file.

## Storage

- File: `~/.config/takealot-cli/watchlist.json` (use `configDir()` from `src/lib/config.ts`, so `XDG_CONFIG_HOME` applies). Mode 0600. Write with `atomicWriteJson()`.
- Do not use the credentials lock. Use a separate lock with the same directory-lock approach that `config.ts` uses for credentials. Name it `watchlist.lock` and hold it around every read-modify-write. A second process that cannot get the lock in 10 s exits 1 with code `watchlist_locked`.
- Shape:

```
{
  schema: 1,
  items: [
    {
      plid, title, addedAt,
      target: number | null,
      dropPercent: number,
      referencePrice: number | null,
      referenceDate: string | null,
      lastCheckedAt: string | null,
      lastPrice: number | null,
      lastPriceDate: string | null,
      lastStatus: "ok" | "not_tracked" | "stale" | "error" | null,
      alertArmed: boolean,
      lastAlert: { price: number, date: string, reasons: ("target" | "drop" | "low")[] } | null
    }
  ]
}
```

- At most 50 items. `watch add` that would pass 50 exits 4, code `watchlist_full`. `--from-wishlist` adds items until the limit, then stops and reports the rest as skipped.
- Validate the file on every read. Every rule below must hold, or the file is invalid:
  - `schema` is 1. `items` is an array of at most 50 objects. No unknown keys.
  - `plid`: positive safe integer, unique in the list.
  - `title`: `null` or a string of at most 200 characters.
  - `addedAt`, `lastCheckedAt`: ISO 8601 UTC strings (`new Date(v).toISOString() === v`), not in the future. `lastCheckedAt` can be `null`.
  - `referenceDate`, `lastPriceDate`: `YYYY-MM-DD` strings that are valid dates, or `null`.
  - `target`: `null` or a finite number greater than 0 and at most 10,000,000, with at most 2 decimals.
  - `dropPercent`: an integer from 1 to 90.
  - `referencePrice`, `lastPrice`: `null` or a finite number greater than 0 and at most 10,000,000.
  - `lastStatus`: one of the listed values or `null`. `alertArmed`: boolean.
  - `lastAlert`: `null`, or an object with `price` (as `lastPrice`), `date` (`YYYY-MM-DD`), and `reasons` (a non-empty array of unique values from `target`, `drop`, `low`).
  - Cross-field: `referencePrice` and `referenceDate` are both null or both set. `lastPrice` and `lastPriceDate` are both null or both set.
- A file that fails validation is not changed. The command exits 1 with code `watchlist_invalid`, the path and the first failed rule. It never repairs or overwrites the file.
- A missing file is an empty list.

## `watch check`

### Locks

- `watch check` takes `watchlist.lock` at the start, reads the file, and holds the lock until it has written the file at the end. The lock covers the network waits. A second `watch check`, `watch add` or `watch rm` waits up to 10 s and then exits 1 with `watchlist_locked`. `--no-update` still takes the lock, so it reads a consistent file, but it writes nothing.
- A held lock is reclaimed only when its same-host owner pid is dead. A lock from another host is never reclaimed.
- Serval single-flight: `loadServalHistory()` takes a per-PLID lock (`serval/PLID<n>.lock`, same directory-lock approach) around "read cache, fetch if missing or expired, write cache". After it gets the lock, it reads the cache again before any fetch. So `price history`, a manual `watch check` and the cron job that run at the same time make at most one successful fetch per PLID per 24 hours. A `not_tracked` result is cached as in `price history`. A failed fetch (network, timeout, 5xx after the retry, other HTTP code) writes a failure marker `{ failedAt, code }` in the same per-PLID cache directory. For 10 minutes after `failedAt`, a caller that gets the lock returns that failure and does not fetch. So a burst of concurrent callers makes at most 2 attempts for one PLID. A returned failure marker counts as 0 attempts and is not a cache hit. It is handled like a live failure with the same code: `serval_rate_limited` or `serval_forbidden` from a marker also sets `serval_blocked` and stops later fetches in this run. If the per-PLID lock cannot be taken in 20 s, that item fails with `serval_busy` and no fetch. `price history` uses the same lock.

Reclaim is best-effort for a dead same-host owner. Correctness comes from fencing: every write checks ownership first and aborts with `lock_lost`. The worst case after a crash is one extra Serval request, never two writers.

### Steps

For each item, in the stored order:

1. Get the Serval result with the same code path as `price history`: the 24-hour cache first, then one fetch (at most 2 HTTP requests per item, as in the existing rules). Refactor the cache read, fetch and parse in `src/commands/price.ts` into one exported function, for example `loadServalHistory(plid, { cache: true, version, verbose, ctx })`, that both commands use. Do not change its behaviour for `price history`.
2. Count HTTP attempts. Before a fetch, if `attempts + 2 > --max-requests` (the fetch can need a retry), do not start it. Mark this item and the remaining items that need a fetch `skipped: "request_limit"`. Items with a valid cache are still served.
3. Wait 3 s before each fetch after the first fetch of the run. Cache hits have no wait.
4. The existing fetch never retries 429, 401 or 403 (it retries only network errors, timeouts and 5xx). Keep that. If a fetch fails with `serval_rate_limited` or `serval_forbidden`, stop all further fetches in this run. Mark the items that need a fetch `skipped: "serval_blocked"`. Serve items that have a valid cache.
5. Other per-item errors (`not_tracked`, `serval_format_changed`, `network`, `timeout`, other HTTP codes) are recorded for that item. The run continues.

The check never uses the Takealot API. It needs no login.

### Drop rules

For an item with Serval data `ok`. Inputs: `current` and `currentDate` are the last point of the cleaned Serval series, exactly as in `price history`. `points` is the full cleaned series.

1. **Stale.** If `currentDate` is more than 7 days before today (UTC), the status is `stale`. Update `lastCheckedAt` and `lastStatus` only. No alert. Do not change any price, reference or alert state.
2. **Not newer.** If `lastPriceDate` is set and `currentDate <= lastPriceDate`, the data is not new. Update `lastCheckedAt` and `lastStatus` only. No alert. This stops a repeat check on the same day, or older cached data, from changing state.
3. **First data.** If `referencePrice` is null: set `referencePrice = current`, `referenceDate = currentDate`, `alertArmed = true`, and update `lastPrice`, `lastPriceDate`, `lastCheckedAt`, `lastStatus` and `title`. No alert.
4. **Reasons.** An item can have more than one reason:
   - `target`: `target` is not null and `current <= target`.
   - `drop`: `current <= referencePrice * (1 - dropPercent / 100)`.
   - `low`: `points` has at least 30 entries, and `current` is less than or equal to the minimum price of every point before the last one (by array position).
5. **Alert.** Alert when there is at least one reason and `alertArmed` is true. Then set `alertArmed = false` and `lastAlert = { price: current, date: currentDate, reasons }`.
6. **Re-arm.** Set `alertArmed = true` only when this check has no reason at all (no `target`, no `drop`, no `low`). The re-arm is applied after step 5, so it affects the next check. Then a later fall can alert again. For example, an alert at R80, a rise to R100 (no reason, re-arm) and a fall to R80 again gives two alerts. A price that stays at or below the target (R80, R82, R79) gives one alert, because the `target` reason stays true and the item does not re-arm.
7. **Reference.** The drop baseline is the most recent high point:
   - Save `previousReference = referencePrice` before this step. The output uses `previousReference`.
   - If the `drop` reason was in an alert that fired in this check, set `referencePrice = current`, `referenceDate = currentDate`.
   - Else, if `current > referencePrice`, set `referencePrice = current`, `referenceDate = currentDate`.
   - A `target` or `low` alert without `drop` does not change the reference.
8. **Always** (for new data): update `lastPrice`, `lastPriceDate`, `lastCheckedAt`, `lastStatus`, `title`.

Items without `ok` data:

- `not_tracked`: set `lastStatus = "not_tracked"` and `lastCheckedAt`.
- A fetch or parse error: set `lastStatus = "error"` and `lastCheckedAt`.
- Skipped (`request_limit`, `serval_blocked`): change nothing. The item keeps its previous `lastStatus` and `lastCheckedAt`, because it was not checked.

Output `items[]` always has `plid`, `title`, `status`, `current`, `currentDate` and `reference`. `current` and `currentDate` are the Serval values for `ok`, `stale` and `not_newer`, and `null` otherwise. `reference` is the stored `referencePrice` before this check (`previousReference`), or `null` when there was none.

Output `items[].status` is one of `ok`, `stale`, `not_newer`, `not_tracked`, `error`, `skipped`. `skipped` items also have `skipped: "request_limit" | "serval_blocked"`. `error` items also have `error: { code, message }`. The stored `lastStatus` for `ok` and `not_newer` is `"ok"`, and for `stale` it is `"stale"`.

All comparisons use the unrounded Serval price. Output values are rounded to 2 decimals as in `price history`. `referencePrice` is always greater than 0 (validation), so `changePercent` is always defined.

### Output

JSON:

```
{
  checkedAt, attempts, cacheHits, runError,
  alerts: [ { plid, title, url, current, currentDate, reference, target, dropPercent, changePercent, reasons, historyMin, historyMinDate } ],
  items: [ { plid, title, status, current, currentDate, reference, skipped?, error? } ],
  errors: [ { plid, code, message } ]
}
```

- `url` is the Takealot product URL `https://www.takealot.com/x/PLID<plid>`. (The Serval URL is in `price history`.)
- `reference` in an alert is the value before this check (`previousReference`), not the updated one. `changePercent` is `(current - previousReference) / previousReference * 100`, rounded to 1 decimal. It is negative for a drop.
- `historyMin` is the minimum price of every point before the last one (by array position). `historyMinDate` is the date of the latest point with that price. `historyMin` and `historyMinDate` are `null` when there are fewer than 2 points.
- Titles: the stored `title` is the cleaned Serval title from `cleanServalTitle()`, truncated to 200 characters. A `null` title stays `null`.
- Human output: one line per alert (title, price, reasons, change), then a summary line (`N alerts, M items checked, K skipped, E errors`). No alerts: print `No price drops.`

`attempts` is the number of HTTP attempts to Serval in this run. `runError` is `null` or `{ code, message }`. It is set in these cases:

- `serval_blocked`: a 429 or 403 stopped fetching.
- `request_limit`: the cap stopped at least one fetch.
- `no_results`: the list is not empty and no item gave usable data (every item failed, was skipped, or was not tracked).

If more than one applies, use the first in this order: `serval_blocked`, `no_results`, `request_limit`.

Exit codes:

- 0: the check ran and `runError` is `null` or `request_limit`. Alerts, per-item errors and skipped items do not change this.
- 1: `runError` is `serval_blocked` or `no_results`, or the check could not run (invalid watchlist file, lock timeout). The cron job treats exit 1 as a failure and posts it.
- 4: usage error.
- An empty watchlist exits 0 with no alerts and `runError: null`.

Alerts do not change the exit code. The cron job reads the JSON.

## Network rules

- The only network calls are the existing Serval fetch (for `check`) and the Takealot `wishlist items` read (for `add --from-wishlist`).
- No Serval search or submit call. No new Serval endpoints.
- The Serval request stays as it is now: the fixed URL template, the literal headers, no Takealot credentials.
- The maximum HTTP attempts to Serval in one `watch check` is `--max-requests`, at most 50. Retries count toward it.

## Hermes cron (outside this repository, after release)

- One job, daily at 08:00 SAST, delivered to the shopping Discord channel.
- It runs `takealot watch check --json`. It posts only when `alerts` is not empty or when the run exits 1. It is silent otherwise.
- The owner confirms the job before it is created.

## Tests

- Watchlist file: create, add, update, remove, the 50 limit, duplicate add, every validation rule (one failing test each), invalid file is not changed, missing file is empty, mode 0600, the lock (second writer waits, times out with `watchlist_locked`, `--no-update` takes the lock and writes nothing).
- Single-flight: two concurrent loaders for one PLID make one fetch. The second reads the cache after it gets the lock. The per-PLID lock times out with `serval_busy`.
- `add --from-wishlist`: items with and without `plid`, the limit, no Serval request, combination errors.
- Drop rules, with fixture histories:
  - first check sets reference, no alert
  - drop at exactly `dropPercent`, just under it
  - target equal and below
  - new low with fewer than 30 points (no `low`) and 30 or more
  - stale item never alerts
  - the same price does not alert twice, and a recovery then a new fall alerts again (R80, R100, R80)
  - a price that stays at or below the target (R80, R82, R79 with target R85) alerts once
  - a target-only or low-only alert does not move the reference
  - reference moves up after a rise and stays after a small fall
  - stale data and data not newer than `lastPriceDate` change only `lastCheckedAt` and `lastStatus`
  - `low` with duplicate timestamps uses array position
  - several reasons at once
- Check loop, with a mocked Serval fetch:
  - cache hits have no wait and do not count as attempts
  - the 3 s wait between fetches (fake timers)
  - `--max-requests` counts attempts, and a fetch that could need a retry does not start when only 1 attempt is left
  - 429 and 403 make one attempt only and stop all further fetches, `runError: serval_blocked`, exit 1
  - per-item errors continue
  - `--no-update` does not write `watchlist.json`
  - no usable result gives `runError: no_results`, exit 1
  - an empty list exits 0
- `price history` output is unchanged after the refactor (the existing tests pass without edits).
- Guard: `send()` still rejects the Serval origin.
- One live test, skipped in CI, read-only: `watch check --no-update` against a temporary `XDG_CONFIG_HOME` with PLID46639928.

## Docs

README, `skill/SKILL.md` and `skill/references/commands.md` get a short section. Say:

- the data comes from Serval, once a day
- `watch add` makes no request
- what each alert reason means
- the limits (50 items, request cap, stop on 429 and 403)

The skill says that `watch` writes only the local watchlist file and never changes the Takealot account, so it needs no `--confirm`. The docs pass `ste-lint` with 0 hard violations.

## Out of scope

Local price snapshots for products that Serval does not track, alerts from the CLI itself (it prints JSON, the cron posts), and a Takealot wishlist sync in the other direction.
