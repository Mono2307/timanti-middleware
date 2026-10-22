-- Migration: buy plan tables + GoKwik webhook capture log.
-- Run ONCE in Supabase Dashboard → SQL Editor, BEFORE deploying the code. Idempotent.

-- 1) Raw GoKwik webhook capture. The webhook is newly wired and its payload / signing scheme has
--    never been inspected, so every delivery is stored verbatim before anything is built on it.
--    Capture only — nothing reads this table to move money.
create table if not exists gokwik_webhook_log (
  id          bigserial primary key,
  received_at timestamptz not null default now(),
  headers     jsonb,
  body        jsonb,
  raw_body    text
);

-- 2) One row per buy plan. The draft is the Shopify document; this row is the system of record for
--    the plan itself (the locked total, the dates) and the snapshot the draft is restored from if
--    someone deletes it. draft_order_id is re-keyed when a draft is restored.
create table if not exists buy_plans (
  id               bigserial primary key,
  draft_order_id   text not null unique,
  draft_name       text,
  customer_id      text,
  customer_email   text,
  customer_phone   text,
  customer_name    text,
  total            numeric(12,2) not null,
  locked_gold_rate text,
  start_date       date not null,
  due_dates        date[] not null,
  status           text not null default 'active' check (status in ('active','completed','cancelled')),
  snapshot         jsonb,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 3) Sent-markers. The unique key is the idempotency guard: a reminder is recorded only after it
--    was sent, and a replayed sweep cannot send the same one twice.
create table if not exists buy_plan_reminders (
  id             bigserial primary key,
  plan_id        bigint not null references buy_plans(id) on delete cascade,
  installment_no int not null,
  audience       text not null check (audience in ('customer','staff')),
  kind           text not null check (kind in ('due','overdue','completed')),
  sent_at        timestamptz not null default now(),
  unique (plan_id, installment_no, audience, kind)
);
