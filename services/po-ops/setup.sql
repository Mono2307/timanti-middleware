-- PO Records table
-- Table already exists in production — CREATE TABLE is a no-op (IF NOT EXISTS).
-- The alter at the bottom is what actually runs for an existing install.

create table if not exists po_records (
  id                uuid        primary key default gen_random_uuid(),
  source_order_id   text        not null,
  po_type           text        not null,          -- 'mto' | 'in-stock'
  draft_order_id    text        not null,
  draft_order_name  text        not null,
  action_token      text        not null unique,
  status            text        not null default 'pending',
  batch_id          text,                          -- set for batch-raised POs, null for legacy webhook POs
  created_at        timestamptz not null default now(),
  constraint po_records_source_type_unique unique (source_order_id, po_type)
);

-- Fast O(1) lookup when HQ clicks an action link
create index if not exists po_records_token_idx on po_records (action_token);

-- ─── Batch PO tracking ───────────────────────────────────────────
-- One row per batch raise (one per po_type per day).

create table if not exists batch_po_records (
  id                   uuid        primary key default gen_random_uuid(),
  batch_id             text        not null unique,   -- e.g. "mto-2026-05-21-1716288000000"
  batch_date           date        not null,
  po_type              text        not null,           -- 'mto' | 'in-stock'
  draft_order_id       text        not null,
  draft_order_name     text        not null,
  source_line_item_ids text[]      not null,
  status               text        not null default 'pending',
  created_at           timestamptz not null default now()
);

-- Add batch_id column to po_records (safe to run even if already exists)
alter table po_records add column if not exists batch_id text;

-- v2 serialization: store code (place of supply) used to mint PO-{CODE}-{SEQ} at HQ acknowledge.
-- Auto-POs copy it from the source order's custom.state_code; batch POs get it from the sheet dropdown.
alter table po_records add column if not exists store_code text;
