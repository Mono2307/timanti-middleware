-- Migration: record REFUNDS in credit_instruments, and the draft's own refunded total.
-- Run ONCE in Supabase Dashboard → SQL Editor, BEFORE deploying the code. Idempotent.
--
-- Why here and not in a new table: a refund against a draft is after-sales money movement, and
-- credit_instruments is already the joinable system of record every after-sales report reads
-- (/api/recon-ledger and /api/adjustment-report both aggregate it). The cad_advance type proved the
-- shape works for an instrument that mints no serial — it uses the document's own name as
-- serial_code. A refund does the same, with a slot suffix: '#D189-R1'.
--
-- That also makes the EXISTING unique constraint (instrument_type, serial_code) the idempotency
-- guard. The draft-updated webhook fires repeatedly, so the refund sync must be safe to replay; an
-- upsert with ignoreDuplicates against this key is what makes it so, with no bespoke dedup column.
--
-- Refund rows are terminal: status 'refunded' has no onward transition. revertApplied only matches
-- status = 'applied', so deleting the draft cannot touch them — which is the point. The refund is
-- true whether or not the document survives.

-- 1) Allow the refund type and the refunded state.
--    NOTE: credit_instruments_setup.sql still declares the type check as ('exchange_note','voucher'),
--    yet cad_advance rows write fine in production — so the live constraint was already widened or
--    dropped outside version control and that file is stale. Restating the WHOLE list (rather than
--    adding to it) makes this converge regardless of what is actually live.
alter table credit_instruments drop constraint if exists credit_instruments_instrument_type_check;
alter table credit_instruments
  add constraint credit_instruments_instrument_type_check
  check (instrument_type in ('exchange_note','voucher','cad_advance','refund'));

alter table credit_instruments drop constraint if exists credit_instruments_status_check;
alter table credit_instruments
  add constraint credit_instruments_status_check
  check (status in ('open','applied','redeemed','voided','expired','refunded'));

-- 2) Refund-specific columns. Nullable, in keeping with the table's existing type-specific columns
--    (price_rule_id is voucher-only, expires_at is voucher-only).
--    gateway_ref is the UTR of the transfer staff made by hand — the join key back to the settlement
--    CSVs in src/data/recon when a refund has to be tied out against the gateway.
alter table credit_instruments add column if not exists refunded_at   timestamptz;
alter table credit_instruments add column if not exists refund_mode   text;
alter table credit_instruments add column if not exists gateway_ref   text;
-- Notification is decoupled from recording: staff press a button, and this is what stops a
-- second press sending a second email.
alter table credit_instruments add column if not exists email_sent_at timestamptz;

-- 3) The draft's own deposit row. amount_paid stays GROSS collected and is never written down;
--    this is the parallel figure the balance is derived against.
alter table store_deposits add column if not exists amount_refunded numeric default 0;

create index if not exists credit_instruments_refund_draft_idx
  on credit_instruments (target_draft_id) where instrument_type = 'refund';
