# Takealot Mobile API Reference (MITM Captured 2026-02-22)

Base: `https://api.takealot.com/rest/v-1-16-0`
User-Agent: `TAL-Android/3.51.0 (fi.android.takealot; build:800735; 14; samsung; SM-S928B; Phone)`
Auth: `Authorization: Bearer {jwt}` + cookies: `taid={id_token}; tal_jwt={jwt}; tal_csrf={csrf_token}; did={did}`

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
  "otp_status": {"remaining_retries": 2, "status": "unverified", "valid_millis": 300000},
  "data_sections": [
    {"section_id": "customer_login", "is_complete": true},
    {"section_id": "two_step_verification", "data_fields": [
      {"field_id": "otp", "title": "Enter OTP"},
      {"field_id": "trust_this_device", "data_type": "boolean"}
    ]}
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

## Products

### Product Details
```
GET /product-details/PLID{plid}?platform=android&show_takealot_now_alt=false&offer_opt=true
```
**Response:** Full product info including `buybox_summary` (sku, pricing, stock), `gallery`, `product_information`, etc.

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

## Checkout

### 1. Initialize Checkout
```
POST /checkout/{customer_id}/complete
Authorization: Bearer {jwt}
Content-Type: text/plain

android
```
**Response:** Sections for shipping_method, delivery_address, delivery_options, payment_method. Creates order.

### 2. Get Order Details
```
GET /checkout/{customer_id}/order/{order_id}
Authorization: Bearer {jwt}
```

### 3. Get Payment Info (PayHost)
```
GET /checkout/order/{order_id}/payhost
Authorization: Bearer {jwt}
```
**Response:** Order summary with totals, amount_due.

### 4. Get Saved Cards
```
GET /customers/card
Authorization: Bearer {jwt}
```
**Response:** `saved_cards[]` with `reference` (UUID), `last_four_digits`, `bank`, `card_scheme`, `card_expires`, `enabled`.

**Card references:**
### 5. Submit Payment
```
POST /order/{order_id}/payment
Authorization: Bearer {jwt}
Content-Type: application/x-www-form-urlencoded

method=Credit+Card+Token&token_reference={card_uuid}&budget_period=Straight
```
**Response:** `{"status_code":200,"result":"ok","response":{"authorized":false,"action":"redirect","url":"https://pay.takealot.com/initiation/{uuid}","tal_initiation_id":"{uuid}"}}`

### 6. PayGate 3DS Flow (WebView)
The `url` from step 5 loads a PayGate page that handles 3DS.
- For **saved cards with tokenized payment**, 3DS typically uses frictionless flow, but issuer challenges may still occur
- Flow: `pay.takealot.com/initiation/{id}` → `secure.paygate.co.za` → `3d.dpopayments.io` → `pay.takealot.com/completion/{id}`
- Completion POST body: `PAY_REQUEST_ID={id}&TRANSACTION_STATUS=1&CHECKSUM={hash}`

### 7. Complete Payment
```
POST /order/{order_id}/payment/complete
Authorization: Bearer {jwt}
Content-Type: application/json

{"tal_initiation_id":"{uuid}","platform":"android","status":"success","redirect_url":"https://secure.takealot.com/buy/payment/{order_id}/confirmation/success?platform=android&tal_initiation_id={uuid}&status=success"}
```
**Response:** `{"is_success":true,"message":""}`

## Other Endpoints

### Customer Summary
```
GET /customers/{customer_id}/summary
```

### Order History
```
GET /customer/{customer_id}/orders?from=2025-11-01&to=2026-02-23&page_number=1&page_size=10
```

### Wishlists
```
GET /customers/{customer_id}/wishlists/summary
```

### Credits Balance
```
GET /customers/{customer_id}/credits/balance
```

## Key Notes

1. **Authenticated requests use the mobile API and User-Agent; the 2FA handshake requires the __cf_bm cookie returned by the first login response**
2. **Saved card tokens typically use frictionless 3DS, but issuer challenges may still occur**
3. **JWT expires in 1 hour** — use refresh_token to get new jwt before expiry
4. **refresh_token rotates** — each refresh returns a new refresh_token (old one invalidated)
5. **Content-Type varies** — checkout init uses `text/plain`, payment uses `x-www-form-urlencoded`, most others use `application/json`
6. **PayGate redirect flow** — steps 5-7 involve a WebView redirect chain. For pure API, we need to either:
   a. Follow the redirect chain programmatically (fetch the PayGate URLs, extract form data, POST completion)
   b. Or find a way to skip it entirely (if `authorized:true` ever comes back from step 5)