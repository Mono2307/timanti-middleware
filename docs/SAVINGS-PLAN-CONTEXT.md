# Savings plan — project context (as of 12 Nov 2026)

This is the pick-up file for the savings plan. The scheme itself is described in `Timanti Store Manuals/Loyalty and EMIs/Timanti_Savings_Plan_Design_and_TnC_v5.docx`.

## What it is
A monthly savings scheme on the BlueStone Gold Mine 10+1 model.
- **Plans:** 6 or 10 fixed instalments, ₹1,000 to ₹1,00,000 a month, in multiples of ₹100.
- **Bonus:** 6 months earns 50% of one instalment; 10 months earns 100%.
- **Early redemption (10-month plan only):** from month 6 with 5 paid, the bonus is 25%. From month 8 with 7 paid, it is 50%.
- **Late payments:** more than 2 late means no bonus.
- **Grace and termination:** a missed instalment can be paid up to 30 days after its due date. On day 31 the plan terminates and pays out the money paid, with no bonus.
- **Prepaid in full:** earns the full bonus straight away (`rules.js PREPAID_BONUS_NOW`; the founder may move this to the maturity date).
- **Refunds:** never in cash.
- **Payout:** a Savings Scheme Voucher, serial `SSV27-KAHSR-0001`, valid 1 year.

## Where things are
| What | Where |
|---|---|
| Rules (pure) and tests | `src/modules/payments/savings-plan/rules.js`, `rules.test.js` |
| Sweep (reminders, grace, termination) and tests | `savings-plan/sweep.js`, `sweep.test.js` |
| How a plan ends; issuing the voucher | `savings-plan/end.js`, `voucher.js` |
| Routes | `savings-plan/routes.js` (`/api/savings-plan/*`) |
| Emails | `savings-plan/notify.js` and the savings section of `src/integrations/email/templates.js` |
| Tables | `savings-plan/migration.sql` (`savings_plans`, `savings_plan_reminders`, and `credit_instruments.paid_part/bonus_part`) |
| 10 instalment slots | `payments/installments.js` (`custom.savings_months` gives a draft 10 slots); the panel shows slots 7–10 only on `savings-plan` drafts |
| Never converts | `buy-plan/convert.js savingsBlock` |
| Advance receipt copy | `templates/Strategy/email_draft_order_invoice.html`, copied to the paste folder |

## How staff run it
1. **Create the draft.** In Shopify, create a draft for the customer with one custom item, **"Savings Plan"**, priced at instalment × months. For example, ₹2,000 × 10 = ₹20,000.
2. **Start the plan** with `POST /api/savings-plan/start {draftId, months, nominee}`. The staff screen for this is not built yet. Starting the plan does five things:
   - turns off "Charge tax" on the line
   - tags the draft `savings-plan` and `savings-in-progress`
   - writes the `custom.savings_*` terms
   - sends the first GoKwik link
   - sends the start email
3. **Payments** come in two ways:
   - GoKwik links, which go out 3 days before each due date, on overdue, and with the day-15 and day-25 grace warnings. The existing webhook writes them into the next free slot.
   - Payments taken in store, which staff type into the panel's Installments section as on any draft.
4. **When a voucher is due**, the store is emailed and the plan appears on the daily digest. Staff press Issue voucher (`POST /api/savings-plan/issue-voucher {how: full|early|stopped|terminated, confirm}`). This:
   - writes `savings_bonus`, `savings_voucher_code` and the other outcome fields
   - adds the tags `savings-completed` or `savings-terminated`, plus `ssv:<code>`, `ssv-value:rs…` and `ssv-bonus:rs…`
   - emails the voucher to the customer

   The bonus never goes into a payment slot. The draft is never deleted.

## Before switching on (`SAVINGS_PLAN_ENABLED=true`)
1. Run `savings-plan/migration.sql` in Supabase.
2. Create the definitions for slots 7–10: `POST /api/metafield-definitions/ensure?group=installments`.
3. Deploy the panel extensions (`shopify app deploy`), so the panel shows slots 7–10.
4. Paste `templates/Shopify-Notifications-PASTE/1 - Draft order invoice (advance receipt).html` into Shopify, under Notifications → Draft order invoice.
5. Optional: set `SAVINGS_WHATSAPP` if the customer WhatsApp number should not be 917710968305.
6. **Do not switch on before part 2.** Part use of the voucher is decided but not built. Until it is, the voucher can only be used on a purchase worth at least its value. Shopify enforces this online; in store, staff have to check it.

## Not built yet
- **Part 2: part use of the Savings Scheme Voucher**, with the balance kept on the same code. This changes the apply-voucher, lock-on-conversion and online-freeze steps. When the balance reaches zero, the plan should move to `savings-redeemed`.
- **Part 3:**
  - a Savings tab on the staff screen (start, status, send link, issue voucher)
  - the sales report split into orders, order advances, buy plans and savings plans
  - the tracker sheet columns
  - the staff SOP
- **Open with the founder:** whether a full prepayment earns the bonus at once (current setting) or only at maturity. The prepay loophole is in design §4.
- **Open with Accounts:** GST on the bonus and on lapsed balances (HQ register SP-5).
