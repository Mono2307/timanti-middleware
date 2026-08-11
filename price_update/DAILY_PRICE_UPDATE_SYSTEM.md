# Daily Gold Price Update — System Overview + 2026-07-22 Incident & Fix

Audience: developer. Covers the architecture, the trigger chain, the pricing math,
what broke on 2026-07-22, how it was recovered, and hardening recommendations.

---

## 1. System overview

A Google Form sets the day's gold rate; a webhook spawns a Python orchestrator that
re-prices **every live variant** in the `auracarat` Shopify store and emails a report.

```
Google Form (gold rate)
   │  Apps Script onSubmit
   ▼
POST https://timanti-middleware.fly.dev/api/trigger-price-update   (server.js, Fly 512MB VM)
   │   - auth: x-webhook-secret
   │   - validates pure_rate + (manual r18k/r14k within ±10% of auto)
   │   - upserts Supabase config.gold_rate   { pure, mode, set_at, r18k?, r14k? }
   │   - upserts Supabase config.buying_rate_table
   │   - spawn('python3', 'orchestrator.py')          ← fire-and-forget
   ▼
orchestrator.py
   1. fetch Shopify token   ← Supabase config.shopify_access_token
   2. load + validate gold rate (abort if > 20h old)
   3. shopify_snapshot.build_snapshot()  → PREVIEW_VARIANT_IMPORT_<date>_v2.csv   (on /data volume)
   4. import_from_preview.mjs  → writes price + metafields to Shopify
   5. notifier.py → Resend emails (run report + rates confirmation; FATAL alert on error)
```

### Components

| File | Role |
|---|---|
| `server.js` → `/api/trigger-price-update` (~L4443) | Webhook: validates, saves rate, spawns orchestrator |
| `price_update/orchestrator.py` | Master runner (token → rate → snapshot → import → email) |
| `price_update/shopify_snapshot.py` | Pages all variants, recomputes prices, writes preview CSV |
| `price_update/import_from_preview.mjs` | Writes price + 6 metafields back to Shopify |
| `price_update/notifier.py` | Resend emails |
| `price_update/config.py` | Ratios, GST, staleness guard, exclusion list |
| Supabase `config` table | Source of truth: `shopify_access_token`, `gold_rate`, `buying_rate_table` |

### Gold rate model (`config.py`)

```python
RATIO_18K = 0.771   # 18K = pure × 0.771   (overridable manually)
RATIO_14K = 0.604   # 14K = pure × 0.604   (overridable manually)
RATIO_22K = 0.9167  # always derived from pure
RATIO_24K = 1.0     # always derived from pure
GST_RATE  = 0.03
GOLD_RATE_MAX_AGE_HOURS = 20
STATIC_PRICE_GATI_IDS = ['SCOIN']   # never repriced (silver coins etc.)
```

- **auto mode**: 18K/14K derived from pure.
- **manual mode**: 18K/14K taken verbatim *only if both provided*; the webhook rejects
  manual rates deviating > ±10% from what auto would compute (typo guard).

### Pricing formula (per variant) — `shopify_snapshot.py`

Karat comes from SKU segment `[2]` (`GATI|COLOR|KARAT|...`).

```python
gold     = round(net_wt * rate_for_karat, 2)
subtotal = round(gold + diamond + making + gemstone, 2)   # all three read from variant metafields
gst      = round(subtotal * 0.03, 2)
total    = round(subtotal + gst, 2)                       # → Variant price
```

The taxable value (`subtotal`) is **gold + diamond + making + gemstone**. Only the gold
leg moves with the daily rate; diamond, making and gemstone are read from the variant's
stored metafields and passed through unchanged — but they are all part of the GST base,
so a missing component understates both the price and the 3% charged on it.

Gemstone is read from `custom.<GEMSTONE_MF_KEY>` (`config.py`, default
`price_breakup_gemstone`). A variant with no such metafield reads 0 and prices exactly as
it did under the old three-component formula, so plain gold and diamond-only pieces are
unaffected. The snapshot logs how many priced variants carried a non-zero gemstone value
(`variants_with_gemstone`) — 0 on a catalogue that has gemstone pieces means the key is
wrong, not that the pieces are free.

Only variants with `custom.net_metal_weight_g > 0` are priced. Archived products and
`STATIC_PRICE_GATI_IDS` are skipped.

### Validating before a live run

```bash
python orchestrator.py --dry-run --test RG00001
```

Builds the preview CSV only — no Shopify write, no email — under its own
`PREVIEW_VARIANT_IMPORT_<date>_DRYRUN_<GATI>_<run_id>_v2.csv` name, so it can never be
mistaken for the day's production CSV by the resume check. Compare
`mf_price_breakup_gemstone` / `mf_price_subtotal` / `mf_price_total` against the product.

### What gets written back — `import_from_preview.mjs`

Two GraphQL mutations against `admin/api/2024-10`:

```graphql
# Price — grouped by product, batches of 50, price ONLY (weight silently breaks this call)
mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price } userErrors { field message code }
  }
}

# Metafields — 6 dynamic fields per variant (static weights/diamond/making are NOT rewritten daily)
mutation metafieldsSet($m: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $m) { userErrors { field message } }
}
```

The 6 daily metafields (namespace `custom`):
`price_breakup_gold`, `price_breakup_gst`, `price_total`, `price_subtotal`,
`gold_rate` (number_decimal), `gold_last_updated_at` (date_time).

`price_breakup_gemstone` is an **input**, like diamond and making — it is carried in the
preview CSV for audit but never rewritten by the daily run.

### Idempotency / resume

- Orchestrator: if `PREVIEW_VARIANT_IMPORT_<date>_v2.csv` already exists on `/data`
  (survives deploys), it **skips the snapshot** and resumes the import.
- Importer: `import_preview_progress_<stem>.json` logs each done variant id; a resumed
  run filters those out. Re-running is safe (writes are deterministic overwrites).

---

## 2. Incident — 2026-07-22

**Symptom:** staff submitted the gold rate via the form; no price update appeared to
run and **no email arrived** (not the run report, not the rates confirmation, not the
FATAL alert).

**Evidence gathered:**
- Supabase `config.gold_rate` = `{"pure":14732,"mode":"manual","set_at":"2026-07-22T05:17:20.524Z","r18k":11049,"r14k":8593}` — **rate saved**.
- `/api/price-update-diag` (live) → server healthy, all deps + env present.
- Full catalog scan of 17,793 variants:

  | Bucket | Count |
  |---|---|
  | Active/Draft on today's rate | 9,481 |
  | Active/Draft still on 2026-07-21, with weight | **3,601** |
  | Active/Draft no weight (skipped ok) | 385 |
  | Archived (skipped) | ~4,326 |

**Root cause:** The webhook saved the rate and *did* `spawn` the orchestrator (the save
happens immediately before the spawn, after all rejection gates). The run priced 9,481
variants (~72%) and was then **hard-killed (SIGKILL)** — consistent with a **deploy/machine
restart** (server.js was being deployed that morning; this has happened before) and/or
**OOM on the 512 MB VM**. Because SIGKILL bypasses Python's `except` block, the FATAL
alert email was never sent → total silence. The rate persisted in Supabase because that
write lives in the Node process, not the killed Python child.

---

## 3. Remediation performed

Rather than re-run the whole catalog through the same fragile 512 MB path, the fix was
**surgical**: complete only the 3,600 stragglers, replicating the importer's exact math,
from an out-of-band script using a valid Admin token.

Target selection (non-archived, has weight, not on today's date, not excluded):

```python
if status == "ARCHIVED": continue
if sku.split("|")[0].upper() in {"SCOIN"}: continue
if net_wt <= 0: continue
if (gold_last_updated_at or "")[:10] == "2026-07-22": continue   # already done
```

Per-variant compute + writes (identical to snapshot/importer):

```python
RATE = {"18":11049.0, "14":8593.0, "22":round(14732*0.9167,2), "24":14732.0}
gold = round(net*rate,2); sub = round(gold+dia+making,2)
gst  = round(sub*0.03,2); total = round(sub+gst,2)
# productVariantsBulkUpdate (price=total, grouped by product, batch 50)
# metafieldsSet: price_breakup_gold/gst, price_total, price_subtotal,
#                gold_rate, gold_last_updated_at="2026-07-22T05:17:20+00:00"
```

**Result:** 3,600 variants written, **0 price errors, 0 metafield errors**.
Post-run verification scan: Active/Draft on today's rate **9,481 → 13,081** (+3,600);
remaining "stale" = 1, which is `SCOIN` (excluded by design). Catalog fully consistent.

---

## 4. Recommendations (hardening)

1. **Survive deploys.** Biggest win. Either (a) move the price run off the web VM into a
   dedicated Fly Machine / job that isn't recycled on app deploy, or (b) add a deploy
   guard that refuses/drains deploys while `price_update.running` exists.
2. **Fix OOM.** Bump the run VM 512 MB → 1 GB, and/or stream the snapshot (don't hold all
   ~17k variant nodes + the full CSV in memory at once).
3. **Alert on START + heartbeat, not just on caught error.** A SIGKILL death is currently
   invisible. Send a "run started" email/log immediately, and a "run finished OK" — absence
   of the finish signal within N minutes should page. Consider a watchdog that re-scans
   completeness after each run.
4. **Auto-recover the run flag.** `_priceUpdateRunning` is in-memory only; a stuck
   `/app/Outputs/price_update.running` file (note: path differs from the `/data` OUTPUTS
   dir) should be TTL-expired so a crashed run can't wedge future triggers with 409.
5. **Completeness check as a first-class step.** Bundle the catalog scan used here
   (count non-archived + has-weight variants NOT on today's `gold_last_updated_at`) into
   the orchestrator's final step and into the report email, so partial runs are caught
   automatically instead of by manual inspection.
```
```

---

*Store: `auracarat.myshopify.com` · API `2024-10` · runtime Python 3.11 (Fly) · Node importer.*
