-- 003 — retire TM27-KAHSR-00005 and 00006, and put order #1073 back on 00007.
--
-- DECISION (2026-09-01): rather than reissue a corrected invoice to the customer, #1073 keeps the
-- number it was printed with (00007) and the two numbers lost on 29 August are formally RETIRED in
-- the register. Nothing customer-facing changes. See RCA_INVOICE_COUNTER_2026-08-29.md.
--
-- This is the better end state for GST anyway: 00005 and 00006 stop being absent and become
-- cancelled — issued, never used, and explained. An auditor reading the series sees a documented
-- retirement instead of a hole nobody can account for.
--
-- It also satisfies the drift check by design: computeSerialDrift() counts every seq from 1 to the
-- counter, cancelled rows INCLUDED, precisely because a cancelled number still owns its slot. After
-- this runs, /api/serial/drift returns 200 again.
--
-- ORDER MATTERS. #1073 is moved off seq 5 BEFORE the retired rows are inserted, so the insert cannot
-- collide with the seq it is vacating.
--
-- APPLY: Supabase dashboard → SQL editor → paste → Run.
-- THEN:  restamp Shopify from the ledger (see the note at the bottom) so the order carries 00007.

begin;

-- 1. #1073 back to the number that was printed and sent.
update serial_ledger
   set seq         = 7,
       serial_code = 'TM27-KAHSR-00007',
       status      = 'active',
       cancelled_at = null
 where doc_type    = 'customer_order'
   and resource_id = '7320736628993';

-- 2. The two numbers lost on 29 August, recorded as retired.
--    resource_id is the serial code itself — the same convention the code uses for documents with no
--    Shopify resource (resourceIdFromCode), and it keeps the (doc_type, resource_id) key unique.
--    resource_type stays null so /api/serial/restamp-from-ledger skips them: they must never be
--    written onto an order.
insert into serial_ledger
  (doc_type, store_code, seq, serial_code, resource_type, resource_id, resource_name, status, cancelled_at)
values
  ('customer_order', '27|KA-HSR', 5, 'TM27-KAHSR-00005', null, 'TM27-KAHSR-00005',
   'RETIRED — lost to a webhook race on 2026-08-29, never issued to a customer', 'cancelled', now()),
  ('customer_order', '27|KA-HSR', 6, 'TM27-KAHSR-00006', null, 'TM27-KAHSR-00006',
   'RETIRED — lost to a webhook race on 2026-08-29, never issued to a customer', 'cancelled', now());

-- 3. Counter back to 7, so the next customer order takes 8.
update serial_counters
   set current_value = 7,
       updated_at    = now()
 where doc_type   = 'customer_order'
   and state_code = '27|KA-HSR';

commit;

-- VERIFY — expect seqs 1,2,3,4 active, 5 and 6 cancelled, 7 active on #1073, counter 7.
--
-- select sl.seq, sl.serial_code, sl.status, sl.resource_name
--   from serial_ledger sl
--  where sl.doc_type = 'customer_order' and sl.store_code = '27|KA-HSR'
--  order by sl.seq;
--
-- select current_value from serial_counters
--  where doc_type = 'customer_order' and state_code = '27|KA-HSR';
--
-- THEN restamp Shopify so order #1073 carries 00007 again. This allocates nothing and advances no
-- counter — it writes the ledger's existing numbers back onto the order:
--
--   curl -H "x-admin-secret: <ADMIN_API_SECRET>" \
--     "https://timanti-middleware.fly.dev/api/serial/restamp-from-ledger?docType=customer_order&nameFrom=1073&nameTo=1073&apply=true"
--
-- FINALLY confirm the guard agrees:  GET /api/serial/drift  →  200, "every counter agrees with its ledger"
