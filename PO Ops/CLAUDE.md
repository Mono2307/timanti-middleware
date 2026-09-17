# CLAUDE.md — Timanti PO Middleware

## Project
PO system for Timanti by Auracarat's Bengaluru store. Bridges store staff → HQ production/inventory via structured, traceable purchase orders. PRD: `PO_System_PRD_v2.docx` (v0.2, April 2026 — build-ready).

## Architecture

```
Shopify order/draft_order updated
    ↓
po-webhook (Supabase edge fn)
    ↓ creates
PO draft order (Shopify) + Sheets row (via Apps Script) + HQ email (via Resend + OPP PDF)
    ↓ HQ clicks action link
po-action (Supabase edge fn)
    ↓ updates
Draft order metafield (custom.po_status) + Sheets timestamp column
    ↓ on shipped
Draft order deleted (Sheets row is permanent record)
```

## File map

| File | Role |
|---|---|
| `supabase/functions/po-webhook/index.ts` | Shopify webhook → create PO draft orders, send email, write Sheets |
| `supabase/functions/po-action/index.ts` | Handle HQ action link clicks, update status + timestamps, delete on shipped |
| `scripts/sheets-app-script.js` | Google Apps Script web app: append rows + update columns in PO_Log |
| `templates/po_template.liquid` | Order Printer Pro template — branches on `custom.po_type` |
| `docs/staff-sop.md` | One-page SOP for store staff |
| `.env.example` | All env vars |

## Key design decisions

- **Signal is line-item-level**, not order-level: `_po_type = mto | replenishment` set by staff as a hidden property (underscore prefix) per line item. Enables mixed-cart routing.
- **Two webhooks**: `orders/updated` + `draft_orders/updated` — covers online orders, offline/POS, and partial-payment draft orders.
- **Per-PO action token**: 32-char random hex stored in `custom.action_token` metafield. `po-action` scans open draft orders for matching token (Phase 2: replace with Supabase table).
- **Google Sheets as audit trail**: Shopify draft order = API query layer; Sheets PO_Log = human-readable record. Draft order deleted on shipped; Sheets row kept forever.
- **No HQ login required**: all status updates happen via email action links.

## PO lifecycle

`pending` → `acknowledged` → `ordered` → `qc_passed` → `shipped` (draft deleted) → `received` (manual)

## Env vars (all required)

```
SHOPIFY_SHOP              auracarat.myshopify.com
SHOPIFY_ADMIN_TOKEN       Admin API token (shpat_xxx)
SHOPIFY_WEBHOOK_SECRET    HMAC signing secret
RESEND_API_KEY            Email delivery
HQ_EMAIL                  hq@timanti.in
FROM_EMAIL                store@timanti.in
APPS_SCRIPT_URL           Google Apps Script web app URL
MIDDLEWARE_BASE_URL       https://YOUR_PROJECT.supabase.co/functions/v1
OPP_API_KEY               Order Printer Pro API key
```

## Phase 2 improvements (not built yet)

1. **Supabase `po_records` table**: `source_order_id + po_type → draft_order_id` — fixes the O(n) draft order scan in both `poAlreadyExists` and `findDraftOrderByToken`.
2. **Token single-use enforcement**: add `token_used_at` per stage to metafield or `po_records`.
3. **OPP PDF path confirmation**: verify `GET /api/v2/documents/draft_order/{id}?template=Purchase+Order` against live OPP docs.

## Open questions (from PRD)

- **Q6**: Supabase edge function domain → set `MIDDLEWARE_BASE_URL` once project is linked.
- **Q7**: POS line item properties — Shopify POS doesn't natively support them. Workaround (admin edit after sale) documented in `docs/staff-sop.md`.

## Deploy commands

```bash
supabase functions deploy po-webhook
supabase functions deploy po-action
```
