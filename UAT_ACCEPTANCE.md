# Timanti Middleware — User Acceptance Criteria & Results

**Audience:** Founder / leadership · **Last updated:** 2026-07-05
**One consolidated, plain-English record of what the system must do, and whether it actually does it.**

This rolls together the money engine, serialization, payment rails, reporting, and regression into a
single acceptance record. Each row is an acceptance criterion (what "correct" means), how it was checked,
and the result. Engineering detail lives in the source plans linked at the bottom.

---

## How to read the status column

| Symbol | Meaning |
|---|---|
| ✅ **Verified** | Run against the live system, result matched the expected number/behaviour. |
| 🔧 **Fixed & verified** | A defect was found here during testing, corrected, and re-checked. |
| 🟡 **Live, not formally signed off** | Code is deployed and in use, but a structured pass/fail run was not recorded. |
| ⏳ **Not yet tested** | Deliberately parked; needs a controlled run. |

**Roll-up (2026-07-05):**

| Area | Verified | Live / not signed off | Not yet tested |
|---|---|---|---|
| Money engine (what the customer pays) | 11 criteria ✅ | — | — |
| Vouchers & credit instruments | 6 ✅ | — | 1 (online-at-checkout) |
| CAD / design advance | 1 ✅ (same-draft) | — | 2 (redeem-later, gates) |
| Draft → final invoice hand-off | — | — | 1 |
| Serialization | — | whole matrix 🟡 | formal E2E sign-off |
| Payment rails (GoKwik / Pine / cash) | — | 🟡 in production use | structured re-run |
| Reporting & recon | 2 ✅ | recon ledger 🟡 | — |

**Bottom line:** the **core money engine is verified correct to the rupee**. Serialization and the
payment rails are **live and in daily use but were never put through a formal signed-off test pass**, and
a small set of "final invoice" checks were intentionally parked. Those are the open items.

---

## A. Money engine — "what does the customer actually pay?"

*Source of results: live run, 2026-07-02 (`services/exchange-cn/CEO_TEST_REPORT.md`).*

| # | Acceptance criterion (plain English) | How we checked | Result |
|---|---|---|---|
| A1 | A festive **discount reduces the taxable bill** (only discounts change GST). | ₹1,00,000 − ₹5,000 → bill ₹95,000, GST on full amount. | ✅ Verified |
| A2 | **Old gold is auto-valued** at the live buying rate — no manual math. | 10 g @ 22kt → ₹1,27,350 (10 × ₹12,735). | ✅ Verified |
| A3 | **Exchange notes, vouchers, old-gold all apply *after* tax** (like cash), never reducing GST. | Full golden scenario. | ✅ Verified |
| A4 | **All credits stack to the correct net.** | 95k − 20k exch − 5k vch − 127k gold → **₹0 to collect**, credit-due flagged. | ✅ Verified |
| A5 | Balance **never shows a wrong inflated figure** when credits exceed the bill. | Same as A4 — shows ₹0, not a negative-turned-positive. | ✅ Verified |
| A6 | **Balance self-heals** when a credit is added *after* a part-payment. | Pay ₹8,000 → ₹12,000 due; add ₹5,000 exchange → balance corrects to **₹7,000**. | ✅ Verified |
| A7 | Balance is computed on the **net after credits, not the full bill**. | Net ₹7,000, ₹999 paid → pending **₹6,001** (not ₹9,001). | 🔧 Fixed & verified |
| A8 | **Over-adjustment is clamped** — collectible never goes negative. | ₹10,000 bill, ₹12,000 note → **₹0**. | ✅ Verified |
| A9 | A **design advance nets against the bill** and marks it paid when covered. | ₹5,000 advance vs ₹5,000 bill → ₹0, fully-paid. | ✅ Verified |
| A10 | When trade-ins cover the **whole** bill, the order **marks itself fully paid**. | Full-cover scenario. | 🔧 Fixed & verified |
| A11 | The **payment-status label saves** correctly (choice-list casing). | Re-checked after format-mismatch fix. | 🔧 Fixed & verified |

**Verdict: PASS.** Every combination landed on the exact right rupee.

---

## B. Vouchers & credit instruments

| # | Acceptance criterion | How we checked | Result |
|---|---|---|---|
| B1 | A voucher **works only once**. | Reused the same voucher on a 2nd bill → blocked (HTTP 409). | ✅ Verified |
| B2 | **Expired** vouchers are refused with a clear reason. | Past-expiry row → 409 expired. | ✅ Verified |
| B3 | **Cancelled/voided** vouchers are refused. | Voided row → 409. | ✅ Verified |
| B4 | Using a voucher **at the counter kills its online code** (no cross-channel double-use). | Offline redeem freezes the online code. | ✅ Verified |
| B5 | **Voiding a voucher** restores the collectible and retires the number. | `voucher-void` → metafield removed, balance recomputed up, serial cancelled. | ✅ Verified |
| B6 | Redeeming on the **same draft twice** is a no-op, not an error. | Returns `alreadyApplied:true`, not 409. | ✅ Verified |
| B7 | A voucher applied **online at checkout** is frozen post-tax with GST base = gross − other promo. | — | ⏳ Not yet tested (needs a test online order) |

---

## C. CAD / design advance

| # | Acceptance criterion | How we checked | Result |
|---|---|---|---|
| C1 | An advance **captured and resolved in the same draft** nets correctly and carries to the order. | ₹5,000 advance + ₹50,000 product → collect ₹50,000, paid ₹5,000 → pending ₹45,000. | ✅ Verified |
| C2 | A **standalone advance redeemed weeks later** on a new sale nets and marks the original redeemed. | — | ⏳ Not yet tested |
| C3 | Redeem **gates**: already-redeemed / expired / not-found are each rejected with a reason tag. | — | ⏳ Not yet tested |

---

## D. Draft → final invoice hand-off

| # | Acceptance criterion | How we checked | Result |
|---|---|---|---|
| D1 | Every adjustment value (exchange, voucher, old-gold, advance, collectible, paid, pending) **copies from the draft onto the finalised order**, unchanged. | — | ⏳ Not yet tested (parked to avoid touching real invoice records) |

---

## E. Serialization (invoice / document numbering)

*Status: the new FY-scoped `TM27-…` scheme is **deployed and live**. The full pass/fail matrix in
`services/serialization/TESTING_E2E.md` was written but **its sign-off boxes are unchecked** — i.e. the
structured run was not recorded.*

| # | Acceptance criterion | Result |
|---|---|---|
| E1 | New customer order → `TM27-KAHSR-00001` (FY-scoped, per-state, ≤16 chars for GST). | 🟡 Live, not formally signed off |
| E2 | Re-firing the same order **does not re-mint** (idempotent, one number per document). | 🟡 |
| E3 | Order with **no state code** waits — no number burned. | 🟡 |
| E4 | Paid repair → `TS27-…`; free repair → `FS27-…`. | 🟡 |
| E5 | `make-challan` → `DC-…`; `make-transfer` → `AURA-…` (B2B). | 🟡 |
| E6 | Exchange / voucher allocate → `EXC27-…` / `VCH27-…` per store; **void cancels by full code**. | 🟡 |
| E7 | **Voided numbers are retired, never reused** — the next mint skips the retired seq (monotonic). | 🟡 |
| E8 | **Financial-year reset** after 1 Apr IST; old `TMNT-…` numbers don't collide with the new format. | 🟡 |

**Action needed:** run `TESTING_E2E.md` cases C1–X2 against scratch drafts (no payment required — all
are webhook replays) and tick the sign-off, so numbering has a recorded acceptance pass.

---

## F. Payment rails (regression — must be unchanged)

*Status: all in **production use**; not re-run as a structured pass for this release.*

| # | Acceptance criterion | Result |
|---|---|---|
| F1 | **GoKwik** link: `send-link-…` tag → link created, SMS/email sent, `payment_links` row; webhook success records payment and nets pending. | 🟡 Live, not re-tested |
| F2 | **Cash tags** partial → full: `cash-4000` then `cash-6000` → pending 6000 → 0, status full. | 🟡 |
| F3 | **Pine terminal** push: `/api/push-to-terminal` → callback records payment. | 🟡 |
| F4 | **Jewel reprice**: `recalculate-price` / `reprice` reprices the line, removes the tag, no loop. | 🟡 |

---

## G. Reporting & recon (live, on demand)

| # | Acceptance criterion | How we checked | Result |
|---|---|---|---|
| G1 | **Sales breakdown report** splits every order into gross · discount · voucher · exchange · old-gold · advance · net · collected, with totals. | Real 40-order pull → ₹30.4L gross, ₹8.3L old-gold, ₹47k exchange. | ✅ Verified |
| G2 | **Outstanding-credit report** shows live voucher / exchange-note liability. | Live query → ₹2,355 outstanding. | ✅ Verified |
| G3 | **Recon ledger** views (summary identity, outstanding, tie-out, CSV) balance. | Returns `count:0` until `credit_instruments` is populated by live flow or backfill. | 🟡 Works, pending data |

---

## Issues caught by testing — fixed before any customer hit them

1. **Over-charging risk** — the counter payment screen calculated "balance owed" on the **full bill**
   instead of the **net after credits**. A customer could have been asked to pay too much. *(A7 — fixed & verified.)*
2. **Payment-status label silently failed to save** (data-format mismatch). *(A11 — fixed.)*
3. **Trade-ins covering the whole bill** didn't mark the order fully paid. *(A10 — fixed.)*

---

## Outstanding items (the honest gap list)

1. **Voucher used online at checkout** (B7) — needs one test online order.
2. **Design advance redeemed weeks later** + its gates (C2, C3).
3. **Draft → final invoice hand-off** of all adjustment values (D1).
4. **Serialization formal E2E sign-off** (E1–E8) — run `TESTING_E2E.md`, no payments needed.
5. **Payment-rail regression re-run** (F1–F4) — currently trusted because in daily production use.
6. **Recon ledger populated check** (G3) — after backfill or first live redemptions.

Items 1–3 were parked by choice to avoid finalising a real invoice; they'll go in one controlled pass.
Items 4–5 are "prove what's already live."

---

## Source documents (engineering detail)

- `services/exchange-cn/CEO_TEST_REPORT.md` — the verified money-engine run (2026-07-02).
- `services/exchange-cn/MASTER_E2E_TEST_PLAN.md` — full engineer test plan & sign-off checklist.
- `services/serialization/TESTING_E2E.md` — serialization no-payment test matrix (C1–X2).
- `services/serialization/SERIALIZATION_MIGRATION_PLAN.md` — the live `TM27-…` numbering scheme.

## Sign-off

| Area | Owner | Date | Signed |
|---|---|---|---|
| Money engine (A, B1–B6, C1, G1–G2) | | 2026-07-02 | ✅ verified |
| Vouchers online / CAD-later / invoice hand-off (B7, C2–C3, D1) | | | ☐ pending |
| Serialization (E1–E8) | | | ☐ pending |
| Payment rails (F1–F4) | | | ☐ pending |
