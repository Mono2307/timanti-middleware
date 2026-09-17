# CAD Advance & Adjustment — PRD (v2)

_Status: SPEC LOCKED, ready to build. Supersedes v1 (which treated the advance as a taxable service via store_deposits). Rewritten 2026-06-26._

## 0. Model in one line
A CAD advance is a **tax-free amount collected on a draft order**. It resolves one of two ways:
- **Path A** — the same draft becomes the final order (advance is just early payment). Common case.
- **Path B** — if punched standalone, it is redeemed against a later order within **365 days**, applied **post-tax** (exchange-note mechanics, separate process).

No GST on collection. No `store_deposits` row. No credit note. No negative line item.

## 1. Product
- One product **"CAD Advance"** with **3 variants** at fixed price tiers (e.g. ₹2,000 / ₹5,000 / …).
- All-in, tax-free, no GST breakup.
- Staff add the matching variant to a draft. The variant's presence is how the system knows a draft carries an advance.

## 2. Metafields (must be created as definitions, pinned to **draft + order**)
| Key | NS | Type | Meaning |
|---|---|---|---|
| `advance` | custom | decimal | advance amount captured / applied |
| `advance_date` | custom | date | **payment date** — starts the 365-day clock |
| `advance_status` | custom | text | `open` \| `applied` \| `redeemed` \| `expired` |
| `redeemed_against` | custom | text | order # the advance was redeemed on (Path B) |
| `advance_ref` | intake | text | staff-entered: the advance order # to redeem (Path B) |

CAD serial (`CAD-{STORE}-{SEQ}`) via the existing serialization registry/counter, so each advance has a human reference (e.g. CAD-KA-HSR-0001). Doc type `cad`.

## 3. Capture (no new tag — inferred)
- **Trigger:** an existing payment event fires the draft webhook (`cash-{amount}` tag, or any draft edit that syncs payment) **and** the draft contains a CAD Advance variant.
- **Action:** stamp `custom.advance` = amount, `custom.advance_date` = today, `custom.advance_status` = `open`. Issue advance receipt. **Draft stays open.**
- Capture hangs off the payment/line-item event, **not** the metafield (metafield writes don't fire the webhook — server.js:2044).

## 4. Path A — resolved in the same draft (common)
- Staff add the real product to the **same draft** and set `amount_paid`/`amount_pending` so the net already accounts for the advance already paid. Staff just take the net.
- No extra action: the advance is inherently applied because it's the same draft with the advance sitting in `amount_paid`.
- On conversion: `advance_status` → `applied`; all `custom` metafields carry to the order via `copyDraftMetafieldsToOrder` (server.js:1861).
- No 365-day check (bought now).

## 5. Path B — advance punched standalone, redeemed later
### 5a. Punch (month-end, manual)
If not resolved by cutoff, the advance draft is completed into a standalone **CAD order**. `advance_status` stays `open`; metafields carry over.

### 5b. Redeem (within 365 days)
- Staff enter the advance order # into **`intake.advance_ref`** on the new sale draft, then build the order normally (adding the real product fires the webhook).
- On that webhook, `handleAdvanceRedeem(draft)` reads `intake.advance_ref`; if present and not yet processed:
  1. Resolve the advance order; read its `advance`, `advance_status`, `advance_date`.
  2. **Gate 1:** `advance_status === 'open'` (single-use). **Gate 2:** `today − advance_date ≤ 365` (not expired).
  3. **Pass** → write `custom.advance` on the new draft (post-tax reduction via `syncAmountToCollect`); stamp the advance order `advance_status=redeemed` + `redeemed_against=#newOrder`; clear/mark `advance_ref` processed; write a log row.
  4. **Fail** → write a visible note/tag: `advance-invalid: already redeemed` or `advance-invalid: expired YYYY-MM-DD`.
- **Two-way reference:** new order shows the applied advance value (keeps its own serial); advance order shows `redeemed_against`. Both survive via metafields/tags.
- **Distinct from exchange:** separate metafields (`advance` vs `exchange_note_value`), separate `intake.advance_ref` field, separate report line/log tab. Same plumbing, but staff never see "exchange" in the advance flow.

## 6. server.js changes
- `syncAmountToCollect` (server.js:2046): include `custom.advance` in the post-tax subtraction, alongside `exchange_note_value`/`voucher_value`/`old_gold_value`.
- New `handleAdvanceCapture(draft)` in the draft-update handler chain: CAD variant present + payment recorded → stamp advance metafields (§3).
- New `handleAdvanceRedeem(draft)` in the chain: process `intake.advance_ref` (§5b).
- `copyDraftMetafieldsToOrder` already carries the metafields on conversion — no change.
- `services/serialization/index.js` `DEFAULT_REGISTRY`: add `cad: { scope:'store', start:1, code:'CAD-{CODE}-{SEQ}', display:'CAD-{CODE}-{SEQ}' }`.

## 7. Reporting & reconciliation
- Status lives on metafields (truth) + payment tags. Flow is **entirely Shopify**, not sheet-dependent.
- Redemptions also written as a row to the exchange log sheet (record only).
- `cad` + an `advance_status` filter in `/api/serial-report` so ops can list open advances at month-end.

## 8. Decisions (locked 2026-06-26 — supersede v1)
| # | Decision |
|---|---|
| 1 | Advance is **tax-free** at collection. Booked as trade receivable; tax paid on income recognition. (Reverses v1.) |
| 2 | Resolution: **Path A** same-draft edit; **Path B** exchange-style **post-tax** redemption. No `store_deposits`, no credit note. |
| 3 | Trigger is the **`intake.advance_ref`** metafield, read on normal draft edits (metafield writes don't self-fire the webhook — server.js:2044). |
| 4 | **365-day** validity from `advance_date` (payment date). Single-use enforced by `advance_status`. |
| 5 | Product with **3 fixed-price variants**, all-in, no GST breakup. |

## 9. Setup steps (one-time)
1. Create the 5 metafield definitions (§2), pinned to draft + order.
2. Create the "CAD Advance" product + 3 variants.
3. Add `cad` to the serialization registry.

## 10. Dependencies
- Serialization (`services/serialization/`), `syncAmountToCollect` + `copyDraftMetafieldsToOrder` (server.js), exchange-note post-tax mechanics (reused, not shared).
