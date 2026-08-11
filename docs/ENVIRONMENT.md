# Environment variables

All of these are read in exactly one place — `src/core/config.js`. Modules import from there
rather than touching `process.env`, so this table is complete by construction.

In production they are **Fly secrets** (`flyctl secrets set NAME=value`), not values in
`fly.toml`. The repo-root `.env` is for local development only and its Shopify token is known to
be stale.

## Required — the service cannot run without these

`assertRequired()` in `config.js` fails fast at boot if any is missing, rather than letting the
failure surface deep inside a request.

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Service-role key — ledgers, counters, config table |
| `SHOPIFY_STORE_URL` | e.g. `https://timanti.myshopify.com`, no trailing slash |

## Shopify

| Variable | Notes |
|---|---|
| `SHOPIFY_CLIENT_ID` | Client-credentials app ID. With the secret, mints a fresh token every 23h |
| `SHOPIFY_CLIENT_SECRET` | |
| `SHOPIFY_ACCESS_TOKEN` | **Fallback only.** Live token comes from Supabase — see `core/shopify.js` |
| `SHOPIFY_WEBHOOK_SECRET` | HMAC verification on inbound webhooks |

## Payments

| Variable | Notes |
|---|---|
| `PINE_PAYMENT_MODE` | `production` selects `PINE_LABS_API_URL`; anything else uses UAT |
| `PINE_LABS_API_URL` / `PINE_LABS_UAT_API_URL` | Terminal API hosts |
| `PINE_LABS_SECURITY_TOKEN` | |
| `GOKWIK_BASE_URL` / `GOKWIK_APP_ID` / `GOKWIK_APP_SECRET` | Payment links |

## Communications

| Variable | Notes |
|---|---|
| `RESEND_API_KEY` | Transactional email |
| `HQ_EMAIL` / `HQ_CC_EMAIL` / `STORE_EMAIL` | Recipients for internal notifications |
| `CN_EMAIL_ENABLED` | Gates credit-note email so it can be dark-launched |
| `FAST2SMS_API_KEY` | SMS |

## Google Apps Script web apps

Each is a different deployed script bound to a different sheet. Unset means that push is skipped
and the run continues.

| Variable | Sheet |
|---|---|
| `APPS_SCRIPT_URL` | PO Ops |
| `EXCHANGE_APPS_SCRIPT_URL` | Exchange / credit notes |
| `PO_QUEUE_SCRIPT_URL` | PO queue |
| `NO_WEIGHT_SHEET_URL` | Daily "skipped — no net weight" list (read by the Python job) |

## Serialization feature flags

Parsed leniently: `true`, `TRUE`, `1`, `yes`, `on` all count as enabled.

| Variable | Enables numbering for |
|---|---|
| `SERIAL_CUSTOMER_ORDER` | Customer orders |
| `SERIAL_REPAIR` | Repairs |
| `SERIAL_MEMO_TRANSFER` | Memos and transfers |
| `SERIAL_PO` | Purchase orders |
| `SERIAL_CUSTOMER_ORDER_START` | ISO instant (IST). Orders before it are never retro-numbered. Default `2026-08-01T00:00:00+05:30` |

## Automation switches

Deliberately **strict** — only the exact string `true` enables them, unlike the serial flags.
These trigger money movement and customer email, so a typo must fail closed.

| Variable | Effect when `true` |
|---|---|
| `AUTO_PUSH_TO_TERMINAL` | Push the amount to a card terminal automatically |
| `AUTO_CONVERT_DRAFT_TO_ORDER` | Convert a draft once fully paid |
| `AUTO_SEND_DRAFT_INVOICE` | Email the Shopify draft invoice |
| `AUTO_SEND_DEPOSIT_EMAIL` | Email a deposit confirmation |

## Other

| Variable | Notes |
|---|---|
| `PORT` | Default 8080; Fly sets it |
| `SERVER_URL` / `MIDDLEWARE_BASE_URL` | Public base URL, used to build links inside emails |
| `TYPEFORM_WEBHOOK_SECRET` | Signature verification |
| `PRICE_UPDATE_WEBHOOK_SECRET` | Guards the price-update trigger |
| `CATALOGUE_URL`, `STORE_MAP_URL`, `SEQUEL_TRACKING_BASE` | Reference data and tracking |
| `LOG_LEVEL` | `debug` / `info` (default) / `warn` / `error` |
