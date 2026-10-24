'use strict';

// Buy plan — the Supabase side. buy_plans is the system of record for a plan (its locked total, its
// dates, the snapshot a deleted draft is rebuilt from); the draft carries the tags and the money.
// buy_plan_reminders is the sent-marker: a message is recorded only after it went out, and its
// unique key means a replayed sweep can never send the same one twice. Tables: ./migration.sql.

const { supabase } = require('../../../core/supabase');

const TABLE = 'buy_plans';
const MARKERS = 'buy_plan_reminders';

async function getPlanByDraft(draftId) {
  const { data, error } = await supabase.from(TABLE).select('*')
    .eq('draft_order_id', String(draftId)).maybeSingle();
  if (error) throw new Error(`buy_plans read: ${error.message}`);
  return data || null;
}

async function getPlan(id) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`buy_plans read: ${error.message}`);
  return data || null;
}

async function listActivePlans() {
  const { data, error } = await supabase.from(TABLE).select('*').eq('status', 'active').order('id');
  if (error) throw new Error(`buy_plans list: ${error.message}`);
  return data || [];
}

// The unique key on draft_order_id makes a double-click (or two staff at once) start ONE plan.
async function insertPlan(row) {
  const { data, error } = await supabase.from(TABLE).insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') { const e = new Error('This draft already has a buy plan'); e.status = 409; throw e; }
    throw new Error(`buy_plans insert: ${error.message}`);
  }
  return data;
}

async function updatePlan(id, patch) {
  const { error } = await supabase.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`buy_plans update: ${error.message}`);
}

async function deletePlan(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(`buy_plans delete: ${error.message}`);
}

async function wasSent(planId, installmentNo, audience, kind) {
  const { data, error } = await supabase.from(MARKERS).select('id')
    .eq('plan_id', planId).eq('installment_no', installmentNo).eq('audience', audience).eq('kind', kind).maybeSingle();
  // If the marker cannot be read, say "sent": a missed reminder is recoverable, a duplicate is not.
  if (error) { console.error(`[buy-plan] marker read failed (${error.message}) — treating as sent`); return true; }
  return Boolean(data);
}

async function markSent(planId, installmentNo, audience, kind) {
  const { error } = await supabase.from(MARKERS)
    .upsert({ plan_id: planId, installment_no: installmentNo, audience, kind },
      { onConflict: 'plan_id,installment_no,audience,kind', ignoreDuplicates: true });
  if (error) console.error(`[buy-plan] marker write failed for plan ${planId} #${installmentNo} ${kind}: ${error.message}`);
}

async function getConfigValue(key) {
  const { data } = await supabase.from('config').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}

async function setConfigValue(key, value) {
  const { error } = await supabase.from('config').upsert({ key, value }, { onConflict: 'key' });
  if (error) console.error(`[buy-plan] config ${key} write failed: ${error.message}`);
}

module.exports = {
  getPlanByDraft, getPlan, listActivePlans, insertPlan, updatePlan, deletePlan,
  wasSent, markSent, getConfigValue, setConfigValue,
};
