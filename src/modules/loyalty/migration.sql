-- Loyalty programme tables (src/modules/loyalty). Run once in the Supabase SQL editor before
-- setting LOYALTY_ENABLED=true. Safe to re-run.

-- One row per order (entry_key 'order:<shopify order id>') or per manual adjustment
-- (entry_key 'adjust:<anything unique>'). Points are UPSERTED per order, never appended, so the
-- several webhook deliveries Shopify sends for one order — and a later refund — can only ever
-- leave the order's current value behind. A customer's lifetime points = SUM(points).
create table if not exists loyalty_ledger (
  id           bigserial primary key,
  entry_key    text not null unique,
  customer_id  text not null,
  order_id     text,
  order_name   text,
  kind         text not null check (kind in ('earn', 'backfill', 'adjust')),
  channel      text,
  points       bigint not null default 0,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists loyalty_ledger_customer_idx on loyalty_ledger (customer_id);

-- Every time the benefit is used, online or in-store. Online rows start 'pending' when the
-- storefront asks for a code and become 'used' when the order arrives (or 'expired').
create table if not exists loyalty_redemptions (
  id                 bigserial primary key,
  code               text unique,
  discount_node_id   text,
  channel            text not null check (channel in ('online', 'store')),
  status             text not null default 'pending'
                       check (status in ('pending', 'used', 'expired', 'cancelled')),
  customer_id        text not null,
  order_customer_id  text,
  customer_mismatch  boolean not null default false,
  draft_id           text,
  order_id           text,
  order_name         text,
  tier               text,
  rate               numeric(6, 2),
  occasion           text,
  diamond_base       numeric(14, 2),
  discount_pre_tax   numeric(14, 2),
  discount_incl_tax  numeric(14, 2),
  lines              jsonb,
  expires_at         timestamptz,
  used_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists loyalty_redemptions_customer_idx on loyalty_redemptions (customer_id);
create index if not exists loyalty_redemptions_status_idx   on loyalty_redemptions (status, expires_at);
