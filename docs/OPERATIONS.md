# Operations

## Where the non-code assets live

Templates, Apps Scripts, SQL and PRDs are **not** in this repo. They are pasted into panels by
hand and live in `../timanti-ops-assets/`, which has its own git history.

| Need to change… | Edit in `timanti-ops-assets/` | Then paste into |
|---|---|---|
| An invoice, receipt, voucher | `order-printer/templates/` | Shopify Admin → Order Printer Pro |
| A sheet automation | `apps-script/` | Google Sheets → Extensions → Apps Script |
| A database table | `sql/` | Supabase → SQL Editor |
| A hosted form | `forms/` | wherever the static HTML is served |
| PO Ops edge functions | `supabase-functions/` | `supabase functions deploy` |

## Recovering a file that was removed from this repo

Nothing was destroyed in the 2026-08 restructure; history still holds every tracked file.

```bash
git log --oneline --all -- templates/tax-invoice.liquid   # find a revision
git show <sha>:templates/tax-invoice.liquid                # print it
```

Full offline bundle and step-by-step recovery: `C:\tm-restore-2026-08-08\RESTORE.md`.

## Inspecting production without credentials

The repo-root `.env` Shopify token is stale and 401s. Production reads its live token from
Supabase at runtime, so the service can see Shopify even when your local credentials cannot.
Use its own read endpoints instead of trying to call Shopify directly:

```
GET /api/draft-orders?status=open|invoice_sent|completed
GET /api/draft-order-metafields?draftOrderId=<numeric id>
GET /api/credit-instrument/open?type=voucher
GET /api/recon-ledger?view=detail&type=voucher
```

**Highest-signal debugging trick:** compare a draft's `updated_at` against the ledger row's
`issued_at`. Every tag-triggered flow ends in a PUT, so if `updated_at` predates the event you
are investigating, nothing ever reached that draft and the middleware never ran — no log hunting
needed.

`flyctl` is not installed locally, so Fly logs need a human with the CLI, or infer from state.

## Monthly reconciliation

`GET /api/recon` reads the CSVs baked into `src/data/recon/` at image build time — refreshing
those means a commit and a deploy. `POST /api/recon` runs the identical matcher over uploaded
files instead, which is the normal path: drop the month's exports in the Drive folder and post
them. No deploy required.

`src/data/recon/_recon_store/` is the **durable** store and accumulates. The monthly dumps beside
it are overwritten. Never delete the store.

## Known rough edges

- **Two GST implementations disagree by 1 paisa.** `reporting/recon.js` and `reporting/reports.js`
  each define `gstSplit` and round differently. 4,476 of 1.5M amount/state combinations differ.
  Enough to stop a reconciliation tying out to zero. Neither is canonical yet.
- **Order Printer can read `order.metafields` as empty at print time.** Templates fall back to
  the native `order.financial_status`. This caused a paid order to print as unpaid once.
- **Shopify tags are capped at 40 characters**, which constrains voucher and exchange code formats.
- **`draft_orders.json` silently ignores `created_at_min`/`max`.** Filter dates client-side; the
  API returns everything regardless.
