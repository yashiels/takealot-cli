# Review guidelines: takealot-cli

`takealot` is a TypeScript (ESM, Node 18+) CLI for the Takealot Android mobile API. Commander drives the command tree in `src/cli.ts`; commands live in `src/commands/`, the API and storage logic in `src/lib/`. It sends the Android app user-agent and auth headers to `https://api.takealot.com`, has no browser dependency, and must never place orders or pay. Price history and the watchlist read `https://www.servaltracker.com` (`src/lib/serval.ts`). It ships as standalone Bun binaries through `.github/workflows/release-impl.yml` (GitHub Release plus `yashiels/tap/takealot`). It handles a real shopper's credentials, saved cards and cart.

## Always flag

- **Payment boundary.** Any change that shrinks `PAYMENT_BLOCKED` in `src/lib/catalogue.ts`, changes the `r()` row builder so a blocked id loses `excluded: true`, or adds a call path that reaches a checkout, payhost, eBucks or Plus pay/card endpoint. Any new code path that builds its own `fetch` to Takealot instead of going through `send()` in `src/lib/api-client.ts`.
- **Transport guard in `send()`.** Weakening the `https://api.takealot.com` origin check, the `redirect: 'manual'` plus 3xx rejection, or the blocked-path check. Same for the Serval fetch: origin must stay `https://www.servaltracker.com` and redirects must stay rejected.
- **Checkout must stay read-only.** `checkoutCommand` in `src/commands/checkout.ts` must throw `UsageError` on `--confirm` (exit 4 via `errorExitCode` in `src/cli.ts`). The release smoke test depends on that exit code.
- **Tests that guard the boundary.** Edits to `src/__tests__/payment-block.test.ts` or `catalogue.test.ts` that drop ids from `PAYMENT_BLOCKED_IDS` or loosen the assertions without a matching, justified catalogue change.
- **Dry-run gate.** A new write command (cart, wishlist, address, cards, account, `register.ts` generated commands) that sends a request without `--confirm`, or an account-security write that skips the `--i-know` check in `src/commands/generic.ts`.
- **Secrets in output or logs.** New output paths (human or `--json`, error `details`, `--verbose` debug lines) that skip `redact()` from `src/lib/redact.ts`; new credential-like keys from the API that are not added to `CREDENTIAL_KEYS`; card output that prints more than the last four digits (`src/commands/cards.ts`).
- **On-disk state.** Writes to the config dir (`credentials.json`, `pending-otp-*.json`, preferences, form cache, `watchlist.json`) that bypass `atomicWriteJson` / mode `0o600`, or that skip the credentials lock or `withDirectoryLock` in `src/lib/directory-lock.ts`. Lost-update races between two processes are real bugs here.
- **Auth flow.** `src/lib/auth.ts` changes that drop the rotated `refresh_token` (it changes on every refresh), stop sending the stored `did`, leave the pending OTP file behind after success or expiry, or prompt for credentials on every command.
- **Cart remove guard.** In `src/commands/cart.ts`, logic that can report success when the target SKU is still in the cart, removes other lines, or prints restore commands with wrong per-SKU quantities (past real bugs in PR #49).
- **Fixtures with personal data.** New or changed files under `src/__tests__/fixtures/` that contain real names, addresses, emails, phone numbers, order signatories, tokens or card data (a past real finding in `orders.json`).
- **Live tests.** Tests that call the live API without `it.skipIf(process.env['CI'] === 'true')`, or live tests that write to the cart, wishlists or account.
- **`--json` contract.** Removing `--json` from a data command, or printing non-JSON to stdout when `--json` is set.
- **User-agent strategy.** Any change to the Android user-agent or app headers in `src/lib/api-client.ts`.
- **Workflows.** Unpinned third-party actions (existing ones are pinned to SHAs), or changes to `release-impl.yml` that drop the binary smoke test (`--version`, `--help`, `checkout --confirm --json` exits 4).
- **Path params.** Values substituted into catalogue paths without `encodeURIComponent` (see `resolvePath`), or URLs built from user input that skip the unsafe-URL checks.

## Severity guide

- **High:** any route to an order or payment endpoint; secrets, tokens, `did`, OTP or full card data printed, logged or committed; a write that runs without `--confirm`; credentials written with loose permissions; the transport guard weakened; cart or wishlist logic that silently removes or changes the wrong items.
- **Medium:** token refresh or OTP state bugs; missing locks or non-atomic writes; wrong exit codes (`errorExitCode`: 4 usage, 3 auth, 1 other); `--json` output shape breaks; personal data in fixtures; live tests not skipped in CI; wrong money or quantity handling in price, watch or cart output.
- **Low:** unclear error messages, missing test coverage for a new command, docs (`README.md`, `skill/`, `docs/MOBILE-API.md`) out of step with behaviour.

## Do not flag

- `package-lock.json`, `dist/`, `version.env` bumps and `chore(release)` commits.
- `docs/endpoints-catalogue.json`: a frozen copy of the app catalogue, large by design.
- Redacted app responses in `src/__tests__/fixtures/4.3.0/` (only flag real personal data, see above).
- Formatting or whole-file style. Prettier exists (`make fmt`) but the repo is not fully formatted, and reformatting unrelated code is itself discouraged.
- Existing JSDoc and line comments already in `src/` (flag only newly added ones).
- The Android user-agent and app headers: deliberate, the API fails with a desktop user-agent.
- `PaymentBlockedError` and `checkout --confirm` failing on purpose; these are features, not bugs.
- Commands generated from the catalogue in `src/commands/register.ts` looking generic or thin.
- Historic `CHANGELOG.md` entries that describe older behaviour.

## Conventions

- No code comments in new code: clear names and small functions instead. Tooling directives are fine.
- No browser automation (Playwright, Puppeteer or similar). The only runtime dependency is `commander`; flag new heavy dependencies.
- Keep the preference engine in `src/lib/preferences.ts`; `cart add` ranking order (prior purchase, brand in category, settings brand, Jaccard title similarity) is intentional.
- Errors use the typed classes in `src/lib/errors.ts` (`UsageError`, `PaymentBlockedError`, `UnsafeUrlError`, `ServalError`, `ApiError` keeps status and redacted body). Flag bare `throw new Error` for user-facing failures and swallowed errors.
- CI (`ci.yml`) only runs `npm run lint` (tsc). Tests are not run in CI, so a change to behaviour should come with vitest tests in `src/__tests__/` and the author is expected to run `make ci` locally.
- Commit and PR titles use `type(scope): imperative summary #N`, with no AI attribution trailers or footers.
