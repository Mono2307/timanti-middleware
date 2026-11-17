# Savings Plan — UAT checklist (v3)

17 November 2026 · replaces v2 after the first test round · covers Fly commit `eb04cef` and the staff app `timanti-metafield-manager-new-69`

## 0. Before you start

- **Run the new database step once:** Supabase → SQL Editor → paste `src/modules/payments/savings-plan/migration_002.sql` → Run. Without it, section H fails: a deleted draft cannot be rebuilt.
- **Test customer:** use one whose email and SMS you can read.
- **Amounts:** every example uses a **₹1,000 instalment**.
  - 10 months paid in full: ₹10,000 + ₹1,000 bonus = **₹11,000**.
  - 6 months paid in full: ₹6,000 + ₹500 = **₹6,500**.
  - Early redemption at month 6 with 5 paid: **₹5,250**.
  - Early redemption at month 8 with 7 paid: **₹7,500**.
- **Payments:** record them on the Savings plan screen with **Record payment**: amount, how it was paid, and the date it came in. It costs nothing. Only B3 and F5 need a real GoKwik payment.

### How the dates work (read this first)

- **The schedule starts on the plan's start date.** Instalment 1 is due on the start date, and each later instalment on the same day of the following months.
- **A payment is late** when its date is after the due date of the instalment it pays.
- **Typing an old date on a payment does not make the plan older.** In round 1, D364 started on 16 Nov 2026. Its payments dated 2025 counted as paid early, never late, and no early-redemption step had been reached.
- **To test anything that depends on time, start the plan with a past start date** (up to 12 months back) and record the payments with their dates. Then press **Run check now**: it sends what the 6-hourly check would send today. Messages really go to the test customer.
- **The automatic check waits 24 hours** after a backdated plan is set up, so staff can record the past payments first. Run check now does not wait.

**Start dates for each test.** The examples below assume you test on **17 Nov 2026**. On another day, keep the rule and move the dates by the same number of days.

| Test | Rule for the start date | If testing on 17 Nov 2026 |
|---|---|---|
| C1: instalment 2 due in 3 days | 1 month back, plus 3 days | 20 Oct 2026 |
| C2: instalment 2 three days overdue | 1 month back, less 3 days | 14 Oct 2026 |
| C3: day 15 and day 25 of the grace | 1 month and 15 days back; then 1 month and 25 days back | 2 Oct 2026; 23 Sep 2026 |
| C4/C5: late payments | 5 months back | 17 Jun 2026 |
| C6: closes on day 31 | 5 months back | 17 Jun 2026 |
| C7: still open on day 30 | 5 months back, plus 1 day | 18 Jun 2026 |
| D1/D5: month 6 | 5 months back | 17 Jun 2026 |
| D2: month 8 | 7 months back | 17 Apr 2026 |

## A. Starting a plan

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | A1 | New draft for the test customer. Add custom item `Savings Plan`, price ₹10,000, qty 1. More actions → Savings plan → 10 → leave the start date as today → tick → Start savings plan. | Banner "Savings plan started". 10 dates, the first today. Tags `savings-plan`, `savings-in-progress`. The line no longer charges tax. The customer gets the start email and an SMS with the first link. | |
| ☐ | A2 | Same with ₹6,000 and 6 months. | ₹1,000 × 6, voucher at the end ₹6,500. No early-redemption line. | |
| ☐ | A3 | Try Start on a draft that also has a product line. | "Fix these before starting … may hold only the "Savings Plan" line". | |
| ☐ | A4 | Try ₹10,500 over 10 months, then ₹5,400 over 6. | Both refused, each with its reason. | |
| ☐ | A5 | Try Start for a customer with no email (or no phone). | Refused, naming what is missing. | |
| ☐ | A7 | Start a second plan for the same customer on a new draft. | Allowed. Two drafts, two plans. | |
| ☐ | A8 | On a plan with nothing paid: tick "Started by mistake or as a demo" → Cancel plan. Then, on a plan with one payment recorded, look for the same box. | Nothing paid: "Plan cancelled", tags removed, no email. With a payment: no cancel box. The only way out is "Customer stops the plan", which issues a voucher for the money paid. | |
| ☐ | A10 | New draft, ₹10,000 / 10 months. Set the start date to 5 months ago. | A yellow "Start date in the past" note. The schedule starts on that date. After Start: no payment link is sent. Banner: record the past payments now. | |
| ☐ | A11 | Try a start date in the future, then one more than 12 months back. | Both refused. | |

## B. Paying

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | B1 | On the A1 plan: Record payment → ₹1,000, Cash, today → Record payment. | Instalment 1 shows Paid. "Saved ₹1,000 (1 of 10)". Press Run check now: the customer gets "Payment received". | |
| ☐ | B2 | Open Jewellery Workspace on the savings draft, then on a normal draft. | Savings draft: rows 1–10, read-only, row 1 says "record payments on the Savings plan screen". Normal draft: rows 1–4, editable. | |
| ☐ | B3 | Press Send payment link. Then press it again. Open the link from the first email. | Second press: "The customer's open payment link … sent again … the same link as before". The link in the first email still opens and pays. Paying it (real ₹1,000) lands in the next row by itself. | |
| ☐ | B4 | Record ₹1,500 on a plan. | Banner "Check these payments … ₹1,500 is not a whole number of ₹1,000 instalments". | |
| ☐ | B5 | On a fresh 10-month plan, record the whole ₹10,000 as one payment today. | Fully paid. **Only one button: "Issue the voucher: ₹11,000".** No "Customer stops the plan". Run check now: "Your savings plan is complete" to the customer, "fully paid — issue the voucher" to the store. | |
| ☐ | B6 | Shopify → draft → Send invoice. | The advance receipt reads "We've received your savings plan payment". | |
| ☐ | B7 | Record a payment dated in the future; one dated before the plan's start date; one larger than what is left. | All three refused, each with its reason. | |

## C. Reminders, late payments, closing

Each test is a new draft started with the start date from the table in section 0, then **Run check now**.

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | C1 | Start date 1 month + 3 days back (20 Oct). Record instalment 1 dated the start date. Run check now. Run it again. | First run: email + SMS "Instalment 2 of 10 … ₹1,000" with a link. Second run: nothing sent. | |
| ☐ | C2 | Start date 1 month − 3 days back (14 Oct). Record instalment 1 dated the start date. Run check now. | One overdue reminder with a link. The screen: "Instalment 2 is 3 days late … closes on …". | |
| ☐ | C3 | Start date 2 Oct, instalment 1 recorded on its date, Run check now. Then a new plan from 23 Sep, the same. | Each: "Your savings plan closes on …", once. | |
| ☐ | C4 | Start date 5 months back (17 Jun). Record instalment 1 dated 17 Jun, instalment 2 dated 20 Jul (3 days after its 17 Jul due date). | The schedule shows instalment 2 "Paid late". "late payments 1 of 2 allowed". | |
| ☐ | C5 | Same plan: record instalment 3 dated 20 Aug and 4 dated 20 Sep. | "late payments 3 of 2 allowed — the bonus is lost". Any voucher amount shows no bonus. | |
| ☐ | C6 | New plan from 17 Jun. Record 4 instalments on their due dates (17 Jun, 17 Jul, 17 Aug, 17 Sep). Instalment 5 (17 Oct) stays unpaid. Run check now. | Plan Closed. Tag `savings-terminated`. Customer: "Your savings plan has closed". Store: "closed — issue the voucher". The only button: "Issue the voucher (no bonus): ₹4,000". | |
| ☐ | C7 | New plan from 18 Jun. Record 4 instalments on their due dates (18 Jun, Jul, Aug, Sep). Run check now. | Not closed: day 30 of the grace. A "closes on 18 Nov" warning. | |

## D. Early redemption (10-month plan)

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | D1 | New plan from 17 Jun. Record 5 instalments on their due dates (17 Jun to 17 Oct). Run check now. | "Redeeming early today pays ₹5,250 (bonus ₹250)". Button "Redeem early: ₹5,250". The customer gets "You can now redeem your savings plan early", once. | |
| ☐ | D2 | New plan from 17 Apr. Record 7 instalments on their due dates (17 Apr to 17 Oct). | "₹7,500 (bonus ₹500)". | |
| ☐ | D3 | A 6-month plan from 17 Jun, 5 paid on time. | No Redeem early button. | |
| ☐ | D4 | Tap the WhatsApp link in any customer email. | WhatsApp opens to the store number with a message naming the plan's draft. | |
| ☐ | D5 | As D1, but 3 of the 5 instalments dated 3 days after their due dates. | Redeem early shows ₹5,000, with no bonus. | |

## E. Issuing the voucher

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | E1 | On the B5 plan: "Issue the voucher: ₹11,000". Try Issue without the tick, then tick and issue. | Without the tick: disabled. Then: "Savings Scheme Voucher SSV… for ₹11,000 (₹10,000 saved + ₹1,000 bonus) issued". The buttons are gone. | |
| ☐ | E2 | Look at the draft. | Tags `savings-completed`, `ssv:SSV…`, `ssv-value:rs11000`, `ssv-bonus:rs1000`. The payment rows are unchanged. Still a draft. | |
| ☐ | E3 | Shopify → Discounts. | The SSV code: ₹11,000 fixed, only for the test customer, no minimum, one use, expires in 1 year. | |
| ☐ | E4 | The customer's inbox. | "Your Savings Scheme Voucher: ₹11,000", with the code and the expiry. | |
| ☐ | E6 | On the D1 plan: Redeem early → tick → issue. | ₹5,250. Plan completed, tag `savings-completed`. | |
| ☐ | E7 | A plan with 3 paid: "Customer stops the plan (no bonus)". | ₹3,000. Tag `savings-terminated`. | |
| ☐ | E8 | On the C6 plan: issue the no-bonus voucher. | ₹4,000. | |

## F. Using the voucher (part use)

How part use works: [see the note at the end](#how-part-use-works).

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | F1 | Purchase draft for the test customer, a piece worth about ₹6,000. Apply the E1 SSV code. | The panel shows the voucher at ₹6,000 (the bill), not ₹11,000. Amount to collect ₹0. On the plan draft's Savings plan screen: "Voucher balance: ₹11,000 of ₹11,000 … applied to a purchase draft now". | |
| ☐ | F2 | Complete the purchase (mark paid / convert). | Plan screen: "Voucher balance: ₹5,000 of ₹11,000" and a line "… #order (in store): ₹6,000 used, ₹5,000 left". Customer email "₹5,000 left on your Savings Scheme Voucher". Discounts: the same code, now ₹5,000. | |
| ☐ | F3 | Print the purchase's Tax Invoice. | GST on the full price of the piece. Below the GST lines: "Less: Savings Scheme Voucher (SSV… · savings plan #D…) − ₹6,000". | |
| ☐ | F4 | Second purchase of about ₹8,000. Apply the same code and complete. | Voucher ₹5,000, customer pays ₹3,000. Plan screen: balance ₹0, "used up", two use lines. The plan draft is tagged `savings-redeemed`. The code is gone from Discounts. | |
| ☐ | F5 | Optional, real money: use a part-used code at online checkout on a smaller cart. | The discount is capped at the cart. After the order, the code comes back for the balance, and the balance email arrives. | |
| ☐ | F6 | Apply the used-up code to a new draft. | A `voucher-invalid: …` tag saying it is used up. | |
| ☐ | F7 | Apply the code for a different customer. | Refused online. In store, the ID check catches it. | |
| ☐ | F8 | With a code applied to draft A (not completed), apply it to draft B. | B holds it; A no longer does. Only one purchase draft holds a voucher at a time. | |

## G. Reports and sheet

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | G1 | Sales report CSV. | Passed in round 1. | |
| ☐ | G2 | The tracker sheet. | A "Savings Plans" tab, one row per plan, refreshed within 10 minutes. | |
| ☐ | G3 | The store inbox the morning after a late plan. | "Savings plan follow-ups: N", with a WhatsApp link per late plan. | |

## H. Deleted drafts (after migration 002)

| ✓ | # | Do this | Pass if | What you saw |
|---|---|---|---|---|
| ☐ | H1 | Start a plan, record nothing, delete the draft in Shopify. | The plan cancels itself. No customer email. | |
| ☐ | H2 | Start a plan, record one payment, delete the draft. | Within a minute a new draft appears with the same customer, the "Savings Plan" line (no tax), the payment row and the tags. The store and HQ get "the draft #D… was deleted and restored as #D…". The Savings plan screen works on the new draft. | |
| ☐ | H3 | On the H2 plan: Send payment link. | A fresh link on the new draft. The link sent before the delete no longer pays. | |

## X. Known gaps: these checks are EXPECTED to fail

| # | What | Why |
|---|---|---|
| X1 | Shopify's own "Create order" on a savings draft is not blocked | Only the middleware refuses to convert. Never press it on a savings draft |
| X2 | Savings payments are not in reconciliation | HQ register SP-2 |

## Z. Clean up

1. Tell Claude the draft numbers you used. Claude voids the test SSV vouchers (the ledger rows and their Shopify discounts) and cancels the test plans.
2. From round 1: D364 (₹7,000 typed in with dates before its start) and D365 (voucher SSV27-KATEST-0001, ₹5,000) are test data. Leave them for Claude to clean up. D362 cancelled itself when its draft was deleted; D363 was cancelled.
3. Then delete the test drafts.

## How part use works

- **One code, all the way.** A Savings Scheme Voucher keeps the same code from issue until it is used up. No second code is ever made.
- **In store:** applying the code takes only what the bill needs: the smaller of the balance and the bill. **Nothing is spent until the purchase is completed** (marked paid or converted). Applying it to a draft only reserves it.
- **One purchase at a time.** Applying the code to a second draft moves it there. To split ₹11,000 over two purchases, complete the first (₹6,000), then apply the code to the second: it then offers the ₹5,000 left.
- **In Shopify → Discounts:** the code is a one-use, fixed-amount discount for that customer only. After each part use, the old discount is deleted and a new one is made **with the same code**, for the balance, with the same expiry. So Discounts always shows what is left (₹5,000), never the original.
- **Online:** at checkout the code is worth the balance. Shopify caps it at the cart value. After the order, the code is re-made for what is left, as in store.
- **How the history is kept:** the ledger keeps the original value (₹11,000: ₹10,000 saved + ₹1,000 bonus) and what is left. A separate list records every use: the order, the amount used and the balance after it. The Savings plan screen on the plan's draft shows all of it, the customer gets a balance email after every use, and the plan draft carries `savings_voucher_balance`.
- **A normal voucher (VCH)** differs: it is used whole on one purchase, and its code is deleted when that purchase is completed.
