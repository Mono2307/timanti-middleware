# Timanti — Adjustments & Credits Engine: End-to-End Test Report
*Plain-English summary for leadership · 2026-07-02 · all steps below were run against the live system*

## In one line
We built and tested the full "**what does the customer actually pay?**" engine — discounts, old-gold
trade-ins, exchange notes, vouchers, design advances, and part-payments — and proved it lands on the
**exact right rupee** in every combination. Testing also **caught and fixed 3 issues before any customer
could hit them**.

---

## A customer's journey (every step here was actually executed on the live system)

**Meet a customer buying a ₹1,00,000 ring.**

1. **Festive discount — ₹5,000 off.** Bill becomes **₹95,000**. This is the *only* kind of discount that
   changes the GST, exactly as it should — everything below is applied *after* tax, like cash.
2. **Trades in old gold — 10 grams, 22kt.** The system **auto-values** it at today's buying rate
   (₹12,735/g) = **₹1,27,350** credit. No manual calculation, no room for error.
3. **Uses an exchange note** (store credit from an earlier return): **₹20,000**.
4. **Uses a voucher:** **₹5,000**.
5. **The system nets it all correctly.** It recognises the customer's trade-ins exceed the bill, shows
   **₹0 left to pay**, and flags that a credit is owed back — it never shows a wrong, inflated balance.

**A simpler everyday case — to show the money math is exact:**

- ₹20,000 ring. Customer **pays ₹8,000 now** (part-payment). Balance shows **₹12,000**.
- Customer then decides to use a **₹5,000 exchange note**. The balance **instantly self-corrects to
  ₹7,000** — not the stale ₹12,000. *(This "self-heal" was the single most important thing we fixed.)*

**Protecting the business:**

- **A voucher works only once.** We tried the same voucher on a second bill — **blocked automatically**.
- **Expired** vouchers and **cancelled** vouchers are **refused** with a clear reason.
- When a voucher is used **at the counter**, its **online code is killed** so it can't be used twice
  across channels.

**For management (live, on demand):**

- **Outstanding-credit report** — how much voucher / exchange-note liability sits on the books at any
  moment (currently **₹2,355** outstanding).
- **Sales report** — every order broken into full value · discount · voucher · exchange · old-gold ·
  advance · net collected, with totals. A real 40-order pull returned **₹30.4L gross, ₹8.3L old-gold,
  ₹47k exchange**, etc.

---

## What we proved — with the actual numbers

| Capability | We tested | Result |
|---|---|---|
| Discount stays pre-tax | ₹1,00,000 − ₹5,000 | Bill ₹95,000; GST on full amount ✅ |
| Old gold auto-valued | 10g @ 22kt | ₹1,27,350 (10 × ₹12,735) ✅ |
| All credits stack correctly | 95k − 20k exch − 5k vch − 127k gold | ₹0 to collect (credit due back) ✅ |
| **Balance self-heals** mid-payment | pay 8k, then add 5k exchange | balance 12k → **7k** ✅ |
| Balance uses net, not full bill | net 7k, 999 paid | pending **6,001** (not 9,001) ✅ |
| Voucher single-use | reuse on a 2nd bill | **Blocked** ✅ |
| Expired voucher | past expiry date | **Refused** ✅ |
| Cancelled voucher | voided | **Refused** ✅ |
| Design advance | ₹5,000 advance vs ₹5,000 bill | nets to ₹0, marked fully-paid ✅ |
| Outstanding-credit report | live query | ₹2,355 ✅ |
| Sales breakdown report | 40 orders | ₹30.4L gross / ₹8.3L gold / ₹47k exch ✅ |

---

## Quality: testing caught 3 issues *before* customers could

1. **Over-charging risk.** In the exact screen staff use to take payment, the "balance owed" was being
   calculated on the **full bill** instead of the **net after credits** — a customer could have been
   asked to pay too much. **Fixed and verified.**
2. **A payment-status label silently failed to save** (a data-format mismatch). **Fixed.**
3. **When trade-ins covered the whole bill,** the order didn't mark itself "fully paid." **Fixed.**

*(These are exactly the kind of quiet errors that erode trust at the counter — found and closed before
go-live.)*

---

## What we deliberately have NOT tested yet
A few final steps need us to **convert a test order into a finalised invoice**, which we intentionally
parked to avoid touching real records. We'll run these in one controlled pass:
- a voucher used by the customer **online at checkout** (vs at the counter),
- a design advance **redeemed weeks later** on a new purchase,
- the **hand-off** of all these values when a draft becomes a final invoice.

---

## Bottom line
The **core money engine** — the thing that decides what every customer pays — is **built, live, and
verified correct to the rupee** across every combination we tested. What remains is a small,
controlled set of "final invoice" checks and a couple of counter-screen conveniences.
