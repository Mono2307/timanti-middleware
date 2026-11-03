-- Migration 004: buy plan rules round 3 (founder, 2026-10-30). Run ONCE in Supabase Dashboard →
-- SQL Editor, BEFORE deploying the code. Idempotent. Needs 003 (run on 2026-10-29).
--
--   installments      4, 5 or 6, chosen at the start (every plan so far is 6)
--   price_changes     [{ date, total, why }] — product changes and the final reprice, oldest first
--   acknowledged_paid what the last "payment received" email covered (one email per new payment)
--   forfeited         closed for non-payment; the money paid became voucher_code
--   lines_key         the pieces the plan is for (draft.js linesKey) — a draft edited without
--                     "Change product" is caught by comparing against it
--   change_pending    a product change waiting for its reprice to finish

alter table buy_plans add column if not exists installments int not null default 6;
alter table buy_plans drop constraint if exists buy_plans_installments_check;
alter table buy_plans add constraint buy_plans_installments_check check (installments between 4 and 6);
alter table buy_plans add column if not exists price_changes jsonb not null default '[]'::jsonb;
alter table buy_plans add column if not exists acknowledged_paid numeric not null default 0;
alter table buy_plans add column if not exists voucher_code text;
alter table buy_plans add column if not exists voucher_value numeric;
alter table buy_plans add column if not exists closed_at timestamptz;
alter table buy_plans add column if not exists closed_reason text;
alter table buy_plans add column if not exists lines_key text;
alter table buy_plans add column if not exists change_pending jsonb;

alter table buy_plans drop constraint if exists buy_plans_status_check;
alter table buy_plans add constraint buy_plans_status_check check (status in ('active','completed','cancelled','forfeited'));

alter table buy_plan_reminders drop constraint if exists buy_plan_reminders_kind_check;
alter table buy_plan_reminders
  add constraint buy_plan_reminders_kind_check
  check (kind in ('due','overdue','received','completed','final_notice','final_reprice','final_price',
                  'warn30','warn45','last15','last25','forfeited','changed','lines_changed'));
