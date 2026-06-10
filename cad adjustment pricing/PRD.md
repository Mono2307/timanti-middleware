# CAD Advance & Adjustment — PRD

_Status: DESIGN / not yet built. Add-on to the serialization system. Created 2026-06-10._

## 1. Problem
Before committing to a custom piece, customers pay a small **CAD rendering advance (₹1,000–5,000)**. Depending on what happens next, that advance must either become revenue on its own or be adjusted against a final purchase. Today there's no clean way to (a) number/track these advances, (b) carry the advance into a final order as a credit, or (c) handle a customer who buys *after* the advance was already booked as revenue.

## 2. Goal
A `cad` document type in the serialization system with its own per-store serial, a clear lifecycle from advance → resolution, and a deterministic adjustment path that **reuses existing infrastructure** (deposits + credit notes) instead of inventing bespoke vouchers.

## 3. Serial & identity
- New doc type **`cad`**, per-store: **`CAD-{STORE}-{SEQ}`** (e.g. `CAD-KA-HSR-1`), via the existing `allocate_serial` counter + registry.
- Created as a **Draft Order** holding the advance line item + payment.
- Metafields (namespace `custom`): the standard serial set (`document_type=cad`, `serial_code`, `serial_display`, `serial_no`, `state_code`) plus:
  - `cad_status` — `open | converted | adjusted` (lifecycle)
  - `cad_amount` — the advance value
  - `cad_ref` — written on the *final customer order* to link back to the CAD serial

## 4. Lifecycle (proposed clean flow)
A CAD advance is created as a draft and **stays a draft (open) until resolved** — typically reviewed at month-end.

```
                         ┌─────────────── customer buys ───────────────┐
   CAD advance (draft) ──┤                                              ▼
   CAD-KA-HSR-1          │                          Final customer order (TMNT-…)
   status=open          │                          - advance applied as a deposit/credit line
                         │                          - cad_ref = CAD-KA-HSR-1
                         │                          - CAD draft status=adjusted
                         │
                         └──── no purchase by cutoff ───► CAD draft → finished CAD ORDER
                                                          (rendering fee earned; status=converted)
```

### 4a. Customer buys (advance adjusts against final order)
- Build the final customer order; add the advance as a **deposit/credit** (reuse the existing `store_deposits` / partial-payment system, or a negative line item) equal to `cad_amount`.
- Set `cad_ref` on the final order; set the CAD draft `cad_status=adjusted`.
- The advance money already collected counts toward the final order's paid amount.

### 4b. No purchase by cutoff
- Convert the CAD draft into a finished **CAD order** (revenue: rendering fee earned). `cad_status=converted`. Serial unchanged.

### 4c. Edge case — CAD already converted to an order, then customer buys
Instead of a refund/voucher dance: **issue a Credit Note** (existing CN system, `CNTM-…`) for the CAD amount against the converted CAD order, and apply that CN to the new final order. The CAD order stays as-is (audit trail intact); the CN cleanly carries the value forward.

## 5. Why this is better than the original sketch
The original idea created a separate "CAD voucher", marked the CAD order "refunded", then adjusted — three bespoke steps. This design:
- keeps the advance a **draft** until the outcome is known (no premature revenue, no refund needed in the common case),
- reuses **deposits** for the buy-path and **credit notes** for the rare already-converted path,
- needs **no new voucher object** — only metafields + existing flows.

## 6. Integration points (when built)
- Registry: add `cad: { scope:'store', start:1, code:'CAD-{CODE}-{SEQ}' }`.
- Assignment trigger: a `make-cad` tag on the draft (mirrors `make-memo`), or the intake that creates the advance.
- Adjustment: a small endpoint `POST /api/cad/adjust { cadDraftId, finalOrderId }` that links them and writes the deposit/`cad_ref`.
- Reporting: `cad` shows up in `/api/serial-report` like any doc type; filter by `cad_status`.

## 7. Open questions (resolve before build)
- Cutoff: is it a hard month-end auto-convert (cron) or manual?
- Buy-path: deposit line vs negative line item — which does accounting prefer?
- Should an adjusted CAD's rendering fee be retained or fully credited if the customer buys?
- GST treatment of the advance vs the final sale.

## 8. Dependencies
- Serialization system (`services/serialization/`) — counter, registry, metafields.
- Existing deposit system (`store_deposits`, `store_deposit_payments`).
- Existing credit-note system (`services/exchange-cn/`, `CNTM-…`).
