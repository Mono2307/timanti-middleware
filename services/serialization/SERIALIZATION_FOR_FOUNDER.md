# Serialization — Plain-English Overview (for discussion)

> ⚠️ **Superseded (2026-06-26):** the serial formats and doc types below describe the *old* scheme.
> The current scheme (TM/TS/AURA/DC/PO + per-FY EXC/VCH, FY-folded counters) is in
> **`SERIALIZATION_MIGRATION_PLAN.md`** — read that for the live formats.


## The 30-second version

Shopify gives every order one running number (`#1038`, `#1039`…). That's a single global
list — it can't tell a Karnataka sale from a Maharashtra sale, and it doesn't number repairs,
POs, memos, transfers or credit notes at all.

So we run our **own parallel numbering system** on top of Shopify. Each kind of document gets
its **own sequence**, and customer orders are numbered **per state** (place of supply, for GST).
Our number is stored alongside the Shopify order (as "metafields") and printed on invoices and
reports. Shopify's `#1038` never changes — ours rides beside it.

**Two ideas to hold onto:**

1. **A central counter** (in our database) hands out the next number for each
   (document type + state). It's atomic, so two orders can never grab the same number.
2. **A ledger** records every number we ever issue — what it is, what it's attached to, and
   whether it's still active or cancelled. This is the single source of truth.

**One golden rule on who does what:** Staff only ever type in the **State Code** (place of
supply, e.g. `KA-HSR`) and add a trigger **tag** (like `make-memo`). *Everything else* — the
actual number, the document type, the formatting — is filled in automatically by the system.

---

## How a number gets created ("minted")

- A number is only created when a document is **finalized**, not when it's first drafted. This
  avoids burning numbers on drafts that get deleted.
- Before creating a number, the system checks if this document **already has one**. If yes, it
  stops — a document can never get two numbers (idempotent).
- Numbers are **continuous** — no yearly reset.
- We guarantee **uniqueness, not gap-free counting**. If a draft is deleted, its number is gone
  for good and the next document gets the following number. A small gap is fine.

---

## The table

| Use case | Summary (one line) | Data inputs & who fills them | Numbering logic / format | When & how it's minted | Cancellation / void & edge cases |
|---|---|---|---|---|---|
| **Online customer order** | A web order, numbered by state for GST. | **Staff** type the **State Code** on the order after it comes in. Everything else: automatic. | Per-state sequence, starts at **1001**. Format `TMNT-{STATE}-{SEQ}` (e.g. `TMNT-KA-HSR-1018`). Online & offline **share** the same per-state count. | When staff fill in the State Code, Shopify pings us (`orders/update`) and we mint + stamp the number on the order. | **Permanent — never voided.** A cancelled or refunded order **keeps** its number; a reversal is handled with a separate credit note. Shipping address is **never** used for the state (that's delivery, not supply). |
| **Offline / in-store customer order** | A counter sale written up as a draft, then paid. | **Staff** set the **State Code** on the draft. | Same per-state customer sequence as online (`TMNT-{STATE}-{SEQ}`, from 1001). | Number is created when the draft is finalized into a paid order; it copies across automatically on "Mark as paid". | Same as above — **permanent**. |
| **Pine / cash / payment-link sale** | An in-store terminal sale where the paying store is known. | **Nobody types the state** — the system reads it from the **paying store's** location record. | Same customer-order per-state sequence. | Minted automatically at payment, before the draft becomes an order. This is the **only** case where the system fills State Code for you (and only if it's blank). | **Permanent.** If staff already typed a State Code, the system never overwrites it. |
| **Repair** | An incoming repair job, globally numbered. | **Staff** add the **repair** tag at intake. No state needed. | One **global** sequence (not per-state), starts at **1**. Format `REP-{SEQ}` (e.g. `REP-42`). | Minted when the repair is **completed**, not at intake. Free repairs (`repair-free` / `free-repair`) are **skipped** — no number. | **Permanent — never voided.** Like customer orders, a repair keeps its number. |
| **Purchase Order (PO)** | An order we place on a vendor/store, numbered per store. | **Staff** drive it from the PO Ops menu; the **store code** comes from the source order's state (auto-PO) or the batch's store code. | Per-store sequence, starts at **1**. Format `PO-{CODE}-{SEQ}` (e.g. `PO-KA-HSR-1`). | Minted when **HQ acknowledges** the PO. A batch PO is split by store, so each store gets its own PO and its own number. | **Can be voided.** A cancelled PO's number is marked cancelled in the ledger and **retired forever — never reused** (keeps audit/GST clean). |
| **Memo** | A consignment/hand-off document between two stores. | **Staff** add the **`make-memo`** tag, plus the **State Code** (origin) and a **delivery/destination** code. | Per-store sequence from **1**. Format `MEMO-{ORIGIN}/{DEST}-{SEQ}` (e.g. `MEMO-KA-HSR/MH-HQ-1`). | One number per draft, minted when the `make-memo` tag is applied; the trigger tag is then removed. | **Can be voided** via a **`cancel-memo`** tag. Number retired, never reused. Needs both origin + destination, or it won't mint. |
| **Transfer** | Stock moving between two stores. | Same as memo: **`make-transfer`** tag + State Code + destination. | Per-store sequence from **1**. Format `TRANSFER-{ORIGIN}/{DEST}-{SEQ}`. | One number per draft when the `make-transfer` tag is applied. | **Can be voided** via **`cancel-transfer`** tag. Same retire-never-reuse rule as memo. |
| **Voucher** (store credit) | 1-year store credit issued to a customer (the rebranded credit note). | Created from the exchange/credit-note Apps Script. No state. | One **global** sequence from **1**. Format `VCH-{SEQ}`. | Minted into the ledger when the voucher is created. | **Can be voided** ("Void Voucher" menu). Number retired, never reused. Old `CNTM-…` credit-note records are kept for history but not reused. |
| **Exchange note** | An instant adjustment applied on a fresh invoice during an exchange. | Created from the exchange Apps Script. No state. | One **global** sequence from **1**. Format `EXC-{SEQ}`. | Minted when the exchange note is created. | Retire-on-void, never reused (same family as voucher). |
| **CAD service** *(planned — not yet live)* | A CAD-render advance (₹1,000–5,000) that later adjusts against a purchase. | **Staff** add a **`make-cad`** tag; system tracks `cad_amount` and status. | Per-store sequence from **1**. Format `CAD-{CODE}-{SEQ}`. | Will mint when the CAD draft is finalized, like memo/transfer. | Treated like a customer order: **permanent**. Adjustment/refund handled via deposit or credit note, not by reusing the number. |

---

## The simple split to remember

| These keep their number forever (PERMANENT) | These can be voided (number retired, NEVER reused) |
|---|---|
| Customer orders (online, offline, Pine) | Purchase Orders |
| Repairs | Memos |
| CAD services *(planned)* | Transfers |
| | Vouchers / Exchange notes |

**Why the split?** A sale or repair that happened is a real event — even if money is later
refunded, the document stays on the books and we reverse it with a *separate* credit note. But a
PO/memo/transfer/voucher that was raised in error never represented a real movement, so we cancel
the number outright — and we **never reuse** a cancelled number, to keep the GST/audit trail clean.

---

## Common questions you might get

- **"What if staff forget the State Code?"** Then no customer-order number is created yet — it
  mints the moment they fill it in. Nothing breaks; it just waits.
- **"Can two orders ever get the same number?"** No. The counter is atomic at the database level.
- **"What about the old orders #1038–#1056?"** There's a one-time backfill tool that numbers
  already-punched orders per state, in date order, with a dry-run preview first.
- **"Is anything turned on automatically?"** No — each document type is behind its own on/off
  switch, so we roll them out one at a time.
