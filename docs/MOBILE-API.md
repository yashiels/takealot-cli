# Takealot Mobile API Reference (MITM Captured 2026-02-22)

Authenticated mobile API: `https://api.takealot.com/rest/v-1-18-0`
Search API: `https://api.takealot.com/rest/v-1-14-0`
User-Agent: `TAL-Android/4.3.0 (fi.android.takealot; build:800751; 14; samsung; SM-S928B; Phone)`
Auth: `Authorization: Bearer {jwt}` + cookies: `taid={id_token}; tal_jwt={jwt}; tal_csrf={csrf_token}; did={did}`

## 4.3.0 notes

App 4.3.0 uses build 800751 and keeps the authenticated API at `v-1-18-0`.

- Public reviews use `product-reviews/plid/{plid}` with the bare numeric PLID plus `page` and optional `sort` query parameters.
- Recommendations require `model` and `display_type=product`. `recommendations/home-page/layout` returns the model keys to use for home-page recommendations.
- Invoice, credit-note, and invoice business-detail paths take `obfuscated_order_id`; the CLI resolves a displayed numeric order id through order history first.
- Product detail reads the buyable from `buybox.items[0]` and falls back to `event_data.documents.product`; multi-variant listings expose choices under `variants.selectors[].options[]` and may have no single SKU.
- The API contains order-completion and payment paths, but this CLI blocks them at its transport boundary. Checkout is a read-only preview and the account owner pays in the Takealot app.

## Auth

### Login

```
POST /customers/login
Content-Type: application/json

{"platform":"android","sections":[{"section_id":"customer_login","fields":[{"field_id":"email","value":"..."},{"field_id":"password","value":"..."},{"field_id":"captcha","value":""}]}]}
```

**Response:** `auth_info.{id_token, jwt, refresh_token, csrf_token, tracking_id, customer_id, id_token_expires, access_key, private_key, did}`

### Login with Two-Step Verification (2FA)

When the account has 2FA enabled, the login flow is two requests:

**Request 1 — Submit credentials:**

```
POST /customers/login
Content-Type: application/json

{"platform":"android","sections":[{"section_id":"customer_login","fields":[{"field_id":"email","value":"..."},{"field_id":"password","value":"..."},{"field_id":"captcha","value":""}]}]}
```

**Response (2FA challenge):**

```json
{
  "two_step_verification": "enabled_untrusted",
  "otp_status": { "remaining_retries": 2, "status": "unverified", "valid_millis": 300000 },
  "data_sections": [
    { "section_id": "customer_login", "is_complete": true },
    {
      "section_id": "two_step_verification",
      "data_fields": [
        { "field_id": "otp", "title": "Enter OTP" },
        { "field_id": "trust_this_device", "data_type": "boolean" }
      ]
    }
  ]
}
```

The response also sets a `__cf_bm` Cloudflare cookie that MUST be included in the second request.

**Request 2 — Submit OTP:**

```
POST /customers/login
Content-Type: application/json
Cookie: __cf_bm=...

{"platform":"android","sections":[
  {"section_id":"customer_login","fields":[{"field_id":"email","value":"..."},{"field_id":"password","value":"..."},{"field_id":"captcha","value":""}]},
  {"section_id":"two_step_verification","fields":[{"field_id":"otp","value":"12345"},{"field_id":"trust_this_device","value":true}]}
]}
```

**Response:** Same `auth_info` as non-2FA login.

**Note:** Each credential-only POST to /customers/login initiates a new 2FA challenge. Submit the OTP from the first response's OTP challenge only. The OTP is valid for 5 minutes (`valid_millis: 300000`).

### Refresh Token

```
POST /customers/auth/refresh
Authorization: Bearer {jwt}
Content-Type: application/json

{"platform":"android","refresh_token":"{refresh_token}","tracking_id":"{tracking_id}"}
```

**Response:** Same token set as login. New `jwt`, `id_token`, `refresh_token`, `csrf_token`.
**Token lifecycle:** `jwt` expires in ~1hr (`max_age:3600`). `id_token` expires in ~30 days. `refresh_token` expires in ~31 days.

## Search

### Autocomplete

```
GET /search/autocomplete?query={q}&include_pages=true
```

### Full Search

```
GET /searches/layout,products,facets,filters,sort_options,product_count,suggested_filters,related_searches?customer_id={cid}&qsearch={q}&client_id={uuid}&platform=android&offer_opt=true
```

### Trending

```
GET /search/trending?platform=android&limit=10
```

**Search response shape** (`sections.products`):

- Result count is `sections.products.paging.total_num_found` (NOT `sections.products.total`, which does not exist).
- Each result: `product_views.{core, buybox_summary}`.
  - `core.id` — the **PLID** (used in `/PLID{id}` links and product-card). Build a link as `www.takealot.com/{core.slug}/PLID{core.id}`.
  - `buybox_summary.product_id` — the **buyable/SKU id** (what add-to-cart wants). It is a _different_ number from `core.id`; `/PLID{buybox.product_id}` 404s.
  - Prices (`buybox_summary.prices[]`, `pretty_price`) are in **Rand**.
  - `core.reviews` — review count (there is no `core.review_count`). `core.star_rating` — rating.
  - `buybox_summary.saving` — pre-formatted discount string (e.g. `"23%"`); no `discount_percentage` field exists.
  - Stock: `product_views.stock_availability_summary.status` / `.is_in_stock`; delivery text at `.estimated_delivery.estimated_dates`.

## Products

### Product Details

```
GET /product-details/PLID{plid}?platform=android&show_takealot_now_alt=false&offer_opt=true
```

**Response:** The buyable product is in `buybox.items[0]`:

- `sku`, `price`, `pretty_price`, `is_add_to_cart_available`, and `stock_availability.status`
- `buybox.tsin`
- Fallback fields at `event_data.documents.product.{sku_id, in_stock, purchase_price}`
- Variant choices at `variants.selectors[].options[]`

Multi-variant listings may not have a single SKU until a variant is chosen; the CLI returns `skuId: null` and exposes the available options instead of guessing.

### Product Card (lightweight)

```
GET /product-card/PLID{plid}?offer_opt=true
```

## Cart

### Add to Cart

```
POST /customers/{customer_id}/cart/items
Authorization: Bearer {jwt}
Content-Type: application/json

{"products":[{"id":{sku_id},"quantity":1}]}
```

**Response:** Cart contents with totals.

### Get Cart

```
GET /customers/{customer_id}/cart
Authorization: Bearer {jwt}
```

**Response:** carries two parallel arrays keyed by `product_id`, and neither alone is sufficient — **join them on `product_id`**:

- `products[]` — `product_id` (SKU id), `plid` (`"PLID{n}"` string — the real PLID for links), `title`, `selling_price` (unit, in **Rand**), `original_price`.
- `cart_items[]` — `product_id`, `quantity`, `sub_total` (line total, Rand), `allocations[].unit_price`.
- Cart total: `cart_summary.total.value` (Rand). `total`/`sub_total` at the top level mirror it. There is no `total_amount`.

## Checkout

### Read-only preview

```
GET /checkout/{customer_id}
Authorization: Bearer {jwt}
```

**Response:** `summary` contains subtotal, discounts, credits, total, and amount due. `data_sections[]` identifies incomplete shipping, address, delivery, or other selections. The CLI returns this as a typed preview with `payInApp: true`.

### Checkout selections

`POST /checkout/{customer_id}` starts or refreshes checkout state. `PUT /checkout/{customer_id}` submits delivery or pickup selections. Both commands use the normal dry-run/`--confirm` write gate. Neither endpoint places an order.

### Blocked order and payment paths

Order completion, order payment, payment completion, payhost, eBucks payment, and Takealot Plus payment or plan-change endpoints remain in the catalogue as excluded rows. `PAYMENT_BLOCKED` and the client's `send()` transport guard reject them before a network request. The CLI does not implement payment redirects or 3DS; the account owner pays in the Takealot app.

### Saved cards

`GET /customers/card` is available, but the CLI returns only bank, scheme, last four digits, expiry, selected state, and enabled state. It never exposes card references. `cards rm --last4` resolves the hidden reference internally and requires exactly one match.

## Other Endpoints

### Customer Summary

```
GET /customers/{customer_id}/summary
```

### Order History

```
GET /customer/{customer_id}/orders?period=all&page_number=0
```

Also accepts `from`/`to`/`page_size`. Paging is **0-indexed**; iterate `page_number` until `response.orders` is empty.

**Response:** orders are at `response.orders[]`. Each order:

- Money (`total_amount`, `subtotal`, `unit_price`, `line_total`, …) is in **Rand**, not cents.
- No `status` field — derive from booleans `is_fully_cancelled`, `is_awaiting_payment`, `is_authorized` / `auth_status`.
- Line items: `consignments[].order_items[]`, each with `product_id` (SKU id), `unit_price`, `quantity`, and `sku.plid` (`"PLID{n}"` — the real PLID for links).

### Wishlists

Wishlist writes use the request DTOs from the Android 4.3.0 app. Group ids, SKU ids, and TSINs are integers.

| Operation                             | Endpoint                                                         | JSON body                                                                |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| List groups                           | `GET /customers/{customer_id}/wishlists`                         | none                                                                     |
| Summary                               | `GET /customers/{customer_id}/wishlists/summary`                 | none                                                                     |
| Create group                          | `POST /customers/{customer_id}/wishlists`                        | `{"name":"Wish List"}`                                                   |
| Rename group                          | `PUT /customers/{customer_id}/wishlists/{group_id}`              | `{"name":"New name"}`                                                    |
| Delete group                          | `DELETE /customers/{customer_id}/wishlists/{group_id}`           | none                                                                     |
| List group items                      | `GET /customers/{customer_id}/wishlists/{group_id}/items`        | none                                                                     |
| Add by SKU                            | `POST /customers/{customer_id}/wishlists/{group_id}/items`       | `{"products":[{"sku":82448522}]}`                                        |
| Add by TSIN                           | `POST /customers/{customer_id}/wishlists/{group_id}/items`       | `{"products":[{"tsin":104146086}]}`                                      |
| Add to last-used group by SKU or TSIN | `POST /customers/{customer_id}/wishlists/last_used/items`        | `{"products":[{"sku":82448522}]}` or `{"products":[{"tsin":104146086}]}` |
| Move items                            | `PUT /customers/{customer_id}/wishlists/items/move`              | `{"from":2181365,"to":[27948686],"products":[{"tsin":104146086}]}`       |
| Replace SKU group membership          | `PUT /customers/{customer_id}/wishlists/items/pid/{sku_id}`      | `{"reset":false,"groups":[2181365]}`                                     |
| Replace TSIN group membership         | `PUT /customers/{customer_id}/wishlists/items/tsin/{tsin_id}`    | `{"reset":false,"groups":[2181365]}`                                     |
| Remove by SKU                         | `DELETE /customers/{customer_id}/wishlists/items/pid/{sku_id}`   | none                                                                     |
| Remove by TSIN                        | `DELETE /customers/{customer_id}/wishlists/items/tsin/{tsin_id}` | none                                                                     |
| Bulk remove                           | `DELETE /customers/{customer_id}/wishlists/{group_id}/items`     | `{"products":[{"tsin":104146086}]}`                                      |
| Shared group                          | `GET /customers/wishlists/{shared_group_id}`                     | none                                                                     |
| Recommendations                       | `GET /recommend/wishlist`                                        | none                                                                     |
| Recommendations for PLIDs             | `GET /recommend/wishlist/{plids}`                                | none                                                                     |

The web bundle also uses `PUT /customers/{customer_id}/wishlists/items/tsin/{tsin_id}/move` with `{"from":2181365,"to":27948686}`. This endpoint is absent from the Android 4.3.0 Retrofit interface, so the catalogue records it as an excluded web-only row rather than exposing it through the mobile CLI.

Typed writes avoid hand-authored payloads: `wishlist add <groupId> --sku N`, `wishlist add <groupId> --plid P`, `wishlist move --from G --to G --tsin N`, and `wishlist rm-items <groupId> --tsin N`. Repeat `--sku` or `--tsin` for multiple products. Each command accepts `--file` as an alternative and uses the normal dry-run/`--confirm` gate.
For compatibility, `wishlist add --file payload.json` without a group id still targets the last-used group.

### Credits Balance

```
GET /customers/{customer_id}/credits/balance
```

## Key Notes

0. **All money values are in Rand, not cents** — do not divide by 100. (`unit_price: 102` == R102; cart total `833` == R833.)
   0b. **Two ids per product** — the **PLID** (`core.id` in search, `plid`/`sku.plid` in cart & orders) is for links and product-card/product-details; the **SKU id** (`buybox_summary.product_id` in search, `buybox.items[0].sku` in product details, and cart/order `product_id`) is for add-to-cart. They are different numbers and are not interchangeable.
   0c. **Device trust rides on a persistent, server-assigned `did`.** The app has no request signing (the `access_key`/`private_key` in the login response are unused for signing). The one authorization interceptor adds exactly `Authorization: Bearer`, `X-Csrf-Token`, and **`TAL-Did: {did}`** to every authenticated request. The `did` is issued by the server (via `Set-Cookie: did=…`, and echoed in `auth_info.did`), persisted, and sent back — as the `TAL-Did` header **and** the `did` cookie — on **every** request including login and refresh. Completing 2FA once with `trust_this_device:true` marks that `did` trusted, so later logins presenting it **skip the OTP challenge**. The CLI therefore: generates nothing locally; captures the `did` from both `Set-Cookie` and the body (cookie wins on conflict); persists it at device scope (survives a token clear); and replays it on every request. This is what makes headless re-login work without a fresh OTP.
1. **Authenticated requests use the mobile API and User-Agent; the 2FA handshake requires the \_\_cf_bm cookie returned by the first login response**
2. **JWT expires in 1 hour** — use refresh_token to get new jwt before expiry
3. **refresh_token rotates** — each refresh returns a new refresh_token (old one invalidated)
4. **Order placement and payment are blocked in this CLI** — use the read-only preview, then pay in the Takealot app

---

## Full endpoint catalogue

The complete, machine-readable list of every endpoint the app exposes (extracted from APK
v4.2.2; paths re-checked against the v4.3.0 Retrofit surface, build 800751, API v-1-18-0, and live-verified for the commands exercised in PR2) lives in
**`docs/endpoints-catalogue.json`** — one row per endpoint with
`{domain, method, path, auth, encoding, mutating, excluded, command}`. It is the source of truth
for the CLI's coverage: a contract test drives every non-excluded row and asserts the exact
request. The catalogue has 198 rows: 170 active command endpoints and 28 excluded rows, including
22 order/payment paths plus telemetry, ads, internal token refresh, and the documented web-only wishlist move. API base for authenticated
calls: `v-1-18-0`.
