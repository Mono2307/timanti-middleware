'use strict';

/**
 * CAD advance — the four draft/order handlers.
 *
 * These hang off the Shopify webhook chain in server.js, which is why they lived there; they are
 * here instead so the whole advance lifecycle sits in one place next to the predicates it shares
 * with the serial minter and the sweeps. server.js keeps only the four step() calls.
 *
 * THE MODEL, in one line: a CAD advance is a PAYMENT, never a post-tax adjustment. It is recorded as
 * an installment leg and is deducted from the bill nowhere. The CAD Advance line item exists only to
 * give a standalone advance something to bill against, and comes off the draft the moment a real
 * product joins it — so a Rs50,000 ring is billed at Rs50,000, not Rs55,000.
 *
 * The four steps, in the order a customer moves through them:
 *   capture       money lands on an advance-only draft   → metafields + register row
 *   lineRemoval   a real product joins it (Path A)        → the CAD line comes off
 *   redeem        an older advance is referenced (Path B) → absorbed as an installment leg
 *   conversion    the draft becomes an order             → applied/redeemed, refs back-filled
 *
 * See CAD_ADVANCE_TRACKING_SPEC.md for the model and the two variants that were rejected.
 *
 * Deps (injected, mirrors the sweep and serialization bundles):
 *   { axios, storeUrl, supabase, getShopifyToken, updateDraftOrderMetafields,
 *     updateOrderMetafields, gqlSetDraftLineItems }
 *
 * gqlSetDraftLineItems is the only one that genuinely has to come from server.js — Shopify REST
 * resets line-item prices to catalog, so the GraphQL writer there is the only safe way to rewrite
 * a draft. The rest are injected for consistency with the modules either side of this one.
 */

const creditInstruments = require('./credit_instruments');
const { readInstallments, sumInstallments, installmentLegPatch } = require('../payments/installments');
const {
  CAD_ADVANCE_MODE, CAD_ADVANCE_DAYS, isCadAdvanceLine, hasCadAdvanceLine,
  hasProductLineBesidesCad, cadAdvanceLineTotal, cadLedgerKey,
} = require('./cad_advance');

function createCadAdvanceHandlers(deps) {
  const {
    axios, storeUrl, supabase, getShopifyToken,
    updateDraftOrderMetafields, updateOrderMetafields, gqlSetDraftLineItems,
  } = deps;

  // Is 'CAD Advance' actually an allowed value for an installment mode?
  //
  // A choices validation is enforced by Shopify ON WRITE. The installment_N_mode definitions were
  // created before this mode existed, and the ensure endpoint only CREATES definitions — it cannot
  // widen one that is already there without the update path added alongside this. So on any store
  // where that widening has not been run, writing the mode is REJECTED.
  //
  // That matters far more than a missing dropdown label, because updateMetafields writes field by
  // field and never throws: a rejected mode aborts the rest of the patch silently, leaving the leg
  // value written but amount_paid untouched. So we ask first, and fall back to a blank mode rather
  // than gambling the write. The leg still prints as "Design Advance" — that label comes from
  // installment_N_type, not from the mode — so the customer-facing document is unaffected.
  //
  // Cached only when TRUE: a false or errored answer is re-checked next time, so widening the enum
  // starts working without a restart. Redemptions are rare; the extra query costs nothing.
  let _modeAllowed = false;
  async function cadModeIsAllowed(token) {
    if (_modeAllowed) return true;
    const QUERY = `query {
      metafieldDefinitions(first: 1, ownerType: DRAFTORDER, namespace: "custom", key: "installment_1_mode") {
        nodes { validations { name value } }
      }
    }`;
    try {
      const { data } = await axios.post(`${storeUrl}/admin/api/2024-01/graphql.json`,
        { query: QUERY }, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 });
      const v = (data?.data?.metafieldDefinitions?.nodes?.[0]?.validations || []).find(x => x.name === 'choices');
      // No choices validation at all means the field is unconstrained — anything writes.
      if (!v?.value) { _modeAllowed = true; return true; }
      const allowed = JSON.parse(v.value) || [];
      _modeAllowed = allowed.includes(CAD_ADVANCE_MODE);
      return _modeAllowed;
    } catch (e) {
      console.warn(`[cad-advance] could not read the installment mode enum (${e.message}) — writing the leg without a mode`);
      return false;
    }
  }

  // Read back the custom metafields of a draft. Used to CONFIRM a write landed before anything
  // irreversible happens on the back of it.
  async function readDraftCustom(draftOrderId, token) {
    const { data } = await axios.get(
      `${storeUrl}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
    const out = {};
    for (const m of (data.metafields || [])) if (m.namespace === 'custom') out[m.key] = m.value;
    return out;
  }
  // CAD Advance CAPTURE (draft update): a draft carrying a CAD-Advance line + a recorded payment → stamp
  // custom.advance / advance_date (starts the 365-day clock) / advance_status='open'. The draft stays open;
  // syncAmountToCollect nets `advance` post-tax. Idempotent once advance_status is set. Never throws into
  // the webhook chain.
  //
  // The payment path has already recorded the collection as installment 1 (value + mode + date). When
  // that leg matches the advance we label its type cad_advance, which makes the invoice print it as
  // "Design Advance" while it keeps its real tender mode and date and STILL counts toward amount_paid.
  // The mode is deliberately left alone: recon matches collections by mode, so relabelling a real
  // Rs5,000 cash receipt as "CAD Advance" would orphan it in the month it was taken.
  //
  // The label only fires when the leg MATCHES the advance; a customer who paid more than the advance
  // in one go gets a generic label and a warning, never a rewritten figure.
  //
  // Also opens the register row in credit_instruments, so an advance is tracked from the moment the
  // money lands — whether or not it is ever redeemed.
  async function handleAdvanceCapture(draft) {
    try {
      if (!hasCadAdvanceLine(draft)) return;
      const draftOrderId = draft.id.toString();
      const token = await getShopifyToken();
      const { data: mfData } = await axios.get(
        `${storeUrl}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
        { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
      );
      const mfMap = {};
      for (const m of (mfData.metafields || [])) if (m.namespace === 'custom') mfMap[m.key] = m.value;
      const mf = (key) => (mfMap[key] === undefined ? null : mfMap[key]);
      if (mf('advance_status')) return;                       // already captured
      if (!(parseFloat(mf('amount_paid') || 0) > 0)) return;  // advance is money collected, not intent
      const advanceAmount = cadAdvanceLineTotal(draft);
      if (!(advanceAmount > 0)) return;
      const today = new Date().toISOString().slice(0, 10);
      const patch = { advance: advanceAmount.toFixed(2), advance_date: today, advance_status: 'open' };

      const legs  = readInstallments(mfMap);
      const first = legs.find(r => r.slot === 1);
      if (first && first.type !== 'cad_advance' && Math.abs(first.value - advanceAmount) < 0.5) {
        // LABEL ONLY. The leg keeps its value and its real tender mode, and it still counts toward
        // amount_paid — the type just makes the invoice print it as "Design Advance" instead of
        // "Amount Received". It must NOT be zeroed out of the total: that money was collected.
        patch.installment_1_type = 'cad_advance';
        console.log(`[cad-advance] installment 1 (Rs${first.value.toFixed(2)} ${first.mode || 'mode unknown'}) labelled as the design advance on draft ${draft.name || draftOrderId}`);
      } else if (first && first.type !== 'cad_advance') {
        console.warn(`[cad-advance] draft ${draft.name || draftOrderId}: installment 1 is Rs${first.value.toFixed(2)} but the CAD advance line is Rs${advanceAmount.toFixed(2)} — leaving it labelled as a plain payment. The money is still counted; only the invoice wording is generic. Check this draft by hand.`);
      } else if (!first) {
        const recorded = parseFloat(mf('amount_paid') || 0) || 0;
        if (Math.abs(recorded - advanceAmount) < 0.5) {
          // Advance recorded without a payment leg (e.g. a panel-entered amount_paid). Synthesize the
          // leg so the invoice payment table still shows it; mode is unknown by construction.
          // amount_paid is deliberately NOT written — it already equals this, and the payment sync at
          // the end of the chain re-derives it from the legs anyway.
          patch.installment_1_value = advanceAmount.toFixed(2);
          patch.installment_1_date  = today;
          patch.installment_1_type  = 'cad_advance';
        } else {
          // MORE money is recorded than the advance, with no leg behind any of it. Synthesizing a leg
          // for the advance alone would make the leg sum authoritative at the advance amount and write
          // the remainder off — the exact #D194 failure. materializeLegacyLeg on the payment-sync step
          // folds the WHOLE recorded figure into one leg instead, which loses nothing; the only cost
          // is that the row prints as a generic payment rather than "Design Advance".
          console.warn(`[cad-advance] draft ${draft.name || draftOrderId}: Rs${recorded.toFixed(2)} recorded with no installment legs but the CAD advance is Rs${advanceAmount.toFixed(2)} — not synthesizing a leg, or the difference would be written off. It will be folded whole on the payment sync.`);
        }
      }

      await updateDraftOrderMetafields(draftOrderId, patch);
      console.log(`[cad-advance] captured ${advanceAmount.toFixed(2)} on draft ${draft.name || draftOrderId} (date ${today})`);

      // Open the register row. Non-authoritative bookkeeping — the metafields remain the truth, so a
      // Supabase hiccup must never break capture. Keyed by the draft name; rekeyed to the order name
      // when the draft converts (handleAdvanceConversion).
      try {
        const expires = new Date(Date.now() + CAD_ADVANCE_DAYS * 864e5).toISOString().slice(0, 10);
        await creditInstruments.upsertIssued(supabase, {
          instrumentType:  'cad_advance',
          serialCode:      cadLedgerKey(draft.name || draftOrderId),
          value:           advanceAmount,
          customerId:      draft.customer?.id || null,
          customerName:    [draft.customer?.first_name, draft.customer?.last_name].filter(Boolean).join(' ') || null,
          sourceOrderId:   draftOrderId,        // the stale-draft sweep converts by this id
          sourceOrderName: draft.name || null,
          stateCode:       mfMap.state_code || null,
          expiresAt:       expires,
        });
        console.log(`[cad-advance] ledger row opened for ${draft.name || draftOrderId} (expires ${expires})`);
      } catch (e) {
        console.error(`[cad-advance] ledger open failed for ${draft.name || draftOrderId}: ${e.message}`);
      }
    } catch (e) {
      console.error(`[cad-advance] capture failed for draft ${draft?.id}:`, e.message);
    }
  }

  // CAD Advance LINE REMOVAL (Path A): the customer came back and bought.
  //
  // The CAD Advance line exists for one reason — a draft needs something on it to bill the ₹5,000
  // against while the advance stands alone. The moment a real product joins it, that reason is gone:
  // the customer is buying a ring, the bill is the ring, and the advance is money already paid toward
  // it. Leaving the line on would bill them 55,000 for a 50,000 ring and rely on a matching deduction
  // to cancel it out — the same number arrived at twice, printed on the invoice as a charge and a
  // credit that stare at each other.
  //
  // So the line comes off, and nothing is deducted anywhere. Total = the ring. Paid = the advance leg.
  // Balance = the difference. The advance metafields and the register row are untouched: they are the
  // record that the money was taken, and handleAdvanceConversion marks it applied at conversion.
  //
  // Only fires once the advance has actually been CAPTURED (advance_status set). Removing the line
  // before its payment is recorded would delete the charge while the money is still unaccounted for.
  async function handleAdvanceLineRemoval(draft) {
    try {
      if (!hasCadAdvanceLine(draft)) return;              // nothing to remove (or already removed)
      if (!hasProductLineBesidesCad(draft)) return;       // still a standalone advance — the line is the bill
      const draftOrderId = draft.id.toString();
      const token = await getShopifyToken();
      const { data: mfData } = await axios.get(
        `${storeUrl}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
        { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
      );
      const captured = (mfData.metafields || []).some(m => m.namespace === 'custom' && m.key === 'advance_status' && m.value);
      if (!captured) {
        console.log(`[cad-advance] draft ${draft.name || draftOrderId} has a product but the advance is not captured yet — leaving the CAD line`);
        return;
      }

      const removed   = (draft.line_items || []).filter(isCadAdvanceLine);
      const remaining = (draft.line_items || []).filter(li => !isCadAdvanceLine(li));
      if (!remaining.length) return;                      // never strip a draft down to nothing
      const value = removed.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 0), 0);

      await gqlSetDraftLineItems(draftOrderId, remaining, token);
      console.log(`[cad-advance] ${draft.name || draftOrderId}: CAD Advance line (Rs${value.toFixed(2)}) removed — the advance is a payment against the product, not a charge beside it`);

      // open → APPLIED. The advance is now committed to a purchase, but nothing is final: this is
      // still a draft, and the customer can walk away. 'applied' is the reservation — it blocks the
      // advance being spent on a second draft while this one is being built, and it is what tells
      // accounts the money is no longer an unattached trade advance.
      //
      // It becomes 'redeemed' only when this draft converts to an order (handleAdvanceConversion).
      await updateDraftOrderMetafields(draftOrderId, { advance_status: 'applied' });
      try {
        await creditInstruments.apply(supabase, {
          instrumentType: 'cad_advance', serialCode: cadLedgerKey(draft.name),
          targetDraftId: draftOrderId, value,
        });
      } catch (e) { console.error(`[cad-advance] ledger apply ${draft.name}: ${e.message}`); }
    } catch (e) {
      console.error(`[cad-advance] line removal failed for draft ${draft?.id}:`, e.message);
    }
  }

  // CAD Advance REDEEM (Path B): staff put the advance order # in intake.advance_ref on a NEW sale draft.
  // Resolve it, gate (advance_status==='open' AND ≤365 days from advance_date), then ABSORB the advance
  // as an installment leg on the new draft (mode 'CAD Advance'), mark the SOURCE order
  // advance_status='redeemed' + redeemed_against, and clear the ref. On failure, tag advance-invalid:<why>.
  // An expired advance fails the status gate on its own once the sweep has written 'expired'.
  // Transient lookup errors leave the ref in place to retry; never throws into the chain.
  async function handleAdvanceRedeem(draft) {
    try {
      const draftOrderId = draft.id.toString();
      const base = storeUrl;
      const token = await getShopifyToken();
      const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
      const { data: mfData } = await axios.get(
        `${base}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`, { headers, timeout: 10000 });
      const findMf = (ns, key) => (mfData.metafields || []).find(x => x.namespace === ns && x.key === key) || null;
      const refMf = findMf('intake', 'advance_ref');
      const ref = refMf ? String(refMf.value || '').trim() : '';
      if (!ref) return;

      const delRef = async () => {
        try { await axios.delete(`${base}/admin/api/2024-01/metafields/${refMf.id}.json`, { headers, timeout: 10000 }); }
        catch (e) { console.error(`[cad-advance] clear ref: ${e.message}`); }
      };
      const failTag = async (reason) => {
        const tags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean).concat([`advance-invalid: ${reason}`]);
        await axios.put(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
          { draft_order: { id: draftOrderId, tags: [...new Set(tags)].join(', ') } }, { headers, timeout: 10000 });
        console.warn(`[cad-advance] ${draft.name || draftOrderId}: ${reason}`);
      };

      // Idempotent: this draft has already absorbed an advance → just clear the ref. The adv-num tag
      // is the marker. Not custom.advance: a Path A draft carries that as its OWN tracking value, and
      // treating it as "already absorbed" would refuse a customer who has one advance on this draft
      // and an older one to redeem. Not a cad_advance leg either, for the same reason.
      const alreadyTagged = (draft.tags || '').split(',').some(t => /^adv-num:/i.test(t.trim()));
      if (alreadyTagged) { await delRef(); return; }

      // Resolve the advance ORDER by name ("#1042" or "1042"). Transient failure → keep ref, retry later.
      const name = ref.startsWith('#') ? ref : '#' + ref;
      let advOrder = null, lookupFailed = false;
      try {
        const { data } = await axios.get(
          `${base}/admin/api/2024-01/orders.json?status=any&name=${encodeURIComponent(name)}`, { headers, timeout: 15000 });
        advOrder = (data.orders || []).find(o => o.name === name) || (data.orders || [])[0] || null;
      } catch (e) { lookupFailed = true; console.error(`[cad-advance] resolve ${ref}: ${e.message}`); }
      if (lookupFailed) return;
      if (!advOrder) { await failTag(`not found ${ref}`); await delRef(); return; }

      const { data: aMfData } = await axios.get(
        `${base}/admin/api/2024-01/orders/${advOrder.id}/metafields.json`, { headers, timeout: 10000 });
      const a = {}; for (const m of (aMfData.metafields || [])) if (m.namespace === 'custom') a[m.key] = m.value;
      const advVal = parseFloat(a.advance || 0);
      if (!(advVal > 0))               { await failTag(`no advance on ${ref}`); await delRef(); return; }
      if (a.advance_status !== 'open') { await failTag(`already ${a.advance_status || 'used'}`); await delRef(); return; }
      // Belt and braces alongside the status gate above: the sweep writes 'expired' once a day, so an
      // advance that lapsed overnight is refused here before the sweep has caught up with it.
      const days = a.advance_date ? (Date.now() - new Date(a.advance_date).getTime()) / 864e5 : 1e9;
      if (days > CAD_ADVANCE_DAYS)     { await failTag(`expired ${a.advance_date}`); await delRef(); return; }

      // PASS — absorb the advance as its own installment leg on the new sale.
      //
      // NOT as custom.advance: this document has no CAD Advance line, so nothing here is a charge for
      // the advance to cancel. Writing custom.advance would net it post-tax AND leave the customer's
      // earlier Rs5,000 uncounted, which is the same money deducted twice. As a leg it is what it
      // actually is — settlement already received, against a bill that stands at full value.
      //
      // Mode is 'CAD Advance' rather than a tender: no money moves on this document today, and
      // claiming "cash" here would put a phantom Rs5,000 into this month's cash reconciliation.
      const newMfMap = {};
      for (const m of (mfData.metafields || [])) if (m.namespace === 'custom') newMfMap[m.key] = m.value;
      const newLegs = readInstallments(newMfMap);
      const today   = new Date().toISOString().slice(0, 10);
      const legMode = (await cadModeIsAllowed(token)) ? CAD_ADVANCE_MODE : '';
      if (!legMode) {
        console.warn(`[cad-advance] "${CAD_ADVANCE_MODE}" is not in the installment mode enum — absorbing the leg without a mode. Run /api/metafield-definitions/ensure?apply=true to widen it.`);
      }
      const legPatch = installmentLegPatch(newLegs, {
        value: advVal, mode: legMode, date: today, type: 'cad_advance',
      });
      // amount_paid must move in the SAME write, or the balance is briefly wrong on the invoice.
      const expectedPaid = sumInstallments(newLegs) + advVal;
      legPatch.amount_paid = expectedPaid.toFixed(2);
      await updateDraftOrderMetafields(draftOrderId, legPatch);

      // CONFIRM before consuming. updateDraftOrderMetafields writes field by field and never throws,
      // so any single rejected value silently abandons the rest of the patch — the leg value lands
      // while amount_paid does not. Everything below this point is irreversible from the customer's
      // side: the source advance goes 'redeemed' and the ref is cleared. Marking an advance spent
      // while this bill still asks for the full amount would take the money twice.
      //
      // On failure we stop, leaving the ref in place so the next draft edit retries, and tag the
      // draft so staff can see why nothing happened.
      const after = await readDraftCustom(draftOrderId, token);
      if (Math.abs((parseFloat(after.amount_paid) || 0) - expectedPaid) >= 0.5) {
        await failTag('advance not absorbed — payment write rejected');
        console.error(`[cad-advance] ${draft.name || draftOrderId}: expected amount_paid ${expectedPaid.toFixed(2)} after absorbing ${ref}, found ${after.amount_paid}. Source advance left UNTOUCHED and the ref kept for retry.`);
        return;
      }

      // Source order: open → APPLIED, not redeemed. The advance is reserved against this draft — it
      // cannot be referenced on a second draft while this one is being built (the gate above accepts
      // 'open' only) — but nothing is final yet. If this sale never converts, the advance was never
      // actually spent, and it must not be sitting there marked used up.
      //
      // It becomes 'redeemed' when this draft converts (handleAdvanceConversion), which is also when
      // the real order number is known and redeemed_against stops pointing at a draft.
      await updateOrderMetafields(String(advOrder.id), { advance_status: 'applied', redeemed_against: draft.name || draftOrderId }, token);

      // adv-num tag mirrors vch-num/exc-num: it is what the conversion handler reads to back-fill the
      // real order number on both sides.
      try {
        const tags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean).concat([`adv-num:${advOrder.name || ref}`]);
        await axios.put(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
          { draft_order: { id: draftOrderId, tags: [...new Set(tags)].join(', ') } }, { headers, timeout: 10000 });
      } catch (e) { console.error(`[cad-advance] adv-num tag: ${e.message}`); }

      try {
        await creditInstruments.apply(supabase, {
          instrumentType: 'cad_advance', serialCode: cadLedgerKey(advOrder.name || ref),
          targetDraftId: draftOrderId, value: advVal,
        });
      } catch (e) { console.error(`[cad-advance] ledger apply ${ref}: ${e.message}`); }

      await delRef();
      console.log(`[cad-advance] absorbed ${advVal.toFixed(2)} from ${ref} → ${draft.name || draftOrderId} as an installment leg`);
    } catch (e) {
      console.error(`[cad-advance] redeem failed for draft ${draft?.id}:`, e.message);
    }
  }

  // CAD Advance at CONVERSION — the step that finally closes the loop on an advance.
  //
  // Three things happen here, none of which any earlier handler can do, because until the draft
  // becomes an order there is no order number to record:
  //
  //  1. Path B back-fill. A sale that absorbed someone's advance carries an adv-num:#1042 tag. Both
  //     the source order's redeemed_against and the ledger row point at a DRAFT name until now; a
  //     draft number is useless to accounts once it no longer exists, so both get the real order.
  //  2. Path A settlement. An advance captured on THIS draft, converting alongside a real product,
  //     is now genuinely spent — applied → redeemed. (The line-removal step moved it open → applied
  //     earlier, when the product was added and the sale was still only a draft.)
  //  3. Rekey. The register row was opened under the draft name (all that existed when the money
  //     landed) and moves to the order name, which is what staff reference and reports print.
  //
  // A CAD-advance-only draft converting (the 30-day sweep, or staff punching it) is NOT consumption:
  // it stays 'open' and keeps its 365-day clock. That is the whole point of Path B.
  //
  // Never throws into the conversion path — an advance bookkeeping failure must not break a sale.
  async function handleAdvanceConversion(draft, orderId, orderName, token) {
    const draftOrderId = draft.id.toString();
    const base    = storeUrl;
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const target  = orderName || String(orderId);

    // 1 ── Path B: this sale consumed an advance taken on an earlier order.
    const advTag = (draft.tags || '').split(',').map(t => t.trim()).find(t => /^adv-num:/i.test(t));
    if (advTag) {
      const srcName = advTag.slice(advTag.indexOf(':') + 1).trim();
      try {
        const { data } = await axios.get(
          `${base}/admin/api/2024-01/orders.json?status=any&name=${encodeURIComponent(srcName)}`,
          { headers, timeout: 15000 });
        const src = (data.orders || []).find(o => o.name === srcName) || (data.orders || [])[0] || null;
        if (src) {
          // applied → REDEEMED. The draft that reserved this advance has become a real order, so
          // the advance is now genuinely spent, and redeemed_against stops pointing at a draft
          // number that no longer means anything to accounts.
          await updateOrderMetafields(String(src.id), { advance_status: 'redeemed', redeemed_against: target }, token);
          console.log(`[cad-advance] ${srcName} applied → redeemed against ${target}`);
        } else {
          console.warn(`[cad-advance] conversion: source order ${srcName} not found — redeemed_against left at the draft name`);
        }
      } catch (e) { console.error(`[cad-advance] conversion back-fill ${srcName}: ${e.message}`); }
      try {
        await creditInstruments.redeem(supabase, {
          instrumentType: 'cad_advance', serialCode: cadLedgerKey(srcName),
          targetDraftId: draftOrderId, targetOrderId: orderId, targetOrderName: target,
        });
      } catch (e) { console.error(`[cad-advance] conversion ledger ${srcName}: ${e.message}`); }
    }

    // 2/3 ── this document's OWN advance. Metafields were copied to the order a moment ago.
    let own = {};
    try {
      const { data } = await axios.get(
        `${base}/admin/api/2024-01/orders/${orderId}/metafields.json`, { headers, timeout: 10000 });
      for (const m of (data.metafields || [])) if (m.namespace === 'custom') own[m.key] = m.value;
    } catch (e) { console.error(`[cad-advance] conversion read ${orderId}: ${e.message}`); return; }
    if (!own.advance_status) return;   // no advance on this document

    try {
      await creditInstruments.rekey(supabase, {
        instrumentType: 'cad_advance',
        fromSerialCode: cadLedgerKey(draft.name),
        toSerialCode:   cadLedgerKey(target),
        patch: { source_order_id: String(orderId), source_order_name: target },
      });
    } catch (e) { console.error(`[cad-advance] conversion rekey ${draft.name}: ${e.message}`); }

    if (own.advance_status === 'redeemed' || own.advance_status === 'expired') return;   // already final

    // An advance-only order — nothing was bought, so nothing was spent. It stays 'open' and keeps
    // running on its original 365-day clock, which is the whole point of Path B.
    if (!hasProductLineBesidesCad(draft)) {
      console.log(`[cad-advance] ${target} is an advance-only order — status stays open, expires on the original clock`);
      return;
    }

    // A product was bought on the same document the advance sits on. The line removal step already
    // moved it open → applied when the product went on; this is the moment it becomes final.
    // ('open' here means the line removal never ran — a draft built in one go, say — so this also
    // covers that: either way, the sale happened and the advance is spent.)
    try {
      await updateOrderMetafields(String(orderId), { advance_status: 'redeemed', redeemed_against: target }, token);
      await creditInstruments.redeem(supabase, {
        instrumentType: 'cad_advance', serialCode: cadLedgerKey(target),
        targetDraftId: draftOrderId, targetOrderId: orderId, targetOrderName: target,
        value: parseFloat(own.advance || 0) || null,
      });
      console.log(`[cad-advance] ${target}: advance ${own.advance} spent on this sale → redeemed`);
    } catch (e) { console.error(`[cad-advance] conversion redeem ${target}: ${e.message}`); }
  }

  return { handleAdvanceCapture, handleAdvanceLineRemoval, handleAdvanceRedeem, handleAdvanceConversion };
}

module.exports = { createCadAdvanceHandlers };
