# Flexible Payment Installment Table (3–4 legs, each value + mode + date)

## Context

Today the middleware models payment as **exactly two installments** — an "advance" and a "final" — hardwired everywhere as *named pairs*, never as an iterable list:

- Mode metafields: `custom.payment_mode_advance` + `custom.payment_mode_final`
- Order/draft tags: `pmode-advance:<mode>` + `pmode-final:<mode>`
- `installmentType` is derived binary on every payment: first payment (`payment_status=unpaid`) → `advance`, any later → `final` (`server.js:522`, `1351`)
- A single blended `custom.amount_paid` (staff-entered) drives `amount_pending = amount_to_be_collected − amount_paid`

The business needs **3–4 installments**, each capturing its **value, payment mode, and date** (e.g. draft #D171: ₹15,000 UPI advance today, then card + cash legs later). The two-slot shape can't express this.

**Outcome:** a real installment *table* stored as a JSON metafield, captured in the admin extension, rendered on invoices/receipts/emails, and read by reporting. End state **retires** the `payment_mode_advance`/`_final` metafields and `pmode-*` tags (per decision), reached via a safe **dual-write migration** so live invoices never break mid-rollout.

## Decisions (locked)

1. **Source of truth:** new JSON metafield `custom.payment_installments` = array of `{value, mode, date}`. Follows the existing `timanti.jewelcode` JSON-metafield precedent (`server.js` reads/writes JSON metafields already).
2. **Row fields:** `value` (number), `mode` (enum string), `date` (YYYY-MM-DD).
3. **End state = replace:** retire `payment_mode_advance`/`_final` + `pmode-advance:`/`pmode-final:` tags once all readers are migrated.
4. `custom.amount_paid` stays as the **derived blended sum** (Σ rows) — it keeps every loosely-coupled reader (recon, adjustment report, sheets) working untouched. `amount_pending` / `payment_status` derivation unchanged.

## Data model

```jsonc
// custom.payment_installments  (type: json)
[
  { "value": 15000,   "mode": "upi",  "date": "2026-07-14" },
  { "value": 20000,   "mode": "card", "date": "2026-07-20" },
  { "value": 6379.49, "mode": "cash", "date": "2026-07-25" }
]
// custom.amount_paid = 41379.49   (derived Σ value — kept)
// custom.amount_pending = amount_to_be_collected − amount_paid  (unchanged)
```

Mode enum needs a home once `payment_mode_advance` is retired. Introduce a definition **`custom.payment_mode`** (`single_line_text_field` with a `choices` validation) that exists solely to hold the allowed-mode list; the admin UI reads its `choices` for the row dropdown via the existing `parseChoices` path. (Storage is inside the JSON; this definition is the enum source only.)

## Changes by module

### 1. Metafield definitions + governance
- Create definition `custom.payment_installments` (json) and `custom.payment_mode` (text + choices enum: upi, card, cash, pos, gokwik_link, …).
- `metafield_governance.csv`: remove rows 5–6 (`payment_mode_advance`/`_final`); add `payment_installments`, `payment_mode`. Keep `amount_paid`/`amount_pending`/`amount_to_be_collected`/`payment_status`.

### 2. Admin capture UI — `metafield-manager/extensions/*/src/MetafieldManager.jsx`
**Four byte-identical copies** (`order-metafield-manager`, `-order`, `-order-action`, `-draft-action`) — edit all four identically.
- Replace the `payment_mode_advance`/`_final` fields + scalar `amount_paid` entry with a **repeatable installment table**: local state array of `{value, mode, date}`, "+ Add installment" / remove-row (1–4 rows), a live read-only Σ display.
- `renderEditable` (`811-851`) has no native repeater — add a new render branch for the installments field composing per-row `s-number-field` (value) + `s-select` (mode, options from `custom.payment_mode` choices) + `s-date-field` (date).
- `save()` (`423-492`): serialize rows → JSON, `metafieldsSet` to `custom.payment_installments`; also write derived `amount_paid` = Σ so blended readers stay instant; then `tagsAdd` `sync-payment` (existing nudge) so server recomputes pending/status.
- Update `FIELD_CONFIG` (`73-78`), `REQUIRED_FIELDS` (`43-49`), `PAYMENT_TRIGGER_KEYS` (`268`), `RECOMPUTE_TRIGGER_KEYS` (`281-285`) to reference `payment_installments` instead of the retired keys.
- Deploy: `npx @shopify/cli app deploy -c timanti-metafield-manager-new` (bare `shopify` not on PATH; no `--force`/`CI=1`).

### 3. Backend — `server.js`
- `getMetafieldType` (`247-260`): add `payment_installments` → `json`. Keep `amount_paid` → `number_decimal`.
- **Gateway/cash payment paths** `handlePaymentCompletion` (`481-592`) + `handleCashPaymentTag` (`1299-1428`): these arrive **incrementally**, so read current `payment_installments`, **push** a new `{value, mode, date}` leg, write back; set `amount_paid = Σ`. Remove `payment_mode_advance`/`_final` writes (`559-562`, `1408-1409`). The existing `store_deposit_payments` audit insert (`538-550`, `1367-1379`) already carries `amount`/`payment_mode`/`installment_type` per row — keep it; it's also the migration source (§6).
  - *Merge note:* server paths **append** one leg; admin UI **replaces** the whole array. They rarely interleave; document that admin edits are authoritative snapshots.
- **Tag twins** `applyPaymentTagsToOrder` (`2122-2189`) + `applyPaymentTagsToDraftOrder` (`2193-2269`): drop `pmode-advance:`/`pmode-final:` emit + the special-case strip logic (`223-234`, `1387-1395`, `2169-2179`, `2241-2250`). Emit **one** aggregate `pmodes:<m1>/<m2>/…` tag instead — the draft-side reporter (§5) is tag-based and needs modes without fetching metafields. Redefine `isInstallmentComplete` (`2164`) from `isFull && !!modeAdvance` → `isFull`. Keep `deposit:`/`paid:`/`pending:`/`total:` tags.
- Self-heal: on `sync-payment`, recompute `amount_paid = Σ payment_installments.value` (belt-and-suspenders if UI didn't send it).
- **Unchanged:** `syncAmountToCollect` (`2284-2321`) and `getCollectionBase` (`464-479`) — net-to-collect is independent of how payments are split. CAD `advance` credit lifecycle (`2323-2455`) unchanged (separate concept).

### 4. Templates (Liquid)
Replace the `pm_advance`/`pm_final` two-slot logic with a loop over `payment_installments`:
```liquid
{% for p in order.metafields.custom.payment_installments.value %}
  Amount Received — {{ p.mode }} ({{ p.date }}): ₹{{ p.value | round }}
{% endfor %}
Balance Due: ₹{{ pending_amount }}
```
- `templates/order-confirmation-receipt.liquid` — assigns `59-72`, rows `409-449`.
- `templates/mto-invoice-template.liquid` — assigns `52-65`, rows `376-415`.
- **root `mto-invoice-template.liquid`** — reads modes from `pmode-*` tags (`3-26`, `417-458`); those tags are retired, so switch it to the JSON loop too. **Reconcile the root vs `templates/` divergence** first — confirm which file is live on the store and keep one canonical copy.
- `templates/voucher.liquid` — no payment section, no change.

### 5. Reporting — `services/reporting/reports.js`
- Orders side (`99-112`): `pmode` join (`107`) and `payment_type` "advance+final" inference (`110-112`) → rebuild from `payment_installments` (join distinct modes; `payment_type` from row count + full/partial). `amount_paid`/`amount_pending`/`net` already blended — untouched.
- Drafts side (`171-224`): `pmode` from `pmode-advance:`/`pmode-final:` tags (`182`) → read the new single `pmodes:` tag. Amounts already from `paid:`/`pending:` tags — untouched.
- `SALES_COLS` (`235-240`): optionally add `installment_count`; `payment_mode` now lists all modes.
- `services/reporting/apps-script.js` (`33-36`, `44-46`): mirror column list; restore the `payment_type` column noted as reverted in SESSION_CONTEXT.

### 6. Recon / ledger — mostly unaffected
- `services/reporting/recon.js`: bank-side matcher (`544-601`, up to 3 legs) and `determineRole` (`321-327`) read **bank** instrument/amount, not our metafields — **no change**, and they already model multi-leg. Draft advance parse (`255-259`) reads `paid:Rs` total — unchanged.
- `services/exchange-cn/credit_instruments.js` + `recon-apps-script.js`: instrument-only ledger (voucher/exchange_note), blended cash — unchanged. The planned `construct_type` unified ledger (`EXCHANGE_ADJUSTMENT_CONTEXT.md` item 7) can later ingest `payment_installments` rows — **noted as future, out of scope.**

### 7. Email — `emailService.js`
- `buildDepositEmailHtml` (`42`, `100-107`) currently shows one "Amount Received" and **no mode**. Add an installment breakdown loop (value + mode + date per row); keep the `amount_paid`/`amount_pending` totals. Pass `payment_installments` from `sendDepositEmail` (`221-229`).

## Migration / rollout order (avoids breaking live invoices)
1. Create `payment_installments` + `payment_mode` definitions.
2. Deploy `server.js` in **dual-write** mode: write the new JSON array **and** keep writing legacy `payment_mode_advance`/`_final` + `pmode-*` tags.
3. **Backfill** `payment_installments` from `store_deposit_payments` (grouped by `draft_order_id` → accurate per-leg `{amount, payment_mode, created_at}`); for admin-only manual `amount_paid` with no audit rows, synthesize a single row from `amount_paid` + `payment_mode_advance`.
4. Migrate templates + `reports.js` to read the JSON array (with legacy fallback).
5. Deploy the admin extension table UI.
6. Once all readers verified, **stop dual-writing** legacy fields, retire `payment_mode_advance`/`_final` + `pmode-*` tags, drop them from governance.

## Critical files
- `server.js` — `247-260`, `481-592`, `1299-1428`, `2122-2189`, `2193-2269`
- `metafield-manager/extensions/*/src/MetafieldManager.jsx` (×4 identical) — `43-49`, `73-78`, `263-285`, `423-492`, `811-851`
- `templates/order-confirmation-receipt.liquid` — `59-72`, `409-449`
- `templates/mto-invoice-template.liquid` — `52-65`, `376-415`
- `mto-invoice-template.liquid` (root) — `3-26`, `417-458`
- `emailService.js` — `42-129`, `221-229`
- `services/reporting/reports.js` — `99-112`, `171-224`, `235-240`
- `services/reporting/apps-script.js` — `33-36`, `44-46`
- `metafield_governance.csv` — rows `5-6`
- new: `services/payment-installments/backfill-installments.js` (reads `store_deposit_payments`)

## Reuse (don't rebuild)
- `timanti.jewelcode` JSON-metafield pattern — precedent for storing + reading a JSON array metafield.
- `store_deposit_payments` — already one row per leg with `amount`/`payment_mode`/`installment_type`; the natural per-installment store and the backfill source.
- `parseChoices` + `renderEditable` (MetafieldManager) — reuse for the per-row mode dropdown.
- `syncAmountToCollect` / `getCollectionBase` — reuse as-is; net logic is installment-agnostic.

## Verification (end-to-end)
1. **Backend leg append:** POST twice to `/api/log-cash-payment` (different modes) for a test draft → GraphQL-read `custom.payment_installments` → assert 2 rows, `amount_paid` = Σ, `amount_pending` correct.
2. **Admin capture:** open a draft in the metafield-manager block, add 3 rows (modes + dates), save → GraphQL-read the JSON metafield (reuse the `X-Shopify-Access-Token` query against `auracarat.myshopify.com`) → assert 3 rows persisted and `amount_paid` derived.
3. **Template render:** render `order-confirmation-receipt.liquid` for an order with 3 installments (via `_order-confirmation-preview.html` harness) → confirm 3 rows show value + mode + date and Balance Due is correct.
4. **Reporting:** hit the sales report endpoint → `payment_mode` lists all modes, `payment_type` reflects installment count; draft rows populate from the `pmodes:` tag.
5. **Live fixture:** migrate #D171 (`amount_paid` 15000 / `payment_mode_advance` upi) → `payment_installments = [{15000, upi, 2026-07-14}]`; add two more legs and re-verify pending = `amount_to_be_collected − Σ`.

---
_Saved 2026-07-15 for later pickup. Status: PLAN ONLY — not started._
