---
name: takealot
description: Shop on Takealot.com from the terminal. Search, add to cart, manage wishlist, and checkout via pure API.
---

# takealot skill

Shop on Takealot.com from the terminal — search products, manage your cart, check out, and review order history. Talks directly to the Takealot mobile REST API; no browser required.

## Install

```bash
brew install yashiels/tap/takealot
```

Or download a standalone binary from the [latest release](https://github.com/yashiels/takealot-cli/releases/latest).

**Build from source** (Node ≥ 18 required):

```bash
git clone https://github.com/yashiels/takealot-cli.git
cd takealot-cli
npm install && npm run build
npm link   # puts `takealot` on your PATH
```

## Credentials

Credentials are managed by the `takealot login` command and cached automatically. The CLI stores tokens in `~/.config/takealot-cli/credentials.json` (XDG-respecting, `chmod 0600`).

For OpenClaw skill injection, place credentials at:

```
~/.openclaw/credentials/takealot.json
```

Example shape (do **not** hard-code credentials; use `takealot login` to populate):

```json
{
  "email": "you@example.com"
}
```

The `login` command prompts for your Takealot account email and password interactively, then caches the token set. Tokens auto-refresh on expiry — you only need to log in once.

## Commands

### Search (no login required)

```bash
takealot search <query>
takealot search <query> --limit <n>     # max results (default 10)
takealot search <query> --json          # machine-readable output
```

Examples:

```bash
takealot search "protein powder"
takealot search "pencils" --limit 5
takealot search "coffee" --json | jq '.[0]'
```

### Cart

```bash
takealot cart                           # show current cart
takealot cart add <item>                # add one item (preference-ranked match)
takealot cart basket "<item>; ..."      # add several items at once
takealot cart clear                     # empty the cart
```

`cart add` accepts an optional leading quantity:

```bash
takealot cart add "3 pencils"
takealot cart add "2 packs sunscreen"
```

`cart basket` splits on commas, semicolons, or newlines and adds items in parallel:

```bash
takealot cart basket "milk; bread; eggs; coffee"
takealot cart basket "3 pens, notebook, sticky notes"
```

### Checkout

```bash
takealot checkout                       # dry-run: print totals, address, card — no charge
takealot checkout --confirm             # place the order and pay with the saved card
takealot checkout --confirm --yes       # skip the interactive confirmation prompt
```

The dry-run prints the full order summary (items, delivery address, payment method, total) so you can verify before committing.

### Orders

```bash
takealot orders                         # list recent orders (default 20)
takealot orders --limit <n>             # show more/fewer orders
takealot orders show <id>               # full detail for one order
```

### Preferences

The preference engine learns from your order history and ranks search results for `cart add`.

```bash
takealot preferences                    # show the current preference cache
takealot preferences show               # same
takealot preferences refresh            # rebuild cache from full order history
```

Run `preferences refresh` after your first login to seed the cache.

### Config

```bash
takealot config                         # show config and credential status (secrets redacted)
takealot config show                    # same
```

Config lives in `~/.config/takealot-cli/` (respects `$XDG_CONFIG_HOME`):

| File | Contents |
|------|----------|
| `config.json` | API base URLs, preferred card, explicit brand list |
| `credentials.json` | Email, cached token set — `chmod 0600` |
| `preferences.json` | Order-history preference cache |

### Auth

```bash
takealot login                          # log in, cache tokens
takealot login --reset                  # clear stored credentials and re-authenticate
```

### Global Flags

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON output (works on every command) |
| `--verbose` | Print debug logging to stderr |
| `--version` | Print the version and exit |
| `--help` | Show help for any command or subcommand |

**Exit codes:** `0` success · `1` general failure

## Preference Engine

When you run `takealot cart add`, the tool picks the best product match through a ranked funnel:

1. **Exact match** — a product you've ordered before with the same title
2. **Brand match** — a product in the same category from a brand you've bought before
3. **Explicit brand list** — brands listed in `config.json → preferredBrands`
4. **Fuzzy similarity** — Jaccard coefficient on title tokens

Seed the cache once with `takealot preferences refresh` after your first login. The cache updates automatically as you order more.

## Quick-Start Example

```bash
# 1. Install
brew install yashiels/tap/takealot

# 2. Authenticate
takealot login

# 3. Seed the preference engine
takealot preferences refresh

# 4. Search and shop
takealot search "protein bar" --limit 5
takealot cart add "2 protein bars"
takealot cart basket "milk; bread; eggs"
takealot cart

# 5. Review and place order
takealot checkout              # dry-run first
takealot checkout --confirm    # then pay
```
