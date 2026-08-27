# CAD Advance — tracking, payments-table wiring, and expiry control

_Status: SPEC LOCKED with founder 2026-08-24. Supersedes `services/cad adjustment pricing/PRD.md` (v2)
on arithmetic, serialization and lifecycle. The v2 PRD's capture/redeem plumbing stays._

## 0. What changes and why

The advance nets correctly on a bill today, but the system cannot answer "what advances are
outstanding" and cannot tell accounts when an unearned advance has aged past a year. Three gaps:

1. `advance_status` is only ever written `open` (capture) or `redeemed` (Path B). **Nothing ever
   writes `applied`** — so a Path-A advance consumed the same week is indistinguishable from one
   nobody has claimed. `expired` is specified and never written by anything.
2. Advances live only as metafields on Shopify documents. No ledger row, so no register, no report,
   no sweep — unlike vouchers and exchange notes, which sit in `credit_instruments`.
3. The advance is excluded from `amount_paid` (`installments.js:48`), which under the SOP where the
   CAD line stays on the draft **over-collects by the advance amount**. See §1.

## 1. The arithmetic (locked — revised 2026-08-25)

**A CAD advance is a PAYMENT, not an adjustment.** It is cash the customer handed over. It belongs in
`amount_paid` as an installment leg and nowhere else.

Rule, one line:

> The bill is whatever was actually sold. `custom.advance` is **never** deducted post-tax. The CAD
> Advance line comes **off** the draft the moment a real product joins it.

| Case | Total | Deduction | Paid (legs) | Pending | Outlay |
|---|---|---|---|---|---|
| Standalone advance draft | 5,000 (the CAD line) | none | 5,000 | 0 | 5,000 |
| Path A — ring added to same draft | **50,000** (CAD line removed) | none | 5,000 | 45,000 | **50,000** |
| Path B — new order, advance referenced | 50,000 | none | 5,000 absorbed + 45,000 | 45,000 | **50,000** |

**A ₹50,000 ring is never billed at 55,000.** The CAD Advance line exists only to give a standalone
advance something to bill against; once the customer is buying a ring, the ring is the bill and the
advance is money already paid toward it. `handleAdvanceLineRemoval` strips the line automatically —
it is not left to staff, because forgetting would over-bill by the advance.

`custom.advance` survives on the document as the tracking amount (the register, and Path B's lookup).
It just never moves a number.

### Two models rejected on the way here

- **Leave the CAD line on and deduct it back off post-tax** (built first, reverted). Reaches the same
  ₹50,000 outlay, but the draft passes through 55,000 and the invoice prints a ₹5,000 charge with a
  ₹5,000 credit facing it. Founder, 2026-08-25: *"there is no scenario in which it becomes 55,000."*
  It also made the balance depend on a deduction firing — any slip over-collects by the advance.
- **Charge the CAD fee on top** (outlay 55,000). Rejected: Path B absorbs the advance, so the same
  customer would pay 55,000 for buying quickly and 50,000 for buying eight months later.

### What was wrong before any of this

`amount_pending = amount_to_be_collected − amount_paid`, where `amount_to_be_collected` subtracted
`custom.advance` and `amount_paid` **excluded** the advance leg (`installments.js:48`). With the CAD
line on the draft that gave 55,000 → 50,000 collectible → 0 paid → **50,000 pending**: a ₹55,000
outlay for a ₹50,000 ring. UAT C1 signed off ₹45,000 pending; the installment refactor changed it
without anyone noticing, because no advance had ever run in production.

## 2. Payments table (locked)

- **Path A** — installment 1 stays exactly as it is: real value, **real tender mode** (cash/upi/card),
  real date, counted in `amount_paid`. Its `type` stays `cad_advance` so the invoice prints
  **"Design Advance"**. Mode is NOT overwritten: recon matches collections by mode
  (`recon.js:369-378`), so relabelling would orphan a real ₹5,000 collection in its month.
  The balance goes to installment 2 as a normal leg.
- **Path B** — the referenced advance is **absorbed as its own leg** in the next free slot:
  `value` = advance, `mode` = **`CAD Advance`** (a new enum member — no money moves on this document,
  so there is no real tender to record), `date` = redemption date, `type` = `cad_advance`.
  `custom.advance` is **not** written on the redeeming draft; the leg is the whole mechanism.

**Nothing is deducted post-tax in either path.** The `Less: Design Advance` row has been removed from
every invoice template — an advance appears once, in the payment table, as money received.

### Consequences

- `sumInstallments` stops excluding `cad_advance` legs — they are money received.
- `installment_N_type` must exist for **all four slots** (only slot 1 has it today, and
  `readInstallments` hardcodes `n === 1`). A Path-B absorbed leg is rarely slot 1.
- `CAD Advance` is unioned into the payment-mode enum. Never narrow the enum below what the server
  writes, or the leg silently fails to record.

## 3. Lifecycle (locked)

The dividing line is **draft vs order**: committed to a draft is reversible, converted to an order is
final. Same shape as vouchers and exchange notes.

| Status | Written when |
|---|---|
| `open` | capture — advance paid, not committed to any purchase |
| `applied` | committed to a draft, reversible. Path A: a product is added to the draft the advance sits on (line removal). Path B: the advance is referenced on a new sale draft. Blocks a second draft claiming it — the redeem gate accepts `open` only. |
| `redeemed` | **final** — that draft converted to an order. Only here is the advance genuinely spent, and only here does `redeemed_against` get a real order number instead of a draft number. |
| `expired` | 365 days from `advance_date` while still `open` |

An advance-only order stays `open` through conversion: nothing was bought, so nothing was spent.

**Known gap:** an `applied` advance on a draft that is then abandoned or deleted stays `applied`.
Vouchers solve this with `revertApplied` on draft delete (`procurement/routes.js:74`); the same hook
is not yet wired for advances, so an abandoned draft needs a manual reset to `open`.

- The 365-day clock stays on `custom.advance_date` (the day payment was recorded). Unchanged.
- **Expiry blocks redemption.** The existing gate already requires `advance_status === 'open'`
  (`server.js:2417`), so writing `expired` refuses the redeem with `advance-invalid: already expired`.
  No override path — founder chose the hard cut-off.
- `redeemed_against` currently records the **draft** name (`#D203`) because redemption happens on a
  draft (`server.js:2423`). Fix: back-fill the real order number when that draft converts.

## 4. The register — `credit_instruments`

Add `instrument_type = 'cad_advance'` alongside `voucher` / `exchange_note`. Reuses the whole
existing apparatus: `issued_at`, `expires_at`, `status`, `source_order_name`, `target_order_name`,
`effectiveStatus()`, and `/api/recon-ledger` — which reports it with no new endpoint.

| Column | Value |
|---|---|
| `instrument_type` | `cad_advance` |
| `serial_code` | source document name (`#D189` / `#1042`) — nothing is minted, so the document name is the key |
| `value` | advance amount |
| `issued_at` | `advance_date` |
| `expires_at` | `advance_date` + 365 days |
| `source_order_name` | the advance document |
| `target_order_name` | the order it was applied/redeemed against |
| `status` | `open` → `applied` \| `redeemed` \| `expired` |

Rows are written at **capture** (both paths — this is the "record it somewhere" ask) and updated at
apply / redeem / expiry. Unique on `(instrument_type, serial_code)`, so writes are idempotent.

## 5. Serialization (locked)

**Nothing is ever minted for a CAD advance** — not on the draft, not on conversion. It is not a
service invoice; the customer gets a payment confirmation, and the money is an advance against a
future order.

This needs a **new guard**: today a converted CAD-only order would pick up an ordinary
`TM27-KAHSR-000NN` customer-order serial from `/api/serial/order-serial`
(`src/modules/serialization/routes.js:236-246`). Skip the mint when every line on the order is a
CAD Advance line. Customer-order serials are permanent with no cancellation path, so this must be
right the first time.

## 6. Stale-draft auto-conversion (locked)

A CAD-advance-only draft that sits untouched converts on its own, so advances stop hiding in draft
state and land somewhere accounts can see.

- **Window: 30 days from `advance_date`.**
- Conditions: draft still open · carries a CAD Advance line · no other product line · `advance_status = open`.
- All validity rules keep running from `advance_date`, **not** from the conversion date — a draft
  converted on day 30 still expires on day 365 from payment.
- The resulting order gets no serial (§5).

**The sweep must call `completeShopifyOrder` directly, NOT `convertDraftToOrder`.**
`AUTO_CONVERT_DRAFT_TO_ORDER` is **false** in production (confirmed with the founder 2026-08-24), and
`convertDraftToOrder` early-returns whenever it is off (`server.js:143-148`) — the sweep would
silently no-op forever with nothing looking broken. Precedent for the direct call:
`/api/convert-to-order` (`server.js:3408-3418`), which bypasses the flag for a deliberate,
staff-initiated conversion. The 30-day sweep is the same kind of deliberate act. The global flag
stays off; this is the only place that steps around it.

Knock-on: with the flag off, every Path-A conversion is a manual staff action. `applied` hangs off
the draft-completed webhook, which fires regardless of who converts — so no change is needed, but
`applied` is only ever as timely as staff punching the order.

## 7. Accounts alert (locked)

Monthly. Two sections:

1. **Crossed the line** — advances that completed 365 days during the month just ended. Accounting
   treatment must move out of trade advances now.
2. **Crossing next** — advances completing 365 days in the next 30 days. Early warning.

Each row: document ref, customer, amount, `advance_date`, expiry date, current status. Section totals.

Runs in-process on `setInterval`, same pattern as `voucher_expiry_sweep.js` — no scheduler, no new
service, the Fly machine already stays up (`min_machines_running = 1`).

## 8. Change list

| File | Change |
|---|---|
| `src/modules/payments/installments.js` | `sumInstallments` counts `cad_advance` legs · `readInstallments` reads `installment_N_type` for all slots |
| `server.js` `syncAmountToCollect` | net `advance` only when a CAD line AND another product line are both present |
| `server.js` `handleAdvanceCapture` | drop the `amount_paid` rewrite · keep the type flag for the invoice label · write the ledger row |
| `server.js` `handleAdvanceRedeem` | write an absorbed leg (next free slot, mode `CAD Advance`) instead of `custom.advance` · update the ledger · record the real order number in `redeemed_against` |
| `server.js` draft-completed handler | **NEW** — Path A: stamp `advance_status = applied` + close the ledger row · back-fill `redeemed_against` for Path B |
| `src/modules/serialization/routes.js` | skip `customer_order` mint for CAD-advance-only orders |
| `src/modules/adjustments/credit_instruments.js` | `cad_advance` instrument type |
| `src/modules/adjustments/cad_advance_sweep.js` | **NEW** — 30-day stale-draft conversion · 365-day expiry · monthly accounts email |
| `src/modules/admin/routes.js` | `installment_2..4_type` definitions · union `CAD Advance` into the mode enum |
| `src/integrations/email/templates.js` | accounts expiry-digest template |

## 9. Open items — all closed 2026-08-24

- **No backfill needed.** `/api/adjustment-report?from=2026-01-01&to=2026-08-24` returns 70 orders,
  **zero** carrying `custom.advance`. The flow has never run for a real customer. Consequences:
  no ledger backfill, no historical `applied` reconstruction, and — most importantly — **no test CAD
  order has burnt a permanent `TM27-…` serial**, so the §5 guard lands before the first real one.
  Any advance sitting `open` on a draft today is test data and can be ignored.
- **§1 does not disturb live balances**, for the same reason. Founder confirmed no open drafts are
  affected.
- **`AUTO_CONVERT_DRAFT_TO_ORDER` is false.** See §6 — the only build consequence is that the sweep
  calls `completeShopifyOrder` directly. The webhook-ordering hazard this flag would have created is
  void.
- **`advance_date` UTC drift** (`server.js:2341`) — one day at the 365-day boundary between 00:00
  and 05:30 IST. Founder: not a problem. Left as-is.

## 10. Build — done 2026-08-25

All four stages are implemented and `npm run verify` is green (125 assertions, 83 routes).

| Stage | Landed in |
|---|---|
| Ledger + statuses | `credit_instruments.js` (`rekey`, `expireOverdue`, `listExpiringBetween`, `apply` takes order refs) · `handleAdvanceCapture` opens the row · new `handleAdvanceConversion` |
| Arithmetic §1/§2 | `installments.js` (`sumInstallments` counts every leg, `installment_N_type` on all slots, `installmentLegPatch` takes a type) · `advance` dropped from `syncAmountToCollect` entirely · new `handleAdvanceLineRemoval` strips the CAD line when a product is added · `handleAdvanceRedeem` absorbs a leg |
| Serialization guard §5 | `serialization/routes.js` — advance-only orders skip the mint |
| Sweeps + digest §6/§7 | new `cad_advance_sweep.js` · `buildCadAdvanceDigestHtml` · `GET|POST /api/cad-advance/sweep` |
| Shared vocabulary | new `cad_advance.js` — line predicates used by the webhook chain, the serial minter and the sweeps, so the three can never disagree on what a CAD line is |
| Tests | new `cad_advance.test.js` (15 assertions) · `installments.test.js` rewritten to the absorbed model |
| Invoices | six Liquid templates: `cad_advance` legs now count in Amount Received, and the `Less: Design Advance` deduction row is gone |

### Still to do by hand (cannot be done from code)

1. **Create the metafield definitions.** `POST /api/metafield-definitions/ensure?apply=true` — adds
   `installment_2..4_type` and unions `CAD Advance` into the payment-mode enum. **The enum matters:
   a choices validation is enforced on write, so until `CAD Advance` is in it, a Path B absorbed leg
   is rejected and the advance silently fails to reach the payments table.** Run the dry run first.
2. **Set `ACCOUNTS_EMAIL`** as a Fly secret. It falls back to `HQ_EMAIL` then `STORE_EMAIL`, so the
   digest always lands somewhere, but not necessarily with accounts.
3. **Paste the updated Liquid** into Shopify Order Printer — templates are not deployed by the
   middleware. Until then the invoice's "Amount Received" will disagree with the balance.
4. **Test with the on-demand sweep**: `/api/cad-advance/sweep?dryRun=true` reports what the daily
   loop would do and changes nothing. `?force=true` re-sends the digest past the once-a-month marker.
