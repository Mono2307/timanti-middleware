# Serialization System — PRD & Systems Overview

_Last updated: 2026-06-10. Lives with the code so context survives across sessions._

## 1. Purpose

Shopify's native order number (`#1038`, `#1039`…) is a single global sequence. The business (Aura Carat / auracarat.myshopify.com, middleware repo `timanti-middleware`) needs **parallel, business-meaningful serials**:

- **Customer orders** numbered **per state** — `Aura Carat KA 1001`, `MH 1001` — where "state" = **place of supply** (GST), set by staff. Online + offline share one per-state sequence.
- **Operational documents** with their own sequences: **Repair** (`REP-1` global), **PO** (`PO-KA-1001`), **Memo** (`MEMO-KA-1001`), **Transfer** (`TRANSFER-KA-1001`), **Credit Note** (`CNTM-…`).

Shopify's `#NNNN` is immutable, so our serial is a **parallel value stored in `custom.*` metafields**, surfaced on custom invoices (Order Printer Pro) and reports. Continuous numbering, **no annual reset**.

## 2. Architecture

```
Google Apps Script / Shopify webhooks ─► Express middleware (server.js, Fly.io)
                                              │
                          services/serialization/index.js
                                              │
                          Supabase RPC  allocate_serial()  ──► serial_counters table (atomic)
                                              │
                          stamp custom.* metafields on the Draft Order / Order
```

- **Atomic counter**: Postgres `allocate_serial(doc_type, state_code, p_start)` — single `INSERT … ON CONFLICT … RETURNING` row-locks the key, so concurrent calls are gapless. The **only** mutator of the counter.
- **Service** `services/serialization/index.js` — registry + `allocateSerial` + `allocateAndStamp` (idempotent, resilient per-field stamping) + state resolvers.
- **Integration** in `server.js` wires each flow; all gated behind `SERIAL_*` env flags.

## 3. Data model

### Supabase (`services/serialization/setup.sql`)
- `serial_counters(doc_type, state_code, current_value)` — `state_code = 'ALL'` for global sequences (repair, credit_note). Unique on (doc_type, state_code).
- `allocate_serial(p_doc_type, p_state_code, p_start default 1001)` → returns next value (first call = p_start, then +1).
- `locations.state_code` column added (used by the Pine/offline flow to derive state from the paying store).

### Registry (`DEFAULT_REGISTRY`, overridable via `config.serial_registry` JSON row)
| docType | scope | start | code | display |
|---|---|---|---|---|
| customer_order | state | 1001 | `{STATE}-{SEQ}` | `Aura Carat {STATE} {SEQ}` |
| po | state | 1001 | `PO-{STATE}-{SEQ}` | `PO-{STATE}-{SEQ}` |
| memo | state | 1001 | `MEMO-{STATE}-{SEQ}` | `MEMO-{STATE}-{SEQ}` |
| transfer | state | 1001 | `TRANSFER-{STATE}-{SEQ}` | `TRANSFER-{STATE}-{SEQ}` |
| repair | global | 1 | `REP-{SEQ}` | `REP-{SEQ}` |
| credit_note | global | 1 | `CNTM-{SEQ}` | `CNTM-{SEQ}` |

### Metafields (namespace `custom`)
| key | type | written by | notes |
|---|---|---|---|
| `state_code` | single_line_text | **STAFF** (system fills only if blank) | place of supply (KA/MH). Staff may use store-level values (KA-HSR/MH-HQ); the system **derives** the state via the prefix before `-`. **Never overwritten when staff set it.** |
| `document_type` | single_line_text | system | customer_order / repair / po / memo / transfer |
| `serial_no` | **number_integer** | system | numeric, for sort/range |
| `serial_code` | single_line_text | system | machine token + **idempotency key** (`KA-1028`) |
| `serial_display` | single_line_text | system | human label (`Aura Carat KA 1028`) |

These all live in `custom`, so `copyDraftMetafieldsToOrder` (server.js) carries them draft→order on conversion automatically — a repair keeps its `REP-N`, a customer order keeps `KA-####`.

`getMetafieldType` (server.js) maps `serial_no → number_integer`.

## 4. Who fills what — the core model

**Staff only ever set `state_code`** (and add `make-memo`/`make-transfer`/`skip-serial` tags). Everything else is machine-written.

- **state_code = place of SUPPLY**, decided by staff. **Shipping province is never used** (that's place of delivery).
- Online orders can ship from anywhere, so `state_code` must be entered manually on the order.
- The Pine/terminal flow is the one exception: it auto-fills `state_code` from the paying store's `locations.state_code`.

## 5. Integration points (all behind `SERIAL_*` flags)

| Flow | Trigger | State source | Result |
|---|---|---|---|
| **Offline customer order** | `draft_orders/create` + `draft_orders/update` (`handleCustomerOrderDraftSerial`) once staff set `state_code`; skips repair/PO/memo drafts | staff `custom.state_code` | `customer_order` serial on the draft → copied to order on "Mark as paid" |
| **Online customer order** | `orders/create` + **`orders/update`** → `/api/serial/order-serial`, when staff fills the order's `state_code` | staff `custom.state_code` (no shipping) | `customer_order` serial on the order |
| **Pine / cash / payment-link** | `handlePaymentCompletion` before draft→order convert (`maybeAssignCustomerOrderSerial`) | store → `locations.state_code` | serial on draft, auto-fills `state_code` |
| **Repair** | repair intake (`repair-intake` tag) → `assignRepairSerial` | none (global) | `REP-N`, `document_type=repair`; kept through conversion |
| **Memo / Transfer** | staff add `make-memo` / `make-transfer` tag (+ `state_code`) → `handleDocumentSerialTags` | `state:XX` tag or staff `state_code` | one serial per draft; trigger tag removed |
| **PO** | po-ops draft carries `po-draft` tag | `state:XX` tag / staff `state_code` / `PO_HQ_STATE` | `PO-KA-####` |
| **Credit note** | Apps Script `createCreditNote` → `/api/serial/allocate {docType:credit_note}` | none | `CNTM-YYYY-NNNN` (year formatted in Apps Script); sheet-row fallback if middleware down |

### Idempotency & safety
- Every path checks `custom.serial_code` first; if present it returns `allocated:false` (no RPC, no number burned).
- Per-field resilient stamping: a conflicting metafield definition on one field can't block `serial_code`. The allocate response returns `stamped` + `writeErrors`.
- We require **uniqueness, not contiguity** — a deleted/re-raised draft burns a number; that's acceptable.

## 6. Routes (server.js)
- `POST /api/serial/allocate` — allocate (+ optionally stamp a draftOrderId/orderId). Idempotent. Body `{docType, stateCode?, draftOrderId?, orderId?, documentType?}`.
- `GET /api/serial/peek?docType=&state=` — read counter, never allocates.
- `POST /api/serial/order-serial` — `orders/create`+`orders/update` webhook for online orders.
- `POST /api/serial/backfill` — one-time chronological backfill for already-punched orders (dry-run by default). Body `{nameFrom,nameTo,from,to,docType,skipTag,dryRun}`.
- `GET /api/serial-report?resource=&docType=&state=&from=&to=&format=` — orders+drafts report (GraphQL, JSON/CSV).
- Draft flows ride the existing `POST /api/shopify-draft-updated` webhook.

## 7. Feature flags (Fly secrets, default off)
`SERIAL_CUSTOMER_ORDER`, `SERIAL_REPAIR`, `SERIAL_MEMO_TRANSFER`, `SERIAL_PO`. Optional `PO_HQ_STATE` (fallback state for batch POs).

## 8. Webhooks required
- `draft_orders/create` + `draft_orders/update` → `/api/shopify-draft-updated` (already registered for repairs/pricing) — carries offline customer + memo/transfer + PO.
- **`orders/update`** → `/api/serial/order-serial` — REQUIRED for online (staff fill state_code after creation). `orders/create` → same route is optional (no state_code at creation yet).
- Note: the old `/api/serial/order-created` route was renamed to `/api/serial/order-serial`.

## 9. Setup checklist (to activate)
1. Run `services/serialization/setup.sql` in Supabase; backfill `locations.state_code` per store.
2. Create Shopify Metafield Definitions on **Orders + Draft orders**: `state_code` (single-line text, **staff-editable, plain text — not a choice list**), `document_type`, `serial_code`, `serial_display` (single-line text), `serial_no` (integer).
3. Register `orders/update` → `/api/serial/order-serial`; fix/remove stale `order-created`.
4. Set `SERIAL_*` flags per rollout.
5. Apps Scripts: paste `services/exchange-cn/apps-script.js` (CN counter) and `services/reporting/apps-script.js` (reports). OPP `repair-note.liquid` prints `serial_display`.

## 10. One-time backfill of existing orders (#1038–#1056)
Goal: number already-punched orders per state, chronologically, with manual curation.
1. **Reset** the test-polluted counters so real numbering starts at 1001:
   ```sql
   delete from serial_counters where doc_type = 'customer_order' and state_code in ('KA','MH');
   ```
2. Staff set `custom.state_code` on each order to include (this is also the GST place-of-supply). **Tag `skip-serial`** on any order to defer (e.g. an MH order whose `MH-1001` should go to a not-yet-punched order).
3. **Dry run** (predicts numbers, allocates nothing):
   `POST /api/serial/backfill {"nameFrom":1038,"nameTo":1056,"dryRun":true}` → review `processed` (predicted `KA-1001`, `KA-1002`…) and `skipped` (reasons: skip-tag / no-state_code / already).
4. **Commit**: same call with `"dryRun":false`.
5. Future orders are handled live by the `orders/update` (online) and draft (offline) flows. Do the backfill **before** relying on `orders/update`, or order edits could assign out of chronological order.

## 11. Key decisions (locked)
- Continuous numbering, no reset.
- Customer orders per-state; online+offline share the sequence; state = staff-entered place of supply; shipping province never used.
- Repairs global `REP-N`, kept through conversion as `document_type=repair`.
- Memo/Transfer: one serial per draft; type via `make-memo`/`make-transfer` tag; HSN/karat grouping is OPP layout only.
- `state_code` is a staff field; system never overwrites it (only fills when blank, e.g. Pine).
- `#1038` was just Shopify's current native number — our serials start at 1001 per state.

## 12. Files
- `services/serialization/setup.sql`, `services/serialization/index.js`
- `server.js` — routes + integration (`maybeAssignCustomerOrderSerial`, `assignRepairSerial`, `assignDocSerial`/`handleDocumentSerialTags`, `handleCustomerOrderDraftSerial`, `/api/serial/*`, `getMetafieldType`)
- `services/repairs/index.js` (+`repair-note.liquid`), `services/exchange-cn/apps-script.js`, `services/reporting/apps-script.js`
- Branch `feat/serialization` (commits `43e5b89` → `eaafd24` …). Not yet merged to `main`.

## 13. Open items
- `/api/serial-report` filters draftOrders by `created_at` via GraphQL search — confirm draftOrders search supports it; else filter client-side.
- Decide per-state vs per-store sequencing if more than one store per state is added (currently per-state: all KA stores share the KA sequence).
- Reset counters before real go-live (test allocations consumed KA up to ~1028+).
