# Reconciliation Ledger for Exchange Notes & Vouchers — Execution Plan

> Status: **spec-locked, not yet built.** Decisions below were worked through and confirmed. Execute later.
> Owner context: see also `EXCHANGE_ADJUSTMENT_CONTEXT.md`, `EXC_METAFIELD_E2E_PLAN.md`.
> ⚠️ Before building: **rotate the Shopify Admin token** that was shared during planning (`shpat_…355c`).

---

## 1. Why

The lifecycle of a credit instrument (Exchange Note or Voucher) — raised against a returned/voided order, adjusted against a *new* order — currently lives only in **Shopify tags + Google Sheet logs + transient metafields**. None are joinable. `serial_ledger` mints the number but stores no value, customer, source/target order, redemption, or expiry. So today we **cannot** answer:
- issued vs redeemed vs outstanding vs voided vs expired,
- outstanding-credit **liability** at a point in time,
- per-order **tie-out**: order total = (exchange + voucher + old-gold adjustments) + cash collected.

This build adds a Supabase **system of record**, a **reconciliation report**, and a **backfill**, and along the way fixes voucher **post-tax correctness** on invoices.

---

## 2. Locked decisions

1. **Voucher = order-level fixed-amount Shopify discount code** (unchanged mechanism). Shopify natively enforces single-use / one-customer / expiry across **online checkout and staff drafts** (one code, one usage counter).
2. **Exchange note = staff-applied `custom.exchange_note_value` metafield** (no customer-facing code). Unchanged.
3. **Tax treatment is classified by IDENTITY, not allocation level.** The discount whose **code/title matches `VCH`** → **post-tax** (`voucher_value`). **Every other discount** — line-level promo, order-level auto-promo (e.g. ₹1k-off-first-order), manual — → **pre-tax** (folds into `Discount Applied`, reducing the taxable base). Level (line vs order) is irrelevant to tax treatment.
4. **No partial redemption** on vouchers (all-or-nothing).
5. **Reproducibility via frozen metafields.** The Tax Invoice must re-render byte-identical forever → it reads **only frozen metafields**, never live discount data. Values are frozen by the `orders/create` webhook (fires seconds after the order; the invoice is issued at dispatch, hours-to-days later → ample margin).
6. **Proforma is a provisional receipt, not a tax document** → it carries **no GST split**.

### Verified facts (don't re-derive)
- Store computes **no tax in Shopify**; prices GST-inclusive; invoice **back-derives GST** from `Gross Value − Discount Applied`, not from `order.total_price`.
- An **order-level discount code is NOT in `line_item.price`** (stays full); it appears in `order.discount_codes` (`[{code, amount, type}]`) + line `discount_allocations`. Live Admin-API read of order #1042 confirmed: `line_item.price` = full `40263.37`, discount in `discount_allocations` (`10263.37`, `total_discount` line-level = `0.00`), `Taxable Value 29126.21 = (40263.37 − 10263.37)/1.03`.
- **Server-side** we always have the raw data to classify: `line_item.price` (gross) + `discount_allocations` (per-line amount + `discount_application_index`) + `discount_applications[i]` (`type`, `title`) + `order.discount_codes` (code+amount). Liquid alone does **not** expose the code reliably (only `title`).
- Checkout is **never modified**; the webhook is a standard post-order hook (same family as the existing serial-mint webhook, `server.js:2878`).
- Pricing-engine hydration (`Gross Value`/`Discount Applied`/`Taxable Value` line props) currently fires **only on `draft_orders/create`** (`server.js:1455`) → pure-online orders lack it.

---

## 3. Build — Part A: credit-instrument ledger

### 3.1 Table — new file `services/exchange-cn/credit_instruments_setup.sql`
Idempotent `create table if not exists`, run once in Supabase SQL Editor (same convention as `services/serialization/ledger_setup.sql`). References `serial_ledger` by `serial_code` only — **no FK**; `mintSerial`/`cancelSerial` stay the number authority.

```sql
create table if not exists credit_instruments (
  id                uuid primary key default gen_random_uuid(),
  instrument_type   text not null check (instrument_type in ('exchange_note','voucher')),
  serial_code       text not null,                 -- EXC-27-0001 / VCH-27-0001
  value             numeric(12,2) not null check (value > 0),
  customer_id       text,
  customer_name     text,
  source_order_id   text,                          -- the voided/returned OLD order
  source_order_name text,
  status            text not null default 'open'
                      check (status in ('open','redeemed','voided','expired')),
  target_order_id   text,                          -- NEW order (set at conversion / online webhook)
  target_order_name text,
  target_draft_id   text,                          -- NEW draft (set at redemption)
  redeemed_at       timestamptz,
  issued_at         timestamptz not null default now(),
  expires_at        timestamptz,                   -- vouchers: issued+1y; exchange notes: null
  voided_at         timestamptz,
  state_code        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint credit_instruments_serial_unique unique (instrument_type, serial_code)
);
create index if not exists credit_instruments_status_idx   on credit_instruments (status);
create index if not exists credit_instruments_customer_idx on credit_instruments (customer_id);
create index if not exists credit_instruments_source_idx   on credit_instruments (source_order_id);
create index if not exists credit_instruments_target_idx   on credit_instruments (target_order_id);
create index if not exists credit_instruments_issued_idx   on credit_instruments (issued_at);
create index if not exists credit_instruments_expiry_open_idx
  on credit_instruments (expires_at) where status = 'open';
```

### 3.2 Helper — new file `services/exchange-cn/credit_instruments.js`
Mirror the serialization `deps`/`{ supabase }` pattern. `updated_at` set in JS (like other tables).
- `upsertIssued(deps, {instrumentType, serialCode, value, customerId, customerName, sourceOrderId, sourceOrderName, stateCode, expiresAt})` → insert `on conflict (instrument_type, serial_code) do nothing`.
- `redeem(deps, {instrumentType, serialCode, targetDraftId?, targetOrderId?, targetOrderName?})` → set `status='redeemed'`, `redeemed_at`, target refs; lazily insert if a legacy caller never issued the row.
- `voidInstrument(deps, {instrumentType, serialCode})` → `status='voided'`, `voided_at`.

### 3.3 Write-points (`server.js`)
| Event | Location | Call |
|---|---|---|
| Issue EXC | `/api/exc-redeem` (3806) or allocate | `upsertIssued('exchange_note', …)` |
| Issue VCH | `createVoucher_` (apps-script) → **new** `POST /api/credit-instrument/issue` | `upsertIssued('voucher', …, expiresAt)` |
| Redeem EXC | `/api/exc-redeem` (3806) | `redeem({…, targetDraftId})` |
| Redeem VCH | orders webhook (2878), VCH found in `order.discount_codes` | `redeem({…, targetOrderId, targetOrderName})` — covers online + offline (one shared code) |
| Void EXC | `/api/exc-void` (3867) | `voidInstrument` |
| Void VCH | `voidVoucher` path | `voidInstrument` + delete the Shopify discount code |
| Stamp EXC target | draft-completed handler (2104) | set `target_order_id/name` |

---

## 4. Build — Part B: tax-invoice post-tax correctness (freeze online split)

Extend the **orders/create + orders/update webhook** (`server.js:2878`). For an order **lacking** the pricing-engine props (pure-online), classify & **freeze**:

```
gross_total      = Σ line_item.price                      // full, pre-discount
discount_applied = 0 ; voucher_value = 0
for each discount_application da (index i):
    amt = Σ line.discount_allocations[where index==i].amount   // total allocated for da
    isVoucher = (order.discount_codes has code matching /^VCH-/i for da)  // identity, not level
                OR da.title matches /VCH/i
    if isVoucher: voucher_value     += amt        // POST-tax
    else:         discount_applied  += amt        // PRE-tax (promo/auto/manual)
taxable_base = gross_total - discount_applied
```
Write frozen **order metafields** the tax invoice reads: `custom.gross_value`, `custom.discount_applied` (or `taxable_base`), `custom.voucher_value`. Reuse `updateDraftOrderMetafields`-style writer for orders.

- Feeds **only the deferred Tax Invoice** (no race — invoice is at dispatch).
- Staff/offline vouchers already write `voucher_value` at draft redemption → **both channels converge** on the same frozen `voucher_value`, separable from any pre-tax discount in `discount_applied`.
- Idempotent: skip if already frozen (guard on presence of `custom.voucher_value`/`gross_value`).

---

## 5. Build — Part C: templates

### 5.1 `templates/proforma-invoice.liquid` — strip the GST split (clean receipt)
- Remove the **Taxable Value / Disc-on-Taxable / GST / Total Invoice Price** block for this provisional doc.
- Show: item list, a plain **"Voucher applied − ₹X"** line read **live** from the order's VCH discount (`order.discount_codes`/`discount_applications` title — correct the instant the order exists, no webhook), **Amount Paid** and **Balance** from payment metafields/tags.
- Result: nothing to mis-compute, no race, never overstates Balance.

### 5.2 `templates/tax-invoice.liquid` — voucher post-tax from frozen metafield
- Add a post-tax **"Less: Voucher (VCH-…)"** line driven by `order.metafields.custom.voucher_value` (mirror the existing CNTM / old-gold / exchange-note post-tax blocks at the current voucher block ~`:368`).
- Renders only from frozen metafields/properties → reproducible re-downloads even after the discount code is deleted.
- Reconcile the voucher tag/metafield naming onto **one** key (today: `cn-*` tags vs `voucher-num:` vs `voucher_value` — pick one).

---

## 6. Build — Part D: recon report + backfill

### 6.1 `GET /api/recon` (mirror `/api/serial-report`; JSON default, `?format=csv`)
- `view=summary` — per type/month: issued / redeemed / outstanding / voided / expired (count+value). Reconciliation identity: **issued = redeemed + outstanding + voided + expired**.
- `view=outstanding` — liability register of `open`: serial, type, value, customer, source order, `issued_at`, `expires_at`, days-to-expiry. (`expired` derived on read: `open && expires_at < now`; optional `POST /api/recon/expire-sweep`.)
- `view=tieout` — per instrument with a `target_order_id`: order total vs (`exchange_note_value`+`voucher_value`+`old_gold_value`) vs cash collected (`Σ store_deposit_payments where draft_order_id = target_draft_id`); variance flag.
- Front-end: new `services/exchange-cn/recon-apps-script.js`, modeled on `services/reporting/apps-script.js` (input cells, `📒 Recon` menu, same CSV/JSON contract).

### 6.2 `POST /api/recon/backfill` (dry-run default, like `runSerialBackfill` server.js:2937)
- Sources, precedence: Shopify (`exc-*`/`cn-*`/`vch-*` tags + `discount_codes`/`discount_applications`) > Exchange/Voucher Log sheets (value, expiry, customer, `price_rule_id`) > `serial_ledger` (existence; `status='cancelled'` ⇒ voided).
- One upserted row per `serial_code`; status: voided if cancelled/sheet=Void → redeemed if target found → expired if past `expires_at` → else open. Conflicts/orphans → review CSV. Execute (`?dryRun=false`) only after the diff is clean.

---

## 7. Execution order
1. Run `credit_instruments_setup.sql` in Supabase.
2. Add `credit_instruments.js` helper.
3. Wire ledger write-points (Part A) into `server.js` + `apps-script.js`.
4. Add Part B freeze logic to the orders webhook.
5. Edit templates (Part C): proforma strip, tax-invoice voucher line.
6. Add `/api/recon` + `recon-apps-script.js`; add `/api/recon/backfill`.
7. Run backfill dry-run → review → execute.

## 8. Verification
1. **DDL** — table + indexes exist (`pg_indexes`).
2. **Online freeze** — pure-online order w/ VCH (+ optional auto-promo): `voucher_value` (post-tax) and `discount_applied` (pre-tax, incl. promo) frozen at `orders/create`; **tax invoice** shows voucher post-tax, correct GST, byte-identical re-download.
3. **Proforma** — same order: items + "Voucher applied −₹X" + Amount Paid + Balance, **no GST table**, available immediately, balance never overstated.
4. **Offline voucher** — staff draft w/ VCH + a pre-tax discount: voucher in `voucher_value`, discount in `Discount Applied`, no collision.
5. **Ledger lifecycle** — issue → redeem (online webhook / offline) → convert → void; `credit_instruments` and `serial_ledger` never diverge; Shopify enforces single-use across channels.
6. **Recon** — `summary` identity holds; `outstanding` lists liability; `tieout` flags mismatches.

## 9. Open item (confirm with first real data)
On the first real **online** VCH order, 30-second Admin-API recheck: VCH discount carries `type:"discount_code"` with its code in `discount_codes`, and a stacked online product/auto promo classifies **pre-tax** as intended.
