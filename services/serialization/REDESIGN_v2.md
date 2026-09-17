# Serialization v2 — Assign-on-Finalize + Ledger (DESIGN, not built)

_Created 2026-06-10. Supersedes the v1 "assign when state_code present" model, which assigned
too early and caused ordering gaps, abandoned-draft gaps, deleted-doc skips, and webhook re-stamps._

## Principles
1. **Mint on finalize, never on draft.** A serial is allocated only when a document reaches its commit point.
2. **Ledger is the source of truth.** A Supabase `serial_ledger` row is created per mint; the Shopify metafield only mirrors it.
3. **Explicit triggers, not metafield-presence.** Each doc type has a defined finalize event. Editing/clearing a metafield never mints or re-mints.
4. **Idempotent.** One serial per (doc_type, resource) — re-firing a finalize event returns the existing serial.
5. **Cancellations logged, numbers retired (not reused).** GST-clean audit trail; gaps are explicit, never silent.

## Finalize triggers (per doc type)
| Doc | Mint trigger | Store code source |
|---|---|---|
| `customer_order` | **Order exists** (draft→paid, or online) **and** store code present, not yet minted. (`orders/create` + `orders/update`.) Drafts never hold a number. | staff `state_code` on the order (copied from draft for offline) |
| `repair` | **repair-complete** event (`repair-complete` tag) **AND not** tagged `repair-free`/`free-repair`. Free + abandoned intakes never mint. | staff `state_code` on the repair draft/order |
| `po` | **`po_records.status = acknowledged`** (real PO milestone, set when HQ acknowledges via the action link in `handlePoAction`). Created-then-deleted-before-ack costs nothing. | **Auto-PO (from any order — draft/finished, in-stock/MTO):** source order's `state_code`. **Merchandising/batch PO (no source order):** a new store-code dropdown added to the PO queue. |
| `memo` / `transfer` | Explicit **issue** action — staff tag `issue-memo` / `issue-transfer`. | staff `state_code` (+ `delivery_code`) |
| `credit_note` | CN creation (already explicit, Apps Script) | n/a (global) |

Store code is a **dropdown (choice list)** so staff can't typo it (prevents "wrong entries"). Canonical store-code string TBD (e.g. `KAHSR` / `KA-HSR`) — the service is format-agnostic and uses whatever the staff pick exactly.

## Data model
Keep `serial_counters` (atomic increment). Add the ledger:
```sql
create table serial_ledger (
  id            uuid        primary key default gen_random_uuid(),
  doc_type      text        not null,
  store_code    text        not null,        -- 'ALL' for global (credit_note)
  seq           bigint      not null,
  serial_code   text        not null,
  resource_type text,                         -- 'order' | 'draft_order'
  resource_id   text,                         -- Shopify numeric id
  resource_name text,                         -- e.g. #1038
  status        text        not null default 'active',  -- 'active' | 'cancelled'
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  constraint serial_ledger_seq_unique      unique (doc_type, store_code, seq),
  constraint serial_ledger_resource_unique unique (doc_type, resource_id)   -- idempotency
);
```
- `serial_ledger_resource_unique` → one serial per resource per doc type (idempotency, even under concurrent webhooks).
- `serial_ledger_seq_unique` → no duplicate numbers within a sequence.

### Mint (atomic, idempotent)
```
mint_serial(doc_type, store_code, resource_type, resource_id, resource_name):
  1. SELECT existing ledger row for (doc_type, resource_id) → if found, return it (idempotent).
  2. seq = allocate_serial(doc_type, store_code)        -- existing atomic counter RPC
  3. INSERT ledger row (status='active'); on the resource-unique conflict, return the existing row
     (a concurrent webhook won the race — the burned counter value is the only cost, acceptable).
  4. return serial.
```
### Cancel
```
cancel_serial(doc_type, resource_id):
  UPDATE ledger SET status='cancelled', cancelled_at=now() WHERE doc_type, resource_id.
  -- number is retired, never reused.
```
Reporting reads the ledger (active vs cancelled), Shopify metafield is the mirror for invoices/OPP.

## What this fixes (the four concerns)
1. **Out-of-order conversion** → customer serials mint at order existence, in order-creation order; drafts hold nothing.
2. **Wrong entries** → store code is a validated dropdown; service uses the exact value.
3. **Free/abandoned repairs** → mint only at repair-complete; intakes that never complete cost nothing.
4. **Deleted/re-entered PO** → mint only on explicit issue; deleted-before-issue costs nothing; cancelled-after is logged & retired (no silent skip).
Plus: the v1 webhook re-stamp class of bug disappears — triggers are explicit events, not "metafield is present."

## Migration (non-breaking, staged)
- v1 metafields stay (`document_type, state_code, serial_no, serial_code, serial_display`).
- Backfill the ledger from the orders already stamped (current `TMNT-…` set) so history is in the ledger.
- Switch triggers per doc type one stage at a time; old draft-time assignment removed as each stage lands.

## Build stages (sign-off at each)
- **Stage 1 — Foundation (non-breaking):** ledger table + `mint_serial`/`cancel_serial` RPCs + service wrappers; backfill ledger from current orders. No trigger changes. _Nothing in the live flow changes yet._
- **Stage 2 — Customer orders:** mint at order level (`orders/create`+`orders/update`); remove draft-time `handleCustomerOrderDraftSerial`. Test.
- **Stage 3 — Repairs:** mint at `repair-complete` **only on the paid path** — skip drafts tagged `repair-free`/`free-repair`. Test.
- **Stage 4 — PO / Memo / Transfer:** PO mints on `po_records.status = acknowledged` (hook in `handlePoAction`); memo/transfer on explicit `issue-*` tags. Remove `po-draft`/`make-*`-at-creation minting. Test.
- **Stage 5 — Cancellation + ledger reporting:** `cancel_serial` wired to **PO cancelled** (`handlePoAction` cancelled transition), order cancel/refund, and memo/transfer/CN voids; `/api/serial-report` reads the ledger (active + cancelled).
- **Stage 6 — Credit notes:** mint via ledger (optional).

Each stage: I propose the exact changes → you approve → I build → you test → we move on.

## Decisions (locked)
1. **PO store code** — auto-PO from any order (draft/finished, in-stock/MTO) → source order's `state_code`. Merchandising/batch PO → a new store-code dropdown to be added to the PO queue. _(Build note: Stage 4 must add that dropdown + read it.)_
2. **Free repairs** — **no serial.** Only paid/completed repairs mint REP; `repair-free`/`free-repair` are skipped.
3. **Store codes** — `KA-HSR` / `MH-HQ`, no spaces; `state_code` choice list to be cleaned to match.
4. **Cancellation** — **auto** on cancel events: PO cancelled (`handlePoAction`), Shopify order cancelled/fully-refunded, memo/transfer/CN voids → ledger `status=cancelled`, number retired.

## Still open
- Customer order: is "order exists + store code set" the right finalize, or also a dedicated finalize tag? _(Tentatively: presence is enough, per your earlier note.)_
