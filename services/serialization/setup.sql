-- Serialization counter
-- Run once in Supabase Dashboard → SQL Editor. Idempotent (safe to re-run).
--
-- One row per (doc_type, state_code). state_code is 'ALL' for global sequences
-- (repair, credit_note); a real state code (KA/MH/…) for per-state sequences
-- (customer_order, po, memo, transfer).

create table if not exists serial_counters (
  id            uuid        primary key default gen_random_uuid(),
  doc_type      text        not null,
  state_code    text        not null,           -- 'ALL' for global sequences
  current_value bigint      not null,
  updated_at    timestamptz not null default now(),
  constraint serial_counters_key_unique unique (doc_type, state_code)
);

-- Atomic allocator. The single INSERT … ON CONFLICT … RETURNING statement
-- row-locks the conflicting row, so concurrent callers serialize into a
-- gapless sequence with no read-then-write race.
--   first call for a key  → returns p_start
--   every later call      → returns previous + 1
create or replace function allocate_serial(p_doc_type text, p_state_code text, p_start bigint default 1001)
returns bigint language plpgsql as $$
declare v_next bigint;
begin
  insert into serial_counters (doc_type, state_code, current_value, updated_at)
    values (p_doc_type, p_state_code, p_start, now())
  on conflict (doc_type, state_code)
    do update set current_value = serial_counters.current_value + 1, updated_at = now()
  returning current_value into v_next;
  return v_next;
end; $$;

-- Location → state mapping used to bucket customer/offline serials by state.
alter table locations add column if not exists state_code text;

-- Backfill one row per store (edit the ids/codes to match this install):
--   update locations set state_code = 'KA' where shopify_location_id = '<KA location id>';
--   update locations set state_code = 'MH' where shopify_location_id = '<MH location id>';
