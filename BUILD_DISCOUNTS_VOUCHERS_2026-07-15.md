# Build: Pre-tax discounts + voucher/exchange-note rework — 2026-07-15

Branch: `feat/metafield-manager-extension` (HEAD `d4b7b4c`). `main` still stale at `92f977c`; **Fly deploys from `feat`**. Two deploy targets: Shopify app (extension) via `npx @shopify/cli app deploy -c timanti-metafield-manager-new`, and middleware (`server.js`) via GitHub Actions → Deploy to Fly.io → branch `feat`.

## What shipped this session

### 1. Diamond-only PRE-tax discounts (new)
Staff can apply a discount that reduces the **diamond component only, order-level, before GST** — flowing to line prices, invoice taxable split, tax-inclusive total, and `amount_to_be_collected`. Survives every reprice (metafield-backed, not Shopify's native discount).

- **Panel:** unified "Add adjustment" selector (Exchange Note / Voucher / **Discount**) replaces the two always-on apply panels. Discount sub-mode = **Discount code** (real Shopify code) or **Custom** (% of diamond / flat ₹). Commit `ce9af11`.
- **Server `handleApplyDiscountTag`:** parses `apply-discount:<code>` or `apply-discount:custom:<v>:<pct|flat>`; resolves a real code via Admin GraphQL `codeDiscountNodeByCode` (percentage is a 0–1 fraction; or fixed `DiscountAmount`), or a custom %/₹; computes ₹ against the total diamond value (capped at it); writes `custom.discount_applied` + `custom.discount_code`; drops a `reprice` tag. Commit `aaa82ff`.
- **Reprice (`handleRecalculatePriceTag` weights path):** sources the discount from `custom.discount_applied`, prorates across lines by diamond value, subtracts from `newDiamondValue` **before ×1.03**. Retires the old `draft.applied_discount` path (which was `clearDiscount:true`-wiped every reprice anyway). Dormant when no discount set (identical output).

**Why native `fnf5` did nothing (root cause):** the reprice only read `draft.applied_discount`; a Shopify discount *code* never populates that field on a draft. Now discounts go through the metafield channel instead.

### 2. Voucher / exchange-note model rework
- **Lock-on-conversion** (`f20d5e5`): `apply-voucher`/`apply-exc` block **only** when the instrument is `redeemed` on a converted order — not when merely `applied` to another draft. The single-use lock moved to conversion: draft→order redeems the voucher/exc **by code** (from the converting draft's `vch-num`/`exc-num` tags) with a double-spend guard, replacing `promoteApplied` (which matched a single reserved draft).
- **Latest-one-wins** (`d4b7b4c`): re-applying a voucher/note to a new draft **strips it off the prior draft** first (`stripInstrumentFromDraft` — deletes the value metafield, removes tags, recomputes net; never touches a converted order). So it's held on exactly one draft at a time → the multi-draft double-spend edge is gone by construction.
- **Free-by-default remove** (`d4b7b4c`): `POST /api/voucher-void` and `/api/exc-void` now **default to FREE** (reopen the ledger row to `open`, keep the serial → available + re-addable). `hardVoid:true` = the rare TRUE void (retire the serial counter + void the ledger) for a credit that must never exist (mis-issue / refunded another way / fraud). New helper `creditInstruments.reopen()`.

### 3. Panel reorg + field overrides (`ce9af11`, live as v17)
- `voucher_value` and `advance` made **editable overrides** (mirror `exchange_note_value`) — staff can type the value when a code isn't in the ledger. `RECOMPUTE_TRIGGER_KEYS` already covers them, so a manual edit recomputes `amount_to_be_collected`.
- New `SECTION_ORDER`: Required → Payments → Pricing (incl. discounts) → Product Metadata → Adjustments → Repair → Credit Note → Manufacturing → System.
- `state_code` promoted to Required Inputs; document_type + serials rendered as a read-only identity block on top; `is_finalized` read-only; `invoice_date` prefilled to today (editable); Procurement PO display fields removed (editable ones moved to Manufacturing).

## Commits (all on `origin/feat`)
| SHA | What |
|---|---|
| `2b79c7a` | panel reorg + voucher/advance overrides (live as v17) |
| `aaa82ff` | discount engine (handleApplyDiscountTag + dia-only reprice) |
| `ce9af11` | panel unified adjustments selector + discount UI |
| `f20d5e5` | voucher lock-on-conversion + free-vs-void split |
| `d4b7b4c` | latest-one-wins migration + free-by-default remove |

## Files
- `metafield-manager/extensions/*/src/MetafieldManager.jsx` — **4 byte-identical copies**, edit together (or via cp from `order-metafield-manager-order-action`).
- `server.js` — discount handler + reprice, apply guards, conversion redeem-by-code, `stripInstrumentFromDraft`, voucher-void/exc-void.
- `services/exchange-cn/credit_instruments.js` — added `reopen()`.

## Deploy (both required; not yet done at time of writing)
1. **App v18:** `cd metafield-manager && npx @shopify/cli app deploy -c timanti-metafield-manager-new --message "discounts + adjustments"` → Release → Yes. Verify `app versions list -c timanti-metafield-manager-new` top row active.
2. **Fly:** GitHub → Actions → Deploy to Fly.io → Run workflow → branch `feat/metafield-manager-extension`. Verify a read-only endpoint.

## Test end-to-end (after both live)
1. Draft with diamond value → Adjustments → Discount → Custom 5% of diamond → Apply → `discount-applied` tag then reprice → Diamond line drops ~5%, line price drops, Taxable/GST recompute, `amount_to_be_collected` drops. Repeat flat ₹ and a real code.
2. Voucher: apply to draft A, then apply same voucher to draft B → B holds it, A auto-stripped (tags/metafield gone, A's balance restored).
3. Convert a draft carrying a voucher → ledger row → `redeemed` against that order; the code can no longer be applied elsewhere.
4. Manual override: type `voucher_value`/`advance` → `amount_to_be_collected` drops.

## Open items / caveats
- **Reporting `gross_value` freeze:** the reprice writes correct per-line props (Taxable/GST/Discount Applied), so the invoice is right, but the aggregate adjustment report reads an order-level `gross_value` (pre-discount) that is **not** frozen for discounted draft-orders. Verify whether that report needs it; if so, freeze `gross_value` in `handleApplyDiscountTag` or the reprice.
- **feat→main reconciliation** still outstanding (main is stale; Fly builds feat). Restore snapshots: `backup/*` tags + `wip/reconciled-main-2026-07-14` on origin.
- **Webhook gap observed:** an `apply-voucher` on draft #D171 (`1437897130241`) left the trigger tag unprocessed with no `voucher-invalid` — a forced webhook didn't process either, while #D166 processed fine. Suspect some draft `draft_orders/update` webhooks aren't reaching the middleware. Worth confirming webhook delivery.
- **Rotate the Shopify Admin token** used for debugging this session (`shpat_…` pasted in chat).

## Debugging reference (voucher ledger)
- Ledger = `credit_instruments` (Supabase). Vouchers enter it via the **voucher Apps Script** calling `POST /api/credit-instrument/issue` at creation (writes the row alongside the Shopify discount code). A voucher that exists only as a Shopify discount code (created outside that flow) has **no ledger row** → offline `apply-voucher` (reads `getBySerial`) can't find it.
- The `recon-ledger` `outstanding` view excludes `applied` rows — use `detail`/direct inspection for true state.
- Shop: `auracarat.myshopify.com`. Store env (`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`) lives only on Fly, not locally — inspect the DB via the middleware endpoints or Supabase directly.
