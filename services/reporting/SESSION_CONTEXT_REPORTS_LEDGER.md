# Session Context — Reporting Suite + Credit-Instrument State Model

_Last updated: 2026-07-15. Branch: `feat/metafield-manager-extension` (the live server deploy branch;
`main` is stale — see memory `deploy-and-branch-topology`). Deploy = GitHub Actions → Fly; a human
triggers it (no local flyctl/gh). Prefer **Deploy Specific Commit to Fly.io** with a SHA._

## What this session did (in order)

Consolidated all reports into `services/reporting/`, added two new reports, added GST/instrument
fields across the suite, and reworked the credit-instrument lifecycle into a proper state model.

### Commits (newest of this arc last)
- `ac3c289` feat(reporting): stitched sales report + serial counters, GST fields, recon consolidation
- `f4269e2` chore(recon): commit monthly reconciliation input CSVs (Recon Test/)
- `c3faf25` fix(recon): un-ignore `Recon Test/` in the Docker build (`.dockerignore` was stripping it)
- `f452c42` feat(recon): union settlement-only Pine txns from MPR + payer-agnostic split matcher _(other session)_
- `6fd430e` feat(reporting): ledger `detail` view, adjustment issuance+redemption, sales recorded-partials
- `1a2703a` feat(ledger): distinguish `applied` (reserved on draft) from `redeemed` (converted to order)
- Later adjacent work by other sessions built ON TOP of the state model: `aaa82ff` diamond-only discount,
  `ce9af11` unified adjustments selector, `f20d5e5` voucher lock-on-conversion + free-vs-void,
  `d4b7b4c` latest-one-wins + free-by-default remove, `56627cb` revert apps-script.js.

## The report suite (all in `services/reporting/`, routes in `server.js`)

| Report | Endpoint | Grain | Notes |
|--------|----------|-------|-------|
| Sales | `GET /api/sales-report` | line item | stitches partial-paid drafts + completed orders (dedupe on `draft.order_id`); GST/HSN/serial/shipping cols; **only drafts with a recorded payment**; `payment_type` = partial vs `full: one-time`/`advance+final`/`paid-in-advance` |
| Adjustments | `GET /api/adjustment-report` | order | per-order GST breakdown + `instruments_issued` / `instruments_redeemed` (credit_instruments joined by source/target order) |
| Payment Recon | `GET /api/recon` | bank txn | reads `Recon Test/` CSVs (now committed + un-ignored); GST + shipping/serial enrichment |
| Payment Recon (local) | `Recon Test/proto_recon.py` | payment leg | persistent `_recon_store/` + regenerated `recon_ledger.csv`; matches across ALL months so an advance and its balance reconcile under one `OrderGroup` |
| Credit Ledger | `GET /api/recon-ledger?view=` | instrument | `detail` (per-instrument state + refs), `summary`, `outstanding`, `tieout` |
| Serial | `GET /api/serial-report` | serial | unchanged |
| Counters | `GET /api/serial-counters` | counter | current_value / next_value per doc_type×store×FY |

Report builders live in `services/reporting/reports.js` (`buildSalesReport`, `buildSerialCounters`,
`gstSplit`, `supplierState`, re-exports recon). Payment recon: `services/reporting/recon.js` (moved
from `services/recon/` which is now empty). GST derivations mirror `templates/tax-invoice.liquid`
(taxable = (gross−discount)/1.03, flat 3%, intra→CGST+SGST vs inter→IGST by supplier `custom.state_code`
vs shipping `province_code`).

## Credit-instrument STATE MODEL (the core change, `1a2703a`)

Vouchers/exchange notes were marked `redeemed` the instant they were applied to a draft — so a credit
on a draft that never converted showed as spent. Now:

```
open → applied (reserved on a draft, reversible) → redeemed (draft converted to an order = TRUE)
                        ↘ (draft deleted / removed) → open
   also: voided, expired
```

- **`services/exchange-cn/credit_instruments.js`** functions: `apply()` (status=applied, target_draft_id,
  applied_at), `promoteApplied({targetDraftId,targetOrderId,targetOrderName})` (applied→redeemed on
  conversion), `revertApplied({targetDraftId})` (applied→open on draft delete), and `reopen()` (full
  reset to open when a credit is removed from a draft before converting — added by the later voucher work).
- **`server.js` wiring:** offline draft-apply paths call `apply()` (handleApplyVoucherTag ~2454,
  handleApplyExcTag ~2510, exc-redeem ~4440, voucher-redeem ~4578). Draft completion handler (~2538)
  calls `promoteApplied` with the real order name. Draft-delete webhook (~3249) calls `revertApplied`.
  Online voucher discount-code on an order (~3388) and the `/api/credit-instrument/issue` backfill
  (~4674) stay `redeem()` (true redemptions with an order target). `reopen()` wired at ~4662/4821.
- **Ledger reporting:** `summary` gained an `applied` bucket — identity is now
  `issued = redeemed + applied + outstanding + voided + expired`. `detail` exposes `applied_to_draft`
  + `applied_at`; state shows `outstanding|applied|redeemed|voided|expired`.

### DB migration — REQUIRED, run before deploying `1a2703a`+
`services/exchange-cn/credit_instruments_applied_migration.sql` (Supabase → SQL Editor, idempotent):
adds `applied` to the status CHECK, adds `applied_at`, and reclassifies stale draft-only `redeemed`
rows → `applied`. **This migration has already been run in prod** (verified live 2026-07-14/15).

## Deploy + verification state (as of last check)
- Live and verified: recon (8 rows), sales-report (24 rows, no unpaid drafts, payment_type filled),
  adjustment-report (instruments_issued populated, e.g. `#1060 → EXC27-KAHSR-0001 [redeemed] → #D154`),
  ledger `detail` + `summary` (VCH27-KAHSR-0001 correctly reads `applied`; both summary rows `balances:true`).
- Verify commands: `curl .../api/recon-ledger?view=detail` and `?view=summary`,
  `.../api/sales-report?from=&to=`, `.../api/adjustment-report?from=&to=&format=json`.

## Sales report — draft window + lineage fix (2026-08-06)
The drafts side passed `created_at_min`/`created_at_max` to REST `draft_orders.json`, which does not
support them and **silently ignores** unsupported params — so every run returned all open/invoice_sent
drafts and each month re-counted the same ones (a July run carried #D115 from May and #D194 from
August; June and July returned an identical 22-draft list). Now filtered client-side on `d.created_at`,
plus the `d.order_id` dedupe this table always claimed but never had, and a `seen` guard across the
open/invoice_sent passes. Order rows now carry `draft_name`: Shopify writes nothing on the order
identifying its draft, so `buildOrderToDraftMap` indexes completed drafts by `order_id` (fails soft —
lineage is enrichment, never fatal). **Needs a deploy to take effect.**

## Outstanding / gotchas
1. **Apps Script regression:** `56627cb` reverted `services/reporting/apps-script.js` to the OLD version.
   The repo copy currently LACKS: Sales `payment_type` col, Adjustments `instruments_issued`/`_redeemed`
   cols, Ledger `detail` hint, AND the two-pass filter-layout fix (buggy single-loop that only lays one
   filter field then errors). **Re-apply these to apps-script.js**, then the user re-pastes into the
   Google Sheet. (Server data already returns the fields; this is display-only, but the two-pass fix is
   a real UX bug that needs restoring.)
2. `instruments_redeemed` on the Adjustments report reads 0 because current redemptions target **drafts**,
   and that report lists **orders**; the redemption still shows on the issuer's row via `→ #Dxxx`.
3. `main` remains ~diverged/stale; reconciling feat→main is still outstanding debt.
4. Recon inputs (`Recon Test/`) are a **monthly** refresh: drop new exports, `git add "Recon Test"`,
   commit, push, deploy that SHA.

## Key files
- `services/reporting/reports.js`, `recon.js`, `apps-script.js`, `SESSION_CONTEXT_REPORTS_LEDGER.md` (this)
- `services/exchange-cn/credit_instruments.js`, `credit_instruments_applied_migration.sql`
- `server.js` routes: `/api/sales-report`, `/api/serial-counters`, `/api/adjustment-report`,
  `/api/recon`, `/api/recon-ledger`; draft webhook completion/delete handlers; voucher/exc apply paths
- Reference: `templates/tax-invoice.liquid` (GST source of truth)
