---
name: takealot
description: Shop Takealot.com end-to-end from the terminal, headless-first for agents. Search, browse, cart, checkout & pay, orders, tracking, returns, wishlist, credits, Plus, account — all 192 API endpoints, device-trust auth that skips OTP after first login, --json everywhere, dry-run-by-default writes.
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

Credentials are managed by the `takealot login` command and cached automatically. The CLI stores email, plaintext password (protected only by filesystem permissions, chmod 0600), and cached tokens in `~/.config/takealot-cli/credentials.json` (XDG-respecting, `chmod 0600`).

The `login` command prompts for your Takealot account email and password interactively, then caches the token set. If your account has two-step verification (2FA) enabled, you will also be prompted for an OTP code sent to your phone. Tokens auto-refresh on expiry; if refresh fails and full login is required, a 2FA account requires an interactive OTP prompt.

## Automated / agent usage

The CLI is built for headless agents. Device trust rides on a server-assigned
`did` the CLI persists and replays on every request (`TAL-Did` header + `did`
cookie). **Once 2FA is completed a single time with device trust, later logins —
including a full re-login after tokens are wiped — skip the OTP entirely**, so
agents keep working unattended.

**Credential injection (no interactive prompt):** set `TAKEALOT_EMAIL` +
`TAKEALOT_PASSWORD` in the environment (these override any stored pair). This is
op-sa / 1Password friendly:

```bash
TAKEALOT_EMAIL="$(op-sa read op://Agents/takealot/username)" \
TAKEALOT_PASSWORD="$(op-sa read op://Agents/takealot/password)" \
  takealot cart --json
```

**First-time / untrusted-device 2FA is a two-step, TTY-free handshake:**

1. Trigger the challenge — the CLI sends the OTP to the user's phone and prints
   the challenge to complete:
   ```bash
   takealot login --json
   # → {"status":"otp_required","challenge":"<nonce>","otpSentTo":"…","expiresInSec":300}
   ```
   (exit 0). If the device is already trusted this instead prints
   `{"status":"ok","customerId":…}` and you're done.
2. Ask the user for the code they received, then complete it — the `--challenge`
   nonce from step 1 is **required**:
   ```bash
   TAKEALOT_OTP=123456 TAKEALOT_CHALLENGE=<nonce> takealot login --json
   # or: takealot login --otp 123456 --challenge <nonce> --json
   ```
   Prefer the env vars — `--otp` leaks via the process list / shell history.

- Structured error codes under `--json`: `otp_required` (no live challenge — run
  `takealot login` first), `otp_state_mismatch` (wrong/absent `--challenge`, or
  account/device changed), `otp_expired` (re-run `takealot login`).
- **Never run `takealot login --reset` unattended** — it re-prompts for
  email/password and needs a TTY. Use env injection instead.
- Multiple agents driving *different* accounts on one box must use separate
  `XDG_CONFIG_HOME` dirs; same-account concurrent invocations are safe (writes are
  serialized by a cross-process lock).
- Search needs no login, so `takealot search … --json` always works.
- For checkout, always dry-run first (`takealot checkout`) and only pass
  `--confirm --yes` when the user has explicitly approved the order and total.

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
| `credentials.json` | Email, plaintext password (protected only by filesystem permissions, chmod 0600), and cached tokens |
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

## Full shopping surface

The CLI now covers every non-telemetry endpoint the Takealot app exposes (see
`docs/endpoints-catalogue.json` — the frozen manifest). Commands are `--json` throughout.

**Typed core** (nice human + rich JSON): `search`, `info <PLID>`, `cart` (+ `add --sku/--plid`,
`set-qty`, `remove`, `basket`, `clear`), `checkout` (dry-run shows delivery + card + total;
`--confirm` pays; `resume <orderId>` after 3DS).

**Passthrough** (raw API JSON under `--json`, compact summary otherwise): `deals`, `recommend`,
`buy-again`, `autocomplete`, `trending`, `reviews`, `orders …`, `returns …`, `refunds …`,
`wishlist …`, `credits …`, `cards …`, `address …`, `pickup-points`, `invoices …`, `plus …`
(Takealot Plus), `account …`, `myreviews …`, `help …` (incl. `help chat`).

### Safety contracts (important for agents)

- **Writes are dry-run by default.** Any state-changing command prints the exact request it
  *would* send and does nothing; add `--confirm` to perform it (`--yes` skips the TTY prompt).
  Example: `takealot address use A123` → dry run; `takealot address use A123 --confirm`.
- **Redaction on by default.** Secrets are masked in all output and errors; 3DS challenge URLs
  and signed invoice/PDF URLs are preserved so workflows still work. `--unsafe-raw` prints
  literal JSON (leaks secrets — avoid).
- **Identifiers are explicit:** `--sku` (buyable) vs `--plid` (listing); `cart set-qty`/`remove`
  take the buyable SKU id.
- **Checkout is idempotent:** an interrupted `--confirm` is reconciled (never re-charged); a 3DS
  challenge yields `{ "status": "action_required", "challengeUrl": … }` — open it, then
  `takealot checkout resume <orderId>`.

### Data-section writes (form → submit)

Some account/returns/subscription writes are server-defined forms. Two steps:

```bash
takealot account password form              # fetch + locally cache the form layout
# edit the JSON, keeping the section_id/field_id from the form
takealot account password submit --file filled.json --confirm
```

`submit` validates your section/field ids against the fetched form locally (rejecting foreign or
stale ids) before sending. Use `--file -` to read the payload from stdin.
