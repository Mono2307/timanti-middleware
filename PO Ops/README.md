# Timanti PO Middleware

Two Supabase edge functions + one Google Apps Script that implement the Purchase Order system for Timanti by Auracarat's Bengaluru store.

## Project structure

```
supabase/functions/
  po-webhook/index.ts     ← Shopify webhook listener: reads _po_type, creates PO draft orders, sends email, writes to Sheets
  po-action/index.ts      ← HQ email action link handler: validates token, updates status, deletes draft on shipped
scripts/
  sheets-app-script.js    ← Deploy to Google Apps Script (no service account needed)
templates/
  po_template.liquid      ← Order Printer Pro Liquid template (deploy via OPP dashboard)
docs/
  staff-sop.md            ← One-page SOP for store staff
.env.example              ← All env vars
```

---

## How it works

1. Store staff adds `_po_type = mto | replenishment` as a line item property on a Shopify order
2. Shopify fires `orders/updated` (or `draft_orders/updated` for partial-payment orders)
3. `po-webhook` groups line items by `_po_type`, creates one PO draft order per type, sends email with PDF to HQ, appends a row to the Google Sheets PO tracker
4. HQ clicks action links in the email → `po-action` validates the token, updates `custom.po_status` on the draft order, writes a timestamp to the Sheets row
5. On "Shipped to store": draft order is deleted from Shopify. Sheets row is the permanent record.

### PO lifecycle

`pending` → `acknowledged` → `ordered` → `qc_passed` → `shipped` (draft deleted) → `received` (manual in Sheets)

---

## Setup

### 1 — Shopify: create draft order metafields

Settings → Custom data → Draft Orders → Add definition for each:

| Key | Namespace | Type |
|---|---|---|
| `po_status` | `custom` | single_line_text_field |
| `po_type` | `custom` | single_line_text_field |
| `source_order_id` | `custom` | single_line_text_field |
| `source_order_name` | `custom` | single_line_text_field |
| `action_token` | `custom` | single_line_text_field |

### 2 — Order Printer Pro

OPP → Templates → New → paste `templates/po_template.liquid` → name: **Purchase Order** → scope: Draft Orders only.

OPP → Automations → New:
- Trigger: Draft Order created
- Condition: `custom.po_status = pending`
- Action: Send email to HQ, subject `New PO — {{draft_order.name}} — {{draft_order.metafields.custom.po_type}}`

### 3 — Google Sheets

1. Create a new Google Sheet named **Timanti PO Tracker**
2. Open Extensions → Apps Script → paste `scripts/sheets-app-script.js`
3. Update `SHEET_ID` at the top (from the Sheet URL)
4. Run `setupSheet()` once to create and format the header row
5. Deploy as Web App: Execute as **Me** · Access: **Anyone**
6. Copy the web app URL → use as `APPS_SCRIPT_URL` env var

### 4 — Supabase

```bash
npm install -g supabase
supabase link --project-ref YOUR_PROJECT_REF

supabase secrets set SHOPIFY_SHOP=auracarat.myshopify.com
supabase secrets set SHOPIFY_ADMIN_TOKEN=shpat_xxx
supabase secrets set SHOPIFY_WEBHOOK_SECRET=xxx
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set HQ_EMAIL=hq@timanti.in
supabase secrets set FROM_EMAIL=store@timanti.in
supabase secrets set APPS_SCRIPT_URL=https://script.google.com/...
supabase secrets set MIDDLEWARE_BASE_URL=https://YOUR_PROJECT.supabase.co/functions/v1
supabase secrets set OPP_API_KEY=xxx

supabase functions deploy po-webhook
supabase functions deploy po-action
```

### 5 — Register Shopify webhooks

Shopify Admin → Settings → Notifications → Webhooks:

| Event | URL |
|---|---|
| `orders/updated` | `https://YOUR_PROJECT.supabase.co/functions/v1/po-webhook` |
| `draft_orders/updated` | `https://YOUR_PROJECT.supabase.co/functions/v1/po-webhook` |

Copy the webhook signing secret → set as `SHOPIFY_WEBHOOK_SECRET`.

---

## Testing

### Replenishment flow
1. Create or find a Shopify order
2. Edit → find a line item → Add property: `_po_type` = `replenishment`
3. Save
4. Check: draft order created, email sent to HQ, row in Sheets

### MTO flow
Same as above with `_po_type` = `mto`. Customer details (billing + shipping) should appear on the PO PDF.

### Mixed cart
1. Order with 2 line items
2. Item 1: `_po_type` = `replenishment`, Item 2: `_po_type` = `mto`
3. Save
4. Confirm: 2 PO draft orders, 2 emails, 2 Sheets rows

### Action links
1. Open the HQ email
2. Click "Acknowledge PO"
3. Confirm: `acknowledged_at` column updates in Sheets, confirmation page shown in browser

### Partial payment (draft order flow)
1. Create a Shopify draft order
2. Add `_po_type` = `replenishment` to a line item
3. Save
4. Confirm: `draft_orders/updated` fires, PO draft order created, Sheets row written

---

## Known limitations / Phase 2

- **Idempotency**: scans all open draft orders to check for duplicates (slow at volume). Replace with a Supabase `po_records` table mapping `source_order_id + po_type → draft_order_id`.
- **Token lookup in po-action**: same scan pattern. Supabase `po_records` table would also solve this.
- **OPP PDF endpoint**: `GET /api/v2/documents/draft_order/{id}?template=Purchase+Order` — confirm exact path and auth with OPP docs.
- **Action token expiry**: tokens don't expire. Add a `token_used_at` check per stage if single-use enforcement is needed.
- **POS properties**: Shopify POS doesn't natively support line item properties. Workaround: staff adds property via Shopify Admin after the sale. See `docs/staff-sop.md`.
