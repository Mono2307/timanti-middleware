'use strict';

/**
 * Daily counter-vs-ledger reconciliation.
 *
 * On 2026-08-29 two invoice numbers left the counter without a document behind them. Nothing
 * noticed. The gap was found on 31 August by a person reading a printed invoice, and the
 * investigation took three days largely because there was no record that anything had happened.
 * See RCA_INVOICE_COUNTER_2026-08-29.md.
 *
 * The fixes that stop it recurring (a single-flight lock, and handing the number back on a lost
 * race) protect against the cause we found. This protects against the ones we have not found yet:
 * whatever the mechanism, a number that goes missing shows up here within a day, in an email,
 * naming the exact serials.
 *
 * Same pattern as voucher_expiry_sweep and cad_advance_sweep — no scheduler, no new service, no new
 * dependency. The process already stays up (min_machines_running = 1 in fly.toml).
 *
 * Sends ONLY when drifted. A daily "all clear" would be read for a week and then filtered, which is
 * how alerts die; silence here means agreement, and the endpoint is there whenever you want to look.
 */

const serialization = require('./index');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param deps.supabase
 * @param deps.sendEmail
 * @param deps.withStoreCc   optional — from integrations/email
 * @param deps.accountsEmail where the alert goes
 * @param opts.dryRun        compute and log, send nothing
 */
async function runSerialDriftSweep(deps, { dryRun = false } = {}) {
  const { sendEmail, accountsEmail, withStoreCc } = deps;

  const result = await serialization.computeSerialDrift(deps);

  if (result.ok) {
    console.log(`[serial-drift] ${result.checkedCounters} counters checked — all agree with the ledger`);
    return { ok: true, checked: result.checkedCounters, drifted: 0, sent: false };
  }

  console.error(`[serial-drift] DRIFT on ${result.driftedCounters} of ${result.checkedCounters} counters:`);
  for (const line of result.summary) console.error(`[serial-drift]   ${line}`);

  if (dryRun) return { ok: false, checked: result.checkedCounters, drifted: result.driftedCounters, sent: false, dryRun: true };

  // Never allowed to throw: a failing alert must not take down the process that raised it, and the
  // console lines above are already a durable record either way.
  if (!sendEmail || !accountsEmail) {
    console.error('[serial-drift] no sendEmail/accountsEmail configured — alert not sent');
    return { ok: false, checked: result.checkedCounters, drifted: result.driftedCounters, sent: false };
  }

  const rows = result.drifted.map(d => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${d.doc_type}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${d.store_code}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${d.counter}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${d.recorded}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#b00;"><strong>${d.missing_seqs.join(', ')}</strong></td>
    </tr>`).join('');

  try {
    await sendEmail({
      to:      accountsEmail,
      cc:      withStoreCc ? withStoreCc() : undefined,
      subject: `Document numbering — ${result.driftedCounters} counter(s) missing numbers`,
      html: `<div style="font-family:Arial,sans-serif;padding:24px;max-width:680px;">
        <h2 style="font-size:18px;margin:0 0 12px;">A document number was issued with nothing behind it</h2>
        <p style="font-size:14px;color:#444;line-height:1.6;margin:0 0 14px;">
          Every number a counter hands out should have a ledger row explaining it — including
          cancelled ones. The counters below do not balance, which means a number left the counter
          and never reached a document.
        </p>
        <table style="border-collapse:collapse;font-size:13px;width:100%;margin:0 0 14px;">
          <tr style="background:#f6f6f6;">
            <th style="padding:8px 12px;text-align:left;">Document</th>
            <th style="padding:8px 12px;text-align:left;">Store</th>
            <th style="padding:8px 12px;text-align:right;">Counter</th>
            <th style="padding:8px 12px;text-align:right;">Recorded</th>
            <th style="padding:8px 12px;text-align:left;">Missing</th>
          </tr>
          ${rows}
        </table>
        <p style="font-size:14px;color:#444;line-height:1.6;margin:0 0 12px;">
          This matters for GST: an invoice series has to read consecutively for the financial year.
          The sooner it is corrected the less of the series sits downstream of the gap.
        </p>
        <p style="font-size:13px;color:#666;line-height:1.6;margin:0;">
          Live detail: <strong>/api/serial/drift</strong> — it returns 409 while any counter is out.
          Background: RCA_INVOICE_COUNTER_2026-08-29.md.
        </p>
      </div>`,
    });
    console.log(`[serial-drift] alert sent → ${accountsEmail}`);
    return { ok: false, checked: result.checkedCounters, drifted: result.driftedCounters, sent: true };
  } catch (err) {
    console.error(`[serial-drift] alert email failed: ${err.message}`);
    return { ok: false, checked: result.checkedCounters, drifted: result.driftedCounters, sent: false };
  }
}

/** Fires once shortly after boot, then every 24h. */
function startSerialDriftSweep(deps) {
  const kick = () => runSerialDriftSweep(deps)
    .catch(err => console.error('[serial-drift] sweep failed:', err.message));

  setTimeout(kick, 90 * 1000);   // after the token and config settle
  setInterval(kick, DAY_MS);
}

module.exports = { runSerialDriftSweep, startSerialDriftSweep };
