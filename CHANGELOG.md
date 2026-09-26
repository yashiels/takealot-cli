# Changelog

All notable changes to takealot-cli are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — full shopping loop (all 192 app endpoints)

- **Complete endpoint coverage.** Every non-telemetry endpoint the Takealot Android app
  exposes (192 of 197 catalogued; 5 telemetry/ads/auth-internal excluded with a reason) is
  reachable as a CLI command. The frozen `docs/endpoints-catalogue.json` is the source of
  truth; a contract test drives every endpoint and asserts the exact method/path/auth/encoding.
- **Generic request core** (`apiRequest`): repeated query keys, JSON/form/text/DELETE-with-body
  encodings, content-type-driven parse, `204`→null, structured `ApiError` (redacted body) under
  `--json`, `429`→`rate_limited`+`retry_after`, `AbortController` timeouts, bounded GET-only retry.
- **Cart editing:** `cart add --sku <id>` (exact buyable), `cart add --plid <id>` (resolved to
  its SKU), `cart set-qty <sku> <n>`, `cart remove <sku>`.
- **Product / browse:** `info <PLID>` (typed, `--credit-options`/`--bundle`/`--card`/`--reviews`),
  `autocomplete`, `trending`, `deals`, `recommend`, `buy-again`, `reviews <PLID>`.
- **Checkout:** dry-run now surfaces the selected delivery address, options, ETA, and fee;
  `checkout --confirm` persists a per-account `pending-order` and reconciles an interrupted or
  ambiguous run instead of re-charging; non-frictionless 3DS returns a structured
  `action_required` (challenge URL preserved); `checkout resume <orderId>` completes it.
- **Orders, returns/refunds, wishlist, credits/vouchers, cards, addresses, Takealot Plus,
  account/security, reviews, invoices, help/chatbot** — full command groups.
- **Data-section writes** use a locally-bound `form` → `submit --file <json>` pair (foreign/stale
  field ids rejected against the fetched form; no assumed server token).

### Removed — BREAKING

- **Order placement and every payment path.** The CLI no longer completes checkout, creates an
  order, submits card payment, follows 3DS, pays with eBucks, or performs Takealot Plus payment,
  signup, reactivation, upgrade, or downgrade operations. These endpoints are now blocked at
  the transport boundary; the account owner completes checkout in the Takealot app.
- `checkout --confirm`, `checkout resume`, `checkout reset`, payment challenge handling, saved-card
  payment references, and persisted pending-order recovery state.

### Changed

- **Checkout is read-only.** `checkout` now returns items, totals, amount due, shipping method,
  incomplete sections, and `payInApp: true`; human output directs the owner to the Takealot app.
- The API transport now permits only the exact `https://api.takealot.com` origin, refuses
  redirects and unsafe paths, and blocks all catalogue payment paths before any fetch.
- Saved-card output contains bank, scheme, last four digits, expiry, selected state, and enabled
  state without exposing references. `cards rm --last4` resolves the reference internally.
- Account-security writes require `--i-know` with `--confirm`. Usage and blocked-payment errors
  exit 4, authentication errors exit 3, and JSON errors use `{error, code, status?}`.
- New device profiles use Android app 4.3.0 build 800751. Existing credentials keep their stored
  profile so trusted-device identity remains stable.

### Fixed

- Public reviews now send a bare numeric PLID with `page` and optional `sort`.
- Recommendations now require a model and `display_type=product`; `recommend layout` exposes
  model keys for a location and unsupported `pdp` requests fail locally.
- Invoice, credit-note, and invoice business-detail commands resolve numeric order ids to the
  API's `obfuscated_order_id` before making the request.
- Product detail and `cart add --plid` now read the 4.3.0 buybox shape, expose variants, and
  refuse to guess a SKU for multi-variant listings.

### Security / safety

- **Mutation gating:** every state-changing command is dry-run by default and prints the exact
  intended request; it writes only with `--confirm` (`--yes` skips the TTY prompt).
- **Recursive, workflow-safe redaction** on all output and error messages (credentials masked;
  3DS challenge and signed invoice/PDF URLs preserved); `--unsafe-raw` opts out.
- **Absolute-URL containment** (address validation): static host allowlist, HTTPS, header
  suppression, manual redirects re-validated per hop.

## [0.4.0] — 2026-09-02

### Changed

- Bumped the authenticated mobile API base to `v-1-18-0` and the mobile User-Agent to `TAL-Android/4.2.2 (build 800750)`, matching the current Takealot Android app. Search stays on `v-1-14-0`. Both bases and the device profile remain overridable via `config.json` (#163)

### Added

- **Headless device trust** — the server-assigned `did` is now captured (from `Set-Cookie` and the body, cookie wins) and persisted at device scope, and sent as the `TAL-Did` header + `did` cookie on **every** request including login and refresh. Completing 2FA once with `trust_this_device:true` now trusts the device, so later logins — even a full re-login after tokens are wiped — skip the OTP. This makes authed commands work headlessly on agents/claws/devices (#161)
- **Two-step headless OTP** — `takealot login --json` emits `{"status":"otp_required","challenge":"<nonce>",…}` and exits 0; a separate `takealot login --otp <code> --challenge <nonce>` (or `TAKEALOT_OTP` + `TAKEALOT_CHALLENGE`) completes it. The persisted challenge is per-account, bound to the account/device/UA, and requires its nonce, so it can't be hijacked or replayed (#162)
- **Non-interactive credential injection** — `TAKEALOT_EMAIL` + `TAKEALOT_PASSWORD` override stored credentials (op-sa / 1Password friendly); persisted only after a successful login (#162)
- **Cross-process credentials transaction** — token/did writes go through one serialized, atomically-written transaction with an OS-backed directory lock, so parallel invocations sharing `credentials.json` no longer invalidate each other's rotating refresh token; the loser adopts the winner's tokens instead of refreshing (#160)
- Mocked-but-stable Android device profile driving the mobile User-Agent (overridable via `config.deviceProfile`); `config show` reports the device profile and did-trust status (redacted) (#161, #162)
- Two-step (OTP / 2FA) login — `loginWithOtp()` detects the `two_step_verification: "enabled_untrusted"` response, captures the `__cf_bm` Cloudflare cookie, and submits it with the OTP in a second request
- Concurrency-safe token renewal and stale-401 handling
- Canonical product-detail links (`www.takealot.com/<slug>/PLID<id>`) on `search`, `cart`, and `orders` output and in `--json` (`url` field) (#19)
- `skuId` on search/cart/order items — the buyable id used for add/remove-to-cart, kept distinct from the PLID (#19)

### Fixed

- Detect Takealot's OTP `cooldown` (HTTP 400 with `otp_status.status === "cooldown"`) and print a clear message instead of prompting for an OTP that will never arrive
- Search always reported "0 results" — now reads `paging.total_num_found` (#19)
- Product links used the SKU id as the PLID and 404'd — now use the real PLID (`core.id` / `sku.plid` / cart `plid`) (#19)
- Prices were 100× too small — the mobile API returns Rand, not cents; removed the erroneous `/100`, fixing cart, order, and checkout totals (#19)
- Cart quantities and total were wrong — join the `products` and `cart_items` arrays and take the total from `cart_summary.total.value` (#19)
- Search review counts (`core.reviews`) and saving badge (`buybox_summary.saving`) now populate (#19)
- Order status now derived from the order's boolean flags instead of a nonexistent `status` field (#19)

## [0.1.0] — 2026-06-08

### Added

- `search <query>` — search the Takealot catalogue without authentication; `--limit` controls result count
- `cart` — view current cart contents
- `cart add <item>` — search for an item and add the preference-ranked match to the cart
- `cart basket <items>` — add multiple comma/semicolon/newline-separated items in one shot
- `cart clear` — empty the entire cart
- `checkout` — dry-run checkout showing totals, delivery address, and selected card
- `checkout --confirm` — actually place the order and charge the saved card
- `checkout --yes` — skip the interactive confirmation prompt
- `orders` — list recent orders with status, totals, and dates; `--limit` controls count
- `orders show <id>` — full detail for a single order
- `preferences` / `preferences show` — display the current order-history preference cache
- `preferences refresh` — rebuild the preference cache by scanning full order history
- `config` / `config show` — print active config and credential status (secrets redacted)
- `login` — log in interactively; `--reset` clears stored credentials before prompting
- Global `--json` flag for machine-readable output on every command
- Global `--verbose` flag for debug logging to stderr
- XDG-compliant config directory (`~/.config/takealot-cli/`) with tight file permissions
- Preference engine: exact order-history match → brand match in category → explicit brand list → Jaccard title similarity
- Pure-API implementation using the Takealot mobile API (Android UA); no browser, no Playwright
- Automatic token refresh with credential persistence
- Standalone binary distribution via Homebrew tap (`yashiels/tap/takealot`) and GitHub Releases

[Unreleased]: https://github.com/yashiels/takealot-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yashiels/takealot-cli/releases/tag/v0.1.0
