# After-sales — code actions

Agreed with the founder 2026-09-28/29 while writing the Chapter 2 store documentation. Each item states what to change, where, why, and how to know it worked.

**Baseline:** HEAD `2649fbc` (2026-09-18), branch `main`. `feat/metafield-manager-extension` is level with main. Four uncommitted files under `apps/metafield-manager/extensions/*/src/MetafieldManager.jsx`.

**The two harnesses are the acceptance tests.** Both already exist:

| Harness | What it proves | State |
|---|---|---|
| `services/exchange-cn/exchange-scenarios.js` | The calculator against 7 synthetic + 8 real scenarios, with known data defects *declared* so the suite stays green on today's data and goes red on a regression | **99 passed, 0 failed** (run 2026-09-28) |
| `services/exchange-cn/exchange-normalize-test.js` | That every live defect is a **data** defect, recoverable at read time, without touching the calculator | **Never run** — needs an orders dump; see A0 |
| `services/exchange-cn/exchange-band-test.js` | Asserts the sheet's gold leg against `custom.price_breakup_gold` for the #1068+ band | not run this session |

---

## A0 · Run the normalisation test (do this first)

Nothing else should be designed before this number is known.

```
curl -s -H "X-Shopify-Access-Token: $TOK" \
  "https://auracarat.myshopify.com/admin/api/2026-07/orders.json?status=any&limit=250" \
  -o services/exchange-cn/orders.json
node services/exchange-cn/exchange-normalize-test.js
```

It prints, for every diamond line in the store, a before/after count on three invariants — *paid column foots*, *diamond cap is known*, *gold leg computable* — and then lists the lines normalisation **cannot** recover.

**Why it matters:** that final list is the true residual exposure. Everything above it is schema drift that the adapter in A1 fixes. From the sidecar `exchange-netwt-recovered.json`, the only known-unrecoverable line today is **#1044** (its variant carries no `price_breakup` metafields), plus any line hitting Rule 3's refused fourth route — pre-discount components, a real discount, and no record of how it was split.

**Acceptance:** the printed residual list, pasted into this file under A0 so it stops being a guess.

---

## A1 · Port the normaliser into the Apps Script

**This is the main item, and it supersedes what was originally scoped as three separate guards.**

`exchange-normalize-test.js` already contains the whole solution as `normalise_()`. It is a **read-time adapter** — it writes nothing, and it cannot, because line-item properties are immutable on an existing order. Its five rules:

| Rule | Recovers | From |
|---|---|---|
| 1 | Missing **GST** | `Gross − Taxable − Discount`, else 3% of the components. Both exact |
| 2 | Which **discount era** the components belong to | Whichever reading foots against what the customer was actually charged — `comps + gst` (post) vs `comps − disc + gst` (pre) |
| 3 | The **diamond cap** (`Diamond (After Discount)`) | Three exact routes: no discount → `Diamond`; post-discount era → `Diamond` already *is* the figure; pre-discount era with `Making (After Discount)` → `Diamond − (discount not absorbed by making)`. The fourth case is **refused on purpose** — a guessed cap under-credits a real customer |
| 4 | Component **normalisation to pre-discount** | Zero the discount row when it is already inside the components |
| 5 | Missing **net weight** | `custom.price_breakup_gold ÷ custom.gold_rate` on the variant — the rate cancels, so today's rate differing from the locked one does not matter |

**Where:** `paidComponents_` and `refreshExchangeColumn_` in `services/exchange-cn/EXCHANGE-CALCULATOR-FULL.gs.txt`.

**Note on Rule 2:** `paidComponents_` currently *assumes* components are pre-discount and subtracts the discount unconditionally. That is the double-count on #1042/#1044/#1045/#1047. Rule 2 replaces the assumption with a test. Commit `6b70a8e` (2026-09-16, *"price off the components, never off the discounted price"*) fixed this at source for new orders; Rule 2 fixes it for the ones already written.

**Also port** `exchange-netwt-recovered.json` as a sheet-side lookup, or better, have the script read the two variant metafields directly so it never goes stale.

**Acceptance:** `exchange-normalize-test.js` reports the same before/after figures when run against the sheet's own output; the #1045 paid column foots to ₹40,500.00; no order-number cut-off appears anywhere in the logic.

---

## A2 · Full Value reads the order total directly

**Where:** `refreshExchangeColumn_`, the `'full'` branch.

Full Value currently rebuilds the invoice by copying column B row by row. If column B has a blank GST row, the credit comes out as the **taxable** value — on #1065 that under-credits the customer by ₹2,591.11, exactly the tax.

Full Value means "give back the whole invoice". It needs one number: `order.total_price`. It has no business reading the component breakdown at all.

This also retires `fullValueGuardPasses_`, which exists only to refuse the case this change makes impossible. **The founder's objection to that guard was correct**: the store is tax-inclusive, tax is always collected, and refusing the transaction was the wrong remedy for a display gap.

The component table stays on screen as the staff-facing explanation.

**Acceptance:** #1065 and #1060 both issue a Full Value credit equal to their `total_price`. `exchange-scenarios.js` scenario 13 flips from "declared not to foot" to passing.

---

## A3 · Hard error when the catalogue diamond value is absent

**Where:** the diamond leg in `refreshExchangeColumn_`.

If `custom.price_breakup_diamond` is missing, `C34` reads as zero, 80% of zero is zero, and the diamond leg is **silently ₹0** — the worst failure in the set, because it looks like a deliberate valuation. The metafield is always present on a properly catalogued item, so erroring is safe.

`exchange-catalogue-snapshot.json` shows **#1070 carries `dia: null`** — so this is live, not hypothetical.

**Acceptance:** entering an order whose variant lacks the metafield produces a named error, not a number.

---

## A4 · Flag what normalisation cannot recover

Only after A1. **Not a hard refusal** — the residual set is closed and can only shrink.

Surface a named footnote on the sheet when Rule 3 refuses a cap or Rule 5 finds no recoverable weight, and route those to HQ. The store documentation says: *a blank figure means stop and post on the group* — no order-number rule.

**Acceptance:** the residual lines from A0 each show a reason on screen; everything else values silently.

---

## A5 · Credit integrity — four fixes, one batch

| # | Fix | Where |
|---|---|---|
| A5.1 | **Wire a real voucher void.** `voidVoucher` cancels the serial and deletes the price rule but never calls `/api/voucher-void`, so `credit_instruments.status` stays `open` and the voucher is still redeemable in store. To be exposed via the Apps Script editor or a Shopify admin action app — **staff never call it** | `.gs:3316–3385`; route at `server.js:4145–4168` |
| A5.2 | **Strip the first voucher when a second is issued against the same order.** Latest-one-wins operates on *application* to a draft; duplicate *issuance* against one order is unconnected, leaving two live credits | issuance path, `.gs` |
| A5.3 | **Refuse issuance without a resolved customer.** `customer_selection` silently falls back to `'all'`, minting a bearer voucher with no warning. Process prevents it; the guard makes a process failure visible | `.gs:1058–1135` |
| A5.4 | **Automate `Refresh log statuses from ledger`** as a time-driven trigger | `.gs:2651–2770` |

Two further defects found while reading, worth folding in:

- `cancelSerial` matches on `seq` alone (`.eq('seq', N).maybeSingle()`), which stopped being unique once counters went per-store **and** per-FY. The `exc-void` route's own comment says exactly this. `src/modules/serialization/index.js:562`
- `voidExchangeNote` posts `/api/exc-void` **without** `hardVoid`, so it soft-voids while the dialog tells the user it retires the serial. `.gs:3386–3454`
- The voucher expiry sweep has no concept of a **superseded** voucher, so it emails a 30-day reminder for one that was replaced and redeemed. `voucher_expiry_sweep.js`

**Acceptance:** a voided voucher is refused by `handleApplyVoucherTag`; a duplicate issuance strips the original; issuance without a customer errors.

---

## A6 · Gateway refunds — initiate and confirm

Today refunds are **record-only** (`src/modules/payments/refunds.js`). Staff initiate on the gateway portal by hand, then record against the order. Neither gateway returns a completion callback, so nobody can confirm a refund landed — only that it was started. The store documentation is written to say *"initiated"* and never *"refunded"* because of this.

Build: refund initiation from the admin action app for both gateways, and a completion notification back into the order.

**Acceptance:** a refund can be initiated without leaving Shopify, and the order shows a completed state when the gateway confirms.

---

## A7 · Correct `DIAMOND_CAP_EXPLAINED.md`

The doc attributes #1045's 2.32× over-credit to *"catalogue diamond +190% since April"*. It is not a price rise:

```
Diamond property (post-discount)   12,759.59
Discount applied                 + 24,967.62
                                   ─────────
Reconstructed pre-discount stone   37,727.21
Today's catalogue (C34)            37,000.00   ← 1.9% BELOW. Flat.
```

The real cause is a **66% discount on the stone** (`24,967.62 ÷ 37,727.21`) hitting the uncapped legacy branch. The over-credit figure is right; the diagnosis is not — and it matters, because the doc also concludes "trigger 1 has never fired", when #1045 *is* trigger 1 and would have been caught decisively had `Diamond (After Discount)` existed.

Also worth a line: the census in that file is the source of truth for the store's data state and should not be re-derived.

---

## Withdrawn

**An order-number cut-off (#1070) for store staff.** Written into the Chapter 2 draft and removed on 2026-09-30 after the founder pointed out that `services/exchange-cn/` already contains the resolution. Normalisation is read-time and invisible to the store; the staff-facing rule is *a blank figure means stop*, which needs no order numbers and stays correct after A1 lands.


---

# B · From the store-document review — 2026-09-30

Raised as Word comments on SOP 1 v2, SOP 2 v1, Manual Ch1 v1b and Manual Ch2 v1. **Scope note:** this section includes order-taking items, so this file is no longer after-sales only.

## B1 · Advance Ref has stopped working — REGRESSION, check first

> *"This entire section is not editable anymore. I'm not able to enter an advance reference and have the advance amount auto-calculate."* — SOP 1, §5.4

A working path has broken. `intake.advance_ref` should accept an order number and the advance should be absorbed as an installment leg (`cad_advance_handlers.js:315–478`).

**Suspect:** the four uncommitted `MetafieldManager.jsx` files under `apps/metafield-manager/extensions/*/src/`. Diff them before anything else — a field losing its editable state is a panel change, not a server one.

**Acceptance:** entering an Advance Ref on a draft auto-fills the advance and the leg appears.

## B2 · Repurpose the repricing module — estimates, never dynamic repricing

> *"This entire module should be renamed... we will never have to reprice a product based on its weight."* — SOP 1, Stage 3

The founder's direction: every product sold gets its **own catalogued Shopify product with a unique design ID** (a 20-cent `ER29` modified to 50 cents becomes `ER29A`; a change to 2 carats becomes a new code entirely). The comma-separated mechanism stays, but **only to produce an estimate at quoting time** — never to reprice a live product.

Work: rename the panel module to match (estimate, not reprice), and confirm nothing else depends on the reprice-on-weight path.

## B3 · Does a carat-only edit trigger a reprice?

> *"If any value is entered in these fields while net weight is left empty in the repricing module, does the repricing function get called? Because we're changing its use case to generate estimates, we can change the current behavior."* — SOP 1, Stage 3

Reprice currently triggers on `gold_rate`, `gold_rate_date`, `making`, `jewelcode_net_weight`, `jewelcode_diamond_carats`. So **yes, carats alone fire it**. Given B2, decide whether it should.

**Acceptance:** stated behaviour, and the SOP can then describe it.

## B4 · Surface storewide discounts in the panel's discount selector

> *"Currently the Metafield Manager app does not surface storewide discounts under the discount code selector. That should change."* — Manual Ch1, Task 7 · SOP 1, §4.1

Wanted: a dropdown listing every promo and discount running storewide, **offline and online**, instead of staff typing a code from memory.

**Where:** `MetafieldManager.jsx`, the discount section.

## B5 · Confirm discount proration and stacking

> *"The 5,000 is always deducted from the diamond value... If there are two line items, then the discount amount is prorated by the taxable value of the two items... If a code discount is stacked with a custom line item discount, then the discounts do get stacked."* — Manual Ch1, Task 7

Three behaviours to confirm in code before the manual asserts them: diamond-only application, **proration across line items by taxable value**, and **code + per-line stacking**. The manual currently says none of this.

## B6 · Voucher strip / re-apply is buggy

> *"The current workflow to strip and re-add or change the voucher is a little buggy but should be mentioned."* — SOP 1, §5.1

Re-applying removes the old voucher or exchange note, and the cross button removes and re-applies. Behaviour needs pinning down before it is documented. Related to A5.2.

## B7 · Refunds behave differently on finished orders vs drafts

> *"In the advance refunds case there is a refunds table, but for finished orders the admin action app does not show the refunds installment table."* — SOP 2, Stage 2

On a **finished order** the panel shows no refunds table, so the refund goes through **Shopify's own refund flow** — amount recorded, customer notification initiated. On a **draft** the panel table exists and recomputes.

Confirm this is intended rather than a gap, because it means two different staff procedures.

## B8 · What does the refund notification actually do on a finished order?

> *"There is no way for the staff to know that an email went on an advance refund or a draft order because it is triggered by a resend... please remove this or verify what happens when the refund notification is sent for a finished order."* — SOP 2, Stage 2

Needed: whether a refund notification on a finished order is visible to staff anywhere (Shopify order timeline?), and whether it fires automatically or on a resend. Until answered, the SOP cannot tell staff to check that the email went — that instruction is being removed.

## B9 · Automatic payment recording (in progress)

> *"We are building a feature to automate this so the payments will not need to be manually recorded."* — SOP 1, Stage 6

Terminal and GoKwik payments will update the installment legs on their own. Until it lands, manual recording is documented as **temporary**.
