---
name: takealot
description: "Use when an agent must shop on Takealot.com or work with a Takealot account from the terminal. It covers search, prices, reviews, the cart, the checkout preview and wishlists. It also covers orders, tracking, invoices, returns, credits, cards, addresses and account data. The takealot CLI uses the Takealot mobile API, gives JSON output and makes every write a dry run first. It cannot place orders or pay. Use it also for short asks such as 'add this to my Takealot cart', 'what did I order' or 'is this in stock'. Use it for a pasted takealot.com link."
---

# takealot

`takealot` is a headless CLI for the Takealot mobile API. The agent can read and change most of the account. The CLI cannot place an order or pay. The owner pays in the Takealot app.

Install: `brew install yashiels/tap/takealot`. This skill describes version 0.7.2 or later. Run `takealot --version` to see the version.

## Safety contract

These rules come from the CLI. Plan every task around them.

1. The CLI blocks every order-placement, payment, 3DS, eBucks and Plus payment endpoint at the transport layer. No flag or file removes this block.
2. Every write is a dry run until you add `--confirm`. The dry run prints the exact request. Read it before you add `--confirm`.
3. `--yes` skips the terminal prompt only. It does not give permission. Permission comes from the owner (see Write policy).
4. `checkout` is a preview. `checkout --confirm` exits 4.
5. The CLI redacts secrets in its output. `cards` never shows card references, also with `--unsafe-raw`.

## Core workflow: build a basket

1. Find the product. Add `--json` to every command whose output you parse.

   ```bash
   takealot search "hb pencils" --limit 5 --json
   takealot info <plid> --json
   ```

   `info` returns `skuId` and `price`. If the listing has variants, `skuId` is null and `variants` lists the choices. Pick the correct variant. Do not guess.

2. Add the SKU. Do a dry run first, then confirm.

   ```bash
   takealot cart add --sku <skuId> --qty 1 --json
   takealot cart add --sku <skuId> --qty 1 --confirm --yes --json
   ```

   Use `--plid <plid>` only for a listing with one variant. The CLI rejects a listing with more than one variant (exit 4).

3. Read the cart and the checkout preview.

   ```bash
   takealot cart --json
   takealot checkout --json
   ```

4. Give the owner the items, `total`, `amountDue` and `sectionsIncomplete`. Tell him to pay in the Takealot app.

The owner uses the same cart for other shopping. Save `takealot cart --json` before a cart write. Compare it after the write.

## Price history

Use Serval to read the past prices of a product:

```bash
takealot price history <plid-or-url> --since 90d --json
```

Serval usually records one price each day, but the history can have gaps. The last price can be stale. Code `not_tracked` with exit 4 means that Serval does not track the product.

## Cart changes that remove or change lines

`cart remove <sku>` and `cart set-qty <sku> <n>` read the cart before and after the write.

- If the SKU is not in the cart, the command exits 4 and sends nothing.
- If a different line disappears or changes quantity, the command exits 1. The JSON output then has `unexpectedRemovals` and a restore command for each line.
- The command never restores lines. Run the printed restore commands yourself after you read the cart.

## Wishlists

Always give the list id to a typed add. Get the ids from `takealot wishlist list --json`.

```bash
takealot wishlist add <groupId> --sku <skuId> --confirm --yes
takealot wishlist move --from <groupId> --to <groupId> --tsin <tsin> --confirm --yes
takealot wishlist rm-items <groupId> --tsin <tsin> --confirm --yes
```

Moves and removals use the TSIN. Get it from `takealot wishlist items <groupId> --json`. Do not use `wishlist add --file` without a list id. That form writes to the list the account used last, and that list can be a different list.

## Write policy

Every `--confirm` needs a clear yes from the owner for that specific action. There are two exceptions:

- Reads and dry runs (no `--confirm`).
- Cart and wishlist changes that the owner asked for while you build a basket: `cart add`, `cart set-qty`, `cart remove`, `cart basket`, wishlist add and wishlist remove. A wishlist move is not in this exception.

`cart clear` needs a yes when the cart holds items that the owner did not ask for. Password, email and mobile writes, 2FA disable and trusted-device removal also need `--i-know` with `--confirm`. `--i-know` is a safety step, not permission.

Writes that need a yes include:

- address changes, `checkout start` and `checkout submit`
- `credits redeem` and card removal
- order cancel or reschedule, returns and refunds
- wishlist moves, Plus changes and invoice business details
- review writes and help-chat messages

## Output contract

Errors print JSON to stdout when you use `--json`:

```json
{ "error": "message", "code": "stable_error_code", "status": 400, "method": "POST", "path": "/rest/v-1-18-0/...", "details": {} }
```

`status`, `method`, `path` and `details` appear on API errors only. `details` contains the server message, code and field errors. The CLI masks email addresses and long numbers in it.

```text
exit 0  success or dry run
exit 1  runtime or API failure
exit 3  authentication or OTP failure
exit 4  usage error, blocked action, or a state that makes the request impossible
```

Code `unavailable_state` (exit 4) tells you that the account state blocks the request. An example is a Plus read on an account without Plus. This result is correct for that account. It is not a CLI fault.

## References

- See `references/commands.md` for all command groups: product, recommendations, cart, checkout, orders, invoices, returns, wishlists, account, Plus, help.
- See `references/auth.md` for login, the OTP flow, unattended credentials and the device profile.
