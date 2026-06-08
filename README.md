# 🛒 takealot-cli

**Search, cart, and checkout on Takealot without a browser.**

[![CI](https://github.com/yashiels/takealot-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/yashiels/takealot-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/yashiels/takealot-cli)](https://github.com/yashiels/takealot-cli/releases/latest)

Pure REST — talks directly to the Takealot mobile API using the Android user-agent that bypasses Cloudflare. No Playwright, no browser, no puppeteer. A preference engine learns your buying history and picks the best match when you add items to your cart.

<!-- docs/assets/hero.png -->

## Install

```bash
brew install yashiels/tap/takealot
```

Or download a standalone binary from the [latest release](https://github.com/yashiels/takealot-cli/releases/latest).

**Build from source** (requires Node ≥ 18 or Bun):

```bash
git clone https://github.com/yashiels/takealot-cli.git
cd takealot-cli
npm install && npm run build
npm link          # puts `takealot` on your PATH
```

## Quick Start

```bash
# No login needed for search
takealot search "protein powder"
takealot search "pencils" --json | jq '.[0]'

# Authenticate once; tokens are cached automatically
takealot login

# Cart
takealot cart add "3 pencils"
takealot cart basket "milk; bread; eggs; coffee"
takealot cart

# Checkout — dry-run by default
takealot checkout
takealot checkout --confirm          # place the order
takealot checkout --confirm --yes    # skip the confirmation prompt
```

## Commands

### Search

```
takealot search <query> [--limit <n>] [--json]
```

Search the Takealot catalogue. No authentication required. Returns the top `n` results (default 10).

### Cart

```
takealot cart                        # show cart contents
takealot cart add <item>             # add one item (preference-ranked)
takealot cart basket "<item>; ..."   # add several items at once
takealot cart clear                  # empty the cart
```

`cart add` accepts an optional leading quantity: `"3 pencils"`, `"2 packs sunscreen"`. Items are matched via the preference engine (see [How it works](#how-it-works)).

`cart basket` splits on commas, semicolons, or newlines, then calls `cart add` for each item in parallel.

### Checkout

```
takealot checkout               # dry-run: show totals, address, card — no charge
takealot checkout --confirm     # place the order and pay with the saved card
takealot checkout --confirm --yes   # skip the interactive "are you sure?" prompt
```

The dry-run prints the full order summary (items, delivery address, payment method, total) so you can verify before committing.

### Orders

```
takealot orders [--limit <n>]   # list recent orders (default 20)
takealot orders show <id>       # full detail for one order
```

### Preferences

```
takealot preferences            # show the current preference cache
takealot preferences show       # same
takealot preferences refresh    # rebuild cache from full order history
```

### Config & Auth

```
takealot config                 # show config and credential status (secrets redacted)
takealot login                  # log in, cache tokens
takealot login --reset          # clear stored credentials and re-authenticate
```

### Global Flags

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON output (works on every command) |
| `--verbose` | Print debug logging to stderr |
| `--version` | Print the version and exit |
| `--help` | Show help for any command |

**Exit codes:** `0` success · `1` general failure · `2` partial failure

## Configuration

Config lives in `~/.config/takealot-cli/` (respects `$XDG_CONFIG_HOME`):

| File | Contents |
|------|----------|
| `config.json` | API base URLs, platform overrides, preferred card, explicit brand list |
| `credentials.json` | Email, hashed password, cached token set — `chmod 0600` |
| `preferences.json` | Order-history preference cache built by `preferences refresh` |

Files are written with tight permissions (`0600` for secrets, `0644` for non-secret config). The directory itself is `0700`.

## How it Works

**API layer** — Every call goes to the Takealot mobile REST API with an Android user-agent. This bypasses Cloudflare's browser-integrity checks that block standard `fetch` requests. Tokens are cached in `credentials.json` and refreshed automatically; you only log in once.

**Preference engine** — When you run `cart add`, the tool picks the best product match through a ranked funnel:

1. **Exact match** — a product you've ordered before with the same title
2. **Brand match** — a product in the same category from a brand you've bought before
3. **Explicit brand list** — brands you've listed in `config.json → preferredBrands`
4. **Fuzzy similarity** — Jaccard coefficient on the title tokens

Run `preferences refresh` after your first login to seed the cache from your full order history.

**Checkout flow** — `checkout --confirm` sends the finalise-order API call directly. 3DS is handled server-side with a saved card; no interactive redirect. The dry-run (`checkout` without `--confirm`) fetches the same preview payload the Takealot app shows before you tap "Pay".

## Development

```bash
npm install       # install dependencies
npm run build     # compile TypeScript → dist/
npm run lint      # type-check (tsc --noEmit)
```

Releases are fully automated. Go to **Actions → Ship**, pick `patch`, `minor`, or `major`. The workflow bumps the version in `version.env` and `package.json`, compiles standalone binaries for macOS arm64 and Linux x64 with Bun, publishes a GitHub Release, and updates the [Homebrew tap](https://github.com/yashiels/homebrew-tap).

## Disclaimer

Not affiliated with or endorsed by Takealot.com (Pty) Ltd. This tool calls private, undocumented APIs reverse-engineered from the Takealot Android app. The API may change without notice. Use at your own risk.

## License

MIT — [Yashiel Sookdeo](https://github.com/yashiels)
