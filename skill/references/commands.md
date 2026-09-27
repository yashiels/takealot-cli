# takealot commands

All commands accept `--json` and `--verbose`. Writes accept `--confirm` and `--yes`. Run `takealot <group> --help` for the flags of one command. Find ids as follows:

- `plid`: the number after `PLID` in a takealot.com link.
- `skuId`: from `info --json` or `search --json`.
- `tsin`: from `wishlist items --json`.
- Order id: from `orders --json`.

## Contents

- Product and search
- Recommendations
- Cart
- Checkout, cards and credits
- Orders and invoices
- Returns and refunds
- Wishlists
- Addresses
- Account and reviews
- Takealot Plus
- Help
- Other

## Product and search

```bash
takealot search "<query>" [--limit <n>]
takealot autocomplete --query query=<text>
takealot trending
takealot deals
takealot info <plid> [--card] [--reviews] [--credit-options] [--bundle <ids>]
takealot reviews <plid> [--page <n>] [--sort <key>]
takealot price history <product> [--since <window>] [--series] [--no-cache]
```

If the price data is missing, `info` tries again one time. If it is still missing, `price` and `skuId` are null and `unavailableReason` gives the cause. `cart add --plid` then stops with exit 1.

The `price history` command reads data from Serval. Serval usually records one price each day, but the history can have gaps. The last price can be stale. Code `not_tracked` with exit 4 means that Serval does not track the product.

## Recommendations

```bash
takealot recommend layout [--location <location>] [--plid <plid>]
takealot recommend <location> --model <key> [--limit <n>] [--plid <plid>]
takealot buy-again
```

Locations: `home-page`, `add-to-cart`, `landing-page`, `domain`, `pdp`. Get the model key from `recommend layout` first. The `pdp` location needs `--plid`.

## Cart

```bash
takealot cart
takealot cart add --sku <skuId> [--qty <n>]
takealot cart add --plid <plid> [--qty <n>]
takealot cart add "<text>"
takealot cart basket "milk; bread; eggs"
takealot cart set-qty <skuId> <n>
takealot cart remove <skuId>
takealot cart clear
```

A text add uses the preference engine. The engine picks the first match in this order:

1. An item that the owner bought before.
2. A brand that the owner bought in that category.
3. A brand from the settings.
4. The closest title.

Read the result in the dry run before you add `--confirm`. `takealot preferences show` lists the cache. `takealot preferences refresh` builds it again from order history.

## Checkout, cards and credits

```bash
takealot checkout
takealot checkout start [--file <json>]
takealot checkout submit --file <json>
takealot cards
takealot cards rm --last4 <dddd>
takealot credits
takealot credits redeem --file <json>
```

`checkout` shows items, totals, `amountDue`, the shipping method, `sectionsIncomplete` and `payInApp: true`. `checkout start` and `checkout submit` change delivery or pickup choices only. They cannot place an order. `cards rm` needs exactly one card that matches `--last4`.

## Orders and invoices

```bash
takealot orders [--limit <n>]
takealot orders show <orderId>
takealot orders track <orderId>
takealot invoices <orderId>
takealot invoices pdf <orderId> <invoiceId>
takealot invoices creditnote-pdf <orderId> <creditnoteId>
```

Invoice commands accept the number that `orders` prints. The CLI finds the internal order id for you. `orders` also has `cancel`, `reschedule`, `request-cancel` and `consignment-cancel`. These are writes that need the owner's yes.

## Returns and refunds

```bash
takealot returns orders
takealot returns track <returnId>
takealot returns pickup-points
takealot refunds
takealot refunds show <refundId>
```

`returns pickup-points` needs an open return checkout. Without one, the request can fail with a server error. All return and refund writes need the owner's yes.

## Wishlists

```bash
takealot wishlist list
takealot wishlist items <groupId>
takealot wishlist mk --file <json>
takealot wishlist add <groupId> --sku <skuId> [--sku <skuId> ...]
takealot wishlist add <groupId> --plid <plid>
takealot wishlist move --from <groupId> --to <groupId> --tsin <tsin> [--tsin <tsin> ...]
takealot wishlist rm-items <groupId> --tsin <tsin> [--tsin <tsin> ...]
```

The CLI checks ids before it sends a request. An id must be a positive integer. A SKU, TSIN or PLID must have 4 digits or more. `--from` and `--to` must be different lists. The old form `wishlist add group <groupId> --file <json>` still works.

## Addresses

```bash
takealot address list
takealot address config
takealot address add submit --file <json>
takealot address update submit <addressId> --file <json>
takealot address use --file <json>
takealot address rm <addressId>
takealot pickup-points
```

Every address write needs the owner's yes.

## Account and reviews

```bash
takealot account summary
takealot account personal
takealot account group form <groupId>
takealot account security
takealot account activity
takealot account trusted-devices
takealot myreviews list
takealot myreviews reviewable
```

Group ids are names, for example `personal`. Some writes use a form from the server and then a submit:

```bash
takealot account password form
takealot account password submit --file filled.json --confirm --i-know
```

The CLI saves the form and rejects section or field ids that are not in it. Use `--file -` to read from stdin. Password, email and mobile writes, 2FA disable and trusted-device removal need `--i-know` with `--confirm`.

## Takealot Plus

```bash
takealot plus plans
takealot plus history
takealot plus savings
takealot plus manage plan
takealot plus cancel form
takealot plus claim-discount form
```

An account without Plus gets code `unavailable_state` (exit 4) from `manage plan`, `cancel form` and `claim-discount form`. The CLI blocks Plus payments and plan changes.

## Help

```bash
takealot help topics
takealot help search "<query>" [--autocomplete]
takealot help context <slug>
takealot help chat ...
```

Help-chat messages are writes. They need the owner's yes.

## Other

```bash
takealot config show
takealot config app-version
takealot cms page <slug>
takealot cms route <link>
takealot orders --help
```

Run `takealot --help` for every group. Each group has `--help`.
