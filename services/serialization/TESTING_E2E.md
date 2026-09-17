# Serialization — End-to-End Test Plan (no payments, no new orders)

_Companion to `TESTING_v2.md`. Same code (`origin/main`), same triggers — but every case here is
exercised **without marking anything paid and without creating a single order**. Use this to prove the
whole service (customer orders **and** draft orders) covers every case._

> **Throughout:** `BASE=https://timanti-middleware.fly.dev`, `STORE=auracarat.myshopify.com`.

---

## 0. The trick — why we never need a payment

A serial is minted by exactly one of four things, and **none of them is a payment**:

| Trigger | Fires on | How we trigger it in a test (free) |
|---|---|---|
| `orders/update` webhook → `/api/serial/order-serial` | Shopify pings it when an order changes | **Replay it ourselves** — POST `{id,name}` of an *existing* order. The handler only *reads* that order's metafields by id and mints; it never touches money or creates anything. |
| draft `make-memo`/`make-transfer` tag + save | Saving a draft order | Tag a **scratch draft** and hit Save. Drafts are never "paid". |
| `repair-complete` (via `/repairs/set-complete`) | Staff marks a repair done | Run set-complete on a scratch repair draft. No charge involved. |
| PO **Acknowledge** action link / `/api/po-action?action=acknowledge` | HQ clicks the email link | Hit the link/endpoint directly. |
| Credit note `/api/serial/allocate {docType:credit_note}` | Explicit API call | Just call it. |

So the **entire surface is reachable by replaying webhooks against resources that already exist** plus
a few explicit endpoints. We mutate only `custom.*` metafields + the `serial_ledger` / `serial_counters`
tables, and we can wipe both afterwards (Section 8).

**Golden rule for clean numbers:** customer_order and repair serials are **permanent** (no void path).
So during testing, do the destructive/idempotency work on **scratch drafts** and on **counters you reset
afterward** — not on live customer orders you care about.

---

## 1. Pick your scratch resources (one-time)

Reserve these in the Shopify admin before you start and write the ids here:

- **Scratch order** — any one existing order you don't mind numbering (e.g. a test/demo order). `ORDER_ID=__________`, name `#____`.
- **Scratch draft A** (repair) — an open draft order. `DRAFT_A=__________`
- **Scratch draft B** (memo/transfer) — another open draft. `DRAFT_B=__________`
- A spare **store code** to test with, e.g. `KA-TEST`, so test serials are visibly segregated from real `KA-HSR` numbers.

> Using `KA-TEST` (a code no real location uses) means you can later just `delete=true` its counter rows
> and the live sequences are untouched. Strongly recommended.

---

## 2. Pre-flight (read-only, run first)

```bash
# App is alive + report reads the ledger
curl -s "$BASE/api/serial-report?docType=customer_order" | head -c 400

# Counters healthy (next >= max minted seq)
curl -s "$BASE/api/serial/peek?docType=customer_order&state=KA-HSR"
curl -s "$BASE/api/serial/peek?docType=repair&state=KA-TEST"
```
SQL sanity (Supabase):
```sql
select doc_type, store_code, count(*), min(seq), max(seq) from serial_ledger group by 1,2 order by 1,2;
select * from serial_counters order by doc_type, state_code;
```

---

## 3. Coverage matrix (what "all cases" means)

| # | Doc type | Case | Trigger used (free) | Expected |
|---|---|---|---|---|
| C1 | customer_order | online order, state_code set | replay `order-serial` | `TMNT-KA-TEST-{seq}`, ledger `active` |
| C2 | customer_order | already numbered | replay `order-serial` again | **no** re-mint (idempotent) |
| C3 | customer_order | no state_code | replay `order-serial` | skip, no row |
| C4 | customer_order | order is NOT cancellable | n/a | no cancel path exists (locking rule) |
| C5 | customer_order | backfill of punched orders | `backfill` dry-run | predicts numbers, allocates nothing |
| R1 | repair | free repair | `repair-free` tag + complete | **no** ledger row |
| R2 | repair | paid/normal repair | `repair-complete` | `REP-KA-TEST-{seq}`, draft stamped |
| R3 | repair | idempotency | re-save completed draft | still one row |
| R4 | repair | no state_code | complete blank-state draft | skip, no row |
| R5 | repair | not cancellable | n/a | no void path (locking rule) |
| M1 | memo | make-memo, state+delivery | `make-memo` tag | `MEMO-KA-TEST/MH-TEST-{seq}`, tag cleared |
| M2 | memo | missing delivery_code | `make-memo` tag | skip until delivery set |
| M3 | memo | void | `cancel-memo` tag | ledger → `cancelled`, tag cleared |
| T1 | transfer | make-transfer | `make-transfer` tag | `TRANSFER-KA-TEST/MH-TEST-{seq}` |
| T2 | transfer | void | `cancel-transfer` tag | ledger → `cancelled` |
| P1 | po | store_code captured | `raise-po` on order | `po_records.store_code` set |
| P2 | po | mint on acknowledge | acknowledge link | `PO-KA-TEST-{seq}` |
| P3 | po | void | cancel link | ledger → `cancelled` |
| N1 | credit_note | allocate | `/api/serial/allocate` | `CNTM-{seq}`, ledger `active` |
| N2 | credit_note | void before expiry | `cancel-by-code` | ledger → `cancelled` |
| X1 | all | counter monotonic | after any void | next mint skips the retired seq |
| X2 | all | report JSON + CSV + status filter | `/api/serial-report` | rows incl. `status`,`cancelled_at` |

---

## 4. Customer orders — no payment, replay the webhook

**C1 — mint on an existing order.** Set the store code, then replay the webhook against the real order id:
```bash
# 1. stamp staff state_code on the scratch order (no money, just a metafield)
curl -s "$BASE/api/serial/set-state?orderId=$ORDER_ID&code=KA-TEST"

# 2. replay the orders/update webhook (this is exactly what Shopify POSTs)
curl -s -X POST "$BASE/api/serial/order-serial" \
  -H 'content-type: application/json' \
  -d "{\"id\":$ORDER_ID,\"name\":\"#TEST\"}"

# 3. verify
curl -s "$BASE/api/serial-report?docType=customer_order" | grep -i "$ORDER_ID"
```
Expect: a `customer_order` ledger row `TMNT-KA-TEST-{seq}`, status `active`; order now carries
`custom.serial_code`. (Requires `SERIAL_CUSTOMER_ORDER=true`, already live.)

**C2 — idempotency.** Re-run step 2 above. Expect: **no** new row, counter unchanged, log shows no mint
(`mf.serial_code` already present → returns early).

**C3 — no state_code → skip.** Clear state first, then replay:
```bash
curl -s "$BASE/api/serial/clear?orderId=$ORDER_ID&withState=true"   # removes serial + state
curl -s -X POST "$BASE/api/serial/order-serial" -H 'content-type: application/json' -d "{\"id\":$ORDER_ID}"
```
Expect: no row (handler returns at "store code not set yet").

**C4 — order not cancellable (locking rule).** Confirm the route is gone:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/api/serial/order-cancelled"   # expect 404
```
There is intentionally no way to void a customer_order — a cancelled/refunded order keeps its number.

**C5 — backfill dry-run** (predicts, allocates nothing — safe even though flag is on):
```bash
curl -s "$BASE/api/serial/backfill?nameFrom=1038&nameTo=1060&dryRun=true" | head -c 800
```
Expect: `dryRun:true`, a `processed[]` list with `predicted_serial_code`, and `serial_counters` unchanged
(re-check `peek`).

---

## 5. Draft orders — repairs (`SERIAL_REPAIR=true`)

Set the flag: `flyctl secrets set SERIAL_REPAIR=true` (rolling restart). Use **DRAFT_A**.

Prep: in admin, set `DRAFT_A` metafield `custom.state_code = KA-TEST`.

- **R1 free repair = no number:** tag `DRAFT_A` `repair-free`, run it to complete.
  `select * from serial_ledger where doc_type='repair' and resource_id='$DRAFT_A';` → **0 rows**.
- **R2 paid repair mints:** remove `repair-free`, run the normal flow to `repair-complete`
  (`/repairs/set-complete` for that draft — no charge). Expect one row `REP-KA-TEST-1`; draft has
  `custom.serial_code`.
- **R3 idempotency:** re-save `DRAFT_A` (re-fires `draft_orders/updated`). Still exactly one row; counter
  not advanced.
- **R4 no state_code:** on a blank-state draft, complete it → log `no state_code set — skipping mint`, no row.
- **R5 not cancellable:** there is no repair void path — confirm cancelling/refunding leaves the REP row `active`.

Verify after: `curl -s "$BASE/api/serial-report?docType=repair"`.

---

## 6. Draft orders — memo / transfer (`SERIAL_MEMO_TRANSFER=true`)

`flyctl secrets set SERIAL_MEMO_TRANSFER=true`. Use **DRAFT_B**.

Prep in admin: `custom.state_code = KA-TEST`, `custom.delivery_code = MH-TEST`.

- **M1:** tag `DRAFT_B` `make-memo`, Save. Expect ledger `memo` row `MEMO-KA-TEST/MH-TEST-1`, draft stamped,
  and the `make-memo` tag **removed** (so the webhook stops re-firing). Verify via report `docType=memo`.
- **M2 missing delivery:** on a draft with no `delivery_code`, tag `make-memo` → log
  `no delivery_code yet — skipping`, no row. (Add delivery_code, re-save → then it mints.)
- **M3 void:** tag the minted draft `cancel-memo`, Save → ledger row `cancelled`, tag removed.
- **T1:** tag `make-transfer` → `TRANSFER-KA-TEST/MH-TEST-1`.
- **T2 void:** tag `cancel-transfer` → `cancelled`.

> Optional: a `state:XX` tag overrides `custom.state_code` for the store code — add `state:MH-TEST` and
> confirm the prefix follows the tag.

---

## 7. PO and Credit Note

**PO (`SERIAL_PO=true`)** — uses the scratch order, still no payment:
- **P1:** on `$ORDER_ID` set `custom.state_code=KA-TEST`, add tag `raise-po`. Expect a new `po_records`
  row with `store_code='KA-TEST'`. (`select draft_order_name, store_code, status from po_records order by created_at desc limit 5;`)
- **P2 acknowledge:** open the Acknowledge link from the PO email, or:
  `curl -s "$BASE/api/po-action?action=acknowledge&token=<token>"`. Expect `po` ledger row `PO-KA-TEST-1`,
  PO draft stamped.
- **P3 cancel:** click **Cancelled** (or the cancel action) → ledger row `cancelled`, number retired.

**Credit note (no flag):**
```bash
# N1 — allocate
curl -s -X POST "$BASE/api/serial/allocate" -H 'content-type: application/json' -d '{"docType":"credit_note"}'
#   → { allocated:true, serial_no:<seq>, serial_code:"CNTM-<seq>" }   ; ledger row active

# N2 — void by seq (the seq from N1)
curl -s -X POST "$BASE/api/serial/cancel-by-code" -H 'content-type: application/json' \
  -d '{"docType":"credit_note","serialNo":<seq>}'
#   → status:"cancelled"
```
(Full customer flow — sheet "Void Credit Note", expiry block — is in `TESTING_v2.md §5b`.)

**X1 monotonic-after-void:** allocate another CN → its seq is **N1's seq + 1** (the voided number is never
reused). Same principle confirms PO/memo voids don't recycle numbers.

**X2 report:**
```bash
curl -s "$BASE/api/serial-report?docType=po"
curl -s "$BASE/api/serial-report?docType=credit_note&status=cancelled&format=csv"
```
Expect JSON/CSV rows including `status` and `cancelled_at`.

---

## 8. Cleanup — leave the store exactly as you found it

```bash
# 1. strip machine-written metafields from the scratch resources (keeps staff state_code)
curl -s "$BASE/api/serial/clear?orderId=$ORDER_ID"
curl -s "$BASE/api/serial/clear?draftOrderId=$DRAFT_A"
curl -s "$BASE/api/serial/clear?draftOrderId=$DRAFT_B"

# 2. delete the test counter rows so KA-TEST sequences vanish (live KA-HSR etc untouched)
curl -s "$BASE/api/serial/counter?docType=customer_order&state=KA-TEST&delete=true"
curl -s "$BASE/api/serial/counter?docType=repair&state=KA-TEST&delete=true"
curl -s "$BASE/api/serial/counter?docType=memo&state=KA-TEST&delete=true"
curl -s "$BASE/api/serial/counter?docType=transfer&state=KA-TEST&delete=true"
curl -s "$BASE/api/serial/counter?docType=po&state=KA-TEST&delete=true"
```
Then in Supabase delete the test ledger rows:
```sql
delete from serial_ledger where store_code='KA-TEST';
-- credit_note rows are global; delete just your test seqs:
delete from serial_ledger where doc_type='credit_note' and seq in (<the seqs you minted>);
```
Finally flip every test flag back off:
```bash
flyctl secrets set SERIAL_REPAIR=false SERIAL_MEMO_TRANSFER=false SERIAL_PO=false
```
(Leave `SERIAL_CUSTOMER_ORDER` as it was — it's the live one.)

---

## 9. Regression (after each flag flip / at the end)
- Live customer-order minting still fires on real `orders/update` (`SERIAL_CUSTOMER_ORDER`).
- Counter ≥ max(seq) everywhere:
  ```sql
  select doc_type, store_code, max(seq),
    (select current_value from serial_counters c where c.doc_type=l.doc_type and c.state_code=l.store_code)
  from serial_ledger l group by doc_type, store_code;
  ```
- `flyctl logs` shows `[serial]` lines for each mint/skip, and nothing minted for the skip cases.
- No real order was created and nothing was marked paid during the entire run. ✅
