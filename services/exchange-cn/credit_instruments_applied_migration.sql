-- Migration: add the 'applied' state to credit_instruments.
-- Run ONCE in Supabase Dashboard → SQL Editor. Idempotent.
--
-- Why: a voucher/exchange note APPLIED to a draft was being marked 'redeemed' immediately, even though
-- the draft may never convert to an order (or the voucher gets removed). That overcounts redemptions and
-- shows unused credits as spent. New model:
--   open      → issued, unused
--   applied   → reserved on a draft (pending, reversible)   ← NEW
--   redeemed  → the draft CONVERTED to an order (true redemption)
--   voided / expired → unchanged
-- The discount still applies at draft time (frozen onto the order at completion); only the ledger STATE
-- transitions applied → redeemed at conversion, or applied → open on draft delete.

-- 1) Allow 'applied' in the status check.
alter table credit_instruments drop constraint if exists credit_instruments_status_check;
alter table credit_instruments
  add constraint credit_instruments_status_check
  check (status in ('open','applied','redeemed','voided','expired'));

-- 2) When the reservation happened (distinct from redeemed_at).
alter table credit_instruments add column if not exists applied_at timestamptz;

-- 3) Backfill: rows marked 'redeemed' at draft-apply time that never converted (a draft target, no order
--    target) are really just 'applied'. Reclassify them so stale reservations stop counting as redeemed.
update credit_instruments
   set status      = 'applied',
       applied_at  = coalesce(applied_at, redeemed_at),
       redeemed_at = null
 where status = 'redeemed'
   and target_order_name is null
   and target_order_id   is null
   and target_draft_id   is not null;
