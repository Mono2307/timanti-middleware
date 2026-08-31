# RCA — two invoice numbers destroyed on order #1073

**Incident date:** 29 August 2026, 16:30 IST
**Found:** 31 August 2026, by reading a printed invoice
**Impact:** GST invoice series `TM27-KAHSR` jumped 00004 → 00007. Numbers 00005 and 00006 do not exist and cannot be recovered.
**Detected by:** a human noticing the gap. No alert, no log, no error.

---

## 1. What happened

Staff completed draft **#D157** — an eight-week-old draft carrying a ₹55,000 card advance — converting it to order **#1073** at 16:30:29.

That one action produced **five webhook deliveries**. Three of them ran the order-numbering job concurrently. Each drew a number from the counter. Only one could record its number. The other two discarded theirs in silence.

---

## 2. Timeline

| Time | Event | What it did |
|---|---|---|
| 16:30:29 | staff completes #D157 | order #1073 created |
| 16:30:32 | `draft_orders/update` | begins copying **18 metafields** draft → order |
| 16:30:33 | `orders/updated` **pass 1** | folds ₹55,000 into installment leg 1; writes 4 metafields; **writes tags** (`i1:55000@@`, malformed — mode not yet read); gets **422**; bails at numbering (no store code yet) |
| 16:30:37 | **`state_code = KA-HSR` lands** | the numbering job's first guard stops blocking |
| 16:30:37 | `orders/updated` **pass 2** | *fired by pass 1's tag write at :36.* Store code present, no number stamped → **draws a number** |
| 16:30:38 | copy completes | "copied 18 metafields → order" |
| 16:30:39 | three identical tag writes | three passes writing `i1:55000@card@` in the same second |
| 16:30:39 | `[ledger] conversion redeem: 429` | Shopify rate-limiting |
| 16:30:39 | **counter last written** | value now 7 — three draws total (5, 6, 7) |
| 16:30:41 | `orders/updated` **pass 3** | *fired by the :39 tag writes.* → **draws a number** |
| 16:30:41 | `[payment-sync] #1073: 429` | passes throttling each other |
| 16:30:43.577 | `[serial] customer_order order #1073 → TM27-KAHSR-00007` | the pass holding **7** records first and wins |
| 16:30:47 | `orders/updated` **pass 4** | number now stamped → bails correctly |

Every `orders/updated` delivery carried `body-len: 7365` — the same payload, over and over.

---

## 3. Root cause

**The middleware writes tags to the very order whose webhook it is processing, and each write makes Shopify fire that webhook again.** One human action became five deliveries.

Nothing serialises those passes:

- **The order-numbering job has no lock.** Draft orders have one (`processingDrafts`, `after-sales/index.js:52`). Orders were never given the equivalent.
- **Its only defences are two point-in-time reads** — *is the store code present?* and *is a number already stamped?* Both were satisfied for multiple passes during the **six seconds** between the store code arriving (16:30:37) and the number being stamped (16:30:43).
- **The counter is drawn before the record is written.** `mintSerial` calls `allocateSerial` (counter++), then inserts the ledger row. Anything failing in between spends a number with nothing to show.

That six-second window existed because #1073 carried **eighteen** metafields — eight weeks of draft history, the advance, the installment, the discount, `pricing_basis` — and copying them one at a time pushed the store code late while Shopify was already redelivering.

#1072, two nights earlier, had a **three-second** window and fewer deliveries. It survived by luck of timing, not by design.

---

## 4. Why it was invisible

`src/modules/serialization/index.js`:

```js
if (error) {
  // Lost a race on resource_id → return the row that won (the seq we drew is burned).
  if (won) return { ...won, minted: false };
```

A losing pass returns `minted: false`. The caller logs only `if (r.minted)`. So a destroyed invoice number produces:

- no log line
- no error
- no ledger row
- nothing stamped on any order or draft

The behaviour was known and commented — *"the seq we drew is burned"* — but never surfaced. **The only detector in the system was a person reading an invoice.**

This is why the investigation took three days and several wrong answers: an empty search result was indistinguishable from no event having occurred.

---

## 5. Contributing factors

| Factor | Detail |
|---|---|
| Webhook amplification | handlers write tags to the resource they are handling, re-firing their own webhook |
| No single-flight | orders have no per-resource lock; drafts do |
| Draw-before-record | the counter moves before anything durable is written |
| Silent loss | the lost-race branch logs nothing |
| No reconciliation | nothing compares counter value against ledger rows |
| Rate limiting | 422/429 slowed passes *between* draw and record, widening the loss window |
| Slow metafield copy | 18 sequential writes held the guard open for six seconds |

---

## 6. Fixes

### Immediate (this change)

1. **Single-flight lock on order numbering** — a second webhook for an order already being numbered is dropped, mirroring `processingDrafts`.
2. **Give the number back on a lost race** — roll the counter back when our seq is still the tip, using the conditional update already used elsewhere in the file.
3. **Log every loss** — the lost-race branch writes `console.error`, so this can never again be invisible.
4. **Drift check** — `GET /api/serial/drift` compares every counter against its ledger rows and reports any gap.

### Next

5. **Make draw + record atomic** — move the counter increment inside the RPC that writes the ledger row, so a number cannot exist without a row. Removes the class entirely rather than mitigating it.
6. **Reduce self-triggering writes** — batch tag writes so a handler writes at most once per pass.
7. **Authenticate the admin endpoints.** `/api/serial/counter?set=`, `/api/serial/clear`, `/api/serial/backfill` and others are unauthenticated GETs on the public internet. Not the cause of this incident — ruled out via browser history and log search — but an open hole in its own right.
8. **Fix two live broken references** seen throughout these logs: `syncDraftOrderToSheet is not defined` (56×) and `syncOrderToSheet is not defined`. Same class as the `_buyingTableCache` fault that once killed the process.

---

## 7. How this stops happening again

Five layers, each independent. Any one of them would have prevented this incident; together they mean a future variant is caught rather than discovered.

**Layer 1 — don't run twice.** A single-flight lock per resource per handler. Concurrency is the precondition for every race in this system, not just this one.

**Layer 2 — don't lose what you drew.** Roll back on failure now; make draw-and-record atomic next. A number cannot go missing if it cannot exist without its record.

**Layer 3 — say so when it happens.** Every counter movement and every loss is logged. Silence is the defect that turned a five-second bug into a three-day investigation.

**Layer 4 — reconcile daily.** Counter value must equal minted + cancelled, per counter. Any drift is a same-day alert, not a customer-facing discovery. This is the layer that makes the guarantee real: even a cause nobody predicted is caught within 24 hours.

**Layer 5 — stop the amplification at source.** Handlers should not write to the resource they are processing unless the value genuinely changed, and should batch what they do write. Layers 1–4 make losses impossible or visible; layer 5 reduces how often the system is under concurrent load at all.

### The general lesson

The system now has enough moving parts that **almost every action fires a draft or order webhook, and many handlers write back to the resource that triggered them.** That is a feedback loop by construction. It has been survivable so far because most handlers are idempotent by value — they compute the same answer twice and write it twice, harmlessly.

**Counters are the exception.** They are not idempotent by value: drawing twice produces two different answers, and one of them is thrown away. Any future counter, sequence or allocator must be treated as money, not as data — locked, atomic, logged, and reconciled.
