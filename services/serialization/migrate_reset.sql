-- Serialization restructure — PROTOTYPE clean-slate reset.
-- Run once in Supabase Dashboard → SQL Editor. Safe: nothing is operational (prototype phase).
-- See SERIALIZATION_MIGRATION_PLAN.md for the full plan.

-- 1. Snapshot first (cheap insurance; drop later once verified).
create table if not exists serial_ledger_archive_20260626   as table serial_ledger;
create table if not exists serial_counters_archive_20260626 as table serial_counters;

-- 2. Wipe the live counters + ledger so the new FY-scoped scheme starts clean.
truncate table serial_ledger;
delete  from serial_counters;

-- 3. Clear any stale runtime registry override — new defaults live in index.js DEFAULT_REGISTRY.
delete from config where key = 'serial_registry';

-- After this: redeploy, then re-tag test orders (clear their serial_* metafields and re-fire the
-- order-serial webhook / run /api/serial/backfill?dryRun=false). New serials use the new format
-- (TM27-… / TS27-… / AURA-… / DC-… / PO-… / EXC-27-… / VCH-27-…) and cannot collide with old ones.
