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
3. ~~Deploy the Shopify app~~ Done on 14 Nov 2026 as `timanti-custom-extension-app-4`: the Savings plan action and the panel's slots 7–10. Until the middleware is deployed and switched on, More actions → Savings plan shows an error. Deploy the app from this branch, or from `main` once it is merged; a deploy from a branch without `extensions/savings-plan` would add it back only with `--allow-deletes`, never silently remove it.
4. Paste `templates/Shopify-Notifications-PASTE/1 - Draft order invoice (advance receipt).html` into Shopify, under Notifications → Draft order invoice.
5. Optional: set `SAVINGS_WHATSAPP` if the customer WhatsApp number should not be 917710968305.
6. Paste the updated `templates/tax-invoice.liquid`, `order-confirmation-receipt.liquid` and `pricing-estimate.liquid` into Order Printer. They print an SSV code as "Less: Savings Scheme Voucher".
7. Re-paste `services/buy-plan-sheet/apps-script.gs.js` into the tracker sheet's Apps Script and deploy a new version. It now writes a "Savings Plans" tab when the savings module pushes one.
8. Deploy the middleware (this branch), then set `SAVINGS_PLAN_ENABLED=true` on Fly.

## Part use of the voucher (`savings-plan/redeem.js`)
These steps act only on codes starting with `SSV`. Every other voucher behaves as before.
- **Applying in store** (`server.js handleApplyVoucherTag`): only what the bill needs after other credits is applied, and `voucher_value` is set to that amount. The draft is tagged `vch-original:savings plan #D…`.
- **When the purchase converts** (the draft-completed lock) **or an online order arrives** (`serialization/routes.js freezeOnlineVoucher`): `settleUse` writes one row per order in `savings_voucher_uses`. That row also stops a repeated webhook from deducting twice. Then:
   - **balance left:** the ledger row goes back to `open` with `remaining` set to the balance, and the Shopify code is re-made for the balance with the same code and expiry. The customer is emailed the balance, and the plan draft shows `savings_voucher_balance`.
   - **nothing left:** the voucher is marked redeemed and its code deleted. The plan becomes `redeemed` and its draft is tagged `savings-redeemed`; from then on the draft may be deleted.
- **The 30-day expiry reminder** quotes the balance.
- **The Shopify code has no minimum purchase.** Shopify caps a fixed discount at the order total, and the balance is re-made afterwards.

## Staff side
- **Screen:** More actions → Savings plan on a draft (`apps/metafield-manager/extensions/savings-plan`). It starts the plan, shows its standing, sends a link and has the end buttons.
- **Sales report:** a `sale_kind` column (order · order advance · buy plan · savings plan) and a `savings_plan` column. Savings rows have no GST columns. There are also columns for instalments 7–10.
- **Tracker sheet:** a "Savings Plans" tab, pushed every 10 minutes while switched on (`savings-plan/sheet.js`).
- **Staff documents:** drafts in `Timanti Store Manuals/Loyalty and EMIs/`: `Timanti_SOP4_SavingsPlan_DRAFT_v1` and `Timanti_Manual_Ch4_SavingsPlan_DRAFT_v1`. Publish them at launch (HQ register SP-6, SP-7).

## Open
- **Reconciliation** does not match plan payments to settlements yet (HQ register SP-2).
- **Open with the founder:** whether a full prepayment earns the bonus at once (current setting) or only at maturity. The prepay loophole is in design §4.
- **Open with Accounts:** GST on the bonus and on lapsed balances (HQ register SP-5).
