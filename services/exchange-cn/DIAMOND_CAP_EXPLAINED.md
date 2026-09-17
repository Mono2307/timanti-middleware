# The diamond cap, explained

Why the Deduction diamond leg is `MIN(80% of today's value, what you paid)` — and when that
second half actually does anything.

Source: `EXCHANGE-CALCULATOR-FULL.gs.txt`, `refreshExchangeColumn_` (the `case 'dia'` branch).

---

## The formula

```
Deduction:   diamond leg = IF(B35 = "",  C34 × 0.8,  MIN(C34 × 0.8, B35))
Full Value:  diamond leg = B42                        (mirrors the invoice, cap not involved)
```

Three numbers, and the whole confusion comes from them being three *different* things:

| Cell | Name on the sheet | What it actually is | Discount state |
|---|---|---|---|
| `C34` | Live diamond value | **Today's** catalogue price, from variant `custom.price_breakup_diamond` | Pre-discount — a catalogue price has no discount in it |
| `B42` | Diamond (paid column) | The `Diamond` line-item property, frozen at purchase | **Pre-discount** — this is the base the discount engine started from |
| `B35` | Diamond paid (after discount) | The `Diamond (After Discount)` property | **Post-discount** — what the customer really paid for the stone |

So the base of the haircut is pre-discount, and the only post-discount number in the whole
calculation is `B35`, which is a **ceiling and nothing else**. It never adds value; it can only
hold value down.

---

## Why the discount row is blank on Deduction

This is the most-asked question, so take it slowly.

Taking 80% of a pre-discount value is arithmetically the same as *granting a 20% discount*. If the
customer's own discount was smaller than that, the haircut has already more than covered it.
Deducting the discount a second time on its own row would take it off twice.

Diamond ₹100,000, customer discount ₹10,000:

```
Honest revaluation:     100,000 × 0.8            = 80,000   ← what we credit
Double-counted version: 100,000 × 0.8 − 10,000   = 70,000   ← wrong, discount taken twice
```

The customer paid ₹90,000 for that stone and is credited ₹80,000. Correct. On **Full Value** the
discount *is* deducted, because that column is a straight copy of the invoice and the invoice was
charged net of it.

---

## When the cap binds

The cap binds whenever `C34 × 0.8 > B35`. There are **two** ways to get there, and the code
comments only mention the first.

### Trigger 1 — a discount over 20% of the diamond

Assume the catalogue hasn't moved, so `C34` = the purchase diamond value of ₹100,000.

| Discount | As % of diamond | Paid for stone (`B35`) | `C34 × 0.8` | Credit | Cap binds? |
|---|---|---|---|---|---|
| ₹0 | 0% | 100,000 | 80,000 | **80,000** | No |
| ₹10,000 | 10% | 90,000 | 80,000 | **80,000** | No |
| ₹20,000 | 20% | 80,000 | 80,000 | **80,000** | Exactly at the boundary |
| ₹30,000 | 30% | 70,000 | 80,000 | **70,000** | **Yes** |

At 30% the uncapped answer would be ₹80,000 — ₹10,000 **more than the customer ever paid for the
stone**. The cap is the only thing stopping the exchange credit climbing above the invoice.

> **This trigger has never actually fired.** The table above assumes a discount lands on the stone,
> and on a large discount it usually does not. Across all 29 diamond line items in the store
> (#1001–#1073), the cap binds on **zero** of them. Two orders carry a discount well over the 20%
> line and the stone is untouched on both:
>
> | Order | Diamond | Discount | % of diamond | `Diamond (After Discount)` | `Making` → `Making (After Discount)` |
> |---|---|---|---|---|---|
> | #1073 | 12,400 | 3,852 | **31.1%** | 12,400 — *unchanged* | 8,560 → 4,708 |
> | #1068 | 8,400 | 2,512 | **29.9%** | 8,400 — *unchanged* | 5,020 → 2,508 |
>
> So `paidComponents_`'s comment — *"the discount engine takes diamond first and then making"* — is
> **not what the engine does**. #1069 and #1072 take it off the diamond; #1073 and #1068 take it
> entirely off making. The discount appears to be defined against one named component, not applied
> in a fixed order.
>
> The comment's *conclusion* still holds, and more strongly than it claims: reconstructing the cap
> as `Diamond − Discount Applied` would have given #1073 a ceiling of 8,548 against a true stone
> cost of 12,400, clamping the credit ~14% below what the customer is owed. Right decision,
> wrong reason.

### Trigger 2 — the catalogue price rose more than 25%

Undocumented in the code, but it falls straight out of the arithmetic. With **no discount at all**,
`B35` equals the purchase price `D`, so the cap binds as soon as:

```
C34 × 0.8 > D      →      C34 > 1.25 × D
```

Purchase diamond ₹100,000, no discount:

| Today's `C34` | Change | `C34 × 0.8` | `B35` | Credit | Cap binds? |
|---|---|---|---|---|---|
| 100,000 | flat | 80,000 | 100,000 | **80,000** | No |
| 120,000 | +20% | 96,000 | 100,000 | **96,000** | No — customer gains from the uplift |
| 150,000 | +50% | 120,000 | 100,000 | **100,000** | **Yes** |

So the cap is not purely a discount guard. It is a general "never credit more than was paid for the
stone" rule, and a large enough catalogue re-pricing trips it on an order that carried no discount
whatsoever.

---

## A real order: #1072

```
Gold      37,796.42
Diamond  230,000.00     ← pre-discount, the B42 figure
Other      7,880.00
Discount −20,000.00
GST        7,670.29
─────────────────────
Paid     263,346.71
```

The discount is ₹20,000 on a ₹230,000 diamond — **8.7%**, comfortably under the 20% line.

**Verified against the API on 2026-09-17**, not assumed: the order really does carry
`Diamond (After Discount) = Rs210000.00`, and `Making (After Discount)` is unchanged at
`Rs7880.00`, so the whole ₹20,000 came off the stone. The catalogue diamond
(`custom.price_breakup_diamond`) is still ₹230,000, so the catalogue is genuinely flat here.

```
C34 × 0.8 = 230,000 × 0.8 = 184,000
B35                        = 210,000
credit = MIN(184,000, 210,000) = 184,000     ← cap does not bind
```

The gold leg is the part worth watching. `_net_wt` on the order is **3.940g**, the rate locked at
purchase was ₹9,593, and `custom.gold_rate` today is **₹9,032** — gold has *fallen* 5.9%:

```
gold leg = 3.940 × 9,032 = 35,586.08          (equals custom.price_breakup_gold exactly)
NET      = 35,586.08 + 184,000 = 219,586.08   against an invoice of 263,346.71
```

This is the normal case. On a typical order the cap is inert and the credit is simply 80% of
today's value.

---

## When `B35` is missing

On an order placed before the middleware started writing `Diamond (After Discount)`, `B35` is
blank and the formula takes its uncapped branch — 80% of today's value, no ceiling.

`paidComponents_` **deliberately refuses** to reconstruct the number as `Diamond − Discount
Applied`:

> the discount engine takes diamond first and then making, so that subtraction would over-tighten
> the cap whenever making absorbed part of the cut

In other words a guessed cap would be *too low* and would under-credit real customers, which was
judged worse than leaving old orders uncapped. The consequence is real though: an old order with a
discount above 20% of its diamond **will over-credit**, and nothing on the sheet warns you. If the
discount looks large and `Diamond paid (after discount)` is empty, check the credit by hand before
issuing.

### How much exposure is this, really?

`Diamond (After Discount)` starts at **#1067** (2026-07-28). Everything at or below **#1066** is
uncapped — **22 of the 29 diamond line items in the store**.

The worst live case is **#1045** (2026-04-21), and it is not close:

```
Paid for the stone (Diamond property)        12,759.59
Catalogue diamond today                      37,000.00     ← +190% since April
80% of today's value, with nothing to cap it 29,600.00
                                             ─────────
Over-credit on the stone                     16,840.41     ← 2.32× what they paid
```

Note what does **not** catch this. "Credit does not exceed the invoice" passes cleanly — ₹29,600
against a ₹40,500 invoice — because the gold leg is zero (see below) and the invoice is padded by a
₹24,967.62 discount. The breach is only visible if you compare the diamond leg against the *stone*,
which is the check `exchange-scenarios.js` now makes.

Three separate defects stack up on this one order:

1. **No cap.** Legacy order, no `Diamond (After Discount)`.
2. **Components are already post-discount.** On orders up to #1047 the `Gold`/`Diamond`/`Making`
   properties sum to `Taxable Value` exactly — they are net of the discount. `paidComponents_`
   assumes pre-discount and subtracts it again, so the paid column reads **₹15,532.38** against a
   real invoice of **₹40,500.00**. Four orders (#1042, #1044, #1045, #1047) are in this state.
3. **No `_net_wt`.** The property was never written, so `B29` is blank and the gold leg computes as
   zero. Ironically the only thing holding the total down.

On **Full Value** defect 2 is the dangerous one: that column is a straight copy of column B, so an
order whose paid column does not foot issues a credit that does not match the invoice.

Other orders that do not reconcile at all: **#1065** and **#1060** carry no `GST` property and no
`tax_lines` (tax-inclusive store), so the paid column lands short by exactly the tax — ₹2,591.11 and
₹1,370.15. And **#1067** reconciles only as `(components − 2 × discount) × 1.03` — its `Gross Value` was
written post-discount, so the discount is taken a second time. That is the compounding bug fixed at
source by `6b70a8e` (*"price off the components, never off the discounted price"*, 2026-09-16);
#1067 is the last order priced before it. **Reviewed and closed by the founder on 2026-09-17** —
one order out of 73, not worth a guard in the customer-facing templates. It needs no action unless
a second order shows the same shape.

---

## Full Value mode

The cap plays no part. Every row of column C mirrors its column-B counterpart, discount and GST
included, so the total is exactly what the customer paid, tax inclusive. The diamond row is the
pre-discount `Diamond` property and the discount comes off once, on its own row — the same way the
invoice was built.

---

## Quick reference

| Question | Answer |
|---|---|
| Is the diamond picked up pre- or post-discount? | **Pre-discount** from #1051 on. On #1047 and earlier the properties are already post-discount and the sheet subtracts the discount twice. |
| Why is the discount row blank on Deduction? | The 80% haircut already absorbs a discount up to 20% of the diamond. |
| When does the cap actually do something? | In theory: discount > 20% of the diamond, **or** catalogue price up more than 25%. In practice, on live data: **never yet** — 0 of 29 line items. |
| Does a big discount make the cap bind? | Not on its own. On #1073 and #1068 the discount came off *making* and left the stone untouched. |
| What if `B35` is blank? | No cap. 22 of 29 line items (#1066 and below). Worst live case is #1045 at **2.32× over-credit**. |
| Does any of this apply to Full Value? | The cap, no. But a paid column that does not foot (#1045, #1065, #1060, #1067) issues a wrong Full Value credit, because that column is a straight copy of it. |
| Gemstone and making? | Zero on Deduction — not credited on an exchange. Gemstone has no money value anywhere in the system, only weights. |

---

## Checking this yourself

`exchange-scenarios.js` renders every case above as the sheet would build it and asserts the
invariants:

```
node services/exchange-cn/exchange-scenarios.js --quiet    # 99 checks
node services/exchange-cn/exchange-scenarios.js --real     # real orders only
node services/exchange-cn/exchange-scenarios.js 14         # the #1045 over-credit
```

Scenarios 1–7 are synthetic and isolate the mechanics. Scenarios 8–15 are real orders pulled from
`auracarat.myshopify.com`, with `invoiceTotal` stated from `order.total_price` rather than derived,
which is what lets the footing check actually fail. Known defects are *declared* in the scenario
(`expectFoot`, `expectStoneBreach`) so the suite stays green on today's known-bad data and turns red
the moment any of it changes.

---

## Checking it yourself

`exchange-scenarios.js` renders this same before/after table for a matrix of scenarios and asserts
the invariants, so the logic can be checked without touching the live sheet:

```
node services/exchange-cn/exchange-scenarios.js           every scenario, with checks
node services/exchange-cn/exchange-scenarios.js --quiet   summary only
node services/exchange-cn/exchange-scenarios.js 14        one scenario
```

Scenarios 1-7 are the synthetic boundary cases from the tables above. The rest are real orders,
including several that carry known data defects — those are **declared** in the scenario rather
than fixed, so the harness stays green while still printing what is wrong and by how much. A new
failure therefore means a genuine regression, not a pre-existing data problem.
