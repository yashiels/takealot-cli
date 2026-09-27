# Takealot mobile API reference

First captured with a MITM proxy on 2026-02-22. Checked again against the Android app 4.3.0.

Authenticated mobile API: `https://api.takealot.com/rest/v-1-18-0`
Search API: `https://api.takealot.com/rest/v-1-14-0`
User-Agent: `TAL-Android/4.3.0 (fi.android.takealot; build:800751; 14; samsung; SM-S928B; Phone)`
Auth: the `Authorization` bearer header with the JWT, plus `X-Csrf-Token` and `TAL-Did` when a CSRF token and a `did` exist. Cookies: `tal_jwt={jwt}`, plus `taid={id_token}`, `tal_csrf={csrf_token}` and `did={did}` when those values exist.

## 4.3.0 notes

App 4.3.0 uses build 800751 and keeps the authenticated API at `v-1-18-0`.

- Public reviews use `product-reviews/plid/{plid}` with the numeric PLID only (no `PLID` prefix). The query takes `page` and an optional `sort`.
- Recommendations require `model` and `display_type=product`. `recommendations/home-page/layout` returns the model keys to use for home-page recommendations.
- Invoice, credit-note and invoice business-detail paths take `obfuscated_order_id`. The CLI finds it from the order number through the order history first.
- Product detail reads the buyable item from `buybox.items[0]`, with `event_data.documents.product` as the fallback. A listing with variants shows the choices under `variants.selectors[].options[]`. It can have no single SKU.
- The API has order-completion and payment paths. This CLI blocks them at its transport boundary. Checkout is a read-only preview, and the account owner pays in the Takealot app.

## Auth

### Login

```
POST /customers/login
Content-Type: application/json

{"platform":"android","sections":[{"section_id":"customer_login","fields":[{"field_id":"email","value":"..."},{"field_id":"password","value":"..."},{"field_id":"captcha","value":""}]}]}
```

**Response:** `auth_info.{id_token, jwt, refresh_token, csrf_token, tracking_id, customer_id, id_token_expires, access_key, private_key, did}`

### Login with Two-Step Verification (2FA)

When the account has 2FA, the login flow has two requests:

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

The response also sets a `__cf_bm` Cloudflare cookie. The second request must include this cookie. Between the two requests, the CLI keeps the cookie in the pending-challenge file (mode 0600).

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

**Note:** Each POST to /customers/login with credentials only starts a new 2FA challenge. Send the OTP for the challenge that the first response started. The OTP is valid for 5 minutes (`valid_millis: 300000`).

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
  - `buybox_summary.product_id` — the **buyable SKU id** that add-to-cart needs. It is a _different_ number from `core.id`. `/PLID{buybox.product_id}` returns 404.
  - Prices (`buybox_summary.prices[]`, `pretty_price`) are in **Rand**.
  - `core.reviews` — review count. There is no `core.review_count`. `core.star_rating` — rating.
  - `buybox_summary.saving` — discount as a formatted string (for example `"23%"`). There is no `discount_percentage` field.
  - Stock: `product_views.stock_availability_summary.status` and `.is_in_stock`. Delivery text: `.estimated_delivery.estimated_dates`.

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

A listing with variants can have no single SKU until someone chooses a variant. The CLI then returns `skuId: null` and shows the options. It does not guess.

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

**Response:** two parallel arrays, both keyed by `product_id`. One array alone is not sufficient. **Join them on `product_id`**:

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

`POST /checkout/{customer_id}` starts the checkout state or makes it current again. `PUT /checkout/{customer_id}` sends delivery or pickup choices. Both commands use the normal dry-run and `--confirm` write gate. Neither endpoint places an order.

### Blocked order and payment paths

Order completion, order payment, payment completion, payhost, eBucks payment, and Takealot Plus payment or plan-change endpoints stay in the catalogue as excluded rows. `PAYMENT_BLOCKED` and the client's `send()` transport guard reject them before a network request. The CLI has no payment redirects and no 3DS. The account owner pays in the Takealot app.

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

The endpoint also accepts `from`, `to` and `page_size`. Paging starts at **0**. Increase `page_number` until `response.orders` is empty.

**Response:** orders are at `response.orders[]`. Each order:

- Money (`total_amount`, `subtotal`, `unit_price`, `line_total`, …) is in **Rand**, not cents.
- No `status` field. Get the state from the booleans `is_fully_cancelled`, `is_awaiting_payment`, and `is_authorized` or `auth_status`.
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
| Delete by SKU                         | `DELETE /customers/{customer_id}/wishlists/items/pid/{sku_id}`   | none                                                                     |
| Delete by TSIN                        | `DELETE /customers/{customer_id}/wishlists/items/tsin/{tsin_id}` | none                                                                     |
| Bulk delete                           | `DELETE /customers/{customer_id}/wishlists/{group_id}/items`     | `{"products":[{"tsin":104146086}]}`                                      |
| Shared group                          | `GET /customers/wishlists/{shared_group_id}`                     | none                                                                     |
| Recommendations                       | `GET /recommend/wishlist`                                        | none                                                                     |
| Recommendations for PLIDs             | `GET /recommend/wishlist/{plids}`                                | none                                                                     |

The web bundle also uses `PUT /customers/{customer_id}/wishlists/items/tsin/{tsin_id}/move` with `{"from":2181365,"to":27948686}`. The Android 4.3.0 Retrofit interface does not have this endpoint. The catalogue therefore records it as an excluded web-only row, and the CLI does not expose it.

With typed writes, you do not write payloads by hand: `wishlist add <groupId> --sku N`, `wishlist add <groupId> --plid P`, `wishlist move --from G --to G --tsin N`, and `wishlist rm-items <groupId> --tsin N`. Repeat `--sku` or `--tsin` for more products. Each command also accepts `--file` and uses the normal dry-run and `--confirm` gate.

`wishlist add --file payload.json` without a group id still writes to the last-used group, for compatibility.

### Credits Balance

```
GET /customers/{customer_id}/credits/balance
```

## Key notes

1. **All money values are in Rand, not cents.** Do not divide by 100. (`unit_price: 102` is R102. A cart total of `833` is R833.)
2. **Each product has two ids.**
   - The **PLID** is for links, product-card and product-details. It is `core.id` in search, and `plid` or `sku.plid` in the cart and orders.
   - The **SKU id** is for add-to-cart. It is `buybox_summary.product_id` in search, `buybox.items[0].sku` in product details, and `product_id` in the cart and orders.
   - The two ids are different numbers. You cannot use one in place of the other.
3. **Device trust depends on a stored `did` that the server gives.**
   - The app does not sign requests. The login response contains `access_key` and `private_key`, but the app does not use them for signing.
   - The app has one authorization interceptor. In the decompiled app, it adds `Authorization`, `X-Csrf-Token` and **`TAL-Did: {did}`** to authenticated requests. The CLI adds `X-Csrf-Token` and `TAL-Did` only when it has a CSRF token and a `did`.
   - The server gives the `did` in `Set-Cookie: did=…` and also in `auth_info.did`. The app stores it and sends it back on **every** request, also on login and refresh. It sends it as the `TAL-Did` header **and** as the `did` cookie.
   - One 2FA login with `trust_this_device:true` makes that `did` trusted. Later logins that send it **skip the OTP challenge**.
   - The CLI does the same:
     - It makes no `did` itself.
     - It reads the `did` from `Set-Cookie` and from the body. The cookie wins when the two are different.
     - It stores the `did` with the device, so the `did` stays when the CLI clears the tokens.
     - When it has a `did`, it sends the `did` on every request.
   - This lets a headless login succeed without a new OTP.
4. **Authenticated requests use the mobile API and the mobile user-agent.** The 2FA step needs the `__cf_bm` cookie from the first login response.
5. **The JWT expires after 1 hour.** Use the refresh token to get a new JWT before it expires.
6. **The refresh token changes on every refresh.** Each refresh returns a new refresh token, and the old one stops working.
7. **This CLI blocks order placement and payment.** Use the read-only preview, then pay in the Takealot app.

---

## Full endpoint catalogue

`docs/endpoints-catalogue.json` lists every endpoint that the app exposes, one row per endpoint, with `{domain, method, path, auth, encoding, mutating, excluded, command}`. The first list came from APK v4.2.2. A second check compared the paths with the v4.3.0 Retrofit interface (build 800751, API `v-1-18-0`). The commands used in PR2 were also checked against the live API.

The catalogue is the source of truth for what the CLI covers. A contract test runs every row that is not excluded and checks the exact request.

The catalogue has 198 rows: 170 command endpoints and 28 excluded rows. The excluded rows are 22 order and payment paths, telemetry, ads, the internal token refresh, and the web-only wishlist move. The API base for authenticated calls is `v-1-18-0`.
