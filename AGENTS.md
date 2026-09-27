# AGENTS.md: takealot-cli

`takealot` is a TypeScript CLI for the Takealot mobile API. It sends the Android app user-agent and the app's auth headers. It has no browser dependency. It cannot place orders or pay.

## Structure

```
takealot-cli/
├── src/
│   ├── cli.ts                   # entry point, Commander program, run() error handling
│   ├── types.ts                 # shared types
│   ├── commands/
│   │   ├── cards.ts             # redacted card list, remove by last four digits
│   │   ├── cart.ts              # cart show, add, basket, set-qty, remove, clear, remove guard
│   │   ├── checkout.ts          # read-only checkout preview
│   │   ├── config.ts            # config show
│   │   ├── generic.ts           # dry-run gate, form and submit helpers, unavailable-state errors
│   │   ├── info.ts              # product detail and variants
│   │   ├── login.ts             # login, --reset, OTP steps
│   │   ├── orders.ts            # orders list, show
│   │   ├── preferences.ts       # preferences show, refresh
│   │   ├── recommend.ts         # recommendation layout and models
│   │   ├── register.ts          # commands generated from the catalogue
│   │   ├── reviews.ts           # public product reviews
│   │   ├── search.ts            # search
│   │   └── wishlist.ts          # typed wishlist add, move, rm-items
│   ├── lib/
│   │   ├── api-client.ts        # all API calls except login and refresh, send() transport guard
│   │   ├── auth.ts              # login, refresh, tokens, 2FA
│   │   ├── catalogue.ts         # endpoint rows and the PAYMENT_BLOCKED set
│   │   ├── checkout.ts          # checkout response parser
│   │   ├── config.ts            # config directory, file IO, credentials lock
│   │   ├── context.ts           # Context for commands, OTP challenge state
│   │   ├── device.ts            # stored Android device profile
│   │   ├── errors.ts            # usage, payment and unsafe-URL errors
│   │   ├── preferences.ts       # preference engine
│   │   ├── prompt.ts            # terminal prompts
│   │   ├── redact.ts            # secret redaction
│   │   └── ui.ts                # terminal output and colour
│   └── __tests__/               # vitest suites, fixtures/4.3.0 holds redacted app responses
├── .github/workflows/
│   ├── ci.yml                   # typecheck on push to main and on every PR
│   ├── release-impl.yml         # build, binary smoke test, release, tap update
│   └── ship.yml                 # manual release entry point
├── docs/
│   ├── MOBILE-API.md            # mobile API reference
│   ├── endpoints-catalogue.json # frozen copy of the endpoint catalogue
│   └── plans/                   # signed-off design plans
├── skill/                       # agent skill (SKILL.md and references)
├── AGENTS.md                    # CLAUDE.md is a link to this file
├── CHANGELOG.md
├── Makefile
└── README.md
```

## Build, test and lint

```bash
make ci       # lint, then build and test. Run it before every commit.
make lint     # tsc --noEmit
make test     # build, then vitest run
make build    # tsc to dist/
make fmt      # prettier --write .
make clean    # rm -rf dist
make install  # npm install
```

The package needs Node 18 or later. CI uses Node 22.

Do not run `make fmt` or prettier on whole files in a change. The repository is not fully formatted, and a full run adds unrelated changes to the diff.

## Key design decisions

- **Direct mobile API.** Authenticated calls go to `https://api.takealot.com/rest/v-1-18-0` with the Android user-agent. A desktop user-agent makes the API fail.
- **Transport guard.** Every request goes through `send()` in `src/lib/api-client.ts`. It allows only the `https://api.takealot.com` origin. It rejects redirects, unsafe URLs and every endpoint in `PAYMENT_BLOCKED`.
- **Dry-run writes.** A write sends nothing until the caller adds `--confirm`. Account-security writes also need `--i-know`.
- **Device trust.** The server gives a device id (`did`). The CLI stores it and, when it has one, sends it back on every request. After one OTP login with device trust, later logins normally skip the OTP.
- **Preference engine.** A text `cart add` ranks the results. The order is:
  1. An item that the owner bought before.
  2. A brand that the owner bought in the same category.
  3. A brand from the settings.
  4. Title similarity (Jaccard).
- **Credentials.** The CLI keeps credentials, tokens and the device record in `~/.config/takealot-cli/credentials.json` (mode 0600). A lock stops two processes from writing the file at the same time. Tokens refresh automatically.
- **`--json` on every data command.** Scripts and agents use it. Do not remove it from a command.

## Auth flow

1. `POST /customers/login` with the email and password.
2. If the response has `two_step_verification: "enabled_untrusted"`, the CLI saves the challenge to `pending-otp-<hash>.json` (mode 0600). The file holds the `__cf_bm` cookie, the `did` and the expiry time.
3. The owner gives the OTP. `POST /customers/login` again with the credentials, the OTP section and the `__cf_bm` cookie.
4. The CLI parses `auth_info` into a token set (jwt, refresh token, csrf token, did) and saves it.
5. The CLI removes the pending-challenge file after a successful login, after expiry, or when the challenge no longer matches the account or device.

`refresh_token` changes on every refresh. See `docs/MOBILE-API.md` for the request and response formats.

## Constraints

- **Do not change the Android user-agent strategy** in `src/lib/api-client.ts`.
- **Do not add order-placement or payment code.** `PAYMENT_BLOCKED` and `send()` are a security boundary. Tests must continue to prove that blocked endpoints are unreachable.
- **Keep `--json` on every data command.**
- **Keep the preference engine** in `src/lib/preferences.ts`. It is a core feature.
- **Do not add browser automation.** No Playwright, Puppeteer or other headless browser.
- **Do not ask for credentials on every command.** The first login can need an OTP. Later commands use the stored tokens and refresh them.
- **Do not add code comments.** Use clear names and small functions instead.

## Tests

- Tests that call the live Takealot API must use `it.skipIf(process.env['CI'] === 'true')`. CI has no account.
- Live tests are read-only. A live test must not write to the owner's cart, wishlists or account, because a restore step can fail.

## CI and release

- `ci.yml` runs `npm run lint` on push to `main` and on every PR.
- `ship.yml` starts a release by hand (`gh workflow run ship.yml -f bump=patch`). It calls `release-impl.yml`.
- `release-impl.yml` builds a standalone Bun binary for each target. It runs the binary for the runner's own platform before it publishes:
  1. `--version` must print the release version.
  2. `--help` must succeed.
  3. `checkout --confirm --json` must exit 4.

  If the job tests no binary, it fails. After the test, it makes the GitHub Release and updates `yashiels/tap/takealot`.
