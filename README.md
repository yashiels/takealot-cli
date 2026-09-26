# 🛒 takealot-cli

**The Takealot store from your terminal, built for headless agents.**

[![CI](https://github.com/yashiels/takealot-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/yashiels/takealot-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/yashiels/takealot-cli)](https://github.com/yashiels/takealot-cli/releases/latest)

Search and browse, manage a cart and account, preview checkout, read orders and invoices, handle returns, and use the rest of Takealot's non-payment app surface from the command line. The CLI talks directly to the Android mobile API. It has no browser dependency.

The agent can use the full account surface exposed by the CLI, but it cannot place orders or pay. `checkout` is a read-only preview of the amount due and incomplete sections. Give that preview to the account owner, who completes payment in the Takealot app.

Every data command supports `--json`.

![takealot demo](docs/assets/hero.svg)

## Install

```bash
brew install yashiels/tap/takealot
```

Or download a standalone binary from the [latest release](https://github.com/yashiels/takealot-cli/releases/latest).

Build from source with Node 18 or later:

```bash
git clone https://github.com/yashiels/takealot-cli.git
cd takealot-cli
npm install
npm run build
npm link
```

## Quick start

```bash
takealot search "protein powder" --json
takealot login
takealot info 52341565
takealot cart add --plid 52341565
takealot cart
takealot checkout
```

`cart add --plid` fetches product detail and resolves the listing to a buyable SKU even during a dry run. If the listing has variants and no single SKU, it asks you to choose a variant instead of guessing.

## Authentication and device trust

Credentials and tokens are cached automatically. The CLI persists Takealot's server-assigned device id (`did`) with the Android profile and replays it on every authenticated request. Once 2FA succeeds with device trust enabled, later logins normally skip the OTP.

Environment credentials override the stored pair:

```bash
TAKEALOT_EMAIL="$(op-sa read op://Agents/takealot/username)" \
TAKEALOT_PASSWORD="$(op-sa read op://Agents/takealot/password)" \
  takealot cart --json
```

An untrusted device uses a two-step, non-interactive OTP flow:

```bash
takealot login --json
# {"status":"otp_required","challenge":"<nonce>","otpSentTo":"…","expiresInSec":300}

TAKEALOT_OTP=123456 TAKEALOT_CHALLENGE=<nonce> takealot login --json
```

The second request reuses the `__cf_bm` cookie from the challenge response. Prefer the environment variables because command-line OTP flags can leak through shell history or the process list. Do not run `login --reset` unattended; it requires credential input.

The default profile for new credentials is Takealot Android 4.3.0, build 800751. An existing `credentials.json` keeps its stored device profile so its trusted-device identity does not change. Delete only the stored `device.profile` field if you deliberately want the current default recreated.

## Command overview

All data commands accept `--json`. Use `--help` on a command group for its full generated surface.

| Area | Commands |
|------|----------|
| Find | `search <query> [--limit]` · `autocomplete` · `trending` · `deals` · `info <plid> [--credit-options\|--bundle\|--card\|--reviews]` |
| Reviews | `reviews <plid> [--page <n>] [--sort <key>]` · `myreviews …` |
| Recommend | `recommend layout [--location home-page]` · `recommend <location> --model <key> [--limit 10]` · `buy-again` |
| Cart | `cart` · `cart add <query>` · `cart add --sku <id>` · `cart add --plid <id>` · `cart set-qty` · `cart remove` · `cart basket` · `cart clear` |
| Checkout | `checkout` (read-only preview) · `checkout start` · `checkout submit --file <json>` for delivery or pickup selections |
| Cards and credits | `cards` (never exposes card references) · `cards rm --last4 <dddd>` · `credits …` |
| Orders | `orders` · `orders show <id>` · tracking/cancellation/rescheduling commands · `invoices <orderId>` and its PDF, request, credit-note, and business-detail variants |
| Account | addresses, returns, refunds, wishlist, Plus, account/security, help/chat, config, and preferences command groups |

`recommend layout` returns model keys for `recommend <location> --model`. The supported locations are `home-page`, `add-to-cart`, `landing-page`, and `domain`; `pdp` is rejected because the API does not currently support it.

`invoices <orderId>` accepts the numeric order id shown by `orders`; the CLI resolves it to Takealot's obfuscated order id before calling invoice endpoints.

### Writes and account-security changes

State-changing commands are dry runs unless you pass `--confirm`. Add `--yes` to skip an interactive confirmation. Agents must get the owner's explicit OK for the specific consequential or account-security action before using `--confirm`; `--i-know` is a safety flag, not authorization. Account-security writes that can lock out the owner also require `--i-know`, including password, email, mobile number, 2FA-disable, and trusted-device removal operations.

```bash
takealot address use A123
takealot address use A123 --confirm
takealot account password submit --file filled.json --confirm --i-know
```

Some writes use a server-defined form followed by a submit:

```bash
takealot account password form
takealot account password submit --file filled.json --confirm --i-know
```

The submit payload is checked against the fetched form before it is sent. Use `--file -` to read JSON from stdin.

## Checkout and payment boundary

`takealot checkout` performs a read-only checkout fetch and returns items, subtotal, discounts, credits, total, amount due, shipping method, and `sectionsIncomplete`, with `payInApp: true` in JSON. Human output ends with `Pay in the Takealot app.`

The CLI never creates an order and never pays. Order-completion, card-payment, 3DS, eBucks payment, and Takealot Plus payment or plan-change endpoints are blocked in the API transport. Passing the removed `checkout --confirm` option is refused before a network call.

## Output and errors

Machine-readable failures use this envelope on stdout:

```json
{
  "error": "human-readable message",
  "code": "stable_error_code",
  "status": 400
}
```

`status` is present when an HTTP status is available.

| Exit | Meaning |
|------|---------|
| `0` | Success, including a dry run |
| `1` | Runtime or API failure |
| `3` | Authentication or OTP failure |
| `4` | Usage error or blocked order/payment attempt |

## Safety

- The transport permits only the exact `https://api.takealot.com` origin and rejects redirects, unsafe URLs, and blocked order/payment paths.
- Output is recursively redacted by default. `--unsafe-raw` is for debugging, but `cards` still never returns card references.
- Product listing ids (`PLID`) and buyable SKU ids are distinct; the CLI does not substitute one for the other.
- No browser, Playwright, or Puppeteer is used.

## Configuration

Files live under `~/.config/takealot-cli/`, respecting `$XDG_CONFIG_HOME`:

| File | Contents |
|------|----------|
| `config.json` | API and user-agent overrides plus preferred brands |
| `credentials.json` | Email, password, cached tokens, and device record (`did` plus profile), mode `0600` |
| `preferences.json` | Order-history preference cache |
| `pending-otp-*.json` | Short-lived OTP challenge state, mode `0600` |

Writes are atomic and credentials updates are serialized across processes.

## Preference engine

Text-based `cart add` ranks exact prior purchases first, then brands bought in the same category, configured preferred brands, and finally title similarity. Seed it after login:

```bash
takealot preferences refresh
```

## Development

```bash
make ci
make build
make test
```

Releases are automated by the Ship workflow, which bumps release versions, builds standalone binaries, publishes a GitHub Release, and updates the Homebrew tap.

## Disclaimer

Not affiliated with or endorsed by Takealot.com (Pty) Ltd. This tool calls private, undocumented APIs reverse-engineered from the Takealot Android app; they may change without notice. Use it only on your own account.

## License

MIT — [Yashiel Sookdeo](https://github.com/yashiels)
