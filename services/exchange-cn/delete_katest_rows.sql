-- ═══════════════════════════════════════════════════════════════════════════
-- Remove every KA-TEST row from the Supabase ledger.
--
-- Run in Supabase Dashboard → SQL Editor. Touches ONLY the KA-TEST store — no
-- KA-HSR row matches any predicate below.
--
-- WHY THIS IS NEEDED: the After-Sales Log carries ~Rs 3.65 lakh of KA-TEST
-- instruments that read exactly like live trade. The sheet side is now fixed
-- (the store is recovered from the serial and shown in its own column), but the
-- ledger rows behind them still exist and still answer /api/recon-ledger, so
-- every recon view keeps counting them.
--
-- The predicates deliberately match on BOTH the serial pattern and the store
-- column. state_code was not always populated at issue time, so a store-only
-- filter misses the early rows; the serial always carries KATEST.
--   VCH27-KATEST-0001, EXC27-KATEST-0006, ...
--
-- LEGACY SERIALS ARE NOT MATCHED, deliberately: VCH-2026-0001 and
-- EXC-2026-0001 have no store segment at all. They are on real orders (#1019)
-- and are NOT test data — see the double-issue question on #1019/#1011, which
-- is a business decision, not a cleanup.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — PREVIEW. Run this alone first and read the counts. ─────────────
select 'credit_instruments' as table_name, count(*) as rows_to_delete
  from credit_instruments
 where serial_code ilike '%-KATEST-%' or state_code = 'KA-TEST'
union all
select 'serial_ledger', count(*)
  from serial_ledger
 where serial_code ilike '%-KATEST-%' or store_code = 'KA-TEST'
union all
select 'serial_counters', count(*)
  from serial_counters
 where state_code = 'KA-TEST';

-- Line-by-line, if you want to see exactly what goes:
--   select serial_code, instrument_type, value, status, source_order_name, issued_at
--     from credit_instruments
--    where serial_code ilike '%-KATEST-%' or state_code = 'KA-TEST'
--    order by issued_at;


-- ── STEP 2 — DELETE. Only after the preview looks right. ───────────────────
-- Wrapped in a transaction: if any statement errors, nothing is removed.
-- Change the last line to COMMIT once the row counts match the preview.

begin;

delete from credit_instruments
 where serial_code ilike '%-KATEST-%' or state_code = 'KA-TEST';

delete from serial_ledger
 where serial_code ilike '%-KATEST-%' or store_code = 'KA-TEST';

-- The KA-TEST counters. Removing these resets the test store's numbering to
-- start from the beginning again, which is what you want for a test store —
-- and is why this is safe here and would NOT be safe for KA-HSR.
delete from serial_counters
 where state_code = 'KA-TEST';

rollback;   -- ← change to COMMIT to apply


-- ── STEP 3 — VERIFY (after committing) ─────────────────────────────────────
-- Expect three zeroes.
--   select count(*) from credit_instruments where serial_code ilike '%-KATEST-%' or state_code = 'KA-TEST';
--   select count(*) from serial_ledger      where serial_code ilike '%-KATEST-%' or store_code = 'KA-TEST';
--   select count(*) from serial_counters    where state_code = 'KA-TEST';


-- ── NOT COVERED HERE ───────────────────────────────────────────────────────
-- po_records / batch_po_records have a store_code but belong to PO Ops, not to
-- after-sales. If those also hold test rows, say so and the same pattern
-- applies:  delete from po_records where store_code = 'KA-TEST';
--
-- The SHEET is not touched by any of this. The rows to delete by hand are:
--   CAD Advance Log   2x #TEST-DELETE-ME, and 3 of the 4 #D208 rows
--   After-Sales Log   the duplicate VCH27-KAHSR-0002 row (Ref backfill:...)
--   After-Sales Log / Voucher Log / Exchange Log   the KATEST rows, if you want
--                     them gone from the sheet as well as from the ledger
