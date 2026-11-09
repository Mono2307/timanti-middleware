# Buy Plan: edge-case coverage matrix (9 Nov 2026)

Plain-language version for staff and the founder: `docs/BUY-PLAN-EDGE-CASES.md`. Rows updated for `0d2f06a` (Cancel plan, single-plan sweep, link cancelled on close); the counts below are from before it.

Every edge case we could find, checked against the **code** (not its comments) at `11bdd84` plus the
uncommitted work in progress. Rules: `docs/BUY-PLAN-CONTEXT.md` and the founder decisions.
Line numbers are as of 9 Nov 2026. `server.js` was being edited at the same time, so its numbers may drift
by a few lines. Search for the function name.

**Status key:** **Covered**: the code does it and a test or a direct read proves it. **Partial**: it works
on the happy path, but a nearby variant fails or needs manual work. **Not covered**: nothing handles it.
**Store**: left to staff on purpose. **Building**: in progress now (not audited).

## Summary

| Status | Count |
|---|---|
| Covered | 75 |
| Partial | 33 |
| Not covered | 20 |
| Store | 8 |
| Building | 2 |
| **Total** | **138** |

### Top 10 gaps, ranked by money or customer risk
1. **A plan draft can be converted with a balance still owing, and the plan then counts as "complete".**
   Nothing blocks it: not Shopify's native Create order or Mark as paid, and not `/api/convert-to-order`.
   The sweep then sets the plan to `completed` whatever the balance, sends the customer "your buy plan is
   complete", and stops every reminder (`sweep.js:192`). (CC-1, CC-2)
2. **Closing a plan leaves its payment link open.** `forfeitPlan` never cancels open GoKwik links, and the
   GoKwik webhook does not check the plan's status. A customer paying the link they were sent with the day-45
   warning *after* the plan closed is credited to the released draft, but their voucher was already fixed at
   the earlier amount. Cancellation must not repeat this. (MC-6, PL-6)
3. **A second product change issues a second voucher for the same money.** `finishChange` makes a voucher
   for `paid − newTotal` and never subtracts a voucher already issued for this plan (`sweep.js:90`). Change to
   cheaper piece A (voucher C), then to cheaper piece B: the new voucher is `C + (A−B)`, so C is paid out twice.
   The new code also overwrites `voucher_code` on the plan row. (PC-6)
4. **Payments are dated in UTC, but due dates are IST.** `paymentLegPatch(... date: new Date().toISOString()
   .slice(0,10))` (`server.js:472`). A payment made between 00:00 and 05:30 IST on a due date is dated the day
   before, so it counts in the previous period. That moves the arrears, the missed status and the 60-day close
   clock. (SM-7)
5. **Deleting a plan draft frees the vouchers and exchange notes applied to it, but the restored copy still
   deducts them.** The same delete webhook runs `creditInstruments.revertApplied` (back to *open*), closes a CAD
   advance as `deleted`, and runs the refund bookkeeping (`procurement/routes.js` delete branch). The restored
   draft then carries `voucher_value` / `exchange_note_value` again (`RESTORE_KEYS`), so the same voucher can
   be spent twice. (DR-5)
6. **A voucher, exchange note, old gold or discount applied after the start is ignored by the plan.**
   `buy_plans.total` is frozen at the start. `voucher-redeem`, `exc-redeem`, old gold and Shopify's native line
   or draft discounts are not refused on a locked draft. The draft's amount to collect falls, but the plan still
   asks for the old total, so the customer is chased for money already settled. The draft can also show "Full"
   while the plan shows a balance. (LK-9, PI-10)
7. **A refund or chargeback on a plan payment is invisible to the plan.** `planState` reads only the
   installment slots. Refunds live in `store_deposits.amount_refunded`. A refunded or charged-back payment still
   counts toward the schedule, the voucher on closing, and "complete". (PI-8)
8. **A GoKwik payment can be lost, or recorded at the wrong amount.** The webhook credits the *newest open*
   link and takes the amount from that row, not from the payload (`server.js` `/api/gokwik-webhook`). There is
   no signature check and no check against an already-used transaction id. A payment on a link we marked
   cancelled (the GoKwik cancel failed, so it is still payable) is logged as "no active link" and dropped when
   there is no newer link, or credited at the *newer* link's amount when there is one. A replayed `success`
   webhook does the same against a newer link. (PL-3, PL-4, PL-5)
9. **Two payments recorded at once can lose one.** `handlePaymentCompletion` reads the slots, picks the next
   free one and writes it back, with no lock and no idempotency key. The Buy plan screen blocks a double-click,
   but two staff, or a staff payment landing at the same moment as a GoKwik webhook, can both claim the same
   slot. One payment then vanishes from the slots, though `store_deposit_payments` still has both rows. (CF-1)
10. **Overpaying past the balance leaves an unhandled credit.** A link raised for amount X, paid after
    another payment has already lowered the balance, puts the plan in credit. The sweep stops at "fully paid,
    staff complete" (`sweep.js:242`). Nothing issues a voucher or alerts the store, except on the final price
    (`sendFinalCredit`, store email only) and on a product change. (PI-6)

### Completion and conversion (asked specifically)
- **Nothing stops staff converting a plan draft that still has a balance.** See CC-1 and CC-2. Converting
  through `/api/convert-to-order` or Shopify's Mark as paid also writes a Shopify "paid" transaction for the
  full total, whatever money really came in. That is a general issue, not specific to buy plans.
- **The order inherits the draft's tags (`buy-plan`, `rate-locked` on a gold plan) and its metafields
  (`plan_total`, `plan_due_dates`, the installment slots).** Effects:
  - The sold-piece alert correctly skips the plan's own order (`sold-alert.js:23`).
  - Order-side flows do not check the lock, so nothing breaks today.
  - The invoice and confirmation print slots 1–6 (`8093831`).
  - **Trap:** any later draft copied from this order (an exchange or re-order) that copies its tags would be
    locked and would refuse every reprice. No such copy path exists today; check before building one.
  - `plan_due_dates` on the order means any payment recorded against it later still goes through
    `planLegPatch` (harmless).
- **Fully paid → the customer gets "your buy plan is complete" only after staff convert, at the next 6-hour
  sweep.** Until then a fully paid plan just stops being chased (`sweep.js:242`). Staff can see it on the
  tracker sheet (Balance 0), but nothing alerts the store that a plan is ready to convert. (CC-3)

### What this means for Cancel plan
- **Cancel every open GoKwik link on the draft before anything else** (the same loop as `restore.js:83-89`).
  Then refuse any later payment on a plan that is not active: the GoKwik webhook and `handlePaymentCompletion`
  must check the plan status, or at least alert the store. Otherwise a cancelled plan takes the same late
  money as gap 2.
- **"Is this payment real?":** the evidence differs by source.
  - GoKwik payments have `payment_links.gokwik_txn_id` and a `utr`.
  - Payments recorded in store on the Buy plan screen are `store_deposit_payments` rows with `payment_source
    = 'buy-plan'`. They have no reference field: no UTR, card slip or receipt number.
  - Amounts typed straight into the Metafield Manager slots have **no row at all**, only the slot.
  - So the confirm step should list each payment with its source, and show "typed into the Metafield Manager:
    no record" plainly.
- **Release the draft the same way `forfeitPlan` does** (`forfeit.js:38-41`): remove `buy-plan`,
  `rate-locked`, `buy-plan-final`, `buy-plan-change` and `reprice`. Otherwise the lock stays on and the draft
  can't be repriced or reused. Also clear `plan_total` and `plan_due_dates`, which forfeit leaves behind; while
  they stay on the draft, payments keep landing in plan slots.
- **Set the status before issuing the voucher**, as forfeit does, so a retry can never issue two. Don't
  issue a voucher for any amount a product-change voucher already covered (see gap 3).
- **A demo plan cancelled with no voucher still leaves real slots on the draft.** Say in the store email
  that deleting the draft is now safe: a cancelled plan is not restored (`restore.js:63` only restores
  `active` plans).
- **Deleting a cancelled draft still frees its vouchers and exchange notes** (`revertApplied`). That is
  right for a cancelled plan.
- **Restore chains:** the plan row follows the newest draft id. Cancelling by the current draft id is enough.
  Older D numbers are already gone.

---

## Matrix

### Start (ST)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| ST-1 | Equal plan with 4, 5 or 6 installments: schedule = total ÷ n, rounded up | Covered | `schedule.js:123`, `routes.js:140` | UAT 1 | |
| ST-2 | Gold plan blocked until the gold value is paid | Covered | `draft.js:79-85` | UAT 2 | |
| ST-3 | Gold value = Gold props, no GST; more paid before the start → installment 1 = what was paid | Covered | `draft.js:65`, `routes.js:162` | UAT 2, paying above the gold value | |
| ST-4 | No customer, phone or email on the draft → Start refused | Covered | `draft.js:74-76` | Start on a draft with no email | |
| ST-5 | Draft already fully paid, or nothing to collect → refused | Covered | `draft.js:77-78` | routes.test | |
| ST-6 | Double-click or two staff pressing Start → one plan | Covered | `store.js:33` unique key, `routes.js:147` | Press Start on two devices | |
| ST-7 | Shopify refuses the lock tag → plan row removed | Covered | `routes.js:173-179` | | |
| ST-8 | Plan started on a draft with payments already on it: they count for installment 1, no "received" email | Covered | `routes.js:166`, schedule.test "payment before the plan starts" | Start on a part-paid draft | |
| ST-9 | Plan started on a draft with a voucher, exchange note, old gold or CAD advance: total = amount to collect | Partial | `draft.js:44`. Correct at the start, but on closing the voucher is only the *money* paid. Old gold or an exchange note stays applied to the released draft. | Start with old gold, then let it close (dry run) | **Does old gold or an exchange note handed in become part of the closing voucher, or stay on the released draft?** |
| ST-10 | CAD advance slot on the draft before the start | Covered | `draft.js:45` filters `cad_advance` legs out of payments | | |
| ST-11 | Gold link paid but Start never pressed: money sits on a normal draft, no lock | Store | `routes.js:208` | | Staff press Start the same day |
| ST-12 | Rate moves between paying the gold link and pressing Start (the draft isn't locked yet) | Partial | No lock before Start, and the gold value isn't re-checked at Start | Pay the gold link, reprice the draft, Start | Lock at gold-link time? |

### Lock and price (LK)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| LK-1 | `reprice` / `recalculate-price` tag refused | Covered | `server.js:1636` handleRecalculatePriceTag | UAT 3 | |
| LK-2 | Jewel-code form and PO-sheet reprice refused before they write the rate | Covered | `server.js:4016`, `procurement/routes.js:196` | | |
| LK-3 | apply-discount and loyalty refused | Covered | `server.js:3373`, `loyalty/draft.js:293` | Apply loyalty on a plan draft | |
| LK-4 | Hydration skipped on a locked (or restored) draft | Covered | `server.js:1247` | | |
| LK-5 | `rate-locked` removed by hand → `buy-plan` still locks | Covered | `lock.js:33`, lock.test | | |
| LK-6 | Gold Rate typed (or mistyped) in the Metafield Manager | Partial | Prices stay put, but `custom.gold_rate` keeps the typo. The restore copies it (`RESTORE_KEYS`), and the final price's *estimate* reads it (`final.js:45`). The final price itself uses each line's `_gold_rate`. | UAT 3, then read the metafield | Clear or revert the field on a locked draft? |
| LK-7 | Piece removed and re-added: plan price put back | Covered | `sweep.js:159` keepLockedPrices, sweep.test | UAT 4 (not yet proven live) | |
| LK-8 | Line price edited by hand in Shopify admin | Covered | the same price comparison `draft.js:193` | Edit a line price, run a dry sweep | |
| LK-9 | Shopify native line or draft discount added | Not covered | Neither the price nor the breakup moves, so nothing is caught. The amount to collect falls, the plan total doesn't. | Add a 5% draft discount, run a dry sweep | |
| LK-10 | Line quantity changed | Covered | Shows as "pieces edited" (`sweep.js:143`), store alerted | | |
| LK-11 | Shopify admin "Send invoice" → customer checks out the full amount | Partial | The draft completes; the plan becomes completed (`sweep.js:192`). The money is outside the plan's slots. | | Staff never press Send invoice on a plan |
| LK-12 | Gold rate falls after a gold lock: no exception | Covered | Founder: strict | | |

### Payments in (PI)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| PI-1 | ₹999 refused; "20,000", "₹20,000" and "Rs 20000" accepted | Covered | `schedule.js:216-225` | UAT 6 | |
| PI-2 | Balance under ₹1,000 → the balance is the minimum | Covered | `schedule.js:177` | | |
| PI-3 | More than the balance refused (screen and pay page) | Covered | `schedule.js:224` | | |
| PI-4 | In-store payment: deposit row, slot, amount paid, tags | Covered | `routes.js:232`, `server.js:389` | UAT 5 | |
| PI-5 | Each payment in its own slot; a 7th folds into slot 6 | Partial | `installments.js:140`. The fold **overwrites slot 6's date and payment mode** with the newest, so slot 6's earlier payment is re-dated and the schedule moves it into a later period. | 7 payments, then read the rows | Fold into 6, or refuse a 7th? |
| PI-6 | Stale link paid after the balance has dropped → plan in credit | Not covered | `sweep.js:242` returns "fully paid". No voucher, no alert. | Send a link, record cash, pay the link | Credit → voucher automatically? |
| PI-7 | Amount typed straight into the Metafield Manager slots | Partial | Counted (the schedule reads slots), but there's no `store_deposit_payments` row, so it's missing from the screen's payment list and from reports | Type ₹1,000 into slot 2 | Forbid on plan drafts? |
| PI-8 | Refund or chargeback of a plan payment | Not covered | Refunds don't reduce plan money (`schedule.js:99` reads slots only) | Refund ₹1,000 on a plan draft, run a dry sweep | |
| PI-9 | Payment slot blanked to correct a mistake | Partial | The plan's paid amount drops, `acknowledged_paid` stays high (no email until it's passed again). The deposit row isn't reduced. | | |
| PI-10 | Voucher, exchange note or old gold redeemed on a plan draft after the start | Not covered | Not refused; the plan total stays frozen | `voucher-redeem` on a plan draft | Refuse, or re-base the plan? |
| PI-11 | Payment on a closed, completed or cancelled plan | Not covered | Record payment refuses (`routes.js:239`), but the GoKwik webhook and the Metafield Manager don't | Close in a dry run → see MC-6 | |
| PI-12 | Pine terminal payment on a plan draft | Partial | `handlePaymentCompletion` records it in a slot. The plan screen's mode list has no "pine", so it shows as card. | | |
| PI-13 | Payment after the last due date, before closing | Covered | Last installment = the whole balance (`schedule.js:150`) | UAT 17 window | |

### Payment links (PL)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| PL-1 | One open link per plan (older ones cancelled) | Covered | `links.js:48-56` | Send two links, check `/api/payment-links` | |
| PL-2 | Link valid 30 days; fresh link 3 days before expiry, once | Covered | `links.js:20`, `sweep.js:304`, sweep.test | Not yet proven live | |
| PL-3 | GoKwik cancel fails but the row is marked cancelled → the customer pays the old link | Not covered | `links.js:53` only logs a warning. The webhook finds no open link → payment dropped, or credited at the newer link's amount. | | |
| PL-4 | Replayed or duplicate `success` webhook | Partial | Harmless with one link (it's now `success`). Credits again if a newer open link exists. No transaction-id check. | Replay a captured webhook body | |
| PL-5 | Webhook signature not verified | Not covered | `server.js` gokwik-webhook. Capture only (`gokwik_webhook_log`). | | Verify first (memory: pending) |
| PL-6 | Closing a plan doesn't cancel its open link | Covered (0d2f06a) | `forfeit.js` releaseDraft → `links.js` cancelOpenLinks | Close (real run) → `payment_links` status | |
| PL-7 | `expired` or `cancelled` webhook marks *all* open links on the draft | Partial | `server.js` gokwik-webhook. Fine with one link per plan. | | |
| PL-8 | Pay page: tampered or expired token, plan not active, draft missing | Covered | `links.js:34`, `routes.js:309-322` | UAT 8 | |
| PL-9 | Pay page reported broken | Partial | Investigating (UAT doc request 2) | UAT 8 | |
| PL-10 | Customer with no phone → no SMS | Covered | Start requires a phone (`draft.js:75`) | | |
| PL-11 | Customer's phone or email changed after the start | Partial | The plan keeps the start values (`routes.js:158`) | Change the customer email, send a link | Re-read from the customer? |

### Schedule maths (SM)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| SM-1 | Overpay lowers the later installments; underpay raises them | Covered | `schedule.js:126`, schedule.test | UAT 9 | |
| SM-2 | Missed period carried forward ("double") | Covered | `schedule.js:130` | UAT 13 | |
| SM-3 | Last installment = the whole balance | Covered | `schedule.js:150` | UAT 9 | |
| SM-4 | Two payments in one period both count | Covered | schedule.test | | |
| SM-5 | Start on the 29th, 30th or 31st → clamped to month end, then back to 31 | Covered | `cad_advance.js:25` addMonths (works from the original day) | schedule.test "31 Jan → 28 Feb" | |
| SM-6 | Rounding: `ceil` on each installment, the last absorbs it | Covered | `schedule.js:126` | | |
| SM-7 | Payment between 00:00 and 05:30 IST dated the previous day (UTC) | Not covered | `server.js:472` (and `:1096`) | Pay at 01:00 IST on a due date | |
| SM-8 | Sweep "today" is IST; `asOf` is 11:30 IST | Covered | `draft.js:11`, `routes.js:374` | | |
| SM-9 | Gold plan replays installment 1 as the gold value after a product change | Covered | `schedule.js:105` | | |

### Product change (PC)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| PC-1 | Equal plan: swap the piece → paid kept, rest re-spread, email | Covered | `routes.js:264`, `sweep.js:66` | UAT 11 (done on D327) | |
| PC-2 | Gold plan: the lock is lost for good → Equal | Covered | `routes.js:275-278` | UAT 12 | |
| PC-3 | Cheaper piece than already paid → voucher for the difference | Covered | `sweep.js:90` | UAT 12 | |
| PC-4 | Change pressed with the pieces unchanged → refused | Covered | `routes.js:270` | | |
| PC-5 | A piece with no gold rate today → change refused, nothing written | Covered | `final.js:131` | | |
| PC-6 | **Second change after a change voucher → voucher again for the same money** | Not covered | `sweep.js:90` doesn't subtract `voucher_value` | Change to cheaper A, then cheaper B (dry) | |
| PC-7 | Change voucher: the draft still shows payments above its total; what does the invoice show? | Partial | The draft is over-collected by the voucher amount, which shows on the invoice and in recon | Convert after PC-3 | **Accounting: how should the change voucher show on the invoice?** |
| PC-8 | Change pressed after the final price started but before it finished | Not covered | The change reprice drops `rate-locked`; `finalRepriceDone` needs it (`final.js:161`), so it's stuck in the digest forever | Change inside the last 3 days | Refuse a change in the final window? |
| PC-9 | Change reprice never finishes (webhook lost) | Partial | Digest "stuck" after 1 hour (`sweep.js:69-72`); a manual fix is needed | | |
| PC-10 | Change pressed twice | Covered | `routes.js:268` | | |
| PC-11 | Pieces edited without pressing Change → store alert; the restore keeps the plan's pieces | Covered | `sweep.js:143`, `:216` | sweep.test | |

### Final price, Equal plan (FP)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| FP-1 | 3 days before the last date: only the gold moves | Covered | `final.js:68`, `sweep.js:105` | Not proven live (dry run D327 with `asOf`) | |
| FP-2 | Runs once; waits for the recompute | Covered | `sweep.js:110`, `final.js:161` | sweep.test | |
| FP-3 | Line with no Gold breakup or no rate → left at its price, logged | Partial | `final.js:80-81`. Only a log warning, no store alert. | | |
| FP-4 | Gold fell below what was paid → credit | Partial | `sendFinalCredit` emails the store; no voucher | | Voucher automatically? |
| FP-5 | The reminder's estimate ignores an earlier product change | Partial | `final.js:122` uses `plan.total`, not `currentTotal` | Change, then reach the final window | |
| FP-6 | Final price stuck (the sync never clears) | Partial | Digest "stuck" (`sweep.js:119`) | | |

### Missed payments and closing (MC)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| MC-1 | Warnings at 30 and 45 days with the close date | Covered | `schedule.js:168`, `sweep.js:255` | UAT 15 | |
| MC-2 | 60 days with no payment → closed, voucher | Covered | `sweep.js:245`, `forfeit.js:22` | UAT 16 (dry run first) | |
| MC-3 | Last installment +30 days → closed; warnings at 15 and 25 | Covered | `schedule.js:164-169` | UAT 17 | |
| MC-4 | Any payment restarts the clock | Covered | schedule.test | UAT 14 | |
| MC-5 | Closed draft released (tags off, `buy-plan-closed`) | Partial | `forfeit.js:38-41`. `plan_total` and `plan_due_dates` stay on the draft. | Read the tags and metafields after closing | |
| MC-6 | Customer pays the warning-email link after closing | Partial | The link is now cancelled on close (0d2f06a). Still open if GoKwik's cancel fails (PL-3), and the webhook doesn't check plan status (PI-11). | | |
| MC-7 | Closed draft must be deleted by hand | Store | Store email | | |
| MC-8 | Sweep with a future `asOf` touches all plans | Covered (0d2f06a) | `draft=D327` runs one plan, never sends the digest (`sweep.js` planMatches) | sweep.test | |

### Vouchers (VO)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| VO-1 | VCH serial, single-use code tied to the customer, 1 year, ledger row | Covered | `voucher.js:28-60` | Shopify Discounts + `/api/credit-instrument/open?type=voucher` | |
| VO-2 | "One purchase of at least its value": enforced online | Covered | `voucher.js:48` prerequisite_subtotal_range | Check out under the value | |
| VO-3 | Same minimum in store | Store | Staff check | | |
| VO-4 | Voucher half made (serial minted, Shopify failed) | Partial | `voucher.js:60` puts the serial in the error, the store email says to create it by hand, no retry. The plan stays closed with no `voucher_code`. | | |
| VO-5 | Closing never issues two vouchers | Covered | Status set first (`forfeit.js:24`) | | |
| VO-6 | Plan with no customer id → no voucher | Covered | Can't happen: Start requires a customer (`draft.js:74`); `voucher.js:31` guards | | |
| VO-7 | Voucher works with loyalty | Covered | `voucher.js` allowVoucherWithLoyalty | | |
| VO-8 | Voucher expiry | Covered | the existing voucher expiry sweep | | |
| VO-9 | Customer later merged or changed in Shopify → voucher bound to the old customer id | Partial | `prerequisite_customer_ids` | | |

### Completion and conversion (CC)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| CC-1 | **Converted with a balance still owing → plan "completed", customer emailed "complete"** | Not covered | `sweep.js:192` checks only `status === 'completed'` | Convert a part-paid test plan, run the sweep | **Block, or alert the store?** |
| CC-2 | `/api/convert-to-order` and Shopify Mark as paid don't check the balance | Not covered | `server.js:4442` | | |
| CC-3 | Fully paid → no prompt to convert (auto-convert is off) | Partial | Plan just goes quiet (`sweep.js:242`); the sheet shows Balance 0 | UAT 10 | Digest row "ready to convert"? |
| CC-4 | Invoice shows every payment (slots 1–6) | Covered | `8093831` (if pasted into Order Printer) | UAT 10 | |
| CC-5 | Order carries `buy-plan`, `rate-locked` and plan metafields | Partial | Harmless today; a trap if a copy-from-order flow is built | | |
| CC-6 | Sold-piece alert skips the plan's own order | Covered | `sold-alert.js:23-29` | sold-alert.test | |
| CC-7 | "Complete" email shows the current total | Covered | `notify.js:128` | | |
| CC-8 | Spent draft deleted after full payment → not restored | Covered | `restore.js:67-71` | | |

### Delete and restore (DR)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| DR-1 | Deleted plan draft recreated with lines, prices, payments; new D number; store alert | Covered | `restore.js:61` | UAT 18 (not proven live after `0e8b316`) | |
| DR-2 | Deleting the restored copy restores it again (forever) | Covered | By design (the plan follows the new id). Your demo-draft problem; Cancel plan is the way out. | | |
| DR-3 | Restore fails (Shopify error) | Partial | Logged; the sweep retries every 6 hours. **No store alert on failure**, and the sweep result only says "restore attempted". | | |
| DR-4 | Open links on the deleted draft cancelled | Covered | `restore.js:83-89` | | |
| DR-5 | **Vouchers, exchange notes and CAD advance on the deleted draft freed, but still deducted on the copy** | Not covered | delete branch `procurement/routes.js` (revertApplied, handleAdvanceDraftDeleted) vs `RESTORE_KEYS` | Delete a plan draft with a voucher applied; check the ledger | |
| DR-6 | `store_deposit_payments` not moved to the new draft id | Not covered | `restore.js:81` moves `store_deposits` only, so the Buy plan screen's payment list is empty after a restore, and reports point at the dead draft | UAT 18, then open the Buy plan screen | |
| DR-7 | Restore and the sweep at the same moment → two drafts | Partial | Small window; whoever loses finds the plan already moved | | |
| DR-8 | Line discounts and draft-wide discount carried | Covered | `draft.js:130-149`, links.test | | |
| DR-9 | Order Printer / tracker sheet: the old D number vanishes | Store | Note the old against the new | | |

### Cancellation (CA)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| CA-1 | Cancel plan: customer opted out (voucher for verified money) or demo / staff mistake (no voucher) | Covered (0d2f06a) | `cancel.js`, `routes.js` cancelHandler, `BuyPlan.jsx` | cancel.test; live: cancel a demo draft | Still open: per-payment source list, partial verification (D5), plan_total/plan_due_dates left on the draft, change-voucher double count (PC-6) |
| CA-2 | Pay page on a cancelled plan | Covered | `routes.js:317` "no longer active" | | |

### Messages (MS)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| MS-1 | Every reminder sent once (sent-markers) | Covered | `store.js` wasSent/markSent | sweep.test | |
| MS-2 | Staff digest once a day, every issue listed | Covered | `sweep.js` runBuyPlanSweep | sweep.test | |
| MS-3 | "Payment received" is up to 6 hours late | Partial | Only the sweep sends it | | |
| MS-4 | WhatsApp is manual (wa.me links) | Store | | | |
| MS-5 | A failed email isn't retried; the marker is written only after sending | Covered | `sweep.js:274-275` pattern | | |

### Staff screen and Metafield Manager (UI)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| UI-1 | Buttons disabled while busy (no double-click) | Covered | `BuyPlan.jsx:233,297,317,342-351` | | |
| UI-2 | Metafield Manager shows slots 1–6 on plans, 1–4 elsewhere | Covered | `68b8bb5` | UAT 19 | |
| UI-3 | Slot with two payments shows only one mode | Partial | Known limit (before `8e03e4f` only) | | |
| UI-4 | Staff can edit plan slots freely in the Metafield Manager | Partial | See PI-7 and PI-9 | | |
| UI-5 | Wait about 5 minutes after Change product before any other edit | Store | | | |

### Tracker sheet (TS)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| TS-1 | Active plans read live every 10 minutes and after each payment | Covered | `sheet.js:73-80` | | |
| TS-2 | **Closed, completed and cancelled plans show Paid 0, Balance = total** | Not covered | `sheet.js:55` reads `snapshot.legs`, which `snapshotOf` never writes | Look at any completed plan's row | |
| TS-3 | Sheet secret was shared in chat | Not covered | Rotate it (Script properties + Fly secret) | | |

### Invoice and templates (IT)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| IT-1 | Tax invoice and confirmation print slots 5–6 | Covered | `8093831` | UAT 10 | |
| IT-2 | Installed Order Printer copy may lag the repo | Store | (memory: template drift) | Re-print one plan order | |
| IT-3 | Shopify notifications (draft invoice / advance receipt) have no buy-plan wording | Partial | `templates/Shopify-Notifications-PASTE/1`: nothing plan-specific | | Wanted? |

### Reports and recon (RR)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| RR-1 | Reports have 6 installment columns | Covered | `reporting/reports.js:105` | | |
| RR-2 | Plan payments recorded and reconciled as their own type | Not covered | Next steps item 4 | | |
| RR-3 | GoKwik plan payments match in recon (mode `online_link`) | Partial | `recon.js:385` matches by mode; the order exists only months later | | |
| RR-4 | Plan vouchers in the ledger with `BUY-PLAN` source | Covered | `voucher.js:57` | | |

### Concurrency and failure (CF)
| # | Case | Status | Where | How to test | Decision |
|---|---|---|---|---|---|
| CF-1 | Two payments at once (two staff, or staff + webhook) → one lost from the slots | Not covered | `server.js:389` read, then write, no lock | | |
| CF-2 | Store payment recorded with no idempotency key (`Date.now()` id) | Partial | `routes.js:249`. A network retry would record it twice. | | |
| CF-3 | Product-change and final-price follow-ups are in-memory timers, lost on deploy | Covered | The next 6-hour sweep picks them up | | |
| CF-4 | One bad plan doesn't stop the sweep | Covered | `sweep.js` runBuyPlanSweep try/catch | | |
| CF-5 | Plan reminder markers can't be read → treated as sent | Covered | `store.js:56` | | |
| CF-6 | More than one Fly machine would run two sweeps (double voucher on close) | Store | `fly.toml` min 1 machine; no lock in the code | | Keep one machine |
| CF-7 | Rate limits: plan sync passes get 429'd (memory: webhook rate-limit amplifier) | Partial | Recompute may lag; final price waits for `sync-payment` | | |
| CF-8 | Supabase down during record payment | Partial | `handlePaymentCompletion` may write Shopify but not the deposit row | | |
