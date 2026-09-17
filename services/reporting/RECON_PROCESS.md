# Payments Recon — monthly process

_Established 2026-08-07. Applies to the Payment Recon tab in the Google Sheet
(`POST /api/recon`) and to the local `Recon Test/proto_recon.py`._

## The monthly routine

1. Export the six inputs (table below) and drop them in the **Drive folder**.
2. Open the Sheet → **📊 Reports → Payment Recon**. It uploads whatever is in that
   folder and reconciles it.

That's it. No commit, no deploy. The Drive folder ID lives in **B1** of the Payment Recon
tab; leave B1 blank to fall back to the copy baked into the server image.

## What range to export, and why it differs per file

The answer is not one range for everything — it depends on whether the export is a
*period record* (append) or a *point-in-time snapshot* (replace or keep).

| Input | Range | Filename | Old files |
|---|---|---|---|
| Pine `All transactions report` | **the month** | as exported (carries the range) | **keep forever** |
| Pine `MPR` (.xlsx) | **the month** | as exported | **keep forever** |
| GoKwik `transaction-report` | **the month** | as exported | **keep forever** |
| GoKwik `settlement_v2-report` | **the month** | as exported | **keep forever** |
| Shopify `Accounts - Fully Paid Orders` | **financial-year-to-date** | keep the **same name**, overwrite | n/a — one file |
| `draft-orders-report` (middleware) | point-in-time | date-suffixed, e.g. `draft-orders-report-2026-08-07.csv` | **keep forever** |

### Why the gateway files are monthly and accumulate
Recon unions every file matching each keyword, so months simply add up. Never delete them:
a payment taken on 30-Jul settles in August, so its fee and UTR appear in the **August**
MPR, not July's. Keeping both is what lets a July payment ever show its settlement. It also
means re-running an earlier month after dropping the new one can legitimately *improve* it.

### Why fully-paid orders is year-to-date
A payment can precede its order by weeks (an advance) or follow it, and the matcher's
window is 35 days. If the orders export only covers the current month, a payment from the
previous month has nothing to match against — that is exactly why six June/May legs read
UNLINKED in the 2026-08 run while the orders file held only #1064–#1067.

Export FY-to-date and keep the **same filename** so each export overwrites the last. Orders
are immutable once fully paid, so a wider range costs nothing but coverage. If you ever do
end up with two orders files, the later one wins per order ref — an overlapping re-export
restates a document, it does not double-count it.

### Why draft snapshots must be kept
`/api/draft-orders-report` returns only `open` + `invoice_sent` drafts. **A draft disappears
from it the moment it converts to an order.** #D156 took a ₹37,900 advance in June and
converted to #1066 in July — by August it was gone from the live export, and only the
retained June snapshot still carried it. Delete old snapshots and you lose the ability to
reconcile any advance whose draft has since converted.

So: date-suffix each month's export and keep them all. Later snapshots win per draft ref,
and drafts that only exist in an older snapshot survive.

## Which drafts to export

Pull by payment status — anything that received money qualifies, whatever it was for:

```
/api/draft-orders-report?paymentStatus=partial
/api/draft-orders-report?paymentStatus=fully-paid
```

Merge the two into one file. Repairs and CAD advances are included deliberately — they are
real money received. (E2E test drafts also come through; they carry real-looking `paid:Rs`
tags and are noise until they're deleted.)

Note `from`/`to` do **not** work on that endpoint — Shopify's REST `draft_orders.json`
ignores `created_at_min`/`created_at_max` silently. Filter by payment status only.

## Reading the output

`GroupStatus` / `Role` / `Notes` carry the reconciliation story. Methods, strongest first:

| Method | Meaning |
|---|---|
| `BILL_INVOICE` / `ORDER_REF` / `DRAFT_REF` | the transaction named its document — trust it |
| `AMOUNT_DATE` | amount matches a total or a recorded advance, within 3 days |
| `BALANCE_MATCH` | closes what was still outstanding after an earlier leg — the cross-month case |
| `MULTI_DOC_PAYMENT` | one swipe covering several documents for the same customer |
| `VPA_CROSS_REF` / `NAME_DATE` | identity-based, amount unconfirmed — check these |
| `SPLIT_PAYMENT` | several legs summing to one total — amounts only, LOW confidence |
| `AMBIGUOUS` / `UNLINKED` | needs a human |

`UNLINKED` almost always means one of: the document is outside the exported range (fix the
export), the draft converted and its snapshot was deleted (see above), or the card was run
for a figure that is neither the total nor the balance — e.g. #1067 was swiped for the
pre-discount ₹77,394 against a ₹74,288.67 order.

## How the date window works (fixed 2026-08-11)

The window is there to **choose between documents that share an amount** — it is not a
plausibility test on the payment. It used to be a flat 3 days, applied even when only one
document in the dataset carried that amount, which wrongly rejected both an advance
collected before its order existed and #1060 (card `K SANTOSH KUMAR` vs order
`Santosh Kampli`). It now widens with the evidence:

| Situation | Window |
|---|---|
| Exactly one document has this amount — nothing to disambiguate | 60d |
| Payer and customer are the same person (name ≥ 0.6) | 45d |
| Shared surname, or an initialled form of the name (≥ 0.34) | 21d |
| Amount alone, payer unknown | 7d |

Name comparison scores by *containment*, so `akash.shetty@okhdfcbank` ↔ `Akash Shetty` and
`varshareddy24@okhdfcbank` ↔ `Varsha Reddy` both read as the same person. A single shared
common surname is not enough on its own.

A document with **no date** (a Month-grouped export, or a renamed column) is no longer
silently unmatchable — it is judged on amount and name, marked LOW, and the note says so.

## Known gaps (not yet fixed)

- Converted drafts are only available from retained snapshots. Reading `status=completed`
  drafts directly during recon would remove the need to keep them.
- `SPLIT_PAYMENT` is amount-driven and payer-agnostic, so a plausible-looking combination
  can be coincidence. Treat every LOW split as needing a human — e.g. ₹72,000 (30-May) +
  ₹32,548 (17-Jun) → #1059 ₹104,548.71 fits to 71 paise but the payers differ.
