# Self-Verify Runbook — Prove the automated test results yourself

**For:** the founder, running it personally · **Created:** 2026-07-05
**Goal:** independently re-run the checks behind `UAT_ACCEPTANCE.md` — **without** any draft→final
invoice conversion, **without** creating a real order, and **without** marking anything paid for real.

Every command below is written for **Windows PowerShell** (your default shell). Just open PowerShell and
paste. Read-only checks can also be pasted straight into a **web browser** if you prefer.

> **What's excluded (on purpose, per your ask):** anything that converts a draft into a final order —
> that's criteria **D1** (metafield carry-over), CAD **Path A/B** conversion steps (C2/C3), and the
> "convert draft → order" tail of the golden scenario. Those need a separate controlled pass.

---

## 0. One-time setup (2 minutes)

**a) Set the base address.** Paste this once per PowerShell window:

```powershell
$BASE = "https://timanti-middleware.fly.dev"
```

**b) A tiny helper so results are readable.** Paste this once — it pretty-prints JSON:

```powershell
function Check($url) { Invoke-RestMethod $url | ConvertTo-Json -Depth 8 }
```

**c) Pick scratch resources in Shopify admin** (so you never touch a real customer):
- **One scratch draft order** you don't mind editing. Note its numeric id → you'll use it as `DRAFT`.
- **One existing scratch order** you don't mind numbering → its numeric id as `ORDER`.
- We'll number everything with a fake store code **`KA-TEST`** so it's visibly separate from real
  `KA-HSR` numbers and can be deleted at the end.

```powershell
$DRAFT = "PUT_DRAFT_ID_HERE"
$ORDER = "PUT_ORDER_ID_HERE"
```

**How to read a result:** each command prints a block of text. Under each step I tell you the one or two
values to look at. If they match → write ✅ next to that criterion. If not → write ❌ and copy the output.

---

## 1. Money engine — the "what does the customer pay?" checks

These all run on a **draft** and only read its metafields. No conversion, no real payment.

> **Reset between tests:** to reuse the same draft cleanly, remove any adjustment tags/metafields in
> admin, or just use a fresh scratch draft per test. The numbers below assume a fresh draft.

### Step 1.1 — Baseline: a plain draft with no adjustments  *(criterion A-series baseline)*
1. In admin, make `DRAFT` have **one item at ₹10,000**, no discount.
2. Read it:
```powershell
Check "$BASE/api/draft-order-metafields?draftOrderId=$DRAFT"
```
**Expect:** `amount_to_be_collected` = **10000**. → ✅ if it matches.

### Step 1.2 — One post-tax credit reduces the collectible  *(A3, A4)*
1. Draft with one item **₹20,000**.
2. Apply a ₹5,000 exchange note:
```powershell
$body = @{ newDraftRef="#D$DRAFT"; excNumber="EXC-TEST-1"; excValue=5000; oldOrderNumber="#1052"; customerName="TEST" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$BASE/api/exc-redeem" -ContentType "application/json" -Body $body
```
3. Re-read metafields (Step 1.1 command).
**Expect:** `exchange_note_value` = 5000, `amount_to_be_collected` = **15000**. → ✅
*(Before the fix this wrongly showed 5000 still pending — this is the bug that was closed.)*

### Step 1.3 — Balance self-heals after a part-payment  *(A6 — the most important fix)*
1. Draft, item **₹20,000**. In admin add tag **`cash-8000`** (records an ₹8,000 part-payment).
2. Read → `amount_pending` should be **12000**.
3. Now apply a ₹5,000 exchange note (as Step 1.2, change `excNumber` to `EXC-TEST-2`).
4. In admin add tag **`cash-7000`**.
5. Read again.
**Expect:** `amount_pending` = **0** (it re-based to 15000 and 15000 was paid). → ✅

### Step 1.4 — Balance uses net, not full bill  *(A7)*
On a draft with net collectible ₹7,000, record ₹999 paid (`cash-999` tag), read metafields.
**Expect:** `amount_pending` = **6001** (not 9001). → ✅

### Step 1.5 — Over-adjustment is clamped, never negative  *(A8)*
Draft item **₹10,000**, apply a **₹12,000** exchange note (Step 1.2 with `excValue=12000`).
**Expect:** `amount_to_be_collected` = **0** (never a negative number). → ✅

### Step 1.6 — Old gold auto-values at the live rate  *(A2)*
1. On the draft set metafields `intake.old_gold_weight = 10`, `intake.old_gold_purity = 22`, then **edit
   the draft** (any small edit fires the valuation).
2. Read metafields.
**Expect:** `old_gold_value` is filled in automatically (≈ 10 × today's 22kt buying rate). → ✅
*(Exact rupees depend on the live rate table — just confirm it auto-filled a sensible number.)*

---

## 2. Vouchers — the protection checks

### Step 2.1 — Redeem a voucher onto a draft  *(sets up 2.2)*
```powershell
$body = @{ newDraftRef="#D$DRAFT"; vchNumber="VCH27-KAHSR-0001"; vchValue=5000; oldOrderNumber="#1052" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$BASE/api/voucher-redeem" -ContentType "application/json" -Body $body
```
**Expect:** response OK; `voucher_value` = 5000 on the draft, collectible drops by 5000. → ✅

### Step 2.2 — Same voucher on a DIFFERENT draft is blocked  *(B1 single-use)*
```powershell
$body = @{ newDraftRef="#Dsome-other-draft"; vchNumber="VCH27-KAHSR-0001"; vchValue=5000 } | ConvertTo-Json
try { Invoke-RestMethod -Method Post -Uri "$BASE/api/voucher-redeem" -ContentType "application/json" -Body $body }
catch { "BLOCKED as expected: " + $_.Exception.Response.StatusCode }
```
**Expect:** it prints **BLOCKED … 409** (already redeemed). → ✅

### Step 2.3 — Re-running on the SAME draft is a harmless no-op  *(B6)*
Repeat Step 2.1 exactly.
**Expect:** response says `alreadyApplied:true` — **not** an error. → ✅

### Step 2.4 — Void the voucher restores the balance  *(B5)*
```powershell
$body = @{ newDraftId="$DRAFT"; vchNumber="VCH27-KAHSR-0001" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$BASE/api/voucher-void" -ContentType "application/json" -Body $body
```
**Expect:** `voucher_value` removed, `amount_to_be_collected` goes back up, `vch-*` tags stripped. → ✅

> **Expired / cancelled voucher refusals (B2, B3)** need a row edited directly in the Supabase database
> (set `expires_at` to yesterday, or `status='voided'`, then re-redeem → expect 409). If you want to run
> those, do it from the Supabase table editor — tell me and I'll give you the exact rows to change.

---

## 3. CAD advance — the part that needs NO conversion  *(C1 capture only)*

1. On `DRAFT`, add a **custom line item titled exactly `CAD Advance`, price ₹5,000**.
2. Add tag **`cash-5000`**. Edit the draft (fires the webhook).
3. Read metafields.
**Expect:** `advance` = **5000**, `advance_status` = **open**, and `amount_to_be_collected` reduced by
5000. → ✅
*(The "redeem weeks later" and "Path A convert to order" parts are the excluded conversion tests.)*

---

## 4. Serialization — invoice numbering (all no-payment, no conversion)

### Step 4.1 — Pre-flight read (browser-friendly)  *(sanity)*
Paste these into a browser, or:
```powershell
Check "$BASE/api/serial-report?docType=customer_order"
Check "$BASE/api/serial/peek?docType=customer_order&state=KA-HSR"
```
**Expect:** the report returns rows; peek shows a `next` number ≥ the highest issued. → ✅

### Step 4.2 — Mint a number by replaying the webhook  *(E1)*
This numbers your scratch `ORDER` with the fake `KA-TEST` code — it does **not** create anything.
```powershell
Invoke-RestMethod "$BASE/api/serial/set-state?orderId=$ORDER&code=KA-TEST"
$body = @{ id=[int]$ORDER; name="#TEST" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$BASE/api/serial/order-serial" -ContentType "application/json" -Body $body
Check "$BASE/api/serial-report?docType=customer_order"
```
**Expect:** a new row like `TM27-KATEST-00001` (or `TMNT-KA-TEST-…` on the old scheme), status active. → ✅

### Step 4.3 — Running it again does NOT create a second number  *(E2 idempotent)*
Re-run just the POST line from 4.2.
**Expect:** **no** new row, the count is unchanged. → ✅

### Step 4.4 — No state code → it waits, no number burned  *(E3)*
```powershell
Invoke-RestMethod "$BASE/api/serial/clear?orderId=$ORDER&withState=true"
$body = @{ id=[int]$ORDER } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$BASE/api/serial/order-serial" -ContentType "application/json" -Body $body
```
**Expect:** no new number minted (handler stops at "store code not set"). → ✅

### Step 4.5 — Backfill dry-run predicts numbers but allocates nothing  *(safety)*
```powershell
Check "$BASE/api/serial/backfill?nameFrom=1038&nameTo=1060&dryRun=true"
```
**Expect:** `dryRun:true`, a `processed` list with `predicted_serial_code`, and the counters unchanged
(re-run the peek from 4.1 to confirm). → ✅

> **Repair / challan / transfer / PO numbering (E4–E6)** are driven by Shopify **tags** (`repair-complete`,
> `make-challan`, `make-transfer`, PO acknowledge) and require their feature flags to be on. These are
> heavier to set up. If you want to cover them, ping me and I'll give you the exact tag + flag steps.

---

## 5. Reporting — read-only, safe to run anytime  *(G1, G2)*

Paste into a browser or PowerShell:
```powershell
Check "$BASE/api/adjustment-report?from=2026-04-01&to=2026-07-01"
Check "$BASE/api/recon-ledger?view=outstanding"
```
**Expect:**
- Adjustment report: a `count`, one row per order with gross/discount/voucher/exchange/old_gold/advance/
  net/paid, and a `totals` row that sums the columns. → ✅ (this is the ₹30.4L / 40-order check)
- Outstanding: your live voucher + exchange-note liability total. → ✅ (the ₹2,355-style figure)

---

## 6. Payment rails — optional regression  *(F2 is the easy one)*

**Cash tags partial→full (F2)** — pure draft, no conversion:
1. Fresh draft, item **₹10,000**. Add tag `cash-4000` → read → `amount_pending` = **6000**.
2. Add tag `cash-6000` → read → `amount_pending` = **0**, `payment_status` = full. → ✅

> GoKwik link (F1) and Pine terminal (F3) push real payment rails and are best left to a controlled
> pass — skipping here.

---

## 7. Cleanup — leave the store exactly as you found it

```powershell
# strip machine-written metafields from the scratch resources (keeps your staff state_code)
Invoke-RestMethod "$BASE/api/serial/clear?orderId=$ORDER"
Invoke-RestMethod "$BASE/api/serial/clear?draftOrderId=$DRAFT"

# delete the fake KA-TEST counter so those test numbers vanish (real KA-HSR untouched)
Invoke-RestMethod "$BASE/api/serial/counter?docType=customer_order&state=KA-TEST&delete=true"
```
Then in admin remove any `cash-*`, `vch-*`, `exc-*` tags and the `CAD Advance` line you added to the
scratch draft. (Any test ledger rows under `KA-TEST` / `EXC-TEST-*` can be deleted from Supabase — I can
give you the one-line SQL if you want.)

---

## Your score sheet

Tick these as you go — they mirror `UAT_ACCEPTANCE.md`:

| Ran it | Criterion | Step | Passed? |
|---|---|---|---|
| ☐ | A2 old-gold auto-value | 1.6 | |
| ☐ | A3/A4 credit reduces collectible | 1.2 | |
| ☐ | A6 self-heal | 1.3 | |
| ☐ | A7 net-not-full | 1.4 | |
| ☐ | A8 clamp | 1.5 | |
| ☐ | B1 voucher single-use | 2.2 | |
| ☐ | B5 voucher void | 2.4 | |
| ☐ | B6 same-draft no-op | 2.3 | |
| ☐ | C1 CAD capture | 3 | |
| ☐ | E1 mint number | 4.2 | |
| ☐ | E2 idempotent | 4.3 | |
| ☐ | E3 no-state waits | 4.4 | |
| ☐ | G1 adjustment report | 5 | |
| ☐ | G2 outstanding report | 5 | |
| ☐ | F2 cash partial→full | 6 | |

**Excluded (need draft→final conversion — separate pass):** D1 carry-over, C2/C3 advance-redeem-later,
B7 voucher-online-at-checkout, and any "convert draft to order" step.

---

### If a command errors

- **401 / permission** — the endpoint may need an API key; send me the exact error and I'll adjust.
- **A voucher/exchange test says "already redeemed"** from a previous run — change the `EXC-TEST-n` /
  `VCH27-…` number to a fresh one, or clean up the row in Supabase first.
- **Anything unexpected** — copy the whole printed block to me; don't retry blindly.
