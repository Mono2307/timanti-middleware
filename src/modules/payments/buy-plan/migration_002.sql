-- Migration 002: let the sweep record "payment received" emails as sent.
-- Run ONCE in Supabase Dashboard → SQL Editor, BEFORE deploying the code. Idempotent.
--
-- The sweep confirms every installment a payment closes ("payment received, here is your new
-- schedule") and guards it with the same sent-marker as the reminders. Without 'received' in the
-- check constraint those marker writes fail, and the confirmation would be re-sent every 6 hours.

alter table buy_plan_reminders drop constraint if exists buy_plan_reminders_kind_check;
alter table buy_plan_reminders
  add constraint buy_plan_reminders_kind_check
  check (kind in ('due','overdue','received','completed'));
