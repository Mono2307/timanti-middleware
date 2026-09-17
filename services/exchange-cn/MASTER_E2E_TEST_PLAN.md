# End-to-End Test Plan — Adjustments, Credits, Ledger & Reporting

Covers every workflow shipped in commits `c3ae8a4 → a8664fa` (net-to-collect, voucher post-tax,
CAD advance, metafield carry-over, credit-instrument ledger, recon, reporting) plus regression of the
existing payment flows. Run top-to-bottom. Everything is **live** on `https://timanti-middleware.fly.dev`.

> ⚠️ Use **throwaway drafts** for every test. Never test on a real customer order.
> `credit_instruments` table must exist (SQL already run). Serial flags are OFF (serialization section is optional).

---

## 0. Tooling & how to verify

**Base URL:** `BASE=https://timanti-middleware.fly.dev`

**Read a draft's metafields** (the main check for most tests):
```bash
curl -s "$BASE/api/draft-order-metafields?draftOrderId=DRAFT_ID" | python -m json.tool
```
**Read a draft's line items + tags:**
```bash
curl -s "$BASE/api/draft-order-line-items?draftOrderId=DRAFT_ID" | python -m json.tool
```
**Read an order's metafields:** Shopify Admin → the order → Metafields card (or the GraphQL you used to create the definitions).

**Supabase checks:** Dashboard → Table editor → `credit_instruments` and `store_deposits`; or SQL Editor:
```sql
select instrument_type, serial_code, value, status, target_draft_id, target_order_name, redeemed_at, expires_at
from credit_instruments order by created_at desc limit 50;
select draft_order_id, total_amount, amount_paid, amount_pending, payment_status from store_deposits order by updated_at desc limit 20;
```

**Getting DRAFT_ID:** In Shopify the draft URL ends in the numeric id, or the draft name is `#Dxxx`. The redeem
endpoints accept either the numeric id or `#Dxxx`.

**Golden scenario used throughout (memorise the numbers):**
Item ₹1,00,000 (GST-incl.) → native promo −₹5,000 (draft `total_price` = **95,000**) → old-gold 10g@22kt
(≈ **55,000**) → exchange note **20,000** → voucher **5,000**. Expected **`amount_to_be_collected` = 15,000**.
(Old-gold value depends on the live buying-rate table; adjust the expected numbers to whatever the rate yields.)

---

## 1. Net-to-collect (Phase 1) — the money fix

### TC-1.1 Plain draft, no adjustments (baseline — must be unchanged)
1. Create draft, one item ₹10,000. No discount/adjustment.
2. Verify metafields: `amount_to_be_collected` = **10000.00**.
3. Add tag `cash-4000` (partial). Verify: `amount_paid`=4000, `amount_pending`=**6000**, tag `deposit:partial`.
4. Add tag `cash-6000`. Verify: `amount_paid`=10000, `amount_pending`=**0**, `payment_status`=full, tag `deposit:fully-paid`.
5. Supabase `store_deposits`: `total_amount`=10000, `amount_pending`=0. **PASS if identical to old behaviour.**

### TC-1.2 Draft with one post-tax adjustment
1. Draft, item ₹20,000 (`total_price`=20000).
2. Apply exchange note ₹5,000:
   ```bash
   curl -s -X POST "$BASE/api/exc-redeem" -H "Content-Type: application/json" \
     -d '{"newDraftRef":"#Dxxx","excNumber":"EXC-TEST-1","excValue":5000,"oldOrderNumber":"#1052","customerName":"TEST"}'
   ```
3. Verify metafields: `exchange_note_value`=5000, `amount_to_be_collected`=**15000**.
4. Tag `cash-15000`. Verify `amount_pending`=**0**, status full. **(Pre-fix this showed 5000 pending — the bug.)**

### TC-1.3 Adjustment applied AFTER a partial payment (self-heal)
1. Draft, item ₹20,000. Tag `cash-8000` → `amount_pending`=12000.
2. NOW apply exchange note ₹5,000 (as TC-1.2). `amount_to_be_collected`→15000.
3. Tag `cash-7000`. Verify `amount_pending`=**0** (base refreshed to 15000 − 15000 paid). **PASS if it reconciles to 0.**

### TC-1.4 Full stack (golden scenario)
1. Draft item ₹1,00,000, native discount ₹5,000 (`total_price`=95000).
2. Set `intake.old_gold_weight`=10, `old_gold_purity`=22 (edit the draft to fire the webhook) → `old_gold_value` auto ≈55000.
3. exc-redeem 20000; voucher-redeem 5000 (see TC-2.3).
4. Verify `amount_to_be_collected` = **95000 − 55000 − 20000 − 5000 = 15000**.
5. Pay net → `amount_pending`=0.

### TC-1.5 Over-adjustment clamp
1. Draft ₹10,000, exchange note ₹12,000. Verify `amount_to_be_collected`=**0** (never negative).

---

## 2. Voucher post-tax (Phase 2)

### TC-2.1 Online voucher freeze (the critical one)
1. Create a Shopify **discount code** named like `VCH27-KAHSR-9999` (fixed amount, e.g. ₹5,000). *(Or use a real issued voucher code.)*
2. Place a **test online order** using that code on an item ≥ ₹5,000, with a customer.
3. Ensure the `orders/create`+`orders/update` webhook points at `/api/serial/order-serial` (it already does for serials).
4. On the ORDER metafields, verify: `voucher_value`=**5000** (post-tax), `gross_value`=full item price, `discount_applied`= any *other* promo (0 if none).
5. Re-trigger the webhook (edit the order) → values unchanged (**idempotent**).
6. Supabase `credit_instruments`: a `voucher` row for that code → `status='redeemed'`, `target_order_name`=the order.
7. **PASS:** voucher is separated as post-tax, GST base = gross − discount_applied (not reduced by the voucher).

### TC-2.2 Order with NO voucher (freeze must no-op)
1. Place a test order with only a normal promo code (no `VCH`).
2. Verify: no `voucher_value` written by the freeze; `credit_instruments` unchanged. **PASS if untouched.**

### TC-2.3 Offline voucher redemption
```bash
curl -s -X POST "$BASE/api/voucher-redeem" -H "Content-Type: application/json" \
  -d '{"newDraftRef":"#Dxxx","vchNumber":"VCH27-KAHSR-0001","vchValue":5000,"oldOrderNumber":"#1052"}'
```
1. Verify draft metafields: `voucher_value`=5000, `amount_to_be_collected` reduced by 5000, tags `vch-applied`,`vch-num:…`.
2. Supabase: `credit_instruments` voucher row → `status='redeemed'`, `target_draft_id`=DRAFT_ID.

### TC-2.4 Single-use gate (NEW — must block)
Precondition: a `voucher` row exists in `credit_instruments` (from TC-2.3 or the backfill), status `redeemed`.
1. Try to redeem the **same** `vchNumber` onto a **different** draft:
   ```bash
   curl -s -X POST "$BASE/api/voucher-redeem" -H "Content-Type: application/json" \
     -d '{"newDraftRef":"#Ddifferent","vchNumber":"VCH27-KAHSR-0001","vchValue":5000}'
   ```
2. **Expect HTTP 409** `already redeemed on …`. **PASS if blocked.**
3. Re-running on the **same** draft it was applied to → returns `alreadyApplied:true` (not 409).

### TC-2.5 Expired / voided gate
1. In Supabase set a test voucher row `expires_at` to yesterday → voucher-redeem it → **409 expired**.
2. Set another row `status='voided'` → voucher-redeem → **409 was voided**.

### TC-2.6 Voucher void
```bash
curl -s -X POST "$BASE/api/voucher-void" -H "Content-Type: application/json" \
  -d '{"newDraftId":"DRAFT_ID","vchNumber":"VCH27-KAHSR-0001"}'
```
1. Verify: `voucher_value` metafield removed, `amount_to_be_collected` recomputed up, `vch-*` tags stripped.
2. Supabase: row → `status='voided'`, `voided_at` set. Serial cancelled in `serial_ledger`.
3. Void after the draft converted → **409**.

---

## 3. CAD Advance (Phase 3) — CAD is a **custom line item titled "CAD Advance"**

### TC-3.1 Capture
1. Create a draft. Add a **custom line item** titled exactly `CAD Advance`, price ₹5,000.
2. Record a payment: tag `cash-5000`.
3. Edit the draft (fires the webhook). Verify metafields: `advance`=**5000**, `advance_date`=today, `advance_status`=**open**.
4. `amount_to_be_collected` = `total_price − 5000` (advance netted).
5. Idempotency: edit again → `advance_status` stays `open`, no duplicate.

### TC-3.2 Path A — resolved in the same draft
1. Continue TC-3.1's draft. Add the **real product** ₹50,000 (draft total now 55,000; advance still 5,000).
2. Verify `amount_to_be_collected` = 55000 − 5000 = **50000**; `amount_paid`=5000 → `amount_pending`=**45000**.
3. Convert draft → order. Verify order metafields carry `advance`, `advance_status`.

### TC-3.3 Path B — standalone advance redeemed later
1. **Advance order:** the TC-3.1 advance draft, converted to an order (call it `#ADV1`), `advance_status`=open.
2. **New sale draft:** create a fresh draft with a real product. Set `intake.advance_ref` = `#ADV1` (staff-fill metafield). Edit the draft.
3. On the webhook, verify new draft: `advance`=5000 written, `amount_to_be_collected` reduced by 5000, `intake.advance_ref` **cleared**.
4. Verify `#ADV1` order: `advance_status`=**redeemed**, `redeemed_against`=new draft name.

### TC-3.4 Path B gates
1. **Already redeemed:** repeat TC-3.3 with the same `#ADV1` on another draft → draft gets tag `advance-invalid: already redeemed`.
2. **Expired:** in Shopify set `#ADV1`'s `advance_date` to >365 days ago, set status back to open → redeem → tag `advance-invalid: expired …`.
3. **Not found:** `intake.advance_ref` = `#9999999` → tag `advance-invalid: not found …`.

---

## 4. Metafield carry-over (Phase 4)

### TC-4.1 Adjusted draft → order
1. Build a draft with **all** of: `exchange_note_value`, `voucher_value`, `old_gold_value`, `advance`, `amount_to_be_collected`, `amount_paid`, `amount_pending`.
2. Convert to an order.
3. On the ORDER, verify **every** key above is present with the **same** value (`copyDraftMetafieldsToOrder`).
4. Verify linkage **tags** carried (`exc-*`, `vch-*`).
5. Verify `intake.advance_ref` is **absent** on the order (intake namespace not copied — correct).
6. **PASS** only if no key is missing or mismatched.

---

## 5. Credit-instrument ledger + Recon (Phase 5)

### TC-5.1 Write-points populate the ledger
Run TC-2.3 (voucher redeem), TC-1.2 (exchange), TC-2.6 (void). After each, query `credit_instruments`:
- exchange note → one row, `status='redeemed'`, `target_draft_id` set.
- voucher redeem → row `redeemed`.
- void → row `voided`.

### TC-5.2 Backfill from logs
1. Run the Apps Script `backfillLedgerFromLogs` (see step 1 of the ops guide).
2. Verify `credit_instruments` now has one row per Voucher Log + Exchange Log entry; values & statuses match the sheets.
3. Re-run → counts unchanged (**idempotent**).

### TC-5.3 Recon report — summary identity
```bash
curl -s "$BASE/api/recon-ledger?view=summary" | python -m json.tool
```
- For each row check the identity: `issued_count == redeemed + outstanding + voided + expired` and `balances:true`.

### TC-5.4 Outstanding liability
```bash
curl -s "$BASE/api/recon-ledger?view=outstanding" | python -m json.tool
```
- Only `open` (non-expired) instruments listed; `days_to_expiry` correct; total = your live credit liability.

### TC-5.5 Tie-out
```bash
curl -s "$BASE/api/recon-ledger?view=tieout" | python -m json.tool
```
- Redeemed instruments show their `target_order_name`/`target_draft_id`.

### TC-5.6 Open-voucher lookup (dropdown source)
```bash
curl -s "$BASE/api/credit-instrument/open?customerId=CUSTOMER_ID&type=voucher" | python -m json.tool
```
- Returns that customer's `open`, non-expired vouchers only.

### TC-5.7 CSV
```bash
curl -s "$BASE/api/recon-ledger?view=outstanding&format=csv"
```
- Downloads a well-formed CSV.

> **KNOWN (verify later):** all `recon-ledger` views return `count:0` until `credit_instruments` has data.
> Run the log-backfill (§5.2) or let live redemptions flow first, then re-run TC-5.3–5.7. The
> `adjustment-report` (§6) already works today; the ledger recon is empty until populated.

---

## 6. Reporting

### TC-6.1 Adjustment report
```bash
curl -s "$BASE/api/adjustment-report?from=2026-04-01&to=2026-07-01" | python -m json.tool
```
- `count` matches orders in range; each row has gross/discount/voucher/exchange/old_gold/advance/net/paid/total.
- `totals` row = column sums. **Note:** historical orders may show `amount_to_be_collected == total_price` (fallback) — that's expected; new orders are exact.

### TC-6.2 Adjustment report via the sheet
- In the Recon sheet: fill B3/B4 dates → **📒 Recon → Adjustment Report** → table + bold TOTAL row written from row 8.

### TC-6.3 CSV
```bash
curl -s "$BASE/api/adjustment-report?from=2026-06-01&to=2026-06-30&format=csv"
```

---

## 7. Regression (must be unchanged)

- **TC-7.1 GoKwik link:** tag `send-link-5000` on a draft with a phone → link created, SMS/email sent, `payment_links` row. GoKwik webhook success → payment recorded, pending nets correctly.
- **TC-7.2 Cash tag partial→full:** as TC-1.1.
- **TC-7.3 Pine terminal push:** `/api/push-to-terminal` → Pine callback → payment recorded.
- **TC-7.4 Jewel reprice:** tag `recalculate-price` / `reprice` on a draft → line reprices, tag removed, no loop.
- **TC-7.5 Repair / PO flows:** unchanged (not touched by these commits).

---

## 8. Serialization cutover (REQUIRED for invoice numbering; independent of Phases 1–5)

**Current state (2026-07-01):** serialization is **OFF** — new orders get **no serial number** (nothing
minted since 2026-06-10). Existing test serials are OLD format (`TMNT-KA-HSR-1001` … counter at 1018).
This cutover is what resumes stamping, in the new `TM27-KAHSR-…` format. It does NOT affect the
adjustments/credits/recon/reporting flows, but invoice/document numbering will not work until it runs.
Parked by choice until backfill + void are proven across ALL doc types.

### TC-8.0 Wipe + retag procedure (run in order)
1. Supabase → run `services/serialization/migrate_reset.sql` (snapshots + wipes counters/ledger).
2. `fly secrets set SERIAL_CUSTOMER_ORDER=true SERIAL_REPAIR=true SERIAL_MEMO_TRANSFER=true SERIAL_PO=true`.
3. **Clear** old serial metafields on test orders (keeps `state_code`):
   `GET /api/serial/clear?nameFrom=1024&nameTo=1063&withState=false`
4. **Backfill** new-format customer_order serials — dry-run first:
   `GET /api/serial/backfill?docType=customer_order&nameFrom=1024&nameTo=1063&dryRun=true` → review →
   `…&dryRun=false`.
5. Other doc types re-mint on their next trigger tag (repair-complete, make-challan, make-transfer, PO ack).

### Then verify
- **TC-8.1** New order → `serial_code` = `TM27-KAHSR-00001` (≤16 chars, FY-scoped, `KA-HSR` present).
- **TC-8.2** Paid repair → `TS27-…`; free repair → `FS27-…`.
- **TC-8.3** `make-challan` tag → `DC-…`; `make-transfer` → `AURA-…`.
- **TC-8.4** Exchange/voucher allocate → `EXC27-…` / `VCH27-…` per-store; void cancels by full code.
- **TC-8.5** FY reset: peek shows the counter resets after Apr 1 IST.
- **TC-8.6** Old `TMNT-…` numbers are gone / re-minted; no collisions with new format.

---

## Sign-off checklist
- [ ] §1 net-to-collect (incl. self-heal & clamp)
- [ ] §2 voucher online freeze + offline + single-use/expired/void gates
- [ ] §3 CAD capture + Path A + Path B + all gates
- [ ] §4 carry-over (all keys on the order)
- [ ] §5 ledger write-points + backfill + recon identity + outstanding + open-lookup
- [ ] §6 reporting (JSON + sheet + CSV)
- [ ] §7 regression clean
- [ ] §8 serialization (if cutover done)
