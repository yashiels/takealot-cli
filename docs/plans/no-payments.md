# takealot-cli v0.7.0: full-access agent CLI, no payments/3DS (issue #29)

## Owner decision (final, not up for review)
The agent gets FULL account access (cart, wishlist, addresses, orders cancel/reschedule, returns, refunds, invoices, reviews, account, help chat, credits, Plus manage). The ONLY capability removed: creating an order and paying for it (card, 3DS, eBucks, Plus payment). Owner pays in the official Takealot app. Supersedes the earlier "cart-only allowlist" plan.

Design lens: Ponytail (attached). Shortest correct diff, deletion over addition, no new abstractions, reuse what exists, one guard where all callers route through, one runnable check per non-trivial path. Security guard at the trust boundary is NOT simplified away.

## Repo facts (verified)
- TS, node>=18, commander, vitest. `make ci` = `tsc --noEmit` + build + vitest. No comments in code (house rule).
- `src/lib/catalogue.ts`: 197 rows `{id, method, path, base, auth, encoding, mutating, excluded, reason?, command, sample}`; `docs/endpoints-catalogue.json` is a frozen copy asserted equal by `catalogue.test.ts`; a contract test drives every non-excluded row. `endpoint(id)` returns any row; `TakealotClient.call(id)` throws only if `row.excluded`.
- `TakealotClient.apiRequest(method, pathOrUrl, opts)` in `src/lib/api-client.ts` is the single HTTP choke point for mobile calls. BUT `src/lib/checkout.ts` also has private `getJson/postJson` that hit `/checkout/{cid}/complete`, `/order/{id}/payment`, `/order/{id}/payment/complete`, `/checkout/order/{id}/payhost` and follow paygate URLs.
- Existing write gate (`src/commands/generic.ts` `gate()`): dry-run default, `--confirm` performs, `--yes` skips TTY prompt. Keep as is.
- Error handling: `src/cli.ts` `run()` prints `{error}` JSON on --json, exit 1 for everything.
- Live facts (4.3.0 audit, real account):
  - `GET checkout/{cid}` works WITHOUT a prior POST and is read-only. Returns `summary.{subtotal,discount,shipping_discount,donation,total,amount_due,customer_credits}.price.amount` (ZAR), `shipping_method` ("delivery"), `data_sections[]` (shipping_method, courier_address, ...), per-item products. This is the checkout preview source. `checkout.create` (POST) / `checkout.update` (PUT, select delivery/pickup) do not create an order; `checkout.complete` (POST `checkout/{cid}/complete`) creates the order.
  - `GET customers/{cid}/cart`: `total`(==sub_total), `total_saving`, `summary`, `promotions[].missed_by`, `cart_items[]`, `products[]`; no delivery fee/address.
  - reviews: path must be bare numeric plid `product-reviews/plid/{plid}` + `page` (+`sort`); `PLID` prefix -> 400.
  - recommend: locations `home-page|pdp|add-to-cart|landing-page|domain`; needs `platform=android&model=<key>&limit&display_type=product`. Keys from `GET recommendations/home-page/layout?platform=android&number_of_slots=N&has_customer_id=true` (rfy, customer_consumables, trending, trending_by_department_N). home-page verified; pdp 500s.
  - invoices/creditnote/business-details: path param is `obfuscated_order_id` (on each order in `customer/{cid}/orders`), numeric -> 400.
  - info: data is `buybox.items[0].{sku, price, pretty_price, is_add_to_cart_available, stock_availability.status}`, `buybox.tsin`, `event_data.documents.product.{sku_id,in_stock,purchase_price}`; code reads nonexistent `buybox_summary`. Multi-variant listings: no sku on summary; `variants.selectors[].options[]`.
  - App 4.3.0 build 800751; api still v-1-18-0; CLI pins 4.2.2/800750. Device profile persisted per credential (`creds.device.profile`), hashed into OTP binding.

## Changes

### 1. Payment block (the one security boundary)
- In `catalogue.ts` set `excluded: true, reason: 'payment: pay in the Takealot app'`, `command: null` on: `checkout.complete`, `checkout.order.update`, `checkout.payment`, `checkout.payment.complete`, `checkout.payhost`, `ebucks.requestotp`, `ebucks.login`, `ebucks.pay`, `plus.pay`, `plus.card.add`, `plus.card.payment`, `plus.manage.card` (+ its form row if separate). Export `PAYMENT_BLOCKED` = those ids.
- Guard ONCE in `apiRequest`: before fetch, reject any request whose method+resolved path matches a `PAYMENT_BLOCKED` row's path template (templates compiled to regex from catalogue, `{x}` -> `[^/]+`), and any absolute URL whose host is not in the existing mobile/search allow-list. Throws `PaymentBlockedError` (exit 4). This catches raw `apiRequest` callers and any future bypass, not just `call()`.
- Delete `src/lib/checkout.ts` payment/3DS/reconcile code (initCheckout, getAmountDue, submitPayment, followPaygate, completePayment, orderPaidStatus, runCheckout, payOrder, reconcile*, resumeCheckout, getJson/postJson/parse, hashCart) and pending-order store in `config.ts` (`pendingOrderPath/load/write/clear`), `PendingOrder`/`CheckoutResult` types, `defaultCardReference` config key (keep reading it harmlessly? no: drop it, config loader ignores unknown keys; verify).
- Legacy pending file: if `pending-order-*.json` exists, `config show`/`checkout` prints one stderr warning "legacy pending payment marker found; check `takealot orders`" and never reads/acts on it. No rename logic (ponytail: a warning is enough; nothing reads it anymore).
- Tests (`src/__tests__/payment-block.test.ts`): for each `PAYMENT_BLOCKED` id, `client.call(id, sample)` and `client.apiRequest(method, resolvedSamplePath)` both throw `PaymentBlockedError` with fetch mock asserting zero calls; `checkout.get`/`checkout.create`/`checkout.update` are NOT blocked. Existing `checkout.test.ts` rewritten for the preview; catalogue contract test skips excluded rows (already does).

### 2. `checkout` = read-only preview
- `takealot checkout` (no flags): `GET checkout/{cid}` -> typed `{items[], subtotal, discount, shippingDiscount, credits, total, amountDue, shippingMethod, currency, sectionsIncomplete[]}` + `payInApp: true`, human output ends "Pay in the Takealot app." Reuse existing `getCart` only if checkout.get lacks item titles.
- `checkout --confirm`, `checkout resume`, `checkout reset`: removed. `--confirm` passed -> usage error exit 4 "orders are placed in the Takealot app". Selecting delivery method/address stays available via existing generic `checkout submit` (PUT checkout, gated) and `address use`.
- `cards` read stays (typed DTO: bank, scheme, last4, expires, selected, enabled; `reference` and `cardholder` dropped even under --unsafe-raw). `cards rm` stays gated (reversible-ish account hygiene, not a payment).

### 3. Everything else: keep full access, existing gate
- No capability allowlist, no plan-id system (rejected: YAGNI, owner wants full access; the dry-run+--confirm gate already exists and is tested).
- Account-security writes (`account.password`, `account.2fa.disable`, `account.trustedDevices.rm`/`rmAll`, `account.email`, `account.mobile`) additionally require `--i-know` alongside `--confirm` (one check inside `gate()` keyed by a small id set). Reason: only writes that can lock the owner out or de-trust the agent's device.

### 4. Agent error contract (small)
- `src/cli.ts` `run()`: map errors to exit codes: 1 runtime/API, 3 auth (existing auth errors / 401 / OTP required), 4 usage + PaymentBlockedError. JSON error envelope `{error, code, status?}` on stdout. Dry-run exits 0 (unchanged). No new error class hierarchy beyond `PaymentBlockedError` + tagging existing auth errors.

### 5. Read fixes
- reviews: catalogue path `product-reviews/plid/{plid}`, command passes `page` (default 1) and `--sort`.
- recommend: `recommend layout [--location home-page]` and `recommend <location> --model <key> [--limit 10]`; location validated against enum; `pdp` rejected locally with "not supported by API" until proven; `customer_id` auto-added when authed.
- invoices: rename catalogue param `{orderId}` -> `{obfuscatedOrderId}` for the 7 invoice/creditnote/business rows; commands accept numeric id and resolve via `orders.list` pages (stop at first match, max pages from `page_summary.page_count`); unresolved -> error exit 1 "order not found".
- info: parse `buybox.items[0]` + `event_data.documents.product`; output `skuId`, price, prettyPrice, inStock, addToCart, variants (title + options with plid/href). Multi-variant without sku -> `skuId: null` and list options; `cart add --plid` on such a listing errors "pick a variant" instead of guessing.
- Redacted fixtures (addresses, names, phone, card refs, obfuscated ids replaced) under `src/__tests__/fixtures/4.3.0/` for cart, checkout.get, product single+multi variant, reviews page, reco layout + home-page, orders list. One parser test per fix.

### 6. Device profile
- `DEFAULT_DEVICE_PROFILE` -> 4.3.0/800751, `DEFAULTS.mobileUserAgent` same. Existing creds keep their persisted profile (current behaviour already: `creds.device.profile ?? default`), so the owner's trusted device does not change. No bump command (YAGNI; delete creds' profile field manually if ever needed, documented one line).

### 7. Docs/release
- README, skill/SKILL.md (+ agent-scripts `skills/takealot` is a symlink/copy? verify, update the source), AGENTS.md, docs/MOBILE-API.md, CHANGELOG, catalogue JSON regenerated, version 0.7.0. Jarvis skill `grocery-ordering`: "Takealot: `takealot checkout` preview, owner pays in app".

## PR stack (bottom-up, one squashed commit each, `Closes #29` on the last; each PR body names the one below)
1. `feat(api): block order placement and payment at the client #29` — section 1 + 4 + tests.
2. `refactor(checkout): make checkout a read-only preview #29` — section 2 + legacy warning + cards DTO + `--i-know`.
3. `fix(api): reviews, recommend, invoices, info against app 4.3.0 #29` — section 5 + fixtures.
4. `chore(release): 4.3.0 device profile, docs, 0.7.0 #29` — sections 6-7.

## Acceptance
- `make ci` green per PR.
- `grep -rn "payment\|payhost\|paygate\|3ds\|threeDs" src --include=*.ts | grep -v __tests__ | grep -v catalogue.ts` returns only the block/guard code.
- Live smoke (manual, not CI): `search`, `cart`, `checkout` (shows amountDue), `checkout --confirm` exits 4 with no network call (verbose log shows none), `reviews <plid>`, `recommend layout`, `recommend home-page --model rfy`, `invoices <numeric id>`, `info` single + multi-variant, `orders`, `cards --json` has no reference.
- No added `//` or `/*` comments in src.

## Round-1 revisions (v3.1)
1. Transport bypass: ONE private `send(url, init)` in `api-client.ts` becomes the only `fetch` caller in the client (replaces the raw `fetch` in `authedFetch`, the unauthed mobile fetch, `absoluteFetch`, and `search`). `send` (a) parses the URL, (b) rejects any host other than exact `api.takealot.com` (search + mobile + absolute all live there; `absoluteFetch`'s allow-list narrows from `takealot.com` suffix to exact `api.takealot.com`, so `secure.takealot.com`/PayGate are rejected), (c) canonicalizes the path: decodeURIComponent, strip `/rest/v-N-N-N/` prefix, collapse `//`, drop trailing `/`, (d) tests method+path against the `PAYMENT_BLOCKED` regexes, (e) fetches with `redirect: 'manual'` and re-runs (b)-(d) on every `location` hop (max 5). `authedFetch` stays public but routes through `send`. `auth.ts` login/refresh fetches are fixed literal paths (`customers/login`, `customers/auth/refresh`) and stay as is; a test asserts no other `fetch(` in `src/lib` outside `send` and `auth.ts` (grep test on source). Tests: authedFetch to `/checkout/1/complete`, versioned absolute `https://api.takealot.com/rest/v-1-18-0/order/9/payment`, encoded `order%2F9%2Fpayment`, a 302 to `https://secure.takealot.com/...`, and a PayGate host: all throw `PaymentBlockedError`, zero fetches past the block.
2. Plus: decompile (`SourceNetworkConnectorSubscription`) shows plan changes are `PUT subscription/signup/plan/{id}`, `PUT subscription/reactivate`, `PUT subscription/manage/plan/upgrade|downgrade`, with payment separately via `POST subscription/pay` + `GET subscription/card/add|payment`. Whether signup/reactivate/upgrade charge the saved card server-side cannot be proven offline, so they are BLOCKED too (they commit money). Allowed Plus writes: `cancel`, `cancel/reason`, `manage/address`, `claim-discount`, `account link/unlink`. `downgrade` blocked as well (plan change, may pro-rate). `PAYMENT_BLOCKED` adds `plus.signup`, `plus.reactivate`, `plus.manage.upgrade`, `plus.manage.downgrade` (+ their GET form rows stay readable).
3. Exit handling: `call()` throws `PaymentBlockedError` for blocked ids BEFORE `ensureValid()` (no auth side effects). Commander: `program.exitOverride()` + `configureOutput`; in the top-level `parseAsync().catch`, `CommanderError` with code other than helpDisplayed/version -> exit 4 (JSON envelope when --json in argv). `run()` maps PaymentBlockedError/UsageError -> 4, auth errors (existing `AuthError`/`otp_*` codes, HTTP 401 after refresh) -> 3, else 1.
4. Security gate wiring: `gate()` gains an optional `{ endpointId, iKnow }` in its preview arg; register.ts passes the row id and adds `--i-know` to commands for ids in `SECURITY_WRITES = ['account.password.set','account.email.set','account.mobile.set','account.2fa.disable','account.trustedDevices.remove','account.trustedDevices.removeAll']` (exact catalogue ids, verified in PR). Without `--i-know`, `--confirm` prints refusal and exits 5? no: exits 4 (usage). Test: each id refuses without flag, proceeds with both.
5. `cards rm --last4 <dddd>`: resolves reference internally from `cards.list`; 0 or >1 matches -> exit 4. Reference never printed.
6. `skuForPlid` fixed alongside `info` (same parser: `buybox.items[0].sku ?? event_data.documents.product.sku_id`); multi-variant (no sku) -> error listing variant options; `cart add --plid` uses it. Test with single + multi-variant fixtures.
7. PR stack: merge old PR1+PR2 into PR1 `feat(checkout): read-only checkout preview; block payment at the transport #29` (block + send() + delete payment code + checkout preview + exit codes + security gate + cards rm). PR2 read fixes (+skuForPlid). PR3 device/docs/release. Each compiles and passes `make ci` alone.
8. Config: no migration; drop `defaultCardReference` from type + `config show`; unknown keys retained harmlessly.

## Round-2 revisions (v3.2)
1. `apiRequest()` catch: `if (err instanceof PaymentBlockedError) throw err;` before the network-ApiError wrap. Test: blocked path via apiRequest surfaces PaymentBlockedError, CLI exit 4.
2. `send()` canonicalization: method = `(init.method ?? 'GET').toUpperCase()`; path decoded repeatedly until stable (max 3 passes); after decoding, any `\`, `%` remaining, `/./`, `/../`, or control char -> reject as PaymentBlockedError-style `UnsafeUrlError` (exit 4). Block match is method-agnostic for payment rows (any method on a blocked path template is rejected), so method games do not matter. Tests: `%252F`, `%5C`, lowercase `post`, `..` segments.
3. Validation errors: add `UsageError` (tiny class in `src/lib/errors.ts` next to `PaymentBlockedError`); `intOpt()`, search validation, `kv()`, `--last4` resolution, `--i-know` refusal, `checkout --confirm` throw `UsageError`. `run()` and the top-level catch map UsageError + CommanderError (non-help) -> exit 4.
4. `checkout submit`: explicitly registered in PR1 as a gated generic command for `checkout.update` (and `checkout.create` as `checkout start`) alongside the bespoke `checkout` preview; `BESPOKE_FIRST` keeps skipping the other checkout rows. Test: `checkout submit --file x.json` dry-runs, `--confirm` sends PUT checkout/{cid}.
5. Frozen catalogue: every PR touching `catalogue.ts` regenerates `docs/endpoints-catalogue.json` in the same commit (existing generator/test).
Ponytail cuts adopted: `send()` uses `redirect: 'manual'` and REJECTS any 3xx (no hop following; absoluteFetch's loop deleted). Legacy pending-order warning dropped: pending-order code simply deleted.

## Round-3 revisions (v3.3)
1. `send()` order: parse URL -> exact origin check -> repeated decode -> reject unsafe chars/segments -> collapse `/+` -> strip `^/rest/v-\d+-\d+-\d+/` -> strip trailing `/` -> blocked-template match. Test: `//rest/v-1-18-0/checkout/1/complete` and `/rest/v-1-18-0//checkout/1/complete` blocked.
2. Origin check is exact `url.origin === 'https://api.takealot.com'` (protocol + host + default port). `http://`, other ports, userinfo -> UnsafeUrlError. Test.
3. Error hierarchy: `class UsageError extends Error`; `PaymentBlockedError extends UsageError`; `UnsafeUrlError extends UsageError`. `apiRequest()` catch rethrows `UsageError` unchanged; `run()` maps any `UsageError` -> 4.
4. `readBodyFromFlags()`: missing/unreadable `--file` and `JSON.parse` failures throw `UsageError` (message keeps the path, not the content). Test.

## Round-4 revisions (v3.4)
1. `send()` rejects `url.username || url.password` explicitly (URL.origin ignores userinfo) -> UnsafeUrlError. Test `https://x:y@api.takealot.com/...`.
2. `decodeURIComponent` wrapped: any `URIError` (malformed `%`, e.g. `%E0%A4%A`) -> UnsafeUrlError. Test.
