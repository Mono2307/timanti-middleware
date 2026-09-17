# Exchange / Post-Tax Adjustment — Design & Context Handover

_Captures the full design discussion (2026-06-16) so it survives context loss. Read this before
touching the exchange / voucher / adjustment / reporting flow._

## The accounting model (LOCKED)
- Prices are **GST-inclusive**; Shopify computes **no tax**. The draft-order table shows only
  **subtotal / discount / total** (tax field empty). GST is back-derived in the invoice template only.
- **Native discount is the ONLY construct that touches the taxable base** (it lives in subtotal/discount, pre-tax).
- **Every exchange-derived credit is POST-tax** — voucher, exchange note, old-gold. They are full
  adjustments on the GST-inclusive total and behave **like an advance paid**: they reduce the
  amount the customer actually pays, NOT the subtotal/taxable base, and are reported separately —
  never clubbed into the single Shopify discount bucket.
- **Negative line items are NOT allowed on Shopify** (tested + confirmed). That killed the original
  exchange-note implementation and is why adjustments live in metafields.

## Metafields (CURRENT names — these changed during the discussion)
Namespace `custom`, on **draft orders only** for now (added to orders later when we test draft→order carry-over):

| Key | Type | Meaning | Writer |
|---|---|---|---|
| `exchange_note_value`    | number_decimal | Exchange Note post-tax value (₹) | `/api/exc-redeem` (built + deployed) |
| `voucher_value`          | number_decimal | Voucher post-tax value (₹) | voucher redeem flow (not built yet) |
| `old_gold_value`         | number_decimal | Old-gold consideration (₹) | manual today |
| `amount_to_be_collected` | number_decimal | **Net of ALL adjustments** = total − (exchange_note_value + voucher_value + old_gold_value) | `syncAmountToCollect()` on EVERY draft create/update (universal) |

**Linkage (original order ↔ applied order) stays in TAGS + the Exchange Log sheet — NOT metafields**
(no bloat). Draft tags auto-transfer to the order on conversion, so linkage needs no copy hook;
only the metafield *values* will need copying when we wire draft→order carry-over.

## What was BUILT + DEPLOYED this session (2026-06-16, live on fly.dev)
`server.js`:
- `getMetafieldType()` — `exchange_note_value`, `voucher_value`, `amount_to_be_collected` → number_decimal.
- **`POST /api/exc-redeem` rewritten** — no longer appends a negative line item. Now: writes
  `exchange_note_value` + recomputes `amount_to_be_collected`, adds linkage tags
  (`exc-applied`, `exc-num:`, `exc-original:`). Idempotent on `exchange_note_value`.
- **`POST /api/exc-void` rewritten** — deletes `exchange_note_value`, recomputes
  `amount_to_be_collected` (net of remaining adjustments), strips exc-* tags, retires the serial.
  Still 409s if the draft already converted.
- The old `isExcLine()` helper is now dead for new flows but left in place (still referenced by
  reprice/draft-created handlers; harmless since no EXC lines are created anymore).
- **`syncAmountToCollect()` added + wired into the draft webhook** (`/api/shopify-draft-updated`,
  both create and update branches). `amount_to_be_collected` is now recomputed on EVERY draft
  change in ALL scenarios (plain/discount/voucher/exchange/old-gold), change-guarded against loops.
  Formula: `total_price − (exchange_note_value + voucher_value + old_gold_value)`. Native discount is
  already in `total_price`. The inline writes in exc-redeem/void are now redundant-but-harmless.
- **`resolveDraftId()` fixed** — Shopify's GraphQL `name:` search is FUZZY (it matched `#D1` for
  `#D139` and applied an exchange to the wrong completed order during testing). Now scans OPEN drafts
  via REST and EXACT-matches the name. Deterministic; never resolves to a completed/duplicate-named order.

`services/exchange-cn/apps-script.js`:
- **`DOCTYPE_CELL` → `B45`, `NEWDRAFT_CELL` → `B46`** (were `B37`/`D37`). The live sheet has the
  Document Type dropdown at B45 and New Draft # at B46; the old refs read a blank B37 and always
  fell through to Voucher. **User must re-paste / update these two constants in the sheet's Apps Script.**

## What is PENDING (the "consolidated exercise")
1. **Key `amount_to_be_collected` INTO `amount_paid` / `amount_pending`.** Today the deposit/payment
   system computes `amount_pending = total − paid` off the RAW total (server.js ~413/428/1880/1938),
   so it still ignores adjustments. `amount_to_be_collected` is written but not yet consumed by the
   payment/collection path. Until wired, the GoKwik link amount (which the *caller* passes to
   `/api/generate-payment-link`) won't auto-net the exchange. This must be done carefully so it
   doesn't break existing partial-payment behaviour.
2. **Invoice template** — render `Less: Exchange adjustment` + `Net to collect` from the metafields.
3. **Draft → order metafield carry-over** — copy `exchange_note_value` / `voucher_value` /
   `old_gold_value` / `amount_to_be_collected` from draft onto the order on conversion (metafields
   don't auto-transfer; tags do). Reporting reads orders, so this is required before reporting works.
4. **Voucher redeem flow** — voucher must stop being a native (pre-tax, clubbed) discount code and
   instead write `voucher_value` like exc-redeem; VCH code becomes a claim token retired on redeem.
5. **Old-gold auto-fill** — currently manual; needs a form/route path.
6. **Reporting service** — middleware endpoints that query the Shopify Admin API live (orders +
   metafields), aggregate in-JS, and return the split (discount vs voucher vs exc note vs old-gold).
   **Reporting reads Shopify metafields today, NOT the ledger.**
7. **Unified Supabase ledger** — build the schema to accommodate ALL constructs with a
   `construct_type` column (cash_advance | cash_final | exchange_note | voucher | old_gold | cad_advance),
   orthogonal to payment mode (advance/final) so 3+ entries never lose context. Built to accommodate,
   **not read for reporting yet**. This avoids stitching metafields + store_deposits later.

## Metafield bloat / staff confusion (separate track)
- Problem: 30+ DRAFT metafields, staff can't tell fill vs auto-populated.
- Decision: use **Metafields Guru** app, grouping by namespace (`intake` = staff fill, `custom` = auto).
  Steps in `METAFIELD_GROUPING_PLAN.md` (repo root).
- `po_type` and `document_type` are **inferred**, not staff-fill. Dispatch/delivery dates are NOT metafields.

## CAD relationship (PRD: services/cad adjustment pricing/PRD.md)
CAD advance is the **same family** (post-tax, balance-reducing, reported separately) but a
**different mechanism**: it's real collected money with its own GST, so it rests in `store_deposits`
as an advance *payment*, not a metafield. The unified ledger's `construct_type` is where CAD and
exchange credits eventually report together.

## Key files
- `server.js` — `/api/exc-redeem`, `/api/exc-void`, `updateDraftOrderMetafields()`, payment metafield logic.
- `services/exchange-cn/apps-script.js` — `createExchangeNote_` / `applyExchangeNote_` / `voidExchangeNote` (sheet side).
- `services/exchange-cn/EXC_METAFIELD_E2E_PLAN.md` — the test plan.
- `METAFIELD_GROUPING_PLAN.md` — Metafields Guru grouping steps.
- `mto-invoice-template.liquid` / `templates/tax-invoice.liquid` — invoice (pending edit).

## Immediate next action
User creates the `exchange_note_value` (Decimal) + `amount_to_be_collected` (Decimal) definitions in
Admin → Custom data → Draft orders, then runs Phase 1 of the E2E plan (ring up a draft, run an
exchange note from the sheet, confirm the metafields land + tags set). Code is already deployed.
