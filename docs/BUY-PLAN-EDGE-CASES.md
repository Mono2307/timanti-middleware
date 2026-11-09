# Buy Plan: what happens when… (9 Nov 2026)

> **Vouchers are never automatic** (founder, 9 Nov). Whenever money is owed back — a plan closed for
> non-payment, a cheaper piece, an overpayment, gold falling before the final price — the system
> prompts the store (Buy plan screen, store email, daily digest) and nothing is issued or emailed
> about a voucher until staff press **Issue voucher**. Cancel plan → Customer opted out is the other
> staff step that issues one.

Every situation a buy plan can get into, what the system does, what the customer and the store
are told, and whether that part works today. Plain language; the technical audit with code
references is `docs/BUY-PLAN-COVERAGE.md`.

**Status words used below**
- ✅ **Works**: built and tested in code. "Not yet proven live" means nobody has done it on the real store yet.
- ⚠️ **Partly**: the normal path works, but a variant goes wrong or needs a person to step in.
- ❌ **Gap**: nothing handles it today. Each gap is listed again in section 13 with a suggested fix.
- 🧑 **Staff**: handled by the store on purpose, not by software.

---

## 1. Messages: everything the customer and the store receive

Customer emails also go, as a hidden copy, to the store and HQ (the normal email setup). SMS goes
to the customer's phone. WhatsApp is never automatic: the daily store digest has a ready-written
WhatsApp link per customer for staff to send by hand.

### To the customer
| When | Email | SMS | What it says |
|---|---|---|---|
| Gold plan, before it starts: staff press "Send gold value link" | ✅ | ✅ | Pay the gold value to lock today's rate; the link |
| Plan started | ✅ | — | Schedule, terms as bullets, a "pay a different amount" link |
| 3 days before each installment | ✅ | ✅ | Installment k of n, amount, payment link |
| Installment 3 days overdue | ✅ | ✅ | Overdue, amount, a fresh link (once per installment) |
| Their payment link is 3 days from expiring and still unpaid | ✅ | ✅ | "New payment link (the earlier one is expiring)" |
| Staff press "Send payment link" | ✅ | ✅ | The amount staff chose, the link |
| A payment arrives (online or in store) | ✅ | — | Thank you, new schedule. Up to 6 hours late (it goes with the next 6-hourly check) |
| 30 and 45 days with no payment | ✅ | ✅ | "Your plan closes on [date] unless you pay"; any ₹1,000 keeps it going; a link |
| Last installment 15 and 25 days late | ✅ | ✅ | Same, for the last installment |
| Plan closed for non-payment | — | — | Nothing at the moment it closes |
| Staff press Issue voucher on a closed plan | ✅ | — | Plan closed; voucher code for everything paid, valid-until date |
| Staff press Issue voucher on a plan paid over its price | ✅ | — | "You paid ₹X more than your piece"; voucher code; piece fully paid |
| Equal plan: final price, 3 days before the last date | ✅ | ✅ | Final price at today's gold rate, the last amount, a link |
| Product changed | ✅ | — | Old and new price, new schedule; if they had already paid more than the new price: "our store team will be in touch" (no voucher) |
| **Plan cancelled: customer opted out, money paid** | ✅ | — | "Cancelled, as you asked." Voucher code, value, valid until |
| **Plan cancelled: customer opted out, nothing paid** | ✅ | — | "Cancelled, as you asked. No payment was made, nothing more needed." |
| **Plan cancelled: opted out but the voucher failed** | — | — | Nothing. The store is told to make the voucher by hand and tell the customer |
| **Plan cancelled: demo or staff mistake** | — | — | **Nothing, ever** |
| Plan complete (only after staff convert the draft to an order) | ✅ | — | Paid in full, piece is ready |

There is **no SMS** for: start, payment received, closed, changed, cancelled, complete.

### To the store (internal email)
| When | What it says |
|---|---|
| Every day (if anything is due) | Digest: due in 3 days, overdue, closing soon, stuck jobs, **plans owed a voucher not yet issued**, with WhatsApp links |
| A plan draft was deleted | "Deleted and restored as [new D number]". Now also says: to really remove a plan, press Cancel plan first |
| Pieces on the draft edited without "Change product" | Alert, once per edit |
| A piece was re-added at the wrong price | "Put back at the plan price", or "fix by hand" if putting it back failed |
| A piece on an active plan was sold to someone else | Alert to reorder |
| Plan closed for non-payment | "Check the ₹X paid really came in, then press Issue voucher on the Buy plan screen. Only then delete the draft." |
| **Plan cancelled (either kind)** | Who cancelled, why, the amount; voucher code / "CREATE THE VOUCHER BY HAND" / "no voucher, normal draft again" |
| Customer has paid more than the price (gold fell, or a cheaper piece after Change product) | "Offer a piece of higher value or a second piece; if they want the difference back, press Issue voucher." Nothing is issued |

---

## 2. Starting a plan
| If… | Then… | Status |
|---|---|---|
| Staff start an Equal plan with 4, 5 or 6 installments | Total ÷ n per month, tag `buy-plan`, start email | ✅ |
| Staff choose a Gold plan | Start stays blocked until the gold value (before GST) is paid, by link or recorded in store. Installment 1 = gold value, the rest spread over the others | ✅ |
| The draft has no customer, phone or email | Start refused, with the reason | ✅ |
| The draft is already fully paid, or has nothing to collect | Start refused | ✅ |
| Two staff press Start at the same time | Only one plan is created | ✅ |
| Payments were already on the draft before Start | They count toward installment 1; no "payment received" email for them | ✅ |
| The draft already has old gold, an exchange note or a voucher applied | The plan total is what is left to collect — correct at the start. But if the plan later closes or is cancelled, the voucher covers only the **money** paid; the old gold / exchange note stays on the dead draft | ⚠️ **Decision D1** |
| Gold value link paid, but nobody presses Start | The money sits on a normal draft with no lock; the gold rate can still move | 🧑 Staff press Start the same day |
| Gold rate changes between paying the gold link and pressing Start | The gold value is not re-checked at Start | ⚠️ |

## 3. The price lock
| If… | Then… | Status |
|---|---|---|
| Someone adds the `reprice` tag, changes Gold Rate, or applies loyalty / a discount through our tools | Refused; the price does not move | ✅ |
| Someone deletes the `rate-locked` tag by hand | Still locked (the `buy-plan` tag also locks) | ✅ |
| A piece is removed and the same piece added back (comes in at today's catalog price) | Within 6 hours the plan price is put back and the store is told | ✅ not yet proven live |
| A line price is edited by hand in Shopify | Same: put back | ✅ |
| Gold Rate is mistyped in the Metafield Manager | Prices don't move, but the wrong number stays in the field and travels with a restored draft | ⚠️ |
| A **Shopify native** discount is added to the draft | Not caught: the draft's amount to collect drops, but the plan still asks for the full amount | ❌ G6 |
| A voucher / exchange note / old gold is applied **after** the start | Not refused, and the plan still asks for the full amount — the customer is chased for money already settled | ❌ G6 |
| Gold falls after a gold-lock | No exception, price stays (founder decision) | ✅ |

## 4. Payments coming in
| If… | Then… | Status |
|---|---|---|
| Customer pays ₹999 | Refused (minimum ₹1,000, or the balance if smaller) | ✅ |
| Amount typed as "20,000", "₹20,000" or "Rs 20000" | Accepted | ✅ |
| More than the balance | Refused on the screen and on the pay page | ✅ |
| Payment taken in store | Staff press Record payment; it goes in its own slot and the thank-you email follows | ✅ |
| Each payment | Takes its own slot 1–6. A 7th payment is folded into slot 6, **and it overwrites slot 6's date and mode** | ⚠️ **Decision D3** |
| Customer pays more than the current installment | Later installments get smaller | ✅ |
| Customer pays less, or misses a month | The shortfall moves to the next installment ("double") | ✅ |
| An old link is paid after another payment already lowered the balance → customer has paid **more than the price** | Daily digest and the Buy plan screen prompt staff: offer more, or Issue voucher | ✅ |
| Amount typed straight into the Metafield Manager slot | Counts toward the plan, but has no payment record, so it is missing from the Buy plan screen's list and from reports | ⚠️ **Decision D4** |
| A plan payment is refunded or charged back | The plan doesn't notice; it still counts the money | ❌ G7 |
| Two payments land at the same moment (two staff, or staff + online) | One can be lost from the slots (the payment record survives) | ❌ G9 |
| Pine terminal payment | Recorded, shows as "card" | ⚠️ |
| Payment made between midnight and 5:30 am IST on a due date | Dated the day before, so it counts in the previous installment | ❌ G4 |

## 5. Payment links
| If… | Then… | Status |
|---|---|---|
| A new link is sent | Any older open link on the plan is cancelled; only one link is ever payable | ✅ |
| Link validity | 30 days; a new one goes out when the held one is 3 days from expiring and still unpaid | ✅ not yet proven live |
| GoKwik refuses to cancel an old link (but we mark it cancelled) and the customer pays it | Payment may be dropped or credited at the wrong amount | ❌ G8 |
| GoKwik sends the same "paid" notice twice | Harmless with one link; could double-credit if a newer link exists. Webhook signature is not checked | ⚠️ / ❌ G8 |
| "Pay a different amount" page with a bad/expired link, or on a closed/cancelled plan | Polite message, no payment | ✅ |
| "Pay a different amount" reported broken | Still to be reproduced (UAT 8) | ⚠️ |
| Customer changes phone/email in Shopify after the start | The plan keeps messaging the old ones | ⚠️ |

## 6. Changing the product
"Product change" = the customer swaps the piece on the plan for a different piece. Staff change the
lines on the draft; the Buy plan screen shows the new pieces' catalog price next to what has been paid,
and warns if the new pieces cost less ("suggest a piece worth ₹X or more"). Staff press **Change
product** and tick that the customer agreed. The new price is usually ready within a minute (it used
to be a fixed 5-minute wait).

| If… | Then… | Status |
|---|---|---|
| Equal plan, piece swapped | Everything paid is kept; new piece priced at today's rate (gold only moves); balance re-spread over the months left; customer emailed | ✅ (done on D327) |
| Gold plan, piece swapped | The gold lock is lost for good and the plan becomes Equal; same as above | ✅ |
| New piece is cheaper than what is already paid | **No voucher.** The plan is fully paid; the store is emailed and prompted daily to offer a piece of higher value, or to press Issue voucher if the customer wants the difference back. Issuing it settles the plan at its price | ✅ |
| New piece costs more than what is paid (the normal mid-plan case) | No voucher; the rest is spread over the installments left | ✅ |
| Change pressed with the pieces unchanged | Refused | ✅ |
| Pieces edited **without** pressing Change product | Store alerted; a deleted draft comes back with the plan's original pieces | ✅ |
| **A second product change** after a voucher was issued | Refused: the plan is settled once a voucher is issued. Before a voucher, a second change just re-prices (nothing was given back yet) | ✅ fixed 9 Nov |
| Change pressed in the last 3 days, while the final price is being worked out | The plan gets stuck and shows in the digest every day | ❌ G11 |
| The reprice behind a change never finishes | After 1 hour the digest flags it as stuck; a person must fix it | ⚠️ |

**What "second product change" meant, and why it is fixed.** A customer had paid ₹50,000, swapped to
piece A at ₹40,000 (voucher ₹10,000), then to piece B at ₹35,000 — and the old code made a second
voucher for ₹15,000, paying the first ₹10,000 out twice. Now no voucher is automatic, the plan keeps a
running total of every voucher issued on it (a close or cancel only gives back what was not already
returned), and Change product is refused once a voucher has been issued.

## 7. Equal plan: the final price
| If… | Then… | Status |
|---|---|---|
| 3 days before the last date | Only the gold part moves to that day's rate (diamonds, stones, making stay); final link sent with the reminder | ✅ not yet proven live |
| A line has no gold breakup or no rate | Left at its price; only logged, store not told | ⚠️ |
| Gold fell and the customer has already paid more than the final price | Store emailed and prompted; staff press Issue voucher if the customer wants it | ✅ |
| The reminder's estimate after an earlier product change | Uses the original price, so the estimate is off (the final price itself is right) | ⚠️ |

## 8. Missed payments and closing
| If… | Then… | Status |
|---|---|---|
| An installment is missed | Marked missed; added to the next one | ✅ |
| 30 and 45 days with no payment | Customer warned (email + SMS) with the close date; store digest lists it | ✅ |
| 60 days with no payment | Plan closes: lock off, tagged `buy-plan-closed`, the customer's open payment link cancelled. **No voucher yet**: the store is emailed and the plan stays on the daily digest until staff check the money came in and press Issue voucher (1 year, one purchase of at least its value). The customer is emailed when the voucher is issued | ✅ |
| Last installment unpaid 15 / 25 / 30 days after its date | Warnings, then close as above | ✅ |
| Any payment, even ₹1,000 | Restarts the 60-day clock | ✅ |
| Issue voucher fails (Shopify error) | Nothing is issued or emailed; staff can press it again | ✅ |
| The closed draft | Delete it by hand **after** issuing the voucher (a closed plan is never restored). Deleted first: the digest says to make the voucher by hand | 🧑 |
| Testing this on one plan | The check can now run on one draft only (`draft=D327`), without touching other plans or sending the real digest | ✅ new today |

## 9. Cancelling a plan (new today)
On the Buy plan screen, under **Cancel this plan**, staff choose why:

**Customer opted out**
- Nothing paid → plan cancelled, customer emailed "cancelled, as you asked", store emailed.
- Money paid → staff must tick *"I have checked that ₹X actually reached Timanti (bank, GoKwik or
  the cash drawer), not just recorded here"*. Then everything paid becomes a voucher automatically
  (1 year, one purchase of at least its value, no cash refund). Customer gets the voucher email,
  store gets a copy with the code. Staff then delete the draft — do not complete it.
- If the money was only recorded (demo), staff are told to use the other button instead.

**Demo or staff mistake**
- No voucher. No customer message at all. Store emailed.
- The draft becomes a normal draft again (lock off), still showing what was recorded on it.
  Staff can delete it — **it will not come back** — or start a new plan on the same draft.

**Both kinds**: a final "This cannot be undone" tick; the customer's open payment link is cancelled;
reminders and closing stop; deleting the draft no longer restores it; the tracker sheet shows
"Cancelled".

| Edge | Behaviour | Status |
|---|---|---|
| Cancel pressed while a product change is still being priced | Refused: "reopen in a few minutes" | ✅ |
| Voucher fails during cancel | Plan is still cancelled (never two vouchers); customer not emailed; store told to make it by hand | ✅ |
| Only part of the recorded money was real | One tick covers all of it. Staff must cancel as mistake and make a voucher by hand for the real part | ⚠️ **Decision D5** |
| The tick is the only check | The screen doesn't list each payment's source (GoKwik has a transaction id; in-store has none; Metafield Manager typing has no record) | ⚠️ |
| A voucher was already issued on the plan, then the customer opts out | The cancel voucher is only for what was not already given back | ✅ fixed 9 Nov |
| Draft keeps its 6 installment slots after cancel | Harmless if deleted; if kept as a normal draft, new payments still go in plan-style slots | ⚠️ |
| Customer pays some other way after cancel (e.g. typed into the Metafield Manager) | Not blocked | ❌ G2 |

## 10. Completion: turning a paid plan into an order
How it works: when the balance reaches ₹0 the plan just stops chasing. **Staff convert the draft to
an order by hand** (Shopify's "Create order"/"Mark as paid" or our convert button). The order
carries every payment in slots 1–6, and the tax invoice prints them. At the next 6-hourly check the
plan is marked complete and the customer gets the "complete" email.

| If… | Then… | Status |
|---|---|---|
| Fully paid | Plan stops chasing; screen says "Fully paid. The draft can be completed" | ✅ |
| Nobody tells the store a plan is ready to convert | No alert; only the screen and the tracker sheet (Balance 0) show it | ⚠️ |
| **Staff convert a draft that still has a balance** | Nothing stops it. The plan is marked complete, the customer is told "complete", all reminders stop, and the order is marked paid in full | ❌ **G1 (most serious)** |
| Equal plan converted before its final price | Same as above: final price never runs | ❌ G1 |
| The order keeps the `buy-plan` / `rate-locked` tags | Harmless today | ⚠️ |
| Customer pays via Shopify's own "Send invoice" checkout | Order completes; the money is outside the plan | 🧑 Never press Send invoice on a plan draft |

## 11. Deleting a plan draft
| If… | Then… | Status |
|---|---|---|
| A draft on an **active** plan is deleted | Rebuilt with the same pieces, prices and payments under a **new D number**; store alerted; old payment link cancelled | ✅ not yet proven live |
| The rebuilt copy is deleted again | Rebuilt again, forever — that is why your demo drafts kept coming back. **Press Cancel plan first** | ✅ by design |
| A cancelled, closed or completed plan's draft is deleted | Gone for good | ✅ |
| The draft had a voucher / exchange note / CAD advance applied | The delete frees it for reuse, but the rebuilt copy still deducts it → could be used twice | ❌ G5 |
| After a rebuild, the Buy plan screen's payment list | Empty (payment records still point at the old draft); money in the slots is correct | ❌ |
| Rebuild fails (Shopify error) | Retried every 6 hours; store is **not** told it failed | ⚠️ |

## 12. Tracker sheet, invoices, reports
| Item | Status |
|---|---|
| Sheet updates every 10 minutes and after each payment | ✅ |
| Closed / completed / cancelled plans show Paid 0 on the sheet | ❌ (another session is fixing this now) |
| Sheet password was shared in chat | ❌ Rotate it |
| Invoice and confirmation print installments 1–6 | ✅ if the Order Printer copy was updated |
| Buy-plan payments in the reports / recon as their own type | ❌ Not built yet |
| More than one server machine would run the check twice (two vouchers) | 🧑 Keep Fly at one machine |

---

## 13. The open list

### Gaps to fix (most serious first)
| # | Gap | Suggested fix |
|---|---|---|
| G1 | A draft with a balance can be converted; plan marked "complete" | Refuse conversion through our button; if Shopify's own button is used, keep the plan open, don't send "complete", alert the store |
| G2 | Payments after a plan ended (closed/cancelled) are not blocked | Refuse or alert on any payment to a draft whose plan is no longer active |
| G3 | ~~Second product change pays the same money twice~~ | Fixed 9 Nov: no automatic vouchers, running voucher total, change refused after a voucher |
| G4 | Midnight–5:30 am payments land in the previous installment | Date payments in IST |
| G5 | Deleting a draft frees its voucher/exchange note but the copy still uses it | Re-apply them to the rebuilt draft, or leave them unchanged on delete |
| G6 | Discounts/vouchers/old gold applied after the start are ignored by the plan | Refuse them on a plan draft, or re-base the plan |
| G7 | Refunds/chargebacks not seen by the plan | Count refunds against the plan's money |
| G8 | GoKwik webhook trusts the newest link, no signature, no duplicate check | Verify signature; match the payment to its own link and transaction id |
| G9 | Two simultaneous payments can lose one | Lock the draft while writing a payment |
| G10 | ~~Overpayment leaves unhandled credit~~ | Fixed 9 Nov: store prompted, Issue voucher button |
| G11 | Product change in the last 3 days gets stuck | Refuse Change product in the final-price window |

### Decisions needed from the founder
| # | Question | Suggested answer |
|---|---|---|
| D1 | On close/cancel, should old gold or an exchange note handed in at the start become part of the voucher? | Yes: voucher = money paid + old gold + exchange note value |
| D2 | Block converting a plan draft that still owes money? (G1) | Yes |
| D3 | 7th payment: fold into slot 6 (losing its date), or refuse? | Fold, but keep the earlier date |
| D4 | Allow typing payments into the Metafield Manager on plan drafts? | No; plan payments only through the Buy plan screen |
| D5 | Cancel when only part of the recorded money is real? | Let staff enter the verified amount instead of a single tick |
| D6 | ~~Gold fell / overpaid: automatic voucher?~~ | Decided 9 Nov: never automatic; staff press Issue voucher |
| D7 | Re-read the customer's phone/email before each message? | Yes |
| D8 | Alert the store when a plan is fully paid and ready to convert? | Yes, in the daily digest |

### Not yet tried on the live store
Re-added piece put back · final price (gold only) · deleted-draft rebuild · 30-day link refresh ·
closing and its voucher · cancel (both kinds) · single-plan check. All are in the UAT list
(`docs/Buy-Plan-UAT-v2.docx`, checks 1–19), which still needs updating for today's changes.
