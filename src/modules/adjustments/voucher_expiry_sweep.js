'use strict';

/**
 * Voucher expiry reminder — 30 days out.
 *
 * Sent by the middleware through Resend, not by the sheet. The sheet issues
 * vouchers; the ledger knows when they expire, so the reminder belongs here.
 *
 * WHAT IT DOES
 * Once a day, finds every voucher in credit_instruments that is still open, not
 * yet expired, and expires within the next 30 days (to the end of that 30th
 * day), and emails the customer once — the spec's vch-expiry-reminded guard.
 *
 * WHY "<= 30 days" AND A PERSISTED GUARD
 * This used to be a one-day window ("expires exactly 30 days from now") with an
 * in-memory Set as the once-only guard. Both halves failed: a restart re-sent
 * that day's reminders, and a day of downtime skipped that day's vouchers for
 * good. The window is now tolerant, so a missed day goes out on the next run,
 * and the serials reminded are persisted in the config table — the same pattern
 * as the CAD advance reminder (cad_advance_sweep.js). Keyed by voucher serial,
 * not by a tag on the source order, because one order can carry more than one
 * voucher and an order tag would silence the second.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_DAYS = 30;
const REMINDED_KEY = 'vch_expiry_reminded';   // config row: JSON array of serial codes

/**
 * The persisted guard. Returns { reminded: [...serials], seeded } or null when
 * the marker cannot be read — the caller then sends nothing this run: a missed
 * reminder is recovered next run, a duplicate mail about a customer's money is
 * not recoverable.
 */
async function readReminded(supabase) {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', REMINDED_KEY).maybeSingle();
    if (!data || !data.value) return { reminded: [], seeded: false };
    const v = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    return { reminded: Array.isArray(v) ? v : [], seeded: true };
  } catch (err) {
    console.error(`[voucher-expiry] reminded-marker read failed (${err.message}) — skipping reminders this run`);
    return null;
  }
}

/**
 * Resolve a customer email for a ledger row. The ledger stores customer_id and
 * source_order_name, never an address, so we go and find one — in order of how
 * reliable it is:
 *
 *   1. Shopify customer record   — authoritative, survives the order being edited
 *   2. The source order's email  — covers guest checkouts with no customer record,
 *                                  and rows written before customer_id was captured
 *
 * Returns null only when both fail, which is the one case worth logging loudly:
 * a voucher nobody can be reminded about.
 */
async function resolveCustomerEmail(deps, row) {
  const { axios, storeUrl, token } = deps;
  const headers = { 'X-Shopify-Access-Token': token };

  if (row.customer_id) {
    try {
      const { data } = await axios.get(
        `${storeUrl}/admin/api/2024-01/customers/${row.customer_id}.json?fields=id,email`,
        { headers, timeout: 10000 }
      );
      if (data?.customer?.email) return data.customer.email;
    } catch (err) {
      console.warn(`[voucher-expiry] customer ${row.customer_id} lookup failed: ${err.message}`);
    }
  }

  if (row.source_order_name) {
    try {
      const { data } = await axios.get(
        `${storeUrl}/admin/api/2024-01/orders.json?name=${encodeURIComponent(row.source_order_name)}&status=any&limit=1&fields=id,name,email`,
        { headers, timeout: 10000 }
      );
      const email = data?.orders?.[0]?.email;
      if (email) return email;
    } catch (err) {
      console.warn(`[voucher-expiry] order ${row.source_order_name} lookup failed: ${err.message}`);
    }
  }

  return null;
}

/**
 * @param deps.supabase
 * @param deps.sendEmail        from emailService
 * @param deps.buildVoucherExpiryHtml  from emailTemplates
 * @param deps.withStoreCc      from emailService
 * @param deps.axios            for the Shopify lookups
 * @param deps.storeUrl         process.env.SHOPIFY_STORE_URL
 * @param deps.getShopifyToken  async () => token
 * @param deps.customerEmailFor optional override; defaults to resolveCustomerEmail
 */
async function runVoucherExpirySweep(deps, { dryRun = false, now = Date.now() } = {}) {
  const { supabase, sendEmail, buildVoucherExpiryHtml, withStoreCc } = deps;

  const target = new Date(now + LEAD_DAYS * DAY_MS);
  const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayEnd   = new Date(dayStart.getTime() + DAY_MS);

  const marker = await readReminded(supabase);
  if (marker === null) return { found: 0, sent: 0, skipped: 0, blocked: true };

  // Not yet expired, and expiring no later than the end of the 30th day out.
  const { data, error } = await supabase
    .from('credit_instruments')
    .select('serial_code, value, customer_id, customer_name, source_order_name, expires_at, status')
    .eq('instrument_type', 'voucher')
    .eq('status', 'open')
    .gte('expires_at', new Date(now).toISOString())
    .lt('expires_at',  dayEnd.toISOString());

  if (error) throw new Error(`voucher expiry sweep query: ${error.message}`);

  const inWindow = data || [];
  let reminded = marker.reminded;
  let seededNow = [];

  // First run with the persisted guard: there is no record of what the old
  // one-day sweep already sent, so a <= 30 window would re-mail everything it
  // reminded in the last month. Vouchers expiring before the 30th day are taken
  // as already handled and recorded without sending; only the 30th-day cohort
  // (what the old sweep would have sent today) goes out.
  if (!marker.seeded) {
    seededNow = inWindow
      .filter(r => new Date(r.expires_at) < dayStart && !reminded.includes(r.serial_code))
      .map(r => r.serial_code);
    if (seededNow.length) {
      console.log(`[voucher-expiry] first run with persisted guard — recording ${seededNow.length} voucher(s) inside the window as already reminded: ${seededNow.join(', ')}`);
    }
    reminded = reminded.concat(seededNow);
  }

  const rows = inWindow.filter(r => !reminded.includes(r.serial_code));
  console.log(`[voucher-expiry] ${rows.length} voucher(s) expiring by ${dayStart.toISOString().slice(0, 10)} not yet reminded`);

  const token = rows.length ? (deps.token || (deps.getShopifyToken ? await deps.getShopifyToken() : null)) : null;
  const lookup = deps.customerEmailFor
    || ((row) => resolveCustomerEmail({ ...deps, token }, row));

  let sent = 0, skipped = 0;
  const nowSent = [];

  for (const row of rows) {

    let email = null;
    try {
      email = await lookup(row);
    } catch (err) {
      console.warn(`[voucher-expiry] email lookup failed for ${row.serial_code}: ${err.message}`);
    }
    if (!email) {
      console.warn(`[voucher-expiry] no email for ${row.serial_code} — skipped`);
      skipped++;
      continue;
    }

    const expiryDate = new Date(row.expires_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    if (dryRun) {
      console.log(`[voucher-expiry] DRY RUN would send ${row.serial_code} → ${email} (expires ${expiryDate})`);
      sent++;
      continue;
    }

    try {
      await sendEmail({
        to:      email,
        cc:      withStoreCc(),
        subject: `Your Timanti Voucher expires in 30 days — ${row.serial_code}`,
        html:    buildVoucherExpiryHtml({
          cnNumber:      row.serial_code,
          creditValue:   row.value,
          expiryDate,
          originalOrder: row.source_order_name
        })
      });
      nowSent.push(row.serial_code);
      sent++;
      console.log(`[voucher-expiry] sent ${row.serial_code} → ${email}`);
    } catch (err) {
      // One bad address must not stop the rest of the run, and must not be marked as reminded.
      console.error(`[voucher-expiry] send failed for ${row.serial_code}: ${err.message}`);
      skipped++;
    }
  }

  // Persist only what actually went out (plus a first-run seed). Written once at
  // the end so a crash mid-loop re-sends at most the tail, never the whole batch.
  const toRecord = seededNow.concat(nowSent);
  if (toRecord.length && !dryRun) {
    try {
      const { error: wErr } = await supabase.from('config')
        .upsert({ key: REMINDED_KEY, value: JSON.stringify(marker.reminded.concat(toRecord)) }, { onConflict: 'key' });
      if (wErr) throw new Error(wErr.message);
    } catch (err) {
      console.error(`[voucher-expiry] could not persist reminded serials (${err.message}) — these may be re-sent: ${nowSent.join(', ')}`);
    }
  }

  console.log(`[voucher-expiry] done — ${sent} sent, ${skipped} skipped`);
  return { found: rows.length, sent, skipped, seeded: seededNow.length };
}

/**
 * Start the daily loop. Same pattern as the existing GoKwik poller in server.js,
 * so no scheduler, no new service, no new dependency — the process already stays
 * up (min_machines_running = 1 in fly.toml).
 *
 * Fires once shortly after boot, then every 24h.
 */
function startVoucherExpirySweep(deps) {
  const kick = () => runVoucherExpirySweep(deps)
    .catch(err => console.error('[voucher-expiry] sweep failed:', err.message));

  setTimeout(kick, 60 * 1000);        // let the process settle first
  setInterval(kick, DAY_MS);
}

module.exports = { runVoucherExpirySweep, startVoucherExpirySweep, resolveCustomerEmail, LEAD_DAYS, REMINDED_KEY };
