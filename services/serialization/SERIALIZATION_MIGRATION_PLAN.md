# Serialization Restructure — Migration Plan

Status: **PROTOTYPE phase, not operational** → clean wipe is safe. Drafted 2026-06-25.

## 1. Decisions (locked)

- FY-end, 2-digit (FY 2026-27 → `27`), computed at **Apr-1 IST** and frozen into the serial at mint.
- FY is part of the **counter key** for FY-scoped types so the sequence resets each FY.
- Keep the **full compound store code** `KA-HSR` in every serial.
- **Hard 16-char cap** on B2B + B2C tax-invoice serials → brand token trimmed in the serial
  (`TMNT→TM`, `TMRS→TS`). Brand on the printed invoice header is unchanged. *(swap to keep
  brand + drop state if preferred — one-line change.)*
- **B2B tax invoice = inter-store transfer = sale = one `AURA` doc type, one counter.**
  `make-transfer` mints AURA. There is no separate transfer doc type.
- **Memo → Delivery Challan (`DC`)**, trigger tag `make-challan`, cancel `cancel-challan`.
  Destination dropped from the serial (origin only); kept in `custom.delivery_code` metafield.
- **CAD = design fee**; merged with repairs into one **per-store services counter** (`TS`).
- EXC/VCH switch from calendar year to FY-end to match the rest.

## 2. New registry (format set)

| Internal docType   | Serial template            | Example            | Len | Scope  | Resets per FY | Pad | Trigger |
|--------------------|----------------------------|--------------------|-----|--------|---------------|-----|---------|
| `customer_order`   | `TM{FY}-{CODE}-{SEQ}`      | `TM27-KA-HSR-0001` | 16  | store  | yes           | 4   | order-serial webhook (state_code set) |
| `customer_service` | `TS{FY}-{CODE}-{SEQ}`      | `TS27-KA-HSR-0001` | 16  | store  | yes           | 4   | repair-complete + CAD/design |
| `b2b`              | `AURA-{CODE}-{SEQ}`       | `AURA-KA-HSR-0001` | 16  | store  | no            | 4   | `make-transfer` |
| `delivery_challan` | `DC-{CODE}-{SEQ}`         | `DC-KA-HSR-0001`   | 14  | store  | no            | 4   | `make-challan` (cancel `cancel-challan`) |
| `po`               | `PO-{CODE}-{SEQ}`        | `PO-KA-HSR-00001`  | 15  | store  | no            | 5   | HQ acknowledge (po-ops) |
| `exchange_note`    | `EXC-{FY}-{SEQ}`         | `EXC-27-0001`      | 11  | global | yes           | 4   | `/api/serial/allocate` |
| `voucher`          | `VCH-{FY}-{SEQ}`        | `VCH-27-0001`      | 11  | global | yes           | 4   | `/api/serial/allocate` |

`{CODE}` = full compound store code (`KA-HSR`). `{FY}` = 2-digit FY-end (IST). `{SEQ}` = zero-padded.

Doc types removed/renamed: `memo`→`delivery_challan`, `transfer`→folded into `b2b`, `repair`→folded into `customer_service`. Legacy `credit_note` rows are wiped with everything else (prototype).

## 3. Counter-key design (FY folding — no schema change)

`serial_counters.state_code` and `serial_ledger.store_code` are free text. For FY-scoped types the key
becomes `"{FY}|{store-or-ALL}"`:

- `customer_order` KA-HSR in FY27 → key `27|KA-HSR`
- `voucher` (global) FY27 → key `27|ALL`
- non-FY types (`b2b`, `delivery_challan`, `po`) keep the bare store key `KA-HSR`.

The `allocate_serial` RPC and both unique constraints (`(doc_type, store_code, seq)`,
`(doc_type, resource_id)`) keep working unchanged — uniqueness is now correctly *per FY* for the
scoped types. The `{FY}` printed in the serial uses the same value used to build the key.

## 4. Code changes

- **`services/serialization/index.js`**
  - `DEFAULT_REGISTRY`: replace with the §2 set; add `pad` and `periodScope:'fy'` per type.
  - `format()`: add `{FY}` and padded `{SEQ}` (pad width from registry); keep `{CODE}`/`{DELIVERY}`.
  - new `fyEnd(nowUtc)` helper → 2-digit IST financial-year-end.
  - `allocateSerial()`: when `periodScope==='fy'`, build counter key `fy|code`; emit `{FY}` in templates.
  - relax `needsDelivery` for `delivery_challan` (mint even without a destination).
- **`server.js`**
  - `handleDocumentSerialTags()`: `make-memo`→`make-challan` (`delivery_challan`),
    `make-transfer`→`b2b`, cancel tags renamed; remove old memo/transfer doc types.
  - `assignRepairSerial()`: mint `customer_service` (was `repair`); add CAD/design entry point.
  - peek / set-counter / backfill / re-mirror endpoints: make FY-aware (accept/derive the period).
  - voucher/exchange branch in `/api/serial/allocate`: unchanged call, new FY format comes from registry.
- **`services/po-ops/action.js`**: PO mint → 5-digit pad, `{CODE}` compound (already store-scoped).
- **`services/repairs/index.js`**: point at `customer_service`.
- **`services/exchange-cn/apps-script.js`**, **`services/reporting/apps-script.js`**: ensure they don't
  re-format EXC/VCH/CN locally — display comes from the service.
- **`templates/tax-invoice.liquid`**: no change needed (reads `custom.serial_code`/`serial_no`); confirm
  the B2B (AURA) invoice uses the right template variant.
- Feature flags: keep `SERIAL_*`; rename `SERIAL_MEMO_TRANSFER` usage as needed.
- Docs: update `SERIALIZATION_FOR_FOUNDER.md`, `SYSTEM_OVERVIEW.md`, `TESTING_E2E.md`.

## 5. DB migration (prototype clean slate)

```sql
-- Safe: nothing operational. Optional snapshot first.
create table if not exists serial_ledger_archive_20260625 as table serial_ledger;
create table if not exists serial_counters_archive_20260625 as table serial_counters;

truncate table serial_ledger;
delete  from serial_counters;

-- New defaults live in code (DEFAULT_REGISTRY); clear any stale override row.
delete from config where key = 'serial_registry';
```

## 6. Re-tag existing orders

Because the format changed (`TMNT-…` → `TM27-…`), new numbers can't collide with old ones.

1. Clear the serial metafields on the test orders/drafts (`serial_code`, `serial_no`, `serial_display`,
   `document_type`) so the guards (`if (mf.serial_code) return;`) release them.
2. Re-fire the webhooks / run `/api/serial/backfill` (dry-run first) to re-mint in the new scheme.
3. Spot-check serial lengths ≤16 for B2B/B2C, FY reset, and `KA-HSR` presence.

## 7. Cutover order

1. Land code changes behind flags (off).
2. Run §5 SQL.
3. Deploy.
4. Re-tag test orders (§6).
5. Flip flags on; run the E2E suite in `TESTING_E2E.md`.

## 8. Open item

- B2C/service prefix: **Option A `TM`/`TS`** (keep state, trim brand) assumed. Swap to `TMNT`/`TMRS`
  + drop state if preferred.
