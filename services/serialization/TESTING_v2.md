# Serialization v2 — Stages 3/4/5 Testing Plan

_Built 2026-06-11. Code is on `origin/main` (commit `e3b9f3c`). Every trigger is behind an env flag
(off by default), so deploying is safe — nothing fires until you flip the flag for that stage._

> **Throughout:** `BASE=https://timanti-middleware.fly.dev`, `STORE=auracarat.myshopify.com`.

## Run order for tomorrow (do these in sequence)
1. **Deploy first** — complete `DEPLOY_v2.md` steps 1–3: run `po-ops/setup.sql`, `flyctl deploy`,
   paste the two Apps Scripts. (No Shopify webhook needed.)
2. **Smoke test** — open `BASE/api/serial-report?docType=customer_order` in a browser → you should see
   JSON data, not an error. App is alive.
3. **Pre-req SQL sanity** (below) — confirm ledger + counters are healthy.
4. **Test one stage at a time:** flip its flag → run that stage's checks → only then move to the next.
   Flags (each triggers a rolling restart): `flyctl secrets set SERIAL_REPAIR=true` (Stage 3),
   `SERIAL_PO=true` (Stage 4a/PO-cancel), `SERIAL_MEMO_TRANSFER=true` (Stage 4b/memo-cancel).
   CN + report need no flag. To back out: same command with `=false`.
5. Run the **Regression checks** (bottom) after each flag flip.

## Pre-req SQL sanity (run before flipping any flag)
- `services/serialization/ledger_setup.sql` already applied; `services/po-ops/setup.sql` adds
  `po_records.store_code` (safe to re-run).
- Confirm the backfill is present and the counter is ahead of every minted seq:
  ```sql
  select doc_type, store_code, count(*), min(seq), max(seq) from serial_ledger group by 1,2;
  select * from serial_counters order by doc_type, state_code;   -- current_value >= max(seq) per (doc_type, store_code)
  ```

---

## Stage 3 — Repairs  (flag: `SERIAL_REPAIR=true`)
Mints `REP-{CODE}-{SEQ}` only at **repair-complete**, never for free/abandoned repairs.

1. **Free repair = no number:** create a repair draft, set `custom.state_code` (e.g. `KA-HSR`), tag `repair-free`. Complete it.
   - Expect: **no** `serial_ledger` row for this draft.
   - `select * from serial_ledger where doc_type='repair' and resource_id='<draftId>';`  → 0 rows.
2. **Paid repair mints at completion:** new repair draft, set `custom.state_code`, run the normal flow to `repair-complete`.
   - Expect: one `repair` ledger row `REP-KA-HSR-<seq>`; draft has `custom.serial_code` stamped.
3. **Idempotency:** re-fire `draft_orders/updated` on that completed draft (e.g. re-save it).
   - Expect: still exactly **one** row; counter NOT advanced; logs show no new mint.
4. **No state_code = skip:** complete a repair whose `custom.state_code` is blank → log `no state_code set — skipping mint`, no row.

---

## Stage 4a — PO  (flag: `SERIAL_PO=true`)
Mints `PO-{CODE}-{SEQ}` at **HQ acknowledge**; store code from source order (auto-PO) or the sheet (batch).

1. **Auto-PO store code captured:** on a customer order set `custom.state_code=KA-HSR`, add `raise-po` tag.
   - Expect: new `po_records` row has `store_code='KA-HSR'`.
   - `select draft_order_name, store_code, status from po_records order by created_at desc limit 5;`
2. **Mint on acknowledge:** click the **Acknowledge** action link in the PO email (or hit `/api/po-action?action=acknowledge&token=<token>`).
   - Expect: `po` ledger row `PO-KA-HSR-<seq>`; PO draft stamped with `custom.serial_code`.
3. **Batch PO:** in the PO Queue sheet → PO Ops → **Set Batch Store Code** = `MH-HQ`; approve rows; **Run Batch Raise Now**.
   - Expect: batch `po_records` row has `store_code='MH-HQ'`. Acknowledge it → `PO-MH-HQ-<seq>`.
4. **No store code = skip:** acknowledge a PO whose `store_code` is null → log `no store_code on record — skipping mint`, no row, PO status still advances.

## Stage 4b — Memo / Transfer  (flag: `SERIAL_MEMO_TRANSFER=true`)
1. On a draft set `custom.state_code` (origin) + `custom.delivery_code` (destination), tag `make-memo`.
   - Expect: `memo` ledger row `MEMO-<ORIGIN>/<DEST>-<seq>`; draft stamped; `make-memo` tag removed.
2. Missing `delivery_code` → log `no delivery_code yet — skipping`, no row (staff hasn't finished).
3. `make-transfer` → `TRANSFER-<ORIGIN>/<DEST>-<seq>`.

---

## Stage 5 — Cancellation  (uses the same per-doc flags)
**Cancellation model:** only **PO, memo, transfer, and credit_note** can be voided (ledger row →
`status='cancelled'`, number retired, never reused). **Customer-order (and repair/CAD) serials are
permanent** — there is no cancellation path for them; a cancelled/refunded order keeps its number.

1. **PO cancel:** click **Cancelled** action link on an acknowledged PO.
   - Expect: its ledger row `status='cancelled'`, `cancelled_at` set. Number NOT reused on the next mint.
2. **Memo/transfer void:** tag a minted draft `cancel-memo` / `cancel-transfer`.
   - Expect: ledger row → `cancelled`; tag removed.
3. **Order is NOT cancellable:** cancel a serialized order in Shopify → its `customer_order` ledger row
   stays `active` (no listener). Confirm the serial is unchanged.

## Stage 5b — Credit Note  (no flag — explicit endpoints)
1. **CN now lands in the ledger:** create a CN via the exchange-cn Apps Script.
   - Expect: `select * from serial_ledger where doc_type='credit_note' order by seq desc limit 3;` shows a new `active` row, `resource_id` = `CNTM-<seq>`.
   - Note: ledger `serial_code` is `CNTM-<seq>` (no year/pad); the customer-facing number is `CNTM-YYYY-NNNN` — they share the **seq**. (Possible follow-up: align the formats.)
2. **Void before expiry:** CN Tools → **Void Credit Note** → enter the CN number.
   - Expect: Shopify discount/price-rule deleted; ledger row → `cancelled`; CN Log status → `Voided`.
   - Direct test: `curl -X POST $BASE/api/serial/cancel-by-code -H 'content-type: application/json' -d '{"docType":"credit_note","serialNo":<seq>}'`
3. **Void after expiry:** voiding an expired CN → Apps Script blocks it ("can no longer be voided").

## Stage 5c — Report (ledger-backed)
- `curl "$BASE/api/serial-report?docType=po"` → JSON rows from the ledger incl. `status` + `cancelled_at`.
- `curl "$BASE/api/serial-report?docType=credit_note&status=cancelled&format=csv"` → CSV of voided CNs.
- **Before enabling for ops:** confirm `services/reporting/apps-script.js` still parses the columns (customer/total are now blank; `status`,`cancelled_at` appended).

---

## Regression checks (run after each flag flip)
- Stage 2 customer-order minting still fires on `orders/update` (`SERIAL_CUSTOMER_ORDER` already live).
- `select max(seq), (select current_value from serial_counters c where c.doc_type=l.doc_type and c.state_code=l.store_code) from serial_ledger l group by doc_type, store_code;` → counter ≥ max(seq) everywhere.
- Watch `flyctl logs` for `[serial]` lines during each test.

## Open items to confirm next session
- Batch PO spanning multiple stores → currently one `BATCH_STORE_CODE` per run (one PO = one serial). OK or split per store?
- CN ledger `serial_code` format (`CNTM-<seq>`) vs customer-facing `CNTM-YYYY-NNNN` — align or leave (seq is the join key).
- Reporting Apps Script column tolerance.
