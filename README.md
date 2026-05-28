# takealot — search, cart, and checkout without a browser

Command-line tool for Takealot.com. Pure API — talks directly to the mobile API (Android UA bypasses Cloudflare), no Playwright, no browser.

- **No browser required** — direct REST calls to the Takealot mobile API with automatic token refresh
- **Preference engine** — picks the best cart match from your order history: exact match → brand match → fuzzy title
- **Full checkout** — frictionless 3DS with saved cards; `--json` output for scripting

## Install

```bash
brew install yashiels/tap/takealot  # auto-taps yashiels/tap
```

Direct downloads from the [latest GitHub release](https://github.com/yashiels/takealot-cli/releases/latest).

Build from source:

```bash
git clone https://github.com/yashiels/takealot-cli.git
cd takealot-cli
npm install && npm run build
```

## Quick Start

```bash
takealot search "protein powder"
takealot search "pencils" --json
takealot cart add "3 pencils"
takealot cart basket "milk; bread; eggs; coffee"
takealot cart
takealot checkout           # dry-run
takealot checkout --confirm # place the order
```

## Commands

| Command | Description |
|---------|-------------|
| `takealot search <query>` | Search products (no login required) |
| `takealot cart` | Show current cart contents |
| `takealot cart add <item>` | Search and add item to cart (preference-aware) |
| `takealot cart basket <items>` | Add multiple items (`;` `,` or newline separated) |
| `takealot cart clear` | Empty the entire cart |
| `takealot checkout` | Dry-run checkout (shows totals, stops before payment) |
| `takealot checkout --confirm` | Place the order and pay with saved card |
| `takealot orders` | List recent orders |
| `takealot orders show <id>` | Full details for one order |
| `takealot preferences refresh` | Rebuild brand preference cache from order history |
| `takealot config` | Show config and credential status |
| `takealot login` | Force re-login (rotates cached tokens) |
| `takealot --help` | Show help |
| `takealot --version` | Show version |

## Configuration

Config lives in `~/.config/takealot-cli/`:
- `config.json` — API base URLs, platform, preferred card
- `credentials.json` — email, tokens (auto-managed)
- `preferences.json` — order history preference cache
- `preferred-brands.json` — explicit brand preference list

The preference engine picks the best product match when adding to cart: exact match from order history → brand match in category → explicit brand list → Jaccard similarity on title.

Global flags: `--json`, `--verbose`, `--version`, `--help`
Exit codes: `0` success, `1` general failure, `2` partial failure

## Disclaimer

Not affiliated with Takealot.com. Talks to private, undocumented APIs reverse-engineered from the Takealot Android app. Use at your own risk.

## Development

```bash
npm install     # install dependencies
npm run build   # compile TypeScript
npm run lint    # type-check
npm test        # run tests
```

Releases are automated via GitHub Actions. Go to **Actions → Ship**, pick `patch`, `minor`, or `major` — it bumps the version, builds a standalone binary, publishes a GitHub release, and updates the [Homebrew tap](https://github.com/yashiels/homebrew-tap).

## License

MIT — Yashiel Sookdeo
