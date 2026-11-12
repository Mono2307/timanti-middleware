-- Savings plan — tables. Run ONCE in Supabase Dashboard → SQL Editor, BEFORE switching on
-- SAVINGS_PLAN_ENABLED. Idempotent. Separate from buy_plans on purpose: the buy-plan sweep, sheet and
-- reports read every buy_plans row as a buy plan, and a savings plan must never be swept by them.
--
-- The Shopify draft is the document staff see and the money of record (its installment slots); this
-- row is the plan's terms and its outcome.

create table if not exists savings_plans (
  id                bigserial primary key,
  draft_order_id    text not null unique,
  draft_name        text,
  customer_id       text,
  customer_email    text,
  customer_phone    text,
  customer_name     text,
  months            int not null check (months in (6, 10)),
  instalment        numeric(12,2) not null check (instalment between 1000 and 100000),
  total             numeric(12,2) not null,
  start_date        date not null,
  due_dates         date[] not null,
  nominee           text,
  -- active      paying instalments (also: fully paid, voucher not yet issued)
  -- completed   matured / prepaid / redeemed early: voucher issued, awaiting redemption
  -- terminated  30 days past an unpaid due date, or stopped by the customer: voucher (no bonus) due or issued
  -- redeemed    the voucher is used up
  -- cancelled   a demo or a plan started by mistake: no voucher
  status            text not null default 'active'
                    check (status in ('active','completed','terminated','redeemed','cancelled')),
  end_kind          text check (end_kind in ('full','early','terminated','stopped')),
  late_count        int,
  paid_at_end       numeric(12,2),
  bonus_pct         int,
  bonus             numeric(12,2),
  voucher_code      text,
  voucher_value     numeric(12,2),
  voucher_issued_at timestamptz,
  acknowledged_paid numeric not null default 0,
  closed_at         timestamptz,
  closed_reason     text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists savings_plans_status_idx on savings_plans (status);
create index if not exists savings_plans_customer_idx on savings_plans (customer_id);

-- Sent-markers: a message is recorded only after it went out; the unique key means a replayed sweep
-- never sends the same one twice.
create table if not exists savings_plan_reminders (
  id             bigserial primary key,
  plan_id        bigint not null references savings_plans(id) on delete cascade,
  installment_no int not null,
  audience       text not null check (audience in ('customer','staff')),
  kind           text not null,
  sent_at        timestamptz not null default now(),
  unique (plan_id, installment_no, audience, kind)
);

-- The Savings Scheme Voucher lives in the credit-instrument ledger like every voucher. Its value is
-- split into the customer's money and Timanti's bonus, so Accounts can book them apart.
alter table credit_instruments add column if not exists paid_part  numeric(12,2);
alter table credit_instruments add column if not exists bonus_part numeric(12,2);
