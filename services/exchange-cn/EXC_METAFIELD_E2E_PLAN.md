# Exchange Adjustment — Metafield Migration + E2E Test Plan

_Goal: replace the dead negative-line-item approach with post-tax adjustment metafields, and
test the full Exchange Note flow end-to-end from the Apps Script + Google Sheet._

## Why this exists
- **Negative line items are not supported on Shopify** (tested + confirmed) → the committed
  `/api/exc-redeem` negative-line approach is dead and must be rewritten to write a metafield.
- **Both Voucher and Exchange Note are post-tax** adjustments on GST-inclusive prices. **Only the
  native discount touches the taxable base**; everything exchange-derived is a full adjustment on
  the GST-inclusive total, behaving like an advance paid (reduces balance due, not subtotal).
- **Reporting** runs via a middleware → Shopify Admin API service reading these metafields (today).
  A unified Supabase ledger is built to *accommodate* all constructs but is NOT read for reporting yet.

## The 3 post-tax adjustment metafields (create in Admin → Settings → Custom data → Draft orders)
Namespace `custom`. **Decimal (money)**. Leave **unpinned** (AUTO-written; staff never touch them).

| Key | Construct | Writer |
|---|---|---|
| `exchange_note_value`    | Exchange Note deduction (₹) | `/api/exc-redeem` (built + deployed) |
| `voucher_value`          | Voucher value (₹) | voucher redeem flow (separate, later) |
| `old_gold_value`         | Old-gold consideration (₹) | manual today |
| `amount_to_be_collected` | **Net of all adjustments** = total − adjustments | `/api/exc-redeem` + `/api/exc-void` |

Metafields exist on **drafts only** for now (orders later, when testing carry-over).

**Linkage stays OUT of metafields** — no bloat. Original order + applied order live in:
- **Order tags** (`exc-num:`, `exc-applied-to:#D123`, `exc-original:#1052`, etc.) — and draft-order
  tags **auto-transfer to the order on conversion**, so linkage needs no persistence hook.
- **The Exchange Log sheet row** (issued, EXC#, old order, new order, value, status, draft id).

This E2E covers the **Exchange Note** path → `exchange_note_post_tax`. Voucher + old-gold each get
their own value field; their flows are built separately. Create all 3 definitions now regardless.

## Code changes (Claude)
### A. Rewrite `POST /api/exc-redeem` (server.js ~3655)
- **Remove** the negative line-item append (the `excLine` block + the `isExcLine` re-send path).
- **Instead** write `custom.exchange_note_post_tax = excValue` on the draft (metafield API).
- **Idempotency**: skip if `exchange_note_post_tax` is already set on the draft.
- Keep the linkage **tags** (`exc-applied`, `exc-num:`, `exc-applied-to:`, `exc-original:`).
- **Net-to-collect (Q3)**: recompute and write `amount_pending = total − exchange_note_post_tax − amount_paid`,
  so the existing balance surface reflects it. *(Confirm who owns `amount_pending` today before wiring.)*
- The collection amount (GoKwik link / terminal push) must read `amount_pending`, **not** the order total.

### B. Apps Script (`createExchangeNote_` / `applyExchangeNote_`)
- Payload already sends `newDraftRef`, `excValue`, `oldOrderNumber` → drives the metafield + tags.
- Old-order `exc-*` tagging + Exchange Log row stay (these are the linkage record).

### C. Draft → order persistence (metafield values only)
- On `/api/convert-to-order` (and as a safety net, `orders/create` webhook), copy
  `custom.exchange_note_post_tax` (+ `exchange_voucher_value` / `old_gold_value` when set) from the
  draft onto the order. Reporting queries **orders**; metafields do NOT auto-transfer (tags do).

### D. Invoice template (separate, minimal)
- Read `exchange_note_post_tax` → render `Less: Exchange adjustment` + `Net to collect`. (Own task.)

## E2E test phases (Apps Script + GSheet)
**Phase 0 — Setup:** create the 3 definitions; deploy middleware with rewritten `exc-redeem`.
`peek?docType=exchange_note` → `current_value: 0`.

**Phase 1 — Happy path:** ring up a throwaway draft `#D123` (note total). Sheet: old order in `B7`,
value in `B36`, `B37 = Exchange Note`, `D37 = #D123` → run **Create Document** → expect `EXC-2026-0001`.
Verify on the draft:
- **No line-item change** (no negative line, purchase intact).
- `custom.exchange_note_post_tax = value`.
- `amount_pending` dropped by exactly the exchange value; invoice shows `Less: Exchange` + `Net to collect`.
- Linkage in **tags**: `exc-num:EXC-2026-0001`, `exc-applied-to:#D123` on old order; old order also tagged
  `exc-given/exc-val/exc-iss`; Exchange Log row `Applied` with new order + draft id; email; `peek = 1`.

**Phase 2 — Idempotency:** re-run on the same draft → no duplicate metafield write, no second serial, returns `alreadyApplied`.

**Phase 3 — Void:** `exc-void` clears `exchange_note_post_tax`, restores `amount_pending`, strips old-order
`exc-*` tags, marks Exchange Log `Voided`, retires the serial. After converting `#D123` → void refused with 409.

**Phase 4 — Persistence:** convert `#D123` to an order → confirm `exchange_note_post_tax` is on the **order**,
and linkage tags carried over automatically.

**Phase 5 — Reporting:** call the reporting endpoint → exchange adjustment appears, cleanly split from native discounts.

## Division of labor
- **You (sheet/Admin):** create the 3 definitions, sheet entry (`B7/B36/B37/D37`), Create Document / Void clicks, Shopify visual checks.
- **Claude:** rewrite `exc-redeem` + persistence hook, metafield/peek/redeem/void curls, persistence + reporting verification.

## curl helpers
```
BASE="https://timanti-middleware.fly.dev"
curl -s "$BASE/api/serial/peek?docType=exchange_note"
# after rewrite, exc-redeem writes the metafield (no line item) — use a throwaway draft
curl -s -X POST "$BASE/api/exc-redeem" -H "Content-Type: application/json" \
  -d '{"newDraftRef":"#D123","excNumber":"EXC-2026-TEST","excValue":1000,"oldOrderNumber":"#1052","customerName":"TEST"}'
```

## Corrections folded in
- Metafields are construct **values** (`exchange_note_post_tax`, `exchange_voucher_value`, `old_gold_value`) — not linkage.
- Original / applied order live in **tags + the Exchange Log sheet**, not new metafields.
- `po_type`, `document_type` are **inferred**, not staff-fill.
- Dispatch / delivery dates are **not** metafields.
