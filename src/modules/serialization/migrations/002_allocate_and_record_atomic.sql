-- 002 — allocate a serial and record it in ONE transaction.
--
-- WHY
-- Today mintSerial() does two round trips: allocate_serial() bumps the counter, then a separate
-- INSERT writes the ledger row. Between those two statements a number exists that nothing owns.
-- On 2026-08-29 two invoice numbers died in exactly that gap (TM27-KAHSR-00005 and 00006) and left
-- no trace anywhere — see RCA_INVOICE_COUNTER_2026-08-29.md.
--
-- The application-side fixes already shipped (a single-flight lock, and handing the number back when
-- the insert loses its race) make that gap much harder to fall into and impossible to fall into
-- silently. This closes it instead of guarding it: after this, a number cannot exist without the row
-- that explains it, because both happen in one transaction that either commits or does not.
--
-- SAFE TO APPLY WHILE TRADING. It only ADDS a function. Nothing calls it until the application is
-- switched over, which is a separate, revertible change.
--
-- APPLY: Supabase dashboard → SQL editor → paste → Run.
-- VERIFY: select * from allocate_and_record('customer_order','27|KA-HSR',1,'TM27-KAHSR-','order',
--         'test-do-not-keep','TEST');  then delete that ledger row and roll the counter back one.

create or replace function allocate_and_record(
  p_doc_type      text,
  p_state_code    text,   -- the FY-folded counter key, e.g. '27|KA-HSR'
  p_start         int,    -- registry start value, used only when the counter does not exist yet
  p_code_prefix   text,   -- e.g. 'TM27-KAHSR-'
  p_pad           int,    -- zero-padding width for the sequence
  p_resource_type text,
  p_resource_id   text,
  p_resource_name text
)
returns table (seq int, serial_code text, was_existing boolean)
language plpgsql
as $$
declare
  v_seq  int;
  v_code text;
  v_row  record;
begin
  -- Idempotency first, inside the transaction: if this resource already holds a number, hand back
  -- the same one. A retry, a duplicate webhook or a redelivery must never draw a second number.
  select sl.seq, sl.serial_code into v_row
  from serial_ledger sl
  where sl.doc_type = p_doc_type
    and sl.resource_id = p_resource_id
    and sl.status = 'active'
  limit 1;

  if found then
    seq := v_row.seq; serial_code := v_row.serial_code; was_existing := true;
    return next;
    return;
  end if;

  -- Draw the next number. The row lock serialises concurrent callers: the second waits here rather
  -- than drawing its own, which is the entire point of this function.
  insert into serial_counters (doc_type, state_code, current_value)
  values (p_doc_type, p_state_code, p_start)
  on conflict (doc_type, state_code) do update
    set current_value = serial_counters.current_value + 1,
        updated_at    = now()
  returning current_value into v_seq;

  v_code := p_code_prefix || lpad(v_seq::text, p_pad, '0');

  -- Record it in the same transaction. If this raises, the counter bump above rolls back with it,
  -- so the number is returned to the pool rather than burned.
  insert into serial_ledger (doc_type, store_code, seq, serial_code,
                             resource_type, resource_id, resource_name, status)
  values (p_doc_type, p_state_code, v_seq, v_code,
          p_resource_type, p_resource_id, p_resource_name, 'active');

  seq := v_seq; serial_code := v_code; was_existing := false;
  return next;
end;
$$;

-- Rollback, if ever needed:
--   drop function if exists allocate_and_record(text,text,int,text,int,text,text,text);
