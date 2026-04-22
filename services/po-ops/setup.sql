-- PO Records table
-- Run once: Supabase Dashboard → SQL Editor → New Query

create table if not exists po_records (
  id                serial      primary key,
  source_order_id   text        not null,
  po_type           text        not null,          -- 'mto' | 'replenishment'
  draft_order_id    text        not null,
  draft_order_name  text        not null,
  action_token      text        not null unique,
  status            text        not null default 'pending',
  created_at        timestamptz not null default now(),
  constraint po_records_source_type_unique unique (source_order_id, po_type)
);

-- Fast O(1) lookup when HQ clicks an action link
create index if not exists po_records_token_idx on po_records (action_token);
