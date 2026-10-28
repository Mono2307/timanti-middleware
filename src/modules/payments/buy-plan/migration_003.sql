-- Migration 003: the two kinds of buy plan (founder, 2026-10-24). Run ONCE in Supabase Dashboard →
-- SQL Editor, BEFORE deploying the code. Idempotent. Also covers migration_002 (safe if already run).
--
--   gold   pay the gold value first → gold rate locked, the rest over installments 2..6
--   equal  six equal installments; the last is repriced at the gold rate on its due date
--
-- Plans started before this migration were locked from day 1, so they become 'gold' (with no gold
-- value, their installment 1 stays total/6 — exactly how they were set up).

alter table buy_plans add column if not exists mode text not null default 'gold';
alter table buy_plans drop constraint if exists buy_plans_mode_check;
alter table buy_plans add constraint buy_plans_mode_check check (mode in ('gold','equal'));
alter table buy_plans add column if not exists gold_value numeric;
alter table buy_plans add column if not exists start_rates jsonb;
alter table buy_plans add column if not exists final_total numeric;
alter table buy_plans add column if not exists final_rates jsonb;
alter table buy_plans add column if not exists final_repriced_at timestamptz;

alter table buy_plan_reminders drop constraint if exists buy_plan_reminders_kind_check;
alter table buy_plan_reminders
  add constraint buy_plan_reminders_kind_check
  check (kind in ('due','overdue','received','completed','final_notice','final_reprice','final_price'));
