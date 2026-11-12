'use strict';

// Savings plan — the Supabase side (tables: ./migration.sql). savings_plans holds each plan's terms and
// its outcome; the draft carries the money (its installment slots) and the tags staff see.
// savings_plan_reminders is the sent-marker, exactly as buy_plan_reminders is for buy plans.

const { supabase } = require('../../../core/supabase');

const TABLE = 'savings_plans';
const MARKERS = 'savings_plan_reminders';

const fail = (what, error) => { throw new Error(`${TABLE} ${what}: ${error.message}`); };

async function getPlanByDraft(draftId) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('draft_order_id', String(draftId)).maybeSingle();
  if (error) fail('read', error);
  return data || null;
}

async function getPlan(id) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) fail('read', error);
  return data || null;
}

async function listPlansByStatus(status) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('status', status).order('id');
  if (error) fail('list', error);
  return data || [];
}

async function listPlansForCustomer(customerId) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('customer_id', String(customerId)).order('id');
  if (error) fail('list', error);
  return data || [];
}

async function insertPlan(row) {
  const { data, error } = await supabase.from(TABLE).insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') { const e = new Error('This draft already has a savings plan'); e.status = 409; throw e; }
    fail('insert', error);
  }
  return data;
}

async function updatePlan(id, patch) {
  const { error } = await supabase.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) fail('update', error);
}

async function deletePlan(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) fail('delete', error);
}

async function wasSent(planId, installmentNo, audience, kind) {
  const { data, error } = await supabase.from(MARKERS).select('id')
    .eq('plan_id', planId).eq('installment_no', installmentNo).eq('audience', audience).eq('kind', kind).maybeSingle();
  // Cannot read the marker: say "sent". A missed reminder is recoverable, a duplicate is not.
  if (error) { console.error(`[savings-plan] marker read failed (${error.message}) — treating as sent`); return true; }
  return Boolean(data);
}

async function markSent(planId, installmentNo, audience, kind) {
  const { error } = await supabase.from(MARKERS)
    .upsert({ plan_id: planId, installment_no: installmentNo, audience, kind },
      { onConflict: 'plan_id,installment_no,audience,kind', ignoreDuplicates: true });
  if (error) console.error(`[savings-plan] marker write failed for plan ${planId} #${installmentNo} ${kind}: ${error.message}`);
}

// Messages go to the customer as they are now: take the draft's current contact onto the plan.
async function syncContact(plan, customer) {
  if (!plan || !customer) return;
  const patch = {};
  for (const [col, v] of [['customer_email', customer.email], ['customer_phone', customer.phone], ['customer_name', customer.name]]) {
    const val = String(v || '').trim();
    if (val && val !== String(plan[col] || '').trim()) patch[col] = val;
  }
  if (!Object.keys(patch).length) return;
  Object.assign(plan, patch);
  await updatePlan(plan.id, patch).catch(e => console.error(`[savings-plan] contact update for plan ${plan.id}: ${e.message}`));
}

async function getConfigValue(key) {
  const { data } = await supabase.from('config').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}

async function setConfigValue(key, value) {
  const { error } = await supabase.from('config').upsert({ key, value }, { onConflict: 'key' });
  if (error) console.error(`[savings-plan] config ${key} write failed: ${error.message}`);
}

module.exports = {
  getPlanByDraft, getPlan, listPlansByStatus, listPlansForCustomer, insertPlan, updatePlan, deletePlan,
  wasSent, markSent, syncContact, getConfigValue, setConfigValue,
};
