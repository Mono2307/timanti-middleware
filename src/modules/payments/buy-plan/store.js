'use strict';

// Buy plan — the Supabase side. buy_plans is the system of record for a plan (its locked total, its
// dates, the snapshot a deleted draft is rebuilt from); the draft carries the tags and the money.
// Tables: ./migration.sql.

const { supabase } = require('../../../core/supabase');

const TABLE = 'buy_plans';

async function getPlanByDraft(draftId) {
  const { data, error } = await supabase.from(TABLE).select('*')
    .eq('draft_order_id', String(draftId)).maybeSingle();
  if (error) throw new Error(`buy_plans read: ${error.message}`);
  return data || null;
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

async function deletePlan(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(`buy_plans delete: ${error.message}`);
}

module.exports = { getPlanByDraft, insertPlan, deletePlan };
