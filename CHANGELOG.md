# Changelog

All notable changes to takealot-cli are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
