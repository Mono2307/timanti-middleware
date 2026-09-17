# Serialization v2 — Stages 3/4/5 Deploy Runbook

_Built 2026-06-11. App: `timanti-middleware` (Fly.io, region `bom`). Store: `auracarat.myshopify.com`._

Code is committed-ready but **every trigger is behind an env flag that is OFF by default** — deploying
the code changes nothing live until you flip a flag for the stage you're testing. Run the per-stage
tests in `services/serialization/TESTING_v2.md` after each flag flip.

---

## 1. Database (Supabase → SQL Editor)
- Paste & run `services/po-ops/setup.sql` — adds `po_records.store_code` (`alter ... add column if not exists`, safe to re-run).
- `services/serialization/ledger_setup.sql` is already applied (ledger backfilled).

Sanity check:
```sql
select doc_type, store_code, count(*), min(seq), max(seq) from serial_ledger group by 1,2;
select * from serial_counters order by doc_type, state_code;   -- current_value >= max(seq) per bucket
```

## 2. Deploy the middleware
```powershell
# optional but recommended: branch + commit first (you're on main)
flyctl deploy
```
Flags still off → live behavior unchanged.

_(No new Shopify webhook is needed — customer-order serials are permanent and never cancelled, so
there is no `orders/cancelled` listener. PO/memo/transfer/CN voids use existing flows.)_

## 3. Redeploy the two Apps Scripts
- **exchange-cn** (`services/exchange-cn/apps-script.js`): paste into the CN sheet's Apps Script editor, save.
  New "🗑️ Void Credit Note" menu item appears on reload. Needs `write_discounts` scope (already granted).
- **po-queue** (`services/po-ops/po-queue.gs`): paste into the PO Queue sheet's editor, save.
  New "Set Batch Store Code" menu item. If the web-app `doPost` is used, also **Deploy → Manage deployments → new version**.

## 4. Flip flags one stage at a time (each `secrets set` triggers a rolling restart)
```powershell
flyctl secrets set SERIAL_REPAIR=true          # then run Stage 3 tests
flyctl secrets set SERIAL_PO=true              # then Stage 4a
flyctl secrets set SERIAL_MEMO_TRANSFER=true   # then Stage 4b
# CN void + ledger report need no flag — test once deployed
```

## 5. Test
Walk `services/serialization/TESTING_v2.md` top-down; verify each stage before enabling the next.

---

## Prerequisites to confirm in Shopify before testing
- `custom.delivery_code` metafield definition exists on **Draft Orders** (memo/transfer destination).
- Staff set `custom.state_code` as `KA-HSR` / `MH-HQ`-style codes (must match the store-code values used in the PO Queue dropdown / Set Batch Store Code).

## Rollback
- Disable a stage instantly: `flyctl secrets unset SERIAL_REPAIR` (or set `=false`). No code redeploy needed.
- Ledger rows are additive; cancellations are status flips (never deletes) — safe to inspect/repair manually.

## Open items (decide next session — also at the bottom of TESTING_v2.md)
- Batch PO spanning multiple stores → currently one `BATCH_STORE_CODE` per run (one PO = one serial). OK or split per store?
- CN ledger `serial_code` (`CNTM-<seq>`) vs customer-facing `CNTM-YYYY-NNNN` — share the seq; align formats or leave.
- Reporting Apps Script (`services/reporting/apps-script.js`) column tolerance (customer/total now blank; status/cancelled_at appended).
