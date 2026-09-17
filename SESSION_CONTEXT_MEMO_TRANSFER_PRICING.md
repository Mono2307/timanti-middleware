# Session Context — Memo / Transfer + Reprice Pricing (2026-07)

Branch: `feat/metafield-manager-extension` (Fly deploys from here; `main` is stale).
Deployed & live. App: `timanti-middleware.fly.dev` · Store: `auracarat.myshopify.com`.

## Commits shipped in this thread
- **`0d3ec33`** — make-memo-custom, make-transfer weighted %, store-code-aware serial re-issue
- **`ca724c6`** — variant-anchored diamond/making reprice + GST-inclusive Gross Value

## Features

1. **`make-memo-custom` tag** → reprices line items to **gold 100% + making 100% + diamond 50%**,
   overwrites `Gross Value`/`Taxable Value`/`GST` props + line price, mints `MEMO-{STORE}-{SEQ}`.
   **✅ VERIFIED WORKING in prod** (verified when diamond was weighted 0%; the 50% weight is a
   later change — ⏳ re-verify).
2. **`make-transfer` tag** → now *also* reprices to a weighted **`gold×G% + dia×D% + making×M%`**,
   from per-draft `custom.transfer_pct_gold` / `_dia` / `_making` (blank ⇒ **100/100/100**), and mints
   `AURA-…` (existing). Both memo + transfer run through one handler: **`handleWeightedDocReprice`** (server.js).
   Gated on `SERIAL_MEMO_TRANSFER`. *(⏳ not yet live-verified.)*
3. **Store-code-aware serial re-issue** (`mintSerial`, services/serialization/index.js): if `state_code`
   changes (wrong-store fix) or the serial was cancelled, re-adding `make-*` **re-issues the correct
   serial** and **reclaims** the abandoned number when it's still the tip of its store counter (rolls the
   counter back). A human mistake never permanently locks a serial. **No DB migration.** *(⏳ verify.)*
4. Serial registry: added **`memo_custom`** doc type = `MEMO-{CODE}-{SEQ}`; router handles
   `make-memo-custom` / `cancel-memo-custom`.

## Pricing correctness fixes (`ca724c6`)
- **Diamond compounding FIXED** — per-carat rate now always from the variant/product design spec
  (`price_breakup_diamond ÷ product design carats`), scaled to entered carats. Was re-derived from the
  moving `Diamond` prop → value drifted **down** ~6%/reprice (÷ product cts, × entered cts). *(⏳ verify: 2 reprices, no change.)*
- **Making drift FIXED** — making-per-gram from the variant (`price_breakup_making ÷ variant net wt`),
  scaled to entered net weight. Was drifting when the gold **rate** changed (old net wt = oldGold/rate).
- `oldNetWt` now read from the stored `_net_wt` prop (stable delta + fallback).
- **Gross Value is now GST-INCLUSIVE** (`components × 1.03`) in **hydrate + reprice + weighted engine**.

## Convention decisions (durable — don't re-litigate)
- **`Gross Value` prop = tax-INCLUSIVE line total = components + 3% GST = the charged price.** Same meaning
  whether the line was only hydrated or fully repriced. The `Gold`/`Diamond`/`Making` props stay **pre-tax**
  breakdown. This fixed the invoice under-reporting ~3% on un-repriced orders (e.g. order #1064).
- **Reprice is variant-anchored** (founder directive): gold/diamond/making all derived from variant
  metafields scaled by entered weights/carats — never from the moving line-item props → idempotent.

## Open items
- **Live-verify** the three ⏳ above (transfer %, store-code re-issue, diamond/making stability).
- **~₹20 residual** on #1064: the catalog variant `price` and the `price_breakup_*` metafields are out of
  sync (daily `price_update` job writes them at slightly different gold rates). Separate data-sync bug,
  **not** the GST convention. Fix by making the daily job write `price` and `price_breakup_*` atomically.
- **feat→main reconciliation debt** — `main` is stale; Fly deploys from `feat`.
- Optional: expose `transfer_pct_*` in the metafield-manager extension for easy staff entry.

## Deploy / verify
- Deploy = **manual** GitHub Actions → "Deploy to Fly.io" (`workflow_dispatch`) on `feat/metafield-manager-extension`.
  `gh`/`flyctl` NOT installed locally → a human triggers it.
- Deploy-landed probe (read-only): new GET endpoints `/api/serial-counters` (200) and `/api/sales-report`
  (400 = param validation, not 404) confirm the new code is live.

## Key files
- `server.js` — `handleWeightedDocReprice`; `handleRecalculatePriceTag` (diamond/making/gross math);
  `hydrateItemFromVariant`; `handleDocumentSerialTags` router; `/api/shopify-draft-updated` webhook.
- `services/serialization/index.js` — `mintSerial` (re-issue + counter reclaim); `DEFAULT_REGISTRY`
  (`memo_custom`); `cancelSerial`; `serial_ledger` / `serial_counters` (schema in `ledger_setup.sql` / `setup.sql`).
