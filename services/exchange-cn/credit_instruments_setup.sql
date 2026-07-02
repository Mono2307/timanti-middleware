-- Credit-instrument ledger — system of record for Exchange Notes & Vouchers.
-- Run ONCE in Supabase Dashboard → SQL Editor (idempotent; same convention as ledger_setup.sql).
-- References serial_ledger by serial_code only (no FK); mintSerial/cancelSerial stay the number authority.
-- See RECON_LEDGER_AND_VOUCHER_PLAN.md §3.

create table if not exists credit_instruments (
  id                uuid primary key default gen_random_uuid(),
  instrument_type   text not null check (instrument_type in ('exchange_note','voucher')),
  serial_code       text not null,                 -- EXC27-KAHSR-0001 / VCH27-KAHSR-0001
  value             numeric(12,2) not null check (value > 0),
  customer_id       text,
  customer_name     text,
  source_order_id   text,                          -- the voided/returned OLD order
  source_order_name text,
  status            text not null default 'open'
                      check (status in ('open','redeemed','voided','expired')),
  target_order_id   text,                          -- NEW order (set at conversion / online webhook)
  target_order_name text,
  target_draft_id   text,                          -- NEW draft (set at offline redemption)
  redeemed_at       timestamptz,
  issued_at         timestamptz not null default now(),
  expires_at        timestamptz,                   -- vouchers: issued+1y; exchange notes: null
  voided_at         timestamptz,
  state_code        text,
  price_rule_id     text,                          -- Shopify price rule id (voucher); deleted on redeem
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint credit_instruments_serial_unique unique (instrument_type, serial_code)
);

create index if not exists credit_instruments_status_idx   on credit_instruments (status);
create index if not exists credit_instruments_customer_idx on credit_instruments (customer_id);
create index if not exists credit_instruments_source_idx   on credit_instruments (source_order_id);
create index if not exists credit_instruments_target_idx   on credit_instruments (target_order_id);
create index if not exists credit_instruments_issued_idx   on credit_instruments (issued_at);
create index if not exists credit_instruments_expiry_open_idx
  on credit_instruments (expires_at) where status = 'open';
