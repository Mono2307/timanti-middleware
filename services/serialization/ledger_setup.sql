-- Serialization v2 — ledger (source of truth for issued serials)
-- Run once in Supabase Dashboard → SQL Editor. Idempotent.
-- The existing serial_counters table + allocate_serial RPC are still used for the
-- atomic next-number; this ledger records every mint (audit, idempotency, cancellation).

create table if not exists serial_ledger (
  id            uuid        primary key default gen_random_uuid(),
  doc_type      text        not null,
  store_code    text        not null,          -- 'ALL' for global (credit_note)
  seq           bigint      not null,
  serial_code   text        not null,
  resource_type text,                           -- 'order' | 'draft_order'
  resource_id   text,                           -- Shopify numeric id
  resource_name text,                           -- e.g. #1038
  status        text        not null default 'active',  -- 'active' | 'cancelled'
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  -- no duplicate number within a sequence:
  constraint serial_ledger_seq_unique      unique (doc_type, store_code, seq),
  -- one serial per resource per doc type → DB-enforced idempotency (kills double-stamps):
  constraint serial_ledger_resource_unique unique (doc_type, resource_id)
);

create index if not exists serial_ledger_lookup on serial_ledger (doc_type, store_code, status);
