-- Savings plan — migration 002 (16 Nov 2026). Run ONCE in Supabase Dashboard → SQL Editor. Idempotent.
--
-- snapshot: the copy a deleted savings draft is rebuilt from (restore.js): the line, the customer, the
-- payment slots, the savings_* fields and the tags. Taken at start, refreshed by every sweep and every
-- payment recorded on the Savings plan screen. Until this runs, a deleted draft that held money cannot
-- be rebuilt: the store and HQ are emailed the amount instead.

alter table savings_plans add column if not exists snapshot jsonb;
