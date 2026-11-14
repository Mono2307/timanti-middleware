# Savings Plan — UAT checklist (v2)

14 November 2026 · replaces v1 (F3: the whole voucher, bonus included, comes off the GST-inclusive price) · covers Fly v442 (commit `b94908e`) and the staff app `timanti-metafield-manager-new-67`

## 0. Before you start

- **What is live:** the savings plan is switched on (`SAVINGS_PLAN_ENABLED=true`) and its database tables exist. Before section F, paste the advance-receipt notification and the three Order Printer templates. Before G2, re-paste the tracker Apps Script. (Paths are in `docs/SAVINGS-PLAN-CONTEXT.md`.)
- **Test customer:** use one whose email and SMS you can read.
- **Payments:**
  - **Typed into the panel's Installments table:** cost nothing. Use them for almost every check.
  - **GoKwik link payments:** real money, ₹1,000 minimum. Only B3 and F5 need one.
- **Amounts:** every example uses a **₹1,000 instalment**.
  - 10 months paid in full: ₹10,000 + ₹1,000 bonus = **₹11,000**.
  - 6 months paid in full: ₹6,000 + ₹500 = **₹6,500**.
  - Early redemption at month 6 with 5 paid: **₹5,250**.
  - Early redemption at month 8 with 7 paid: **₹7,500**.
- **Where to look:**
  - the Savings plan screen (draft → More actions → Savings plan)
  - the Jewellery Workspace panel
  - the customer's inbox and SMS
  - the store inbox, for the store emails and the daily "Savings plan follow-ups"
  - Shopify → Discounts, for the SSV codes
  - the tracker sheet's Savings Plans tab
- **⏱ checks** need the plan to "live" on another date. There are two ways; ask Claude for either:
  - "**run the savings check for D### as of YYYY-MM-DD, dry run first**". A dry run only reports. The real run sends real messages to the test customer and can close the plan. It runs on that one draft only and never sends the store's real digest.
  - "**move D### back N months**". Claude shifts the plan's start and due dates N months into the past, on both the plan record and the draft. The screen then behaves as if the plan is N months old, which you need for early redemption and issuing vouchers on a mature plan. Type the payments with the dates the screen shows as due.
- **Clean up:** end every demo as in section Z.
- **Record what you saw** in the last column, even when it passes. A screenshot reference is enough.

## A. Starting a plan

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | A1 | New draft for the test customer. Add custom item `Savings Plan`, price ₹10,000, qty 1 (leave "Charge tax" ticked). More actions → Savings plan → 10 → tick → Start savings plan. | Banner "Savings plan started". The schedule has 10 dates, the first today. The draft is tagged `savings-plan` and `savings-in-progress`. The Savings Plan line no longer charges tax. The customer gets the start email (terms as bullets, a WhatsApp link) and an SMS with the first link. | |
| ☐ | A2 | Same with ₹6,000 and 6 months. | The screen shows ₹1,000 × 6 and a voucher at the end of ₹6,500. No early-redemption line. | |
| ☐ | A3 | Try Start on a draft that also has a product line. | "Fix these before starting … may hold only the "Savings Plan" line". | |
| ☐ | A4 | Try ₹10,500 over 10 months (₹1,050 is not a multiple of ₹100), then ₹5,400 over 6 (₹900 is under the minimum). | Both are refused, each with its reason. | |
| ☐ | A5 | Try Start for a customer with no email (or no phone). | Refused, naming what is missing. | |
| ☐ | A6 | Open Savings plan on two devices and press Start on both. | Only one plan. The second sees "already has a savings plan". | |
| ☐ | A7 | Start a second plan for the same customer on a new draft. | Allowed. Two drafts, two plans. | |
| ☐ | A8 | On a plan with nothing paid: tick "Started by mistake or as a demo" → Cancel plan. | "Plan cancelled". Tags removed. No email. The draft can be deleted. | |
| ☐ | A9 | On a plan draft, press Convert to order in the panel. | Refused: "a savings plan draft is never converted to an order". | |

## B. Paying

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | B1 | Panel → Installments → row 1: ₹1,000, cash, today. Save. Reopen Savings plan. | Instalment 1 shows as Paid. "Saved ₹1,000 (1 of 10)". ⏱ After the next check, the customer gets "Payment received". | |
| ☐ | B2 | Look at the Installments section on the savings draft and on a normal draft. | Rows 1–10 on the savings draft, 1–4 on the normal one. | |
| ☐ | B3 | Press Send payment link and pay it (real ₹1,000). | SMS + email. The payment lands in the next empty row by itself. | |
| ☐ | B4 | Type ₹1,500 into a row. | Banner "Check these payments … ₹1,500 is not a whole number of ₹1,000 instalments". It appears on the next digest. | |
| ☐ | B5 | On a fresh 10-month plan, type the whole ₹10,000 as one payment today. | Fully paid at once. Buttons: "Issue the voucher: ₹11,000" and "Customer stops the plan (no bonus): ₹10,000". ⏱ The customer gets "Your savings plan is complete". The store gets "fully paid — issue the voucher". No more payment links. | |
| ☐ | B6 | Shopify → draft → Send invoice. | The advance receipt reads "We've received your savings plan payment" and "Paid into your plan so far". No 21-day box, no balance note. | |

## C. Reminders, late payments, closing (⏱)

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | C1 | Plan with instalment 1 paid. ⏱ Run the check as of 3 days before instalment 2 is due. | One email + SMS: "Instalment 2 of 10 … ₹1,000" with a link. A second run the next day sends nothing. | |
| ☐ | C2 | ⏱ As of 3 days after instalment 2's due date. | One overdue reminder with a link. The plan is on the digest rows. | |
| ☐ | C3 | ⏱ As of day 15, then day 25, after instalment 2's due date. | "Your savings plan closes on …" each time, once each. | |
| ☐ | C4 | Type instalment 2 with a date after its due date. | The schedule shows "Paid late". "late payments 1 of 2 allowed". | |
| ☐ | C5 | Make 3 instalments late. | "— the bonus is lost". The Issue / Redeem amounts show no bonus. | |
| ☐ | C6 | Plan with 4 paid. ⏱ Real run as of day 31 after instalment 5's due date. | Plan Closed. Draft tag `savings-terminated`. Customer: "Your savings plan has closed". Store: "closed — issue the voucher". The open link no longer pays. The only button is "Issue the voucher (no bonus): ₹4,000". | |
| ☐ | C7 | Day 30 instead (dry run). | Not closed. Still a warning. | |

## D. Early redemption (10-month plan)

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | D1 | Ask Claude to move a 10-month plan back 5 months. Type instalments 1–5 on their due dates. Reopen Savings plan. | "Redeeming early today pays ₹5,250 (bonus ₹250)". Button "Redeem early: ₹5,250". ⏱ The customer gets "You can now redeem your savings plan early", once. | |
| ☐ | D2 | Move it back 2 more months, and type 6 and 7. | "₹7,500 (bonus ₹500)". | |
| ☐ | D3 | A 6-month plan, 5 paid, at month 6. | No Redeem early button. | |
| ☐ | D4 | Tap the WhatsApp link in any customer email. | WhatsApp opens to 7710968305, with a message naming the plan's draft. | |
| ☐ | D5 | 10-month plan at month 6 with 5 paid, but 3 of them late. | Redeem early shows ₹5,000, with no bonus. | |

## E. Issuing the voucher

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | E1 | On the B5 plan, press "Issue the voucher: ₹11,000". Try Issue voucher without the tick, then tick and issue. | Without the tick: disabled. Then: "Savings Scheme Voucher SSV27-KAHSR-0001 for ₹11,000 (₹10,000 saved + ₹1,000 bonus) issued". | |
| ☐ | E2 | Look at the draft. | Tags `savings-completed`, `ssv:SSV…`, `ssv-value:rs11000`, `ssv-bonus:rs1000`. Fields `savings_bonus` 1000 and `savings_voucher_value` 11000. The Installments table is unchanged (the bonus is not a payment). The draft is still a draft. | |
| ☐ | E3 | Shopify → Discounts. | The SSV code: ₹11,000 fixed, only for the test customer, no minimum purchase, one use, expires in 1 year. | |
| ☐ | E4 | The customer's inbox. | "Your Savings Scheme Voucher: ₹11,000", with the code and the expiry date. | |
| ☐ | E5 | Press Issue voucher again (second tab). | "Voucher SSV… was already issued on this plan". No second code in Discounts. | |
| ☐ | E6 | On the D1 plan: Redeem early → tick → issue. | ₹5,250. Plan completed, `end` early. | |
| ☐ | E7 | Another plan with 3 paid: "Customer stops the plan (no bonus)". | ₹3,000. Tag `savings-terminated`. | |
| ☐ | E8 | On the C6 plan: issue the no-bonus voucher. | ₹4,000. | |

## F. Using the voucher (part use)

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | F1 | Purchase draft for the test customer, a piece worth about ₹6,000. Apply the E1 SSV code (Manual Ch1 Task 9). | The panel shows the voucher at ₹6,000 (the bill), not ₹11,000. Amount to be collected is ₹0. Tag `vch-original:savings plan #D…`. | |
| ☐ | F2 | Complete the purchase (mark paid / convert). | Customer email "₹5,000 left on your Savings Scheme Voucher". Discounts: the same SSV code, now ₹5,000. The plan draft shows `savings_voucher_balance` 5000. | |
| ☐ | F3 | Print the purchase's Tax Invoice. | GST is worked out on the full price of the piece, as on any sale. Below the GST lines: "Less: Savings Scheme Voucher (SSV… · savings plan #D…) − ₹6,000". The bonus part of the voucher is not split out: the whole voucher is taken off the GST-inclusive price. | |
| ☐ | F4 | Second purchase of about ₹8,000. Apply the same code and complete. | Voucher ₹5,000. Customer pays ₹3,000. The plan's draft is now tagged `savings-redeemed`. The code is gone from Discounts. | |
| ☐ | F5 | Optional, real money: use a part-used SSV code at online checkout on a smaller cart. | The discount is capped at the cart. After the order, the code comes back for the balance, and the customer gets the balance email. | |
| ☐ | F6 | Apply the used-up code to a new draft. | `voucher-invalid: … already redeemed`. | |
| ☐ | F7 | Apply the code for a different customer. | Refused online. In store, the ID check catches it. | |

## G. Reports and sheet

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | G1 | Sales report CSV (`/api/sales-report?from=…&to=…&format=csv`). | A `sale_kind` column. Savings drafts show "savings plan" with `savings_plan` "10 months x Rs1000" and blank GST columns. Purchases show "order"; unconverted paid drafts "order advance"; buy plans "buy plan". | |
| ☐ | G2 | After re-pasting the Apps Script: the tracker sheet. | A "Savings Plans" tab, one row per plan, refreshed within 10 minutes. | |
| ☐ | G3 | The store inbox the morning after a late plan. | "Savings plan follow-ups: N", with a WhatsApp link per late plan. | |

## X. Known gaps: these checks are EXPECTED to fail

| # | What | Why |
|---|---|---|
| X1 | Shopify's own "Create order" on a savings draft is not blocked | Only the panel's Convert is refused. The next check emails the store that the draft was converted |
| X2 | Savings payments are not in reconciliation | HQ register SP-2 |

## Z. Clean up

1. Ask Claude to **void the test SSV vouchers** (the ledger rows and their Shopify discounts) and to **cancel the test plans**.
2. Delete the test drafts and the test purchase orders' drafts.
3. Write the plan and voucher numbers you used in the results, so the cleanup can be checked.
