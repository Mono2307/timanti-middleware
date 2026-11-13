'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Reporting service — the single module that owns every report builder.
//
//   • buildSalesReport   — stitched, line-item SALES view (open/partial drafts + completed orders)
//   • buildSerialCounters — counter/summary view: minted serials per use case + current counter
//   • runRecon / toCSV   — payment reconciliation (re-exported from ./recon)
//
// The server passes a `deps` bag ({ axios, storeUrl, token, supabase, serialization }) so this
// module carries no env wiring of its own. GST/HSN/serial derivations mirror templates/tax-invoice.liquid
// so the reports tie out to the printed invoices.
// ─────────────────────────────────────────────────────────────────────────────

const { runRecon, toCSV: reconToCSV } = require('./recon');
const { readInstallments, installmentModes } = require('../payments/installments');
const { readRefunds } = require('../payments/refunds');
const S = require('../payments/buy-plan/schedule');
const SR = require('../payments/savings-plan/rules');

// ── Small helpers ────────────────────────────────────────────────────────────

const num  = (v) => (parseFloat(v) || 0);
const r2   = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN') : '');

// Bare supplier/place-of-supply state from the compound store code: "KA-HSR" → "KA".
// GST + state normalisation come from src/core/tax.js, shared with recon.js so both reports
// can never disagree on tax again. Rates: flat 3%, intra-state CGST+SGST 1.5% each.
const { gstSplit, supplierState, normState } = require('../../core/tax');

// Read a numeric line-item property from a {name/key,value} array (strips the "Rs" prefix).
function lineProp(attrs, name) {
  const p = (attrs || []).find(a => (a.name || a.key) === name);
  if (!p) return null;
  const v = parseFloat(String(p.value || '').replace(/Rs/i, '').replace(/,/g, '').trim());
  return Number.isFinite(v) ? v : null;
}

const HSN_DEFAULT = '71131914'; // matches the invoice fallback when product.custom.hsn_code is blank

// Given a line's Gross Value / Discount / Taxable props (+ fallbacks), return the money + GST block.
function lineMoney({ grossValue, discount, taxableProp, storeState, shipState }) {
  const gross   = r2(grossValue);
  const disc    = r2(discount);
  const netIncl = r2(gross - disc);                 // tax-inclusive, post-discount
  // taxable = gross/1.03 − discount. The discount is ALREADY pre-tax rupees (it is applied to the
  // diamond/making component, which is itself a pre-tax value), so it must be subtracted AFTER the
  // gross is converted, never divided along with it.
  //
  // This previously computed (gross − disc)/1.03, which divides the discount too and so overstates
  // taxable value — and the GST on it — by exactly discount × 2.91%. On a Rs10,000 discount that is
  // Rs291 of taxable value and Rs8.74 of tax that never existed. The adjustment report
  // (reporting/routes.js) has always had this right and carries a comment forbidding the divide, so
  // the two reports disagreed on the same document whenever the explicit "Taxable Value" line
  // property was absent. Max(0) mirrors the adjustment report: a discount larger than the pre-tax
  // value floors at zero rather than inventing negative tax.
  const taxable = taxableProp != null ? r2(taxableProp) : r2(Math.max(0, gross / 1.03 - disc));
  const gst     = gstSplit(taxable, storeState, shipState);
  return {
    gross_sales: gross, discount: disc, net_sales: netIncl, taxable_value: taxable,
    igst: gst.igst, sgst: gst.sgst, cgst: gst.cgst,
  };
}

// Variant options as their own columns. The orders side has the real option list
// (selectedOptions, name + value); the drafts side only has the concatenated variant_title, which
// Shopify builds by joining the values with " / " — the same split the invoice templates already do
// to derive Metal. Splitting it here keeps both sides producing the same three columns.
//
// Positional on purpose: option_1 is whatever the product's FIRST option is. That is Metal on almost
// every product here, but it is not guaranteed across the catalogue, so treat these as "the option
// values in product order", not as named fields.
const MAX_OPTION_COLS = 3;

function optionColumns(values) {
  const out = {};
  for (let i = 0; i < MAX_OPTION_COLS; i++) {
    out[`option_${i + 1}`] = (values && values[i] != null) ? String(values[i]).trim() : '';
  }
  return out;
}

// Shopify writes the literal string "Default Title" for a product with no real options. It is noise
// in a report column, so it reads as no option at all.
function optionValuesFromVariantTitle(variantTitle) {
  const t = String(variantTitle || '').trim();
  if (!t || t === 'Default Title') return [];
  return t.split(' / ').map(s => s.trim()).filter(Boolean);
}

// ── Payment + refund legs, spread rightward ──────────────────────────────────
//
// Every collection and every refund gets its own set of columns, so the report shows WHAT was taken
// and WHEN and BY WHAT TENDER — not just a total and a count. This replaces the old advance/final
// two-slot framing: there is no "advance" and "final" any more, only leg 1..4 in the order the money
// actually arrived, plus refund legs 1..2 going the other way.
//
// `type` on an installment leg is 'payment' or 'cad_advance'. A cad_advance leg IS settled money and
// counts toward amount_paid like any other (CAD_ADVANCE_TRACKING_SPEC §1) — the column exists so a
// reader can separate a design advance from a real collection without having to guess from the mode.
//
// `ref` on a refund leg is the gateway UTR: the join key back to a bank statement.
//
// Emitted on the first line of a document only, like every other document-level figure here, so
// summing a column never multiplies by the number of line items.
const MAX_INST_COLS   = 10;  // 4 legs on any document, 6 on a buy plan, 10 on a savings plan (payments/installments.js)
const MAX_REFUND_COLS = 2;

// Per-leg DATE and TYPE are deliberately not emitted. The legs still carry both (the parsers below
// read them, and both drive what the invoice prints) — they are simply not report columns. The
// document's own `day` is the date this report is keyed on, and the leg's mode already carries the
// tender.
//
// One case the mode does NOT cover: a Path A design advance puts the REAL tender in the mode and
// marks the leg cad_advance, so on those documents nothing in this report distinguishes it from an
// ordinary collection. (A Path B advance is unambiguous — its mode is literally 'CAD Advance'.)
// custom.installment_N_type still holds it if that ever needs reporting again.
function legColumns(instLegs, refundLegs) {
  const out = {};
  for (let n = 1; n <= MAX_INST_COLS; n++) {
    const leg = (instLegs || []).find(r => r.slot === n);
    out[`i${n}_value`] = leg ? r2(leg.value) : '';
    out[`i${n}_mode`]  = leg ? (leg.mode || '') : '';
  }
  for (let n = 1; n <= MAX_REFUND_COLS; n++) {
    const leg = (refundLegs || []).find(r => r.slot === n);
    out[`r${n}_value`] = leg ? r2(leg.value) : '';
    out[`r${n}_mode`]  = leg ? (leg.mode || '') : '';
    out[`r${n}_ref`]   = leg ? (leg.ref  || '') : '';
  }
  return out;
}

// Blank leg columns, for the non-first line of every document.
const BLANK_LEG_COLUMNS = legColumns([], []);

// The drafts side has no metafields to read — it works off tags. The tag writer packs each leg into
// one tag precisely so a reader with no metafield access can still reconstruct the table:
//   i{slot}:value@mode@date[@c]     @c marks a cad_advance leg
//   r{slot}:value@mode@date
// Same encoding the invoice templates parse. Values are whole rupees here (the writer rounds), so a
// draft row and the order it becomes can differ by under a rupee — see the note on SALES_COLS.
function legsFromTags(tags) {
  const inst = [];
  const refunds = [];
  for (const raw of (tags || [])) {
    const t = String(raw).trim();
    let m = /^i([1-9]\d*):(.*)$/.exec(t);
    if (m) {
      const p = m[2].split('@');
      const value = parseFloat(p[0]);
      if (Number.isFinite(value) && value > 0) {
        inst.push({ slot: +m[1], value, mode: p[1] || '', date: p[2] || '',
                    type: p[3] === 'c' ? 'cad_advance' : 'payment' });
      }
      continue;
    }
    m = /^r([1-9]\d*):(.*)$/.exec(t);
    if (m) {
      const p = m[2].split('@');
      const value = parseFloat(p[0]);
      if (Number.isFinite(value) && value > 0) {
        refunds.push({ slot: +m[1], value, mode: p[1] || '', date: p[2] || '' });
      }
    }
  }
  return { inst, refunds };
}

// ── Buy plans ────────────────────────────────────────────────────────────────
// A buy plan is an ordinary draft to Shopify — its money is the draft's installment legs, so the
// sales figures are already right. What the draft cannot say is that it IS a plan, where the plan
// stands, or what is owed next: that lives in buy_plans. Each draft/order row is joined to its plan
// (by draft id, falling back to draft name for a restored draft) and carries the same status wording
// as the tracker sheet (schedule.statusLabel), computed from the same legs.
//
// A plan that CLOSED (forfeited/cancelled) and whose draft has since been deleted would otherwise
// vanish from this report although money was taken: collectClosedPlans gives it one row per piece,
// stage 'plan-closed', with its legs and the voucher it became. It is not a sale, so no GST columns.
const PLAN_COLS = ['plan_status', 'plan_installments', 'plan_total', 'plan_paid', 'plan_balance',
  'plan_next_due', 'plan_next_amount', 'plan_closes_on', 'plan_voucher'];
const BLANK_PLAN_COLUMNS = Object.fromEntries(PLAN_COLS.map(k => [k, '']));
const NO_PLANS = { byId: {}, byName: {}, all: [], reported: new Set() };
const emptyPlans = () => ({ byId: {}, byName: {}, all: [], reported: new Set() });

const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

// Every plan, any status. Best-effort: a failed read blanks the plan columns, never the report.
async function loadBuyPlans(deps) {
  if (!deps.supabase) return emptyPlans();
  try {
    const { data, error } = await deps.supabase.from('buy_plans').select('*');
    if (error) throw new Error(error.message);
    const out = emptyPlans();
    out.all = data || [];
    for (const p of out.all) {
      out.byId[String(p.draft_order_id)] = p;
      if (p.draft_name) out.byName[p.draft_name] = p;
    }
    return out;
  } catch (e) {
    console.warn(`[sales-report] buy plans unavailable: ${e.message}`);
    return emptyPlans();
  }
}

const planFor = (plans, draftId, draftName) =>
  (draftId && plans.byId[String(draftId)]) || (draftName && plans.byName[draftName]) || null;

// The plan columns for one document. buy_plan is set on every line (so a filter on it keeps whole
// documents); the rest only on the first line, like every other document-level figure.
function planColumns(plan, legs, today, draftExists = true) {
  if (!plan) return { buy_plan: '', ...BLANK_PLAN_COLUMNS };
  const st = S.planState(plan, legs || [], today);
  const active = plan.status === 'active';
  const late = active && st.closure && (st.closure.overdueSince || st.closure.warn);
  return {
    buy_plan:          plan.mode === 'gold' ? 'Gold value lock' : 'Equal',
    plan_status:       S.statusLabel(plan, st, draftExists),
    plan_installments: st.n,
    plan_total:        st.total,
    plan_paid:         st.paid,
    plan_balance:      st.balance,
    plan_next_due:     active && st.upcoming ? st.upcoming.due : '',
    plan_next_amount:  active && st.upcoming ? st.upcoming.amount : '',
    plan_closes_on:    late ? (st.closure.closeOn || '') : '',
    plan_voucher:      plan.voucher_code ? `${plan.voucher_code} (Rs${plan.voucher_value})` : '',
  };
}

// ── Savings plans ────────────────────────────────────────────────────────────
// A savings plan is a draft whose only line is "Savings Plan" (savings-plan/rules.js). Its money counts in
// this report (HQ, 12 Nov 2026: it is never refunded, it becomes a voucher), but it is not a sale of goods:
// no GST columns, sale_kind 'savings plan'. Its standing comes from savings_plans, read best-effort.
const NO_SAVINGS = { byId: {} };
async function loadSavingsPlans(deps) {
  if (!deps.supabase) return NO_SAVINGS;
  try {
    const { data, error } = await deps.supabase.from('savings_plans').select('*');
    if (error) throw new Error(error.message);
    const out = { byId: {} };
    for (const p of data || []) if (p.status !== 'cancelled') out.byId[String(p.draft_order_id)] = p;
    return out;
  } catch (e) {
    console.warn(`[sales-report] savings plans unavailable: ${e.message}`);
    return NO_SAVINGS;
  }
}

const SAVINGS_STATUS = { completed: 'Completed (voucher issued)', terminated: 'Closed (voucher, no bonus)', redeemed: 'Voucher used up', cancelled: 'Cancelled' };
// The plan columns for a savings draft (the same PLAN_COLS a buy plan fills), plus savings_plan.
function savingsColumns(splan, legs, today) {
  if (!splan) return { savings_plan: 'Savings plan', ...BLANK_PLAN_COLUMNS };
  const st = SR.savingsState(splan, legs || [], today);
  const active = splan.status === 'active';
  const total = st.n * st.A;
  return {
    savings_plan:      `${splan.months} months x Rs${Math.round(splan.instalment)}`,
    plan_status:       active ? (st.fullyPaid ? 'Active: fully paid, voucher to issue' : st.overdueDays > 0 ? `Active: ${st.overdueDays} days late` : 'Active: on track')
                              : (SAVINGS_STATUS[splan.status] || splan.status),
    plan_installments: st.n,
    plan_total:        total,
    plan_paid:         st.paid,
    plan_balance:      Math.max(0, total - st.paid),
    plan_next_due:     active && st.next ? st.next.due : '',
    plan_next_amount:  active && st.next ? st.A : '',
    plan_closes_on:    active && st.overdueDays > 0 ? st.closeOn : '',
    plan_voucher:      splan.voucher_code && splan.voucher_code !== 'ISSUING' ? `${splan.voucher_code} (Rs${splan.voucher_value})` : '',
  };
}
const NO_GST = { gross_sales: '', discount: '', net_sales: '', taxable_value: '', igst: '', sgst: '', cgst: '' };

function collectClosedPlans({ from, to }, rows, plans) {
  const today = todayIst();
  const inWindow = (d) => (!from || d >= from) && (!to || d <= to);
  for (const plan of plans.all) {
    if (!['forfeited', 'cancelled'].includes(plan.status)) continue;
    if (plans.reported.has(plan.id)) continue;                    // its draft or order is already listed
    if (!inWindow(String(plan.start_date || '').slice(0, 10))) continue;
    const legs = S.snapshotLegs(plan, readInstallments);
    const planCols = planColumns(plan, legs, today, false);
    const paid = r2(legs.reduce((sum, l) => sum + num(l.value), 0));
    const snap = plan.snapshot || {};
    const lines = (snap.line_items || []).filter(
      li => !((li.title || '').toLowerCase().includes('discount') && parseFloat(li.price) < 0));
    (lines.length ? lines : [{}]).forEach((li, idx) => {
      rows.push({
        stage: 'plan-closed',
        sale_kind: 'buy plan',
        payment_type: `buy plan · closed (${plan.closed_reason || plan.status})`,
        buy_plan: planCols.buy_plan,
        draft_name: plan.draft_name || '',
        order_name: '',
        day: fmtDay(plan.start_date),
        customer: plan.customer_name || '',
        sales_staff: '', place_of_supply: '', shipping_state: '',
        product_title: li.title || '', category: '', variant_title: li.variant_title || '',
        ...optionColumns(optionValuesFromVariantTitle(li.variant_title)),
        sku: li.sku || '', hsn: '', qty: li.quantity || '',
        gross_sales: '', discount: '', net_sales: '', taxable_value: '', igst: '', sgst: '', cgst: '',
        custom_serial: '',
        ...(idx === 0 ? legColumns(legs, []) : BLANK_LEG_COLUMNS),
        amount_paid:     idx === 0 ? paid : '',
        amount_refunded: idx === 0 ? 0    : '',
        net_collected:   idx === 0 ? paid : '',
        amount_pending:  idx === 0 ? 0    : '',
        net_to_collect:  idx === 0 ? 0    : '',
        payment_mode:    idx === 0 ? installmentModes(legs).join(' / ') : '',
        installments:    idx === 0 ? legs.length : '',
        ...(idx === 0 ? planCols : BLANK_PLAN_COLUMNS),
        buy_plan: planCols.buy_plan,
      });
    });
  }
}

// ── Draft → order lineage ────────────────────────────────────────────────────
// Shopify completes a draft in place (PUT .../complete.json): the draft flips to
// status=completed and carries `order_id`, but NOTHING is written back onto the
// order identifying the draft it came from. So an order row can only name its
// originating draft by walking the completed drafts and indexing them by order_id.
// Keyed by the numeric order id, which is what `draft_order.order_id` holds.

async function buildOrderToDraftMap(deps) {
  const { axios, storeUrl, token } = deps;
  const map = {};
  if (!storeUrl || !token) return map;
  let pageUrl = `${storeUrl}/admin/api/2024-01/draft_orders.json?status=completed&limit=250`;
  let page = 0;
  while (pageUrl && page++ < 50) {
    let resp;
    try {
      resp = await axios.get(pageUrl, { headers: { 'X-Shopify-Access-Token': token }, timeout: 30000 });
    } catch (_) { break; }   // lineage is enrichment — never fail the whole report over it
    for (const d of (resp.data.draft_orders || [])) {
      if (d.order_id) map[String(d.order_id)] = { name: d.name || '', id: String(d.id) };
    }
    const link = resp.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = next ? next[1] : null;
  }
  return map;
}

// ── Sales report — orders side (GraphQL) ─────────────────────────────────────

async function collectOrders(deps, { from, to }, rows, draftByOrderId = {}, plans = NO_PLANS) {
  const today = todayIst();
  const { axios, storeUrl, token } = deps;
  const search = `created_at:>=${from} created_at:<=${to}`;
  let cursor = null, page = 0;
  do {
    const query = `query($q:String!,$after:String){ orders(first:50, query:$q, after:$after, sortKey:CREATED_AT){
      pageInfo{ hasNextPage endCursor }
      edges{ node{
        id name createdAt customer{ displayName }
        shippingAddress{ provinceCode province }
        totalPriceSet{ shopMoney{ amount } }
        metafields(namespace:"custom", first:250){ edges{ node{ key value } } }
        lineItems(first:50){ edges{ node{
          title variantTitle quantity sku
          originalTotalSet{ shopMoney{ amount } }
          discountedTotalSet{ shopMoney{ amount } }
          product{ productType hsn: metafield(namespace:"custom", key:"hsn_code"){ value } }
          variant{ selectedOptions{ name value } }
          customAttributes{ key value }
        } } }
      } }
    } }`;
    const { data } = await axios.post(
      `${storeUrl}/admin/api/2024-01/graphql.json`,
      { query, variables: { q: search, after: cursor } },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const conn = data && data.data && data.data.orders;
    if (!conn) throw new Error('Shopify GraphQL error' + (data && data.errors ? `: ${JSON.stringify(data.errors)}` : ''));

    for (const e of conn.edges) {
      const n = e.node;
      const mf = {};
      for (const me of n.metafields.edges) mf[me.node.key] = me.node.value;

      const storeState = mf.state_code || '';                 // place of supply (e.g. KA-HSR)
      const shipState  = n.shippingAddress?.provinceCode || '';
      // Collections come from the installment legs. amount_paid is the middleware's running sum of
      // them and stays authoritative (it also covers orders predating the migration, which have no
      // legs). cad_advance legs are INCLUDED in that sum: a design advance is money settled against
      // this order. It is not also deducted from amount_to_be_collected unless the CAD Advance line
      // item is on the document, in which case the deduction is cancelling that line's own charge.
      const legs    = readInstallments(mf);
      const paid    = num(mf.amount_paid);
      // Money returned to the customer. amount_paid deliberately stays GROSS collected (see
      // payments/refunds), so what was actually KEPT is paid − refunded — and that, not paid, is
      // what a sales figure is entitled to claim.
      const refundLegs = readRefunds(mf);
      const legCols    = legColumns(legs, refundLegs);
      const refunded = num(mf.amount_refunded);
      const netPaid  = r2(paid - refunded);
      const net     = mf.amount_to_be_collected != null ? num(mf.amount_to_be_collected)
                                                        : num(n.totalPriceSet?.shopMoney?.amount);
      const pending = Math.max(0, r2(net - netPaid));
      const isFull  = mf.is_finalized === 'true' || String(mf.payment_status || '').toLowerCase() === 'full' || (netPaid > 0 && pending < 1);
      // A document whose collections all went back is not a partial sale, whatever the gross says.
      const isRefunded = refunded > 0 && netPaid < 1;
      const stage   = isRefunded ? 'refunded' : (isFull ? 'completed-paid' : (netPaid > 0 ? 'partial' : 'unpaid'));
      const pmode   = legs.length ? installmentModes(legs).join(' / ')
                                  : [mf.payment_mode_advance, mf.payment_mode_final].filter(Boolean).join(' / ');
      // How the money arrived: one payment or several. Counted off the legs rather than inferred
      // from which of two named mode fields happened to be set.
      const legCount = legs.length || (mf.payment_mode_advance && mf.payment_mode_final ? 2 : (paid > 0 ? 1 : 0));
      const paymentType = isRefunded ? 'refunded' :
                          isFull ? (legCount > 1 ? `full: ${legCount} installments` : 'full: one-time')
                                 : (paid > 0 ? `partial${legCount > 1 ? `: ${legCount} installments` : ''}` : 'unpaid');
      // the draft this order was converted from, if it started life as one
      const orderLegacyId = String(n.id || '').split('/').pop();
      const origin = draftByOrderId[orderLegacyId] || {};
      const originDraft = origin.name || '';
      const plan = planFor(plans, origin.id, originDraft);
      const planCols = planColumns(plan, legs.filter(l => l.type !== 'cad_advance'), today);

      const lines = n.lineItems.edges.map(le => le.node);
      lines.forEach((li, idx) => {
        const attrs = li.customAttributes || [];
        const gv = lineProp(attrs, 'Gross Value');
        const money = lineMoney({
          grossValue: gv != null ? gv : num(li.originalTotalSet?.shopMoney?.amount),
          discount:   lineProp(attrs, 'Discount Applied') || 0,
          taxableProp: lineProp(attrs, 'Taxable Value'),
          storeState, shipState,
        });
        rows.push({
          stage,
          // order · buy plan (a plan's draft converted). An order is never a savings plan.
          sale_kind:     plan ? 'buy plan' : 'order',
          payment_type:  plan ? `buy plan · ${paymentType}` : paymentType,
          buy_plan:      planCols.buy_plan,
          draft_name:   originDraft,
          order_name:   n.name || '',
          day:          fmtDay(n.createdAt),
          customer:     (n.customer && n.customer.displayName) || '',
          // Who raised the sale. Staff-filled on the document; already in the metafield map.
          sales_staff:  mf.employee_name || '',
          place_of_supply: supplierState(storeState),
          shipping_state:  shipState,
          product_title:   li.title || '',
          category:        (li.product && li.product.productType) || '',
          variant_title:   li.variantTitle || '',
          // Real option list here — name and value, in product order. The drafts side has to split
          // variant_title instead, which yields the same values.
          ...optionColumns((li.variant?.selectedOptions || []).map(o => o.value)),
          sku:             li.sku || '',
          hsn:             (li.product && li.product.hsn && li.product.hsn.value) || HSN_DEFAULT,
          qty:             li.quantity || 0,
          ...money,
          custom_serial:   mf.serial_code || '',
          // Every leg, spread rightward — what was taken, when, and by what tender. Blanked off the
          // first line like every other document-level figure.
          ...(idx === 0 ? legCols : BLANK_LEG_COLUMNS),
          // order-level money on the FIRST line only, so summing a column never double-counts a doc
          amount_paid:     idx === 0 ? r2(paid) : '',
          amount_refunded: idx === 0 ? r2(refunded) : '',
          // What was actually kept. amount_paid stays gross so the two figures reconcile against the
          // ledger; this is the one to sum for a collections total.
          net_collected:   idx === 0 ? netPaid  : '',
          amount_pending:  idx === 0 ? pending  : '',
          net_to_collect:  idx === 0 ? r2(net)  : '',
          payment_mode:    idx === 0 ? pmode    : '',
          installments:    idx === 0 ? legCount : '',
          ...(idx === 0 ? planCols : BLANK_PLAN_COLUMNS),
          buy_plan:        planCols.buy_plan,
        });
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor && ++page < 50);
}

// Product type ("category") for a set of product ids, in one batched GraphQL call per 250.
//
// The drafts side needs this because the REST draft_orders list carries product_id but no product
// type, and a per-LINE lookup would be hundreds of calls on a busy month. Ids are collected across
// the whole window first and resolved in one pass, so the cost is (products / 250) calls total
// rather than one per line.
//
// Best-effort by design: it feeds one display column, so a failure blanks that column and the report
// still returns. It must never take a sales report down.
async function fetchProductTypes(deps, productIds) {
  const { axios, storeUrl, token } = deps;
  const out = {};
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;

  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250).map(id => `gid://shopify/Product/${id}`);
    try {
      const { data } = await axios.post(
        `${storeUrl}/admin/api/2024-01/graphql.json`,
        { query: `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id productType } } }`,
          variables: { ids: chunk } },
        { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 30000 });
      for (const nd of (data?.data?.nodes || [])) {
        if (nd && nd.id) out[String(nd.id).split('/').pop()] = nd.productType || '';
      }
    } catch (e) {
      console.warn(`[sales-report] product type lookup failed for ${chunk.length} products — category left blank: ${e.message}`);
    }
  }
  return out;
}

// ── Sales report — drafts side (REST: open + invoice_sent) ───────────────────
// Completed drafts are excluded by Shopify (they've become orders, picked up by collectOrders), so a
// sale appears exactly once. Draft line HSN/serial/state_code metafields aren't inline on the list
// endpoint, so HSN falls back to the default and place-of-supply approximates from shipping; the
// completed-order row carries the authoritative GST/serial figures.
//
// DATE FILTERING IS DONE CLIENT-SIDE, DELIBERATELY. The REST draft_orders endpoint does not support
// created_at_min/created_at_max — it accepts updated_at_* and since_id only — and Shopify silently
// IGNORES unsupported query params rather than erroring. Passing them looked like it worked while
// actually returning every open/invoice_sent draft ever created, so each month's report re-counted
// the same drafts (a July run carried #D115 from May and #D194 from August, and June's run carried
// the identical draft list). Filter on d.created_at here instead, and never trust the endpoint to
// have narrowed anything.

async function collectDrafts(deps, { from, to }, rows, plans = NO_PLANS, savingsPlans = NO_SAVINGS) {
  const today = todayIst();
  const { axios, storeUrl, token } = deps;
  const hdrs = { 'X-Shopify-Access-Token': token };
  const fromT = from ? new Date(from + 'T00:00:00Z').getTime() : null;
  const toT   = to   ? new Date(to   + 'T23:59:59.999Z').getTime() : null;
  const inWindow = (iso) => {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return false;
    return (fromT == null || t >= fromT) && (toT == null || t <= toT);
  };
  const seen = new Set();

  // Paging collects the qualifying drafts first, and rows are built afterwards.
  //
  // Two of the columns cannot be answered from the draft list payload alone: sales staff lives in a
  // metafield (the list endpoint carries none) and category is the product's type (the list carries
  // product_id only). Resolving either inline would mean one call per draft or per LINE, on every
  // page. Collecting first lets the product types be fetched in one batched pass for the whole
  // window, and the per-draft metafield reads to run bounded and in parallel.
  const qualifying = [];

  for (const status of ['open', 'invoice_sent']) {
    const qp = new URLSearchParams({ limit: '250', status });
    let pageUrl = `${storeUrl}/admin/api/2024-01/draft_orders.json?${qp}`;
    while (pageUrl) {
      const { data, headers } = await axios.get(pageUrl, { headers: hdrs, timeout: 30000 });
      for (const d of (data.draft_orders || [])) {
        // A converted draft is represented by its order row (collectOrders) — never both.
        // Shopify's status filter should already exclude these; this is the belt-and-braces
        // dedupe the sales report is specified to do.
        if (d.order_id) continue;
        // a draft can surface under more than one status pass
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        if (!inWindow(d.created_at)) continue;
        qualifying.push(d);
      }
      const link = headers['link'] || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = next ? next[1] : null;
    }
  }

  // Category, for every product across the window, in one batched pass.
  const productTypes = await fetchProductTypes(deps, qualifying.flatMap(
    d => (d.line_items || []).map(li => li.product_id)));

  // Sales staff, one metafield read per draft. Bounded concurrency: unbounded Promise.all over a
  // busy month would fire hundreds of requests at once and hit Shopify's rate limit, which returns
  // 429 and would blank the column for the whole batch. Best-effort per draft — a failure blanks
  // that one cell, never the report.
  const staffByDraft = {};
  const CONCURRENCY = 5;
  for (let i = 0; i < qualifying.length; i += CONCURRENCY) {
    await Promise.all(qualifying.slice(i, i + CONCURRENCY).map(async (d) => {
      try {
        const { data } = await axios.get(
          `${storeUrl}/admin/api/2024-01/draft_orders/${d.id}/metafields.json`,
          { headers: hdrs, timeout: 15000 });
        const m = (data.metafields || []).find(x => x.namespace === 'custom' && x.key === 'employee_name');
        if (m) staffByDraft[d.id] = m.value || '';
      } catch (e) {
        console.warn(`[sales-report] sales staff lookup failed for draft ${d.id}: ${e.message}`);
      }
    }));
  }

  for (const d of qualifying) {
    const tags = (d.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const tag  = (prefix) => { const t = tags.find(x => x.startsWith(prefix)); return t ? t.slice(prefix.length) : ''; };
    const deposit = tag('deposit:');
    const paid    = num((tag('paid:') || '').replace(/Rs/i, ''));
    // Money returned. The draft side reads TAGS only, which is why the tag writer emits
    // `refunded:Rs…` alongside `paid:Rs…` — there is no metafield fetch here to fall back on.
    const refunded = num((tag('refunded:') || '').replace(/Rs/i, ''));
    const netPaid  = r2(paid - refunded);
    const pending = num((tag('pending:') || '').replace(/Rs/i, ''));
    const total   = num((tag('total:') || '').replace(/Rs/i, '')) || r2(paid + pending);
    // Sales report only counts drafts with a RECORDED payment (an advance/partial or a full
    // pre-payment) — plain open/unpaid drafts are not sales yet, so skip them.
    //
    // The test is on NET paid, so a draft whose deposit was refunded in full drops out: the money
    // came back, and it is no longer a recorded partial. `deposit:refunded` is excluded for the
    // same reason — it is the tag the writer emits precisely for that case.
    if (!(netPaid > 0 || deposit === 'partial' || deposit === 'fully-paid')) continue;
    const stage   = deposit === 'fully-paid' ? 'draft-paid' : (netPaid > 0 ? 'partial' : 'open-draft');
    const paymentType = deposit === 'fully-paid' ? 'full: paid-in-advance'
                      : (refunded > 0 ? 'partial: part-refunded' : 'partial');
    // Every leg, reconstructed from the i{n}:/r{n}: tags. Same table the orders side reads off
    // metafields, and the same table the invoice prints — the tag encoding exists precisely so a
    // reader with no metafield access can rebuild it.
    const draftLegs = legsFromTags(tags);
    const legCols   = legColumns(draftLegs.inst, draftLegs.refunds);
    // Modes come off tags on the draft side (no metafield fetch here). `pmodes:` is the
    // aggregate covering every leg; the two-slot tags are the pre-migration fallback.
    const pmodesTag = tag('pmodes:');
    const pmode   = pmodesTag ? pmodesTag.split('/').filter(Boolean).join(' / ')
                              : [tag('pmode-advance:'), tag('pmode-final:')].filter(Boolean).join(' / ');
    // Now a real count. This used to be blank on purpose: the only leg signal on a draft was
    // `pmodes:`, which carries DISTINCT modes, so two cash legs looked like one and a count off
    // it would have under-reported. The i{n}: tags are per leg, so the figure is now exact and
    // matches what the converted-order row will say.
    const legCount = draftLegs.inst.length || '';
    const plan = planFor(plans, d.id, d.name);
    const planCols = planColumns(plan, draftLegs.inst.filter(l => l.type !== 'cad_advance'), today);
    if (plan) plans.reported.add(plan.id);
    // A savings plan's draft: money held for the customer, not a sale of goods (see savingsColumns).
    const isSavings = SR.isSavingsDraftTags(tags);
    const savingsCols = isSavings ? savingsColumns(savingsPlans.byId[String(d.id)] || null, draftLegs.inst, today) : null;
    const docCols = savingsCols || planCols;
    // order advance: money taken on a draft that has not become an order yet.
    const saleKind = isSavings ? 'savings plan' : plan ? 'buy plan' : 'order advance';

    const shipState  = d.shipping_address?.province_code || '';
    // Draft has no custom.state_code inline. Mirror the invoice's supplier default (KA) so the
    // intra/inter split against the shipping state stays meaningful; the completed-order row
    // carries the authoritative place-of-supply.
    const storeState = 'KA';
    const customer   = d.customer
      ? `${d.customer.first_name || ''} ${d.customer.last_name || ''}`.trim()
      : (d.billing_address?.name || '');

    const productItems = (d.line_items || []).filter(
      item => !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0)
    );
    productItems.forEach((item, idx) => {
      const attrs = item.properties || [];
      const gv = lineProp(attrs, 'Gross Value');
      const money = lineMoney({
        grossValue: gv != null ? gv : (parseFloat(item.price) * item.quantity),
        discount:   lineProp(attrs, 'Discount Applied') || 0,
        taxableProp: lineProp(attrs, 'Taxable Value'),
        storeState, shipState,
      });
      rows.push({
        stage,
        sale_kind:   saleKind,
        payment_type: isSavings ? `savings plan · ${paymentType}` : plan ? `buy plan · ${paymentType}` : paymentType,
        buy_plan:    planCols.buy_plan,
        savings_plan: savingsCols ? savingsCols.savings_plan : '',
        draft_name:  d.name || '',
        order_name:  '',
        day:         fmtDay(d.created_at),
        customer,
        sales_staff:     staffByDraft[d.id] || '',
        place_of_supply: supplierState(storeState),
        shipping_state:  shipState,
        product_title:   item.title || '',
        category:        productTypes[String(item.product_id)] || '',
        variant_title:   item.variant_title || '',
        // No selectedOptions on the REST draft payload — split the concatenated variant_title,
        // which Shopify builds by joining the same values with " / ".
        ...optionColumns(optionValuesFromVariantTitle(item.variant_title)),
        sku:             item.sku || '',
        hsn:             HSN_DEFAULT,
        qty:             item.quantity || 0,
        ...(isSavings ? NO_GST : money),
        custom_serial:   '',
        ...(idx === 0 ? legCols : BLANK_LEG_COLUMNS),
        amount_paid:     idx === 0 ? r2(paid)     : '',
        amount_refunded: idx === 0 ? r2(refunded) : '',
        net_collected:   idx === 0 ? netPaid      : '',
        amount_pending:  idx === 0 ? r2(pending)  : '',
        net_to_collect:  idx === 0 ? r2(total)    : '',
        payment_mode:    idx === 0 ? pmode        : '',
        installments:    idx === 0 ? legCount     : '',
        ...(idx === 0 ? docCols : BLANK_PLAN_COLUMNS),
        buy_plan:        planCols.buy_plan,
        savings_plan:    savingsCols ? savingsCols.savings_plan : '',
      });
    });
  }
}

const SALES_COLS = [
  'stage',
  // order · order advance (paid on a draft not yet an order) · buy plan · savings plan (HQ, 12 Nov 2026).
  'sale_kind',
  'payment_type',
  // Gold value lock / Equal on every line of a buy-plan document, blank otherwise — filter on it.
  'buy_plan',
  // "10 months x Rs2000" on every line of a savings-plan draft, blank otherwise.
  'savings_plan',
  'draft_name', 'order_name', 'day', 'customer',
  // Who raised the sale (custom.employee_name). Free on the orders side; the drafts side pays one
  // metafield read per draft, because the draft list endpoint carries no metafields at all.
  'sales_staff',
  'place_of_supply', 'shipping_state',
  // category is the Shopify product type. variant_title is the whole option string as Shopify
  // renders it; option_1..3 are those same values split out so they can be filtered and pivoted.
  // Positional, in product order — option_1 is Metal on almost every product here, but that is a
  // property of the catalogue, not a guarantee.
  'product_title', 'category', 'variant_title', 'option_1', 'option_2', 'option_3', 'sku', 'hsn', 'qty',
  'gross_sales', 'discount', 'net_sales', 'taxable_value', 'igst', 'sgst', 'cgst',
  'custom_serial',
  // ── Money movement, leg by leg, spread rightward ──
  // Replaces the old advance/final two-slot framing: there is no "advance" and "final" any more,
  // only legs in the order the money arrived. i* is money in, r* money out. r*_ref is the gateway
  // UTR, the join back to a bank statement. Blank on every line but the first of a document.
  //
  // No per-leg date or type columns: `day` is the date this report is keyed on, and the mode already
  // carries the tender. The legs still hold both — they drive what the invoice prints — they are
  // just not reported here. See legColumns for the one case the mode does not cover.
  'i1_value', 'i1_mode',
  'i2_value', 'i2_mode',
  'i3_value', 'i3_mode',
  'i4_value', 'i4_mode',
  'i5_value', 'i5_mode',   // buy plans only
  'i6_value', 'i6_mode',
  'i7_value', 'i7_mode',   // savings plans only
  'i8_value', 'i8_mode',
  'i9_value', 'i9_mode',
  'i10_value', 'i10_mode',
  'r1_value', 'r1_mode', 'r1_ref',
  'r2_value', 'r2_mode', 'r2_ref',
  // ── Totals, to the right of the legs they are computed from ──
  // amount_paid is GROSS collected (the sum of the i* legs) and amount_refunded what went back (the
  // sum of the r* legs); net_collected is the one to sum for a collections total. All three are
  // carried so a refund can be reconciled against the legs, not just netted away.
  //
  // Draft-side figures are WHOLE RUPEES — the tag writer rounds — while order-side figures are 2dp.
  // A draft row and the order it becomes can therefore differ by under a rupee.
  'amount_paid', 'amount_refunded', 'net_collected', 'amount_pending', 'net_to_collect',
  'payment_mode', 'installments',
  // ── Buy plan standing (from buy_plans; same wording as the tracker sheet) ──
  // plan_paid is the plan's own sum of the same legs, so it matches amount_paid; plan_balance is
  // against the PLAN total (the locked price, or the final reprice), which can differ from the
  // draft's pending figure until the draft is repriced.
  ...PLAN_COLS,
];

async function buildSalesReport(deps, { from, to, state, paymentStatus } = {}) {
  const rows = [];
  const draftByOrderId = await buildOrderToDraftMap(deps);
  const plans = await loadBuyPlans(deps);
  await collectOrders(deps, { from, to }, rows, draftByOrderId, plans);
  // An order converted from a plan's draft accounts for that plan, whatever its date.
  for (const o of Object.values(draftByOrderId)) { const p = planFor(plans, o.id, o.name); if (p) plans.reported.add(p.id); }
  await collectDrafts(deps, { from, to }, rows, plans, await loadSavingsPlans(deps));
  collectClosedPlans({ from, to }, rows, plans);
  let out = rows;
  if (state)         out = out.filter(r => r.place_of_supply === normState(state));
  if (paymentStatus) out = out.filter(r => r.stage === String(paymentStatus).toLowerCase());
  return out;
}

// ── Serial counter report ────────────────────────────────────────────────────
// Summary over the already-built counter system: one row per counter (doc_type × store × FY) with
// the CURRENT counter value (next = current + 1) and minted/cancelled counts from serial_ledger.
// serial_counters.state_code holds the FY-folded key for per-FY doc types ("27|KA-HSR").

// Nicer display labels; falls back to Title Case of the doc_type when unmapped.
const USE_CASE_LABELS = {
  customer_order: 'Customer Order (B2C)', customer_service: 'Service Order (paid)',
  free_service: 'Service Order (free)', b2b: 'B2B / Transfer Invoice',
  delivery_challan: 'Delivery Challan', memo_custom: 'Custom Memo', po: 'Purchase Order',
  voucher: 'Voucher', exchange_note: 'Exchange Note', credit_note: 'Credit Note', repair: 'Repair',
};
const titleCase = (s) => String(s || '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Build the printed serial prefix from a registry entry, e.g. TM{FY}-{CODE}-{SEQ} → "TM27-KAHSR-".
function codePrefix(reg, fy, storeCode) {
  if (!reg || !reg.code) return '';
  const codeTok = storeCode === 'ALL' ? '' : String(storeCode || '').replace(/-/g, '');
  return String(reg.code)
    .replace('{FY}', fy || '')
    .replace('{CODE}', codeTok)
    .replace('{STATE}', codeTok)
    .replace('{SEQ}', '')
    .replace(/-+$/, '-');
}

async function buildSerialCounters(deps, { state, docType } = {}) {
  const { supabase, serialization } = deps;
  const registry = serialization && serialization.getRegistry ? await serialization.getRegistry(deps) : {};

  const { data: counters, error } = await supabase.from('serial_counters').select('*');
  if (error) throw new Error(error.message);

  // One aggregate pass over the ledger, keyed by the same (doc_type, store_code) the counter uses.
  const { data: ledger, error: lErr } = await supabase
    .from('serial_ledger').select('doc_type, store_code, status, created_at').limit(100000);
  if (lErr) throw new Error(lErr.message);
  const agg = {};
  for (const l of (ledger || [])) {
    const k = `${l.doc_type}|${l.store_code}`;
    const g = agg[k] || (agg[k] = { minted: 0, cancelled: 0, last: '' });
    g.minted++;
    if (l.status === 'cancelled') g.cancelled++;
    if (!g.last || String(l.created_at) > g.last) g.last = String(l.created_at);
  }

  let rows = (counters || []).map(c => {
    const key = String(c.state_code || '');                    // FY-folded counter key
    const hasFy = key.includes('|');
    const fy    = hasFy ? key.split('|')[0] : '';
    const store = hasFy ? key.split('|').slice(1).join('|') : key;
    const reg   = registry[c.doc_type];
    const g     = agg[`${c.doc_type}|${key}`] || { minted: 0, cancelled: 0, last: '' };
    return {
      use_case:       USE_CASE_LABELS[c.doc_type] || titleCase(c.doc_type),
      doc_type:       c.doc_type,
      store_code:     store,
      fy:             fy,
      code_prefix:    codePrefix(reg, fy, store),
      current_value:  c.current_value,
      next_value:     Number(c.current_value) + 1,
      minted_count:   g.minted,
      cancelled_count: g.cancelled,
      last_minted_at: g.last ? fmtDay(g.last) : '',
    };
  });

  if (docType) rows = rows.filter(r => r.doc_type === String(docType).toLowerCase());
  if (state)   rows = rows.filter(r => normState(r.store_code) === normState(state) || supplierState(r.store_code) === normState(state));
  rows.sort((a, b) => (a.doc_type + a.store_code + a.fy).localeCompare(b.doc_type + b.store_code + b.fy));
  return rows;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function toCSV(rows, cols) {
  const columns = cols || (rows.length ? Object.keys(rows[0]) : []);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.join(',')]
    .concat(rows.map(r => columns.map(c => esc(r[c])).join(',')))
    .join('\r\n');
}

module.exports = {
  savingsColumns, loadSavingsPlans,
  buildSalesReport,
  buildSerialCounters,
  SALES_COLS,
  PLAN_COLS,
  planColumns,
  collectClosedPlans,
  toCSV,
  gstSplit,
  // exported for unit tests — the leg flattening and the tag reconstruction are the two places the
  // orders side and the drafts side have to agree, and nothing else would catch them drifting
  lineMoney,
  legColumns,
  legsFromTags,
  optionColumns,
  optionValuesFromVariantTitle,
  supplierState,
  // re-exported so the reporting module is the single entry point for every report
  runRecon,
  reconToCSV,
};
