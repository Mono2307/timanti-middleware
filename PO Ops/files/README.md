# Timanti PO Middleware

Two Supabase edge functions + one Google Apps Script that implement the PO system.

## Structure

```
po-middleware/
  supabase/functions/
    po-webhook/index.ts     ← Listens to Shopify webhooks, creates PO draft orders
    po-action/index.ts      ← Handles HQ email action link clicks
  scripts/
    sheets-app-script.js    ← Deploy to Google Apps Script (no service account needed)
  .env.example              ← All env vars needed
```

---

## Step 1 — Google Sheets setup

1. Create a new Google Sheet
2. Open Extensions → Apps Script
3. Paste the contents of `scripts/sheets-app-script.js`
4. Update `SHEET_ID` at the top (copy from the Sheet URL)
5. Run `setupSheet()` once to create the header row with formatting
6. Deploy as Web App:
   - Click Deploy → New Deployment → Web App
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Copy the web app URL → this is your `APPS_SCRIPT_URL`

---

## Step 2 — Supabase setup

```bash
# Install Supabase CLI if needed
npm install -g supabase

# Link to your project
supabase link --project-ref YOUR_PROJECT_REF

# Set secrets (one per line)
supabase secrets set SHOPIFY_SHOP=auracarat.myshopify.com
supabase secrets set SHOPIFY_ADMIN_TOKEN=shpat_xxx
supabase secrets set SHOPIFY_WEBHOOK_SECRET=xxx
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set HQ_EMAIL=hq@timanti.in
supabase secrets set FROM_EMAIL=store@timanti.in
supabase secrets set APPS_SCRIPT_URL=https://script.google.com/...
supabase secrets set MIDDLEWARE_BASE_URL=https://YOUR_PROJECT.supabase.co/functions/v1
supabase secrets set OPP_API_KEY=xxx

# Deploy both functions
supabase functions deploy po-webhook
supabase functions deploy po-action
```

---

## Step 3 — Register Shopify webhooks

In Shopify Admin → Settings → Notifications → Webhooks:

| Event | URL |
|---|---|
| `orders/updated` | `https://YOUR_PROJECT.supabase.co/functions/v1/po-webhook` |
| `draft_orders/updated` | `https://YOUR_PROJECT.supabase.co/functions/v1/po-webhook` |

Copy the webhook signing secret → set as `SHOPIFY_WEBHOOK_SECRET`.

---

## Step 4 — Test

### Test replenishment flow
1. Create or find a Shopify order
2. Go to order → Edit → find a line item → Add property: `_po_type` = `replenishment`
3. Save
4. Check: draft order created in Shopify, email sent to HQ, row in Sheets

### Test MTO flow
Same as above but with `_po_type` = `mto`
Customer details should appear in the PO draft order and PDF

### Test action links
1. Open the HQ email
2. Click "Acknowledge PO"
3. Confirm: Sheets `acknowledged_at` column updates, confirmation page shown

### Test mixed cart
1. Order with 2 line items
2. Set item 1 `_po_type` = `replenishment`, item 2 `_po_type` = `mto`
3. Save
4. Confirm: 2 PO draft orders created, 2 emails sent, 2 Sheets rows

---

## Known limitations / Phase 2 improvements

- **Idempotency**: Currently scans all open draft orders to check for duplicates (slow for high volume). Replace with a Supabase table `po_records` that maps `source_order_id + po_type → draft_order_id`.
- **OPP API**: The PDF fetch endpoint (`/api/v2/documents/draft_order/...`) needs to be confirmed with OPP docs — their API may require a slightly different path or auth method.
- **Token reuse**: Action tokens don't expire. If needed, add a `token_used_at` check to make each link single-use.
- **POS line item properties**: Shopify POS may not natively support adding custom properties per line item. Confirm and document workaround (e.g. admin edit after sale).
