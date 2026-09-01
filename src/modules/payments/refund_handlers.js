'use strict';

/**
 * Draft-order refunds — recording money OUT, the mirror of the money-in pipeline.
 *
 * WHY THIS EXISTS
 * A refund against an ORDER is a first-class Shopify object: staff mark it, Shopify emails the
 * customer, and the hourly Apps Script pull lands it in the After-Sales Log. A DRAFT has no refund
 * object at all. So when a deposit on a draft goes back — the sale fell through, or the order value
 * contracted — the money left the bank and nothing in this stack knew: the draft still advertised
 * "deposit:partial, paid:Rs50000", the deposit row still claimed the money, the sales report still
 * counted it as a recorded partial, and the customer heard nothing.
 *
 * SCOPE: RECORD ONLY. Nothing here moves money. The bank transfer is made by hand at the gateway,
 * exactly as before; this records what already happened.
 *
 * ENTRY POINTS
 *   handleRefundSync(draft)          `sync-refund` tag, from the draft-updated webhook chain
 *   handleRefundEmailTag(draft)      `send-refund-email` tag, from the panel's button
 *   handleDraftDeletedRefunds(id)    draft_orders/delete, from the PO webhook
 *
 * The first two are deliberately SEPARATE. A refund that exists only because the order value
 * contracted, where the customer immediately pays a new balance, does not warrant a "your refund is
 * on its way" email. So recording never notifies on its own — staff press the button when the
 * customer should actually hear about it.
 *
 * EXIT POINTS
 *   credit_instruments (instrument_type 'refund')   the joinable system of record
 *   store_deposits.amount_refunded                  the draft's own deposit row
 *   custom.amount_refunded                          the document
 *   integrations/email                              the customer notification
 *
 * THE ARITHMETIC RULE
 * custom.amount_paid stays GROSS collected and is NEVER written down. See refunds.js for why:
 * reconcileDepositPaid takes the higher of the deposit row and the leg sum precisely so a payment
 * figure cannot shrink, and a refund that fought that guard would lose. The balance is derived.
 */

const { readRefunds, sumRefunds, refundLedgerKey, paymentState } = require('./refunds');

const REFUND_INSTRUMENT = 'refund';

function createRefundHandlers(deps) {
  const {
    axios, storeUrl, supabase, getShopifyToken,
    updateDraftOrderMetafields, updateOrderMetafields,
    removeTagFromDraft, removeTagFromOrder,
    sendEmail, buildDraftRefundHtml, withStoreCc,
    getCollectionBase, paidEpsilon = 1,
  } = deps;

  const hasTag = (doc, tag) => (doc?.tags || '').split(',')
    .some(t => t.trim().toLowerCase() === tag);

  // A refund can be recorded on a DRAFT (the deposit went back before the sale completed) or on an
  // ORDER (the sale completed and money went back afterwards). The pipeline is identical — read the
  // custom metafields, write the ledger, stamp amount_refunded, consume the tag — only the Shopify
  // resource differs. This resolves that once so neither path can drift from the other.
  //
  // Wiring only the draft half, as this first shipped, was worse than either: applyPaymentTagsToOrder
  // already READS refund_N_* off an order and derives the balance and tags from them, so staff typing
  // a refund onto a converted order got correct tags and a correct balance while both reports read
  // zero, because nothing ever wrote amount_refunded or a ledger row.
  const RESOURCES = {
    draft_orders: {
      path: 'draft_orders',
      docKey: 'draft_order',
      writeMetafields: updateDraftOrderMetafields,
      removeTag: removeTagFromDraft,
      label: 'draft',
    },
    orders: {
      path: 'orders',
      docKey: 'order',
      writeMetafields: updateOrderMetafields,
      removeTag: removeTagFromOrder,
      label: 'order',
    },
  };

  async function readCustom(res, id, token) {
    const { data } = await axios.get(
      `${storeUrl}/admin/api/2024-01/${res.path}/${id}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
    const out = {};
    for (const m of (data.metafields || [])) if (m.namespace === 'custom') out[m.key] = m.value;
    return out;
  }

  // ── Recording ──────────────────────────────────────────────────────────────
  //
  // Fires on `sync-refund`, which the admin panel adds whenever a refund field changes (a metafield
  // save alone never fires the resource webhook, so the panel has to nudge us).
  //
  // Idempotency is the EXISTING unique constraint on credit_instruments (instrument_type,
  // serial_code). The draft webhook fires repeatedly and every tag PUT fires it again, so this must
  // be safe to replay. Upserting under the key '#D189-R1' with ignoreDuplicates means a replayed
  // pass writes nothing — and tells us so, since an empty returned set IS the "already recorded"
  // signal. No bespoke dedup column is needed.
  async function handleRefundSync(doc, resourceKey = 'draft_orders') {
    const res = RESOURCES[resourceKey];
    const docId = doc?.id?.toString();
    if (!res || !docId) return;
    if (!hasTag(doc, 'sync-refund')) return;
    const isOrder = resourceKey === 'orders';

    try {
      const token = await getShopifyToken();
      const mf    = await readCustom(res, docId, token);
      const legs  = readRefunds(mf);

      // Tag present but no legs: staff added it by hand, or blanked the fields again. Consume it, or
      // it sits on the document re-triggering this on every future edit.
      if (!legs.length) {
        console.log(`[refunds] ${res.label} ${docId}: sync-refund with no refund legs — nothing to record`);
        await res.removeTag(docId, 'sync-refund');
        return;
      }

      const docName      = doc.name || `#${docId}`;
      const customer     = doc.customer || {};
      const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ')
        || doc.billing_address?.name || '';
      const totalRefunded = sumRefunds(legs);

      for (const leg of legs) {
        // Keyed on the DOCUMENT's own name either way. A refund raised on a draft that later converts
        // is rekeyed to the order name by handleRefundConversion — so when this runs again on the
        // order it computes the same key, the upsert no-ops, and there is no second row.
        const serialCode = refundLedgerKey(docName, leg.slot);
        // The row carries a FULL snapshot — name, customer, value, store — because it has to outlive
        // the document. A fully refunded draft is usually deleted, and the refund is still true once
        // the draft is gone, so nothing may need to read back through the draft id to describe it.
        const stamp = leg.date
          ? new Date(`${leg.date}T00:00:00Z`).toISOString()
          : new Date().toISOString();
        const row = {
          instrument_type:   REFUND_INSTRUMENT,
          serial_code:       serialCode,
          value:             leg.value,
          customer_id:       customer.id != null ? String(customer.id) : null,
          customer_name:     customerName || null,
          source_order_id:   docId,
          source_order_name: docName,
          // On an order both target fields are set, which is what keeps it OFF the adjustment
          // report's "refund on a draft that never converted" append — that block skips any row
          // carrying a target_order_name, because the order's own row already shows it.
          ...(isOrder
            ? { target_order_id: docId, target_order_name: docName }
            : { target_draft_id: docId }),
          state_code:        mf.state_code || null,
          status:            'refunded',
          refund_mode:       leg.mode || null,
          gateway_ref:       leg.ref || null,
          // issued_at is what fetchAll windows on, so a date-filtered report finds the refund in the
          // month the money actually moved — not the month someone got round to keying it in.
          issued_at:         stamp,
          refunded_at:       stamp,
          updated_at:        new Date().toISOString(),
        };
        try {
          const { data, error } = await supabase.from('credit_instruments')
            .upsert(row, { onConflict: 'instrument_type,serial_code', ignoreDuplicates: true })
            .select('id');
          if (error) throw new Error(error.message);
          if (data && data.length) {
            console.log(`[refunds] ledger row ${serialCode} — Rs${leg.value} (${leg.mode || 'no mode'})`);
          }
        } catch (e) {
          // Bookkeeping must never break the Shopify-facing flow — the rule every other writer
          // against this table follows.
          console.error(`[refunds] ledger write ${serialCode} failed: ${e.message}`);
        }
      }

      // The document's own derived total. Change-guarded: a metafield write does not fire the
      // resource webhook, but a no-op write is still a wasted call on every unrelated edit.
      const recorded = parseFloat(mf.amount_refunded);
      if (!Number.isFinite(recorded) || Math.abs(recorded - totalRefunded) >= 0.5) {
        await res.writeMetafields(docId, { amount_refunded: totalRefunded.toFixed(2) });
      }

      // store_deposits is keyed on draft_order_id and only ever exists for a draft — an order that
      // converted keeps the row under its ORIGINATING draft id, which this document is not. Skipping
      // on the order path is correct, not an omission: the metafields stay authoritative either way.
      if (!isOrder) await syncDepositRow(docId, mf, totalRefunded);
      await res.removeTag(docId, 'sync-refund');
      console.log(`[refunds] ${res.label} ${docId}: ${legs.length} refund leg(s), Rs${totalRefunded.toFixed(2)} recorded`);
    } catch (err) {
      console.error(`[refunds] handleRefundSync ${res.label} ${docId} failed: ${err.message}`);
    }
  }

  // Keep store_deposits consistent with the document. Advisory — the metafields stay authoritative
  // (see the divergence warning in reconcileDepositPaid) — but the deposit row is what the payment
  // paths read FIRST, so leaving it stale would have the next payment compute its balance against a
  // refund that, as far as that row is concerned, never happened.
  async function syncDepositRow(draftOrderId, mf, totalRefunded) {
    try {
      const { data: deposit } = await supabase
        .from('store_deposits').select('*')
        .eq('draft_order_id', draftOrderId).maybeSingle();
      // No deposit row: the payment was recorded through the panel, which writes metafields only.
      // The document still carries the refund, so there is nothing to reconcile here.
      if (!deposit) return;

      const collectionBase = getCollectionBase
        ? await getCollectionBase(draftOrderId, deposit.total_amount)
        : (parseFloat(mf.amount_to_be_collected) || parseFloat(deposit.total_amount) || 0);
      const st = paymentState({
        amountPaid:     parseFloat(deposit.amount_paid) || 0,
        amountRefunded: totalRefunded,
        collectionBase,
        epsilon:        paidEpsilon,
      });

      await supabase.from('store_deposits').update({
        amount_refunded: totalRefunded,
        amount_pending:  Math.max(0, st.amountPending),
        // 'unpaid' is the state refunds introduce: gross amount_paid is still positive while nothing
        // is net settled. Without it a fully refunded draft stays 'partial' forever.
        payment_status:  st.isUnpaid ? 'unpaid' : (st.isFull ? 'paid' : 'partial'),
        updated_at:      new Date().toISOString(),
      }).eq('id', deposit.id);
    } catch (e) {
      console.error(`[refunds] deposit row sync for draft ${draftOrderId} failed: ${e.message}`);
    }
  }

  // ── Notifying ──────────────────────────────────────────────────────────────
  //
  // Fires on `send-refund-email`, which the panel's button adds. Never fires on its own.
  //
  // The guard is email_sent_at on the ledger row, so a second press sends nothing — and a refund
  // announced weeks ago cannot be re-announced by someone pressing the button for a NEW refund on
  // the same draft. Only rows that have never been emailed are picked up.
  async function handleRefundEmailTag(document, resourceKey = 'draft_orders') {
    const res = RESOURCES[resourceKey];
    const docId = document?.id?.toString();
    if (!res || !docId) return;
    if (!hasTag(document, 'send-refund-email')) return;
    const isOrder = resourceKey === 'orders';

    try {
      // Match on whichever side of the ledger row points at THIS document. A refund raised on a draft
      // that later converted was rekeyed and now carries target_order_id, so an order press finds it.
      const q = supabase.from('credit_instruments')
        .select('*')
        .eq('instrument_type', REFUND_INSTRUMENT)
        .is('email_sent_at', null)
        .order('issued_at', { ascending: true });
      const { data: rows, error } = await (isOrder
        ? q.eq('target_order_id', docId)
        : q.eq('target_draft_id', docId));
      if (error) throw new Error(error.message);

      if (!rows || !rows.length) {
        console.log(`[refunds] ${res.label} ${docId}: nothing unsent — button press ignored`);
        await res.removeTag(docId, 'send-refund-email');
        return;
      }

      const token = await getShopifyToken();
      const { data: docData } = await axios.get(
        `${storeUrl}/admin/api/2024-01/${res.path}/${docId}.json`,
        { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
      const doc = docData[res.docKey];

      // No address to send to is not an error — the rule sendDepositEmail already follows. But do
      // NOT stamp email_sent_at: the customer never heard, so a later press must still be able to
      // tell them once an address exists.
      if (!doc || !doc.email) {
        console.log(`[refunds] ${res.label} ${docId} has no email — skipping refund notification`);
        await res.removeTag(docId, 'send-refund-email');
        return;
      }

      const mf = await readCustom(res, docId, token);
      const amountPaid     = parseFloat(mf.amount_paid) || 0;
      const amountRefunded = parseFloat(mf.amount_refunded) || sumRefunds(readRefunds(mf));
      const collectionBase = parseFloat(mf.amount_to_be_collected) || parseFloat(doc.total_price) || parseFloat(doc.current_total_price) || 0;
      const st = paymentState({ amountPaid, amountRefunded, collectionBase, epsilon: paidEpsilon });

      const refundAmount = rows.reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
      const modes = [...new Set(rows.map(r => r.refund_mode).filter(Boolean))];

      const html = buildDraftRefundHtml({
        draftRef:      doc.name || `#${docId}`,
        customerName:  doc.billing_address?.first_name || doc.customer?.first_name || 'there',
        refundAmount,
        refundMode:    modes.join(' / '),
        amountPaid,
        amountRefunded,
        amountPending: Math.max(0, st.amountPending),
        isFullRefund:  st.isUnpaid,
      });

      await sendEmail({
        to:      doc.email,
        subject: `Your Timanti order ${doc.name || ''} — refund of Rs.${Math.round(refundAmount)}`.replace(/\s+/g, ' '),
        html,
        cc:      withStoreCc ? withStoreCc() : undefined,
      });

      const now = new Date().toISOString();
      await supabase.from('credit_instruments')
        .update({ email_sent_at: now, updated_at: now })
        .in('id', rows.map(r => r.id));

      await res.removeTag(docId, 'send-refund-email');
      console.log(`[refunds] ${res.label} ${docId}: refund email sent for ${rows.length} leg(s), Rs${refundAmount.toFixed(2)}`);
    } catch (err) {
      // Leave the tag in place: the press has not been honoured, and the next webhook retries it.
      console.error(`[refunds] handleRefundEmailTag ${res.label} ${docId} failed: ${err.message}`);
    }
  }

  // Draft converted to an order — the contraction case, where money went back and the customer then
  // settled a new balance.
  //
  // The refund rows opened under the DRAFT name, because that was the only identifier that existed
  // when the transfer was made. Rekey them onto the ORDER name, exactly as a CAD advance is rekeyed
  // (see cadLedgerKey): the order name is what staff quote afterwards and what every report prints.
  // Without this the refund is invisible in the adjustment report, which is order-keyed — the draft
  // name it was filed under matches nothing there.
  async function handleRefundConversion(draft, orderId, orderName) {
    const draftOrderId = draft?.id?.toString();
    if (!draftOrderId || !orderName) return;
    try {
      const { data: rows, error } = await supabase.from('credit_instruments')
        .select('id,serial_code')
        .eq('instrument_type', REFUND_INSTRUMENT)
        .eq('target_draft_id', draftOrderId);
      if (error) throw new Error(error.message);
      if (!rows || !rows.length) return;

      for (const row of rows) {
        // Slot suffix survives the move: '#D189-R1' → '#1042-R1'.
        const slot = String(row.serial_code).split('-R').pop();
        const next = `${orderName}-R${slot}`;
        if (next === row.serial_code) continue;
        // No-op when the destination key already exists, so a replayed conversion webhook cannot
        // collide on the unique (instrument_type, serial_code).
        const { data: clash } = await supabase.from('credit_instruments')
          .select('id').eq('instrument_type', REFUND_INSTRUMENT).eq('serial_code', next).maybeSingle();
        if (clash) continue;
        await supabase.from('credit_instruments').update({
          serial_code:       next,
          source_order_name: orderName,   // the adjustment report indexes on this
          target_order_id:   String(orderId),
          target_order_name: orderName,
          updated_at:        new Date().toISOString(),
        }).eq('id', row.id);
        console.log(`[refunds] rekeyed ${row.serial_code} → ${next} on conversion`);
      }
    } catch (e) {
      console.error(`[refunds] conversion rekey for draft ${draftOrderId} failed: ${e.message}`);
    }
  }

  // Draft deleted after a full refund — the usual end of a sale that fell through.
  //
  // The ledger row must SURVIVE. revertApplied only matches status='applied', so it already cannot
  // touch a refund row; this exists to record that the DOCUMENT is gone, so a report joining on
  // target_draft_id can later tell "draft outside this window" from "draft no longer exists".
  // The refund itself stays true — only the thing it pointed at has been removed.
  async function handleDraftDeletedRefunds(draftOrderId) {
    try {
      const { data, error } = await supabase.from('credit_instruments')
        .update({ voided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('instrument_type', REFUND_INSTRUMENT)
        .eq('target_draft_id', String(draftOrderId))
        .is('voided_at', null)
        .select('serial_code');
      if (error) throw new Error(error.message);
      if (data && data.length) {
        console.log(`[refunds] draft ${draftOrderId} deleted — ${data.length} refund row(s) kept, document marked gone: ${data.map(r => r.serial_code).join(', ')}`);
      }
    } catch (e) {
      console.error(`[refunds] draft-deleted bookkeeping for ${draftOrderId} failed: ${e.message}`);
    }
  }

  return { handleRefundSync, handleRefundEmailTag, handleRefundConversion, handleDraftDeletedRefunds };
}

module.exports = { createRefundHandlers, REFUND_INSTRUMENT };
