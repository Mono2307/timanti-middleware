'use strict';

/**
 * CAD advance sweeps — the unattended half of the advance lifecycle.
 *
 * Capture and redemption are driven by staff actions on a draft. Everything that happens because
 * TIME passed has no such trigger, and that is exactly the part accounts care about. Three jobs, one
 * daily loop:
 *
 *   1. CONVERT stale advance-only drafts (60 days). An advance sitting on an open draft is invisible
 *      to every report that reads orders, so it converts on its own and becomes a real document.
 *      Its 365-day clock is NOT restarted by this — validity runs from the day the money landed.
 *
 *   2. EXPIRE advances at 365 days. effectiveStatus() already derives expiry when a row is read, but
 *      derived state cannot refuse a redemption: the redeem gate reads advance_status off the
 *      Shopify order, so expiry has to be written to both the ledger and the document.
 *
 *   3. REMIND the customer 11 months after the money was taken, while the advance can still be
 *      used. The mirror of the voucher expiry mail.
 *
 *   4. DIGEST to accounts, monthly. What is due to expire during this month, and the write-off
 *      list: advances whose year has run out with nothing bought against them.
 *
 * WHY A CONFIG MARKER FOR THE DIGEST
 * The daily loop would re-send the digest every day of the month, and an in-memory guard would
 * re-send it on every deploy or machine restart. Accounts learning to ignore a duplicated alert is
 * the failure mode worth engineering against, so the last month sent is persisted in the `config`
 * table and checked before sending.
 *
 * Deps (injected):
 *   { supabase, axios, storeUrl, getShopifyToken, updateOrderMetafields, completeDraftOrder,
 *     sendEmail, withStoreCc, buildCadAdvanceDigestHtml, buildCadAdvanceExpiryHtml, accountsEmail }
 */

const { CAD_STALE_DAYS, CAD_REMINDER_MONTHS, addMonths, isCadAdvanceOnly } = require('./cad_advance');
const creditInstruments = require('./credit_instruments');
// The customer-email lookup is identical to the voucher reminder's — Shopify customer record first,
// then the source order's address. Reused rather than re-implemented so the two cannot drift.
const { resolveCustomerEmail } = require('./voucher_expiry_sweep');

const DAY_MS        = 24 * 60 * 60 * 1000;
const UPCOMING_DAYS = 30;
const DIGEST_KEY    = 'cad_advance_digest_last';   // config row holding "YYYY-MM"
const TABLE         = 'credit_instruments';
const API           = '2024-01';

const iso = (d) => new Date(d).toISOString().slice(0, 10);

// ── 1. Stale advance-only drafts ────────────────────────────────────────────────────────────────
//
// The register is the index: a row still keyed by a DRAFT name (#D189) is by definition an advance
// whose draft has never converted. Cheaper and more reliable than crawling every open draft in the
// store, and it cannot miss one, because no advance exists without a row.
async function convertStaleDrafts(deps, { dryRun = false } = {}) {
  const { supabase, axios, storeUrl, getShopifyToken, completeDraftOrder } = deps;
  const cutoff = new Date(Date.now() - CAD_STALE_DAYS * DAY_MS).toISOString();

  const { data, error } = await supabase.from(TABLE)
    .select('serial_code, value, source_order_id, source_order_name, issued_at')
    .eq('instrument_type', 'cad_advance').eq('status', 'open').lte('issued_at', cutoff);
  if (error) throw new Error(`cad stale query: ${error.message}`);

  const candidates = (data || []).filter(r => /^#D/i.test(String(r.serial_code || '')) && r.source_order_id);
  if (!candidates.length) return { found: 0, converted: 0, skipped: 0 };

  const token   = await getShopifyToken();
  const headers = { 'X-Shopify-Access-Token': token };
  let converted = 0, skipped = 0;

  for (const row of candidates) {
    try {
      // Re-read before acting. The register row can be up to a day stale, and the two states that
      // must never be converted over — staff added the product (Path A is in progress) and the
      // draft was already completed — are only visible on the live draft.
      const { data: d } = await axios.get(
        `${storeUrl}/admin/api/${API}/draft_orders/${row.source_order_id}.json`, { headers, timeout: 15000 });
      const draft = d && d.draft_order;
      if (!draft)                   { console.warn(`[cad-sweep] draft ${row.source_order_id} not found — skipped`); skipped++; continue; }
      if (draft.status !== 'open')  { skipped++; continue; }   // already converted; conversion rekeys the row
      if (!isCadAdvanceOnly(draft)) { console.log(`[cad-sweep] ${draft.name} now carries a product — leaving it to staff`); skipped++; continue; }

      if (dryRun) {
        console.log(`[cad-sweep] DRY RUN would convert ${draft.name} (Rs${row.value}, taken ${iso(row.issued_at)})`);
        converted++;
        continue;
      }

      const orderId = await completeDraftOrder(String(row.source_order_id));
      if (!orderId) { console.error(`[cad-sweep] ${draft.name}: conversion returned no order id`); skipped++; continue; }
      converted++;
      console.log(`[cad-sweep] ${draft.name} converted → order ${orderId} (advance Rs${row.value} untouched, still open)`);
    } catch (err) {
      // One bad draft must not stop the rest of the run.
      console.error(`[cad-sweep] convert ${row.serial_code}: ${err.message}`);
      skipped++;
    }
  }
  return { found: candidates.length, converted, skipped };
}

// ── 2. Expiry at 365 days ───────────────────────────────────────────────────────────────────────
async function expireOverdueAdvances(deps, { dryRun = false } = {}) {
  const { supabase, axios, storeUrl, getShopifyToken, updateOrderMetafields } = deps;

  if (dryRun) {
    const { data, error } = await supabase.from(TABLE)
      .select('serial_code, value, source_order_name, expires_at')
      .eq('instrument_type', 'cad_advance').eq('status', 'open').lt('expires_at', iso(Date.now()));
    if (error) throw new Error(`cad expiry dry-run query: ${error.message}`);
    for (const r of (data || [])) console.log(`[cad-sweep] DRY RUN would expire ${r.serial_code} (Rs${r.value}, due ${r.expires_at})`);
    return { expired: (data || []).length, stamped: 0 };
  }

  const rows = await creditInstruments.expireOverdue(supabase, { instrumentType: 'cad_advance' });
  if (!rows.length) return { expired: 0, stamped: 0 };

  const token   = await getShopifyToken();
  const headers = { 'X-Shopify-Access-Token': token };
  let stamped = 0;

  for (const row of rows) {
    const name = String(row.source_order_name || row.serial_code || '').trim();
    // A row still keyed by a draft name has no order to stamp. It cannot be redeemed either — Path B
    // resolves the reference against ORDERS only — so the ledger row alone is a complete record.
    if (/^#D/i.test(name)) {
      console.warn(`[cad-sweep] ${name} expired on a draft that never converted — ledger only`);
      continue;
    }
    try {
      const { data } = await axios.get(
        `${storeUrl}/admin/api/${API}/orders.json?status=any&name=${encodeURIComponent(name)}`,
        { headers, timeout: 15000 });
      const order = (data.orders || []).find(o => o.name === name) || (data.orders || [])[0] || null;
      if (!order) { console.warn(`[cad-sweep] expired ${name}: order not found — ledger updated, document not stamped`); continue; }
      await updateOrderMetafields(String(order.id), { advance_status: 'expired' }, token);
      stamped++;
      console.log(`[cad-sweep] ${name} expired (Rs${row.value}, due ${row.expires_at}) — no longer redeemable`);
    } catch (err) {
      console.error(`[cad-sweep] stamp expired ${name}: ${err.message}`);
    }
  }
  return { expired: rows.length, stamped };
}

// ── 3. Customer reminder, 11 months after the money was taken ───────────────────────────────────
//
// The mirror of the voucher expiry mail: an advance the customer has forgotten is worth a nudge
// while they can still use it, and a month is enough notice to come in.
//
// WHO GETS IT. Anything not yet spent — status 'open' (never committed to a purchase) or 'applied'
// (sitting on a draft that has not converted). 'redeemed' and 'expired' are excluded: one is already
// spent, the other is past saving. Note the founder's phrasing was "applied and not redeemed"; in
// the data a standalone untouched advance is 'open', not 'applied', so both states are included or
// the common case would get no reminder at all.
//
// NOT SENDING TWICE. The voucher sweep leans on a one-day window plus an in-process Set, and accepts
// that a restart inside that day re-sends. For a customer-facing mail about their money that is not
// good enough, so the serials reminded are persisted in the config table — no migration needed, and
// the volume is a handful of rows a year.
const REMINDED_KEY = 'cad_advance_reminded';

async function readReminded(supabase) {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', REMINDED_KEY).maybeSingle();
    if (!data || !data.value) return [];
    const v = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    return Array.isArray(v) ? v : [];
  } catch (err) {
    // Unreadable marker → treat as "none reminded" would re-send to customers. Refuse instead: a
    // missed reminder is recoverable next run, a duplicate mail about their money is not.
    console.error(`[cad-sweep] reminded-marker read failed (${err.message}) — skipping reminders this run`);
    return null;
  }
}

async function remindExpiring(deps, { dryRun = false, now = Date.now() } = {}) {
  const { supabase, sendEmail, withStoreCc, buildCadAdvanceExpiryHtml, getShopifyToken } = deps;
  const today = iso(now);

  const alreadyReminded = await readReminded(supabase);
  if (alreadyReminded === null) return { due: 0, sent: 0, skipped: 0, blocked: true };

  const { data, error } = await supabase.from(TABLE)
    .select('serial_code, value, customer_id, customer_name, source_order_name, issued_at, expires_at, status')
    .eq('instrument_type', 'cad_advance').in('status', ['open', 'applied']);
  if (error) throw new Error(`cad reminder query: ${error.message}`);

  const due = (data || []).filter(r => {
    if (alreadyReminded.includes(r.serial_code)) return false;
    const when = addMonths(r.issued_at, CAD_REMINDER_MONTHS);
    return when && when <= today;          // <= not ===, so a missed day still goes out
  });
  if (!due.length) return { due: 0, sent: 0, skipped: 0 };

  const token = deps.token || (getShopifyToken ? await getShopifyToken() : null);
  const lookup = deps.customerEmailFor || ((row) => resolveCustomerEmail({ ...deps, token }, row));
  let sent = 0, skipped = 0;
  const nowSent = [];

  for (const row of due) {
    let email = null;
    try { email = await lookup(row); }
    catch (err) { console.warn(`[cad-sweep] email lookup failed for ${row.serial_code}: ${err.message}`); }
    if (!email) {
      // Worth logging loudly: an advance nobody can be reminded about will simply lapse.
      console.warn(`[cad-sweep] no email for advance ${row.serial_code} (Rs${row.value}) — cannot remind`);
      skipped++;
      continue;
    }
    const expiryDate = new Date(row.expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    if (dryRun) {
      console.log(`[cad-sweep] DRY RUN would remind ${row.serial_code} → ${email} (expires ${expiryDate})`);
      sent++;
      continue;
    }
    try {
      await sendEmail({
        to:      email,
        cc:      withStoreCc ? withStoreCc() : undefined,
        subject: `Your Timanti design advance expires on ${expiryDate}`,
        html:    buildCadAdvanceExpiryHtml({
          advanceValue:  row.value,
          expiryDate,
          originalOrder: row.source_order_name || row.serial_code,
          customerName:  row.customer_name || '',
        }),
      });
      nowSent.push(row.serial_code);
      sent++;
      console.log(`[cad-sweep] reminded ${row.serial_code} → ${email} (expires ${expiryDate})`);
    } catch (err) {
      // One bad address must not stop the rest of the run, and must not be marked as reminded.
      console.error(`[cad-sweep] reminder send failed for ${row.serial_code}: ${err.message}`);
      skipped++;
    }
  }

  // Persist only what actually went out. Written once at the end so a crash mid-loop re-sends at
  // most the tail, never the whole batch.
  if (nowSent.length) {
    try {
      const { error: wErr } = await supabase.from('config')
        .upsert({ key: REMINDED_KEY, value: JSON.stringify(alreadyReminded.concat(nowSent)) }, { onConflict: 'key' });
      if (wErr) throw new Error(wErr.message);
    } catch (err) {
      console.error(`[cad-sweep] could not persist reminded serials (${err.message}) — these may be re-sent: ${nowSent.join(', ')}`);
    }
  }
  return { due: due.length, sent, skipped };
}

// ── 4. Monthly digest to accounts ───────────────────────────────────────────────────────────────
async function readDigestMarker(supabase) {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', DIGEST_KEY).maybeSingle();
    if (!data || !data.value) return null;
    const v = typeof data.value === 'string' ? data.value : String(data.value);
    return v.replace(/"/g, '').trim();
  } catch (err) {
    // A marker we cannot read is treated as "not sent". Better a duplicate digest than a silent
    // month with none — accounts can ignore a repeat, but cannot act on an email that never came.
    console.warn(`[cad-sweep] digest marker read failed (${err.message}) — treating as unsent`);
    return null;
  }
}

async function writeDigestMarker(supabase, month) {
  const { error } = await supabase.from('config').upsert({ key: DIGEST_KEY, value: month }, { onConflict: 'key' });
  if (error) throw new Error(`digest marker write: ${error.message}`);
}

async function sendMonthlyDigest(deps, { dryRun = false, force = false, now = Date.now() } = {}) {
  const { supabase, sendEmail, withStoreCc, buildCadAdvanceDigestHtml, accountsEmail } = deps;

  const today = new Date(now);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const monthEnd   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const month      = iso(monthStart).slice(0, 7);                       // "2026-09"
  const monthLabel = monthStart.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  // Once per calendar month, and in practice that means the 1st — the daily loop's first run of a
  // new month finds no marker for it and sends.
  //
  // Deliberately NOT "only if today is the 1st". A machine that happens to be down or deploying on
  // the 1st would then skip the month entirely, and a missed write-off list is worse than one that
  // arrives on the 2nd. The marker gives "first opportunity each month" instead.
  if (!force) {
    const last = await readDigestMarker(supabase);
    if (last === month) return { sent: false, reason: `already sent for ${month}`, month };
  }

  // SECTION 1 — due to expire during this calendar month. Still redeemable today, so this is the
  // window in which accounts can chase or the store can call the customer in.
  const expiringThisMonth = await creditInstruments.listExpiringBetween(supabase, {
    instrumentType: "cad_advance",
    from: iso(monthStart),
    to:   iso(monthEnd),
  });

  // SECTION 2 — the write-off list. Advances whose year has run out with nothing bought against
  // them: never redeemed, never converted under Path B. Their order numbers are what accounts need
  // to move the money out of trade advances and close the loop.
  const { data: writeOffRaw, error } = await supabase.from(TABLE)
    .select("serial_code, value, customer_name, source_order_name, issued_at, expires_at, status")
    .eq("instrument_type", "cad_advance").eq("status", "expired")
    .order("expires_at", { ascending: true });
  if (error) throw new Error("cad digest write-off query: " + error.message);
  const writeOff = writeOffRaw || [];

  // Silence is deliberate: a month with nothing to report sends nothing. A recurring "no advances
  // this month" email is exactly how a real one comes to be skimmed past.
  if (!expiringThisMonth.length && !writeOff.length) {
    if (!dryRun) await writeDigestMarker(supabase, month);
    return { sent: false, reason: "nothing to report", month };
  }

  if (dryRun) {
    console.log("[cad-sweep] DRY RUN digest " + monthLabel + ": " + expiringThisMonth.length + " expiring this month, " + writeOff.length + " to write off -> " + accountsEmail);
    return { sent: false, dryRun: true, month, expiring: expiringThisMonth.length, writeOff: writeOff.length };
  }

  await sendEmail({
    to:      accountsEmail,
    cc:      withStoreCc ? withStoreCc() : undefined,
    subject: "CAD advances — " + monthLabel + ": " + expiringThisMonth.length + " expiring this month, " + writeOff.length + " to write off",
    html:    buildCadAdvanceDigestHtml({ monthLabel, expiring: expiringThisMonth, writeOff }),
  });
  await writeDigestMarker(supabase, month);
  console.log("[cad-sweep] digest sent for " + month + " -> " + accountsEmail + " (" + expiringThisMonth.length + " expiring, " + writeOff.length + " write-off)");
  return { sent: true, month, expiring: expiringThisMonth.length, writeOff: writeOff.length };
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────
//
// Order matters: expire BEFORE the digest, so an advance that lapsed overnight is reported in the
// same run it was expired in rather than a month later. Each stage is isolated — a Shopify outage
// during conversion must not cost accounts their digest.
async function runCadAdvanceSweep(deps, opts = {}) {
  const out = {};
  const stages = [
    ['stale',  () => convertStaleDrafts(deps, opts)],
    ['expiry', () => expireOverdueAdvances(deps, opts)],
    ['remind', () => remindExpiring(deps, opts)],
    ['digest', () => sendMonthlyDigest(deps, opts)],
  ];
  for (const [name, fn] of stages) {
    try { out[name] = await fn(); }
    catch (err) { out[name] = { error: err.message }; console.error(`[cad-sweep] ${name} failed: ${err.message}`); }
  }
  return out;
}

/**
 * Daily loop. Same pattern as the voucher expiry sweep — no scheduler, no new service; the process
 * already stays up (min_machines_running = 1 in fly.toml). The digest self-gates to once a month.
 */
function startCadAdvanceSweep(deps) {
  const kick = () => runCadAdvanceSweep(deps)
    .catch(err => console.error('[cad-sweep] sweep failed:', err.message));

  setTimeout(kick, 90 * 1000);   // after the voucher sweep, so boot logs stay readable
  setInterval(kick, DAY_MS);
}

module.exports = {
  runCadAdvanceSweep, startCadAdvanceSweep,
  convertStaleDrafts, expireOverdueAdvances, remindExpiring, sendMonthlyDigest,
  CAD_STALE_DAYS, UPCOMING_DAYS, DIGEST_KEY,
};
