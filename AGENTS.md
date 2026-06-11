# AGENTS.md — takealot-cli

Takealot shopping CLI. TypeScript, talks directly to the Takealot mobile API via Android user-agent (bypasses Cloudflare).

## Structure

```
takealot-cli/
├── src/
│   ├── cli.ts                   # CLI entry point — Commander program wiring
│   ├── types.ts                 # Shared TypeScript types
│   ├── commands/
│   │   ├── cart.ts              # cart show / add / basket / clear
│   │   ├── checkout.ts          # checkout (dry-run) + --confirm
│   │   ├── config.ts            # config show
│   │   ├── login.ts             # login / --reset
│   │   ├── orders.ts            # orders list + orders show <id>
│   │   ├── preferences.ts       # preferences show / refresh
│   │   └── search.ts            # search <query> [--limit] [--json]
│   ├── lib/
│   │   ├── api-client.ts        # Takealot mobile API — Android UA, all HTTP calls
│   │   ├── auth.ts              # Token management + auto-refresh
│   │   ├── checkout.ts          # Checkout flow helpers
│   │   ├── config.ts            # XDG config dir (~/.config/takealot-cli/)
│   │   ├── context.ts           # GlobalOptions + Context passed to commands
│   │   ├── preferences.ts       # Preference engine (order-history ranking)
│   │   ├── prompt.ts            # Interactive terminal prompts (inquirer-style)
│   │   └── ui.ts                # Console output helpers / colour
│   └── __tests__/
│       └── cli.test.ts          # Smoke tests via compiled dist/cli.js
├── .github/workflows/
│   ├── ci.yml                   # Typecheck on push / PR
│   ├── release-impl.yml         # Release implementation details
│   └── ship.yml                 # Version bump + GitHub Release + Homebrew tap
├── docs/
├── AGENTS.md
├── CHANGELOG.md
├── LICENSE
├── Makefile
├── README.md
├── package.json
├── tsconfig.json
└── version.env
```

## Build / Test / Lint

```bash
make ci       # lint + test (use this before every commit)
make lint     # tsc --noEmit  (type-check only, no output)
make test     # npm run build && vitest run
make build    # tsc  (emit dist/)
make fmt      # prettier --write .
make clean    # rm -rf dist
make install  # npm install
```

All targets require Node ≥ 18.

## Key Design Decisions

- **Direct API** — uses the Takealot Android mobile API with an Android User-Agent string. This bypasses Cloudflare bot protection without Playwright or headless browsers.
- **Preference engine** — learns from your order history and ranks search results by: exact past purchase → brand match in category → explicit brand list → Jaccard title similarity.
- **Session caching** — credentials and tokens are stored in `~/.config/takealot-cli/` (XDG, `chmod 0600`). Tokens are refreshed automatically on expiry.
- **No browser** — pure REST, `commander` + `node-fetch`-equivalent. Zero browser dependency.
- **`--json` everywhere** — every data-emitting command accepts `--json` for machine-readable output. Do not remove this from any command.

## Constraints

- **Do not change the Android UA strategy** in `src/lib/api-client.ts`. The mobile UA is the Cloudflare bypass; swapping it for a desktop UA will break all API calls.
- **Keep `--json` on every data command.** The flag is part of the public interface and used by scripts.
- **Preference engine must remain.** The ranking logic in `src/lib/preferences.ts` is a core feature, not optional.
- **No browser automation.** Do not introduce Playwright, Puppeteer, or any headless browser dependency.
- **Auth via saved credentials only.** Do not prompt for credentials on every command; use the stored session and auto-refresh.

## CI

- **`ci.yml`** — runs `npm run lint` (tsc --noEmit) on push to `main` and on every PR.
- **`ship.yml`** — version bump + GitHub Release + Homebrew tap update on tagged releases.
- **Run locally:** `make ci` — lint + tests must pass before merging.

When adding tests that hit the live Takealot API, gate them with `it.skipIf(process.env['CI'] === 'true')` so they are skipped in CI (network not available).
