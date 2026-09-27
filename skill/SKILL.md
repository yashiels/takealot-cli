---
name: takealot
description: Use when shopping or managing a Takealot account from the terminal. Search, browse, cart, preview checkout, orders, tracking, invoices, returns, wishlist, credits, Plus, cards, and account operations through a headless API CLI with device-trust auth, JSON output, and dry-run writes; order placement and payment are blocked.
---

# takealot skill

Use `takealot` for Takealot catalogue and account work without a browser. The agent has broad account access, but the CLI cannot place orders or pay. Hand the owner the checkout preview and tell him to pay in the Takealot app.

## Install

```bash
brew install yashiels/tap/takealot
```

Every data command supports `--json`. Prefer JSON when selecting products or passing results between tools.

## Authentication

Credentials, rotating tokens, and the device record are stored in `~/.config/takealot-cli/credentials.json` with mode `0600`. Tokens refresh automatically. The CLI replays Takealot's server-assigned `did` as the `TAL-Did` header and `did` cookie on authenticated requests.

Complete 2FA once with device trust enabled. Later logins, including full re-login after token expiry, normally skip OTP while the stored device identity remains trusted.

For unattended use, inject credentials through the environment:

```bash
TAKEALOT_EMAIL="$(op-sa read op://Agents/takealot/username)" \
TAKEALOT_PASSWORD="$(op-sa read op://Agents/takealot/password)" \
  takealot cart --json
```

For a first-time or untrusted device, use the two-step OTP flow:

1. Trigger the challenge:

   ```bash
   takealot login --json
   # {"status":"otp_required","challenge":"<nonce>","otpSentTo":"…","expiresInSec":300}
   ```

2. Ask the owner for the code, then submit it with the returned challenge:

   ```bash
   TAKEALOT_OTP=123456 TAKEALOT_CHALLENGE=<nonce> takealot login --json
   ```

The CLI carries the first response's `__cf_bm` cookie into the OTP request. Prefer environment variables because `--otp` and `--challenge` can remain in process listings or shell history.

JSON auth errors include `otp_required`, `otp_state_mismatch`, and `otp_expired`. Re-run the first login step after expiry. Never run `login --reset` unattended because it needs credential input. Use separate `XDG_CONFIG_HOME` directories for different accounts on one machine.

New credentials use Android app 4.3.0, build 800751. Existing credentials keep their persisted device profile to avoid de-trusting the device. To adopt the current default deliberately, delete only `device.profile` from the stored credentials.

## Core workflow

1. Search or inspect a listing.
2. Add a buyable SKU to the cart.
3. Read the cart and checkout preview.
4. Give the preview to the owner and tell him to pay in the Takealot app.

```bash
takealot search "coffee beans" --limit 5 --json
takealot info 52341565 --json
takealot cart add --plid 52341565
takealot cart --json
takealot checkout --json
```

`cart add --plid` resolves product detail to its buyable SKU before printing the dry run. A multi-variant listing without a single SKU is rejected with the available variants; choose the correct variant rather than guessing. Use `--sku` when the exact buyable id is already known.

`checkout` is read-only. It returns items, subtotal, discounts, credits, total, `amountDue`, shipping method, `sectionsIncomplete`, and `payInApp: true`. It never places the order. Order-completion and payment endpoints are blocked at the transport boundary.

## Commands

### Search and product detail

```bash
takealot search <query> [--limit <n>] [--json]
takealot autocomplete --query query=<text>
takealot trending
takealot deals
takealot info <plid> [--credit-options] [--bundle <ids>] [--card] [--reviews]
takealot reviews <plid> [--page <n>] [--sort <key>]
```

### Recommendations

```bash
takealot recommend layout [--location home-page]
takealot recommend <location> --model <key> [--limit 10]
takealot recommend layout --location pdp --plid <plid>
takealot recommend pdp --plid <plid> --model <key> [--limit 10]
takealot buy-again
```

Run `recommend layout` first to obtain model keys. Supported locations are `home-page`, `add-to-cart`, `landing-page`, `domain`, and `pdp`. `pdp` needs `--plid` (sent as `context=PLID:<n>`); take the model key from `recommend layout --location pdp --plid <plid>`.

### Cart

```bash
takealot cart
takealot cart add "3 pencils"
takealot cart add --sku <id> --qty <n>
takealot cart add --plid <id> --qty <n>
takealot cart set-qty <sku> <n>
takealot cart remove <sku>
takealot cart basket "milk; bread; eggs"
takealot cart clear
```

Writes are dry runs without `--confirm`. `cart remove` and `cart set-qty` refuse a SKU that is not in the cart (exit 4), read the cart before and after the write, and exit 1 with `unexpectedRemovals` plus restore commands if any other line disappeared or changed quantity. They never restore automatically; run the printed commands only after checking. Text search uses the preference engine: exact prior purchase, prior brand in category, configured preferred brand, then title similarity.

### Checkout, cards, and credits

```bash
takealot checkout
takealot checkout start [--file <json>]
takealot checkout submit --file <json>
takealot cards
takealot cards rm --last4 <dddd>
takealot credits
```

`checkout start` and `checkout submit` can update checkout delivery or pickup selections; they are dry-run writes and do not place an order. `cards` returns bank, scheme, last four digits, expiry, selected state, and enabled state. It never returns card references, including with `--unsafe-raw`. Card removal resolves the hidden reference from `--last4` and requires exactly one match.

### Orders and invoices

```bash
takealot orders [--limit <n>]
takealot orders show <id>
takealot orders track <id>
takealot invoices <orderId>
takealot invoices pdf <orderId> <invoiceId>
takealot invoices creditnote-pdf <orderId> <creditnoteId>
```

Invoice commands accept the numeric id printed by `orders`. The CLI searches order history and resolves it to `obfuscated_order_id` before calling invoice, credit-note, request, or business-detail paths.

### Wishlists

```bash
takealot wishlist list
takealot wishlist items <groupId>
takealot wishlist add <groupId> --sku <id> [--sku <id> ...]
takealot wishlist add <groupId> --plid <plid>
takealot wishlist move --from <groupId> --to <groupId> --tsin <tsin> [--tsin <tsin> ...]
takealot wishlist rm-items <groupId> --tsin <tsin> [--tsin <tsin> ...]
```

Always pass the group id to typed adds; the CLI refuses to guess. `wishlist add --file <json>` without a group writes to whichever list the account used last, so avoid it. Moves and removals are keyed by TSIN, read from `wishlist items <groupId> --json`. Ids are validated before sending (positive integers, SKU/TSIN/PLID of at least 4 digits). The legacy `wishlist add group <groupId> --file <json>` form still works.

### Help

```bash
takealot help search "<query>" [--autocomplete]
takealot help context <slug>
```

### Full account surface

The catalogue also exposes addresses and pickup points, returns and refunds, wishlists, credits and vouchers, Takealot Plus non-payment operations, account and security, personal reviews, and help/chat. Run `takealot --help` and group-level `--help` for the generated commands.

Takealot Plus reads (`plus cancel form`, `plus claim-discount form`, `plus manage plan`) exit 4 with code `unavailable_state` when the account has no active subscription. That is the expected answer for a non-subscriber, not a CLI fault.

Some writes use a server-provided form followed by a submit:

```bash
takealot account password form
takealot account password submit --file filled.json --confirm --i-know
```

The CLI caches the fetched form and rejects foreign or stale section and field ids. Use `--file -` for stdin.

## Write policy

- State-changing commands are dry runs by default. Add `--confirm` to write and `--yes` to skip a TTY confirmation.
- Password, email, mobile, 2FA-disable, and trusted-device removal writes require `--i-know` together with `--confirm`.
- The CLI cannot place orders or pay. Hand the owner the checkout preview and tell him to pay in the app.
- Payment, order-completion, 3DS, eBucks payment, and Takealot Plus payment or plan-change paths are blocked even if called indirectly.

### Writes that need the owner's explicit OK

Default rule: every `--confirm` needs an explicit yes from the owner for that specific action. This includes anything not listed below as an exception, for example `address use`, `checkout submit`/`start`, `credits redeem`, help-chat messages, account-security changes, card removal, order cancel/reschedule, returns and refunds, address writes, Plus changes, invoice business details, and review writes. `--i-know` is a safety acknowledgement, not authorization.

Exceptions (no per-action OK needed):

- Cart and wishlist changes the owner asked for while building a basket (`cart add`, `cart set-qty`, `cart remove`, `cart basket`, wishlist add/remove). `cart clear` still needs an OK when the cart holds items the owner did not ask for.
- Read commands and dry runs (no `--confirm`).

## Output contract

JSON failures are written to stdout:

```json
{
  "error": "message",
  "code": "stable_error_code",
  "status": 400,
  "method": "POST",
  "path": "/rest/v-1-18-0/customers/<id>/cart/items",
  "details": { "message": "...", "errors": [{ "field": "...", "message": "..." }] }
}
```

`status`, `method`, `path`, and `details` appear on API errors. `details` is an allowlist of the server's message, code, and field errors with emails and long digit runs masked. `--verbose` also logs each failing request line.

| Exit | Meaning                                          |
| ---- | ------------------------------------------------ |
| `0`  | Success or dry run                               |
| `1`  | Runtime or API failure                           |
| `3`  | Authentication or OTP failure                    |
| `4`  | Invalid usage or blocked order/payment operation |

Output is recursively redacted. `--unsafe-raw` is only for deliberate debugging and never reveals card references through `cards`.
