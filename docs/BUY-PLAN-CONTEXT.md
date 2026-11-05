# Buy Plan — project context (as of 6 Nov 2026)

Pick-up file for the buy plan work. Read this first; then `docs/Buy-Plan-UAT-v2.docx` (tests) and
`docs/Buy-Plan-Store-Procedure.docx` (staff).

## Where things are
| What | Where |
|---|---|
| Server code | `src/modules/payments/buy-plan/` (schedule, draft, final, lock, sweep, restore, routes, notify, links, store, sheet, sold-alert) |
| Slot writer | `src/modules/payments/installments.js` `planLegPatch` |
| Emails | `src/integrations/email/templates.js` (buy-plan section) |
| Staff screen | `apps/metafield-manager/extensions/buy-plan/` (draft → More actions → Buy plan) |
| Metafield Manager | shows installments 1–6 on buy-plan drafts/orders only |
| Tracker sheet script | `services/buy-plan-sheet/apps-script.gs.js` (Fly: `BUY_PLAN_SHEET_URL`, `BUY_PLAN_SHEET_SECRET`) |
| Invoice / confirmation | `templates/tax-invoice.liquid`, `templates/order-confirmation-receipt.liquid` (rows 1–6; pasted into Shopify) |
| DB migrations | `buy-plan/migration*.sql` — all run up to 004 |
| Tests | `buy-plan/*.test.js`; gate `npm run verify` |

## Rules (founder decisions)
- 4, 5 or 6 monthly installments. Two types: **Equal** (total ÷ n) and **Gold value lock** (installment 1 = gold value before GST; locks the price).
- Draft until fully paid; **staff convert by hand**; invoice then.
- Any payment ≥ ₹1,000 (or the balance). Shortfall carries forward; overpay lowers later ones; last = whole balance.
- **Each payment takes its own slot** (1–6; a 7th adds into 6). Plan payment links valid **30 days**; fresh link sent when one is 3 days from expiry.
- Equal plan: final reprice 3 days before the last date, **gold part only** (diamonds/making stay).
- Gold lock: whole price frozen. Product change loses the lock for good → plan becomes Equal; new piece priced from today's catalog; cheaper piece → difference as voucher.
- Closing: **60 days with no payment** (warn day 30, 45) or last installment unpaid **30 days** (warn 15, 25) → voucher for all paid, 1 year, one purchase ≥ its value. No cash refund.
- Lock refuses every reprice; re-added same piece gets its locked price put back (sweep); deleted draft is restored (new D number).
- No stock hold; store alerted when a plan piece is sold to someone else.
- Customer document: start email with bulleted terms only.
- Strict lock, no store exceptions when gold falls.

## Live state
- Deployed: Fly v435 (commit `0e8b316`), app v63+. Tracker sheet live (6 plans), refreshes every 10 min.
- Test draft: **#D327** (plan id 3, Equal, ₹90,922 after a product change, ₹12,754 paid 4 Nov, dates 4th of each month to 4 Apr 2027).
- Operator calls (header `x-webhook-secret: PRICE_UPDATE_WEBHOOK_SECRET`): `POST /api/buy-plan/sweep?dryRun=true&asOf=YYYY-MM-DD`, `POST /api/buy-plan/sheet-sync`. The sweep has no single-plan filter yet — a non-dry future-dated run touches ALL active plans.

## Next steps (in order)
1. Run `docs/Buy-Plan-UAT-v2.docx` checks 1–12, 18, 19.
2. Checks 13–17 (missed payments / closing) on D327: move its dates back in `buy_plans` (+ `plan_due_dates` metafield), dry-run the sweep, then real run. Add a single-draft filter to the sweep first.
3. Not yet proven live: G1 price put-back, G2 gold-only final, restore (it used an old API version before `0e8b316` — may never have worked), the 30-day link.
4. Later: buy-plan payments in the reports module (recording + reconciliation).

## Known limits
- In-store voucher minimum is not enforced by software — staff check.
- A closed plan's draft must be deleted by hand.
- A slot with two payments can only show one mode (only from before `8e03e4f`).
- G1 only acts when the pieces are otherwise unchanged.
- Sheet secret `bp-7f3k9q2x-timanti` was shared in chat — rotate it (Script properties + Fly secret).

## Commits (this round)
`3b0853e` rules round 3 · `68b8bb5` MFM slots 5–6 · `17651cb` commas in amounts · `e24d25a` gold value in store before start · `bc6f27e` terms as bullets · `8e03e4f` own slot per payment, 30-day links · `a39af8a` tracker sheet + sold-piece alert · `8093831` invoice rows 5–6 · `0e8b316` gold-only final, re-added price put back, restore discounts, fresh link, full digest
