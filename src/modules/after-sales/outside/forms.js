'use strict';

// Fragments the two signed staff forms in ../index.js embed:
//
//   Set Estimate  → an optional itemised breakdown (any repair). When rows are filled, their sum IS
//                   the estimate, so the figure the customer pays always matches what is itemised.
//   Mark Complete → weight accounting (outside pieces). The weight in vs out, and what the change
//                   is put down to, recorded where the customer will see and sign for it.
//
// Both write line-item properties (_cost_lines, _wt_reconcile), never metafields; see specs.js.

const S = require('./specs');

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// "22K YG", "14K / YG", "18kt" → 22 / 14 / 18. Null when the metal names no karat.
function karatOf(metal) {
  const m = String(metal || '').match(/(\d{1,2})\s*(k|kt|ct)\b/i);
  const k = m ? Number(m[1]) : null;
  return k > 0 && k <= 24 ? k : null;
}

// ── Set Estimate ─────────────────────────────────────────────────────────────

function estimateBreakdownHtml({ metal, ratePerGram } = {}) {
  const rate = ratePerGram > 0 ? Math.round(ratePerGram) : '';
  return `
      <details id="bdWrap" style="margin-top:16px; border:1px solid #e3e3e3; border-radius:6px; padding:10px 14px;">
        <summary style="cursor:pointer; font-size:13px; font-weight:500;">Itemise the estimate <span class="opt-label">(optional — shown to the customer and on the repair note)</span></summary>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
          <div><label style="font-size:12px;color:#666;">Labour (₹)</label><input class="bd" data-k="labour" type="text" inputmode="decimal" placeholder="e.g. 1500" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;"></div>
          <div><label style="font-size:12px;color:#666;">Stones (₹)</label><input class="bd" data-k="stones" type="text" inputmode="decimal" placeholder="0" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;"></div>
          <div><label style="font-size:12px;color:#666;">Metal added (g)</label><input class="bd" data-k="metalG" type="text" inputmode="decimal" placeholder="e.g. 0.30" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;"></div>
          <div><label style="font-size:12px;color:#666;">Rate (₹/g)${metal ? ` · ${esc(metal)}` : ''}</label><input class="bd" data-k="rate" type="text" inputmode="decimal" value="${rate}" placeholder="today's rate" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;"></div>
          <div><label style="font-size:12px;color:#666;">Other — what</label><input class="bd" data-k="otherLabel" type="text" placeholder="e.g. Rhodium" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;"></div>
          <div><label style="font-size:12px;color:#666;">Other (₹)</label><input class="bd" data-k="other" type="text" inputmode="decimal" placeholder="0" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;"></div>
        </div>
        <p class="hint" id="bdTotal" style="margin-top:10px;">Fill any row and the estimate becomes their total.</p>
        <input type="hidden" name="costLines" id="costLines" value="">
      </details>
      <script>
      (function () {
        var f = function (k) { var el = document.querySelector('.bd[data-k="' + k + '"]'); return el ? el.value.trim() : ''; };
        var n = function (v) { var x = parseFloat(String(v).replace(/,/g, '')); return isFinite(x) ? x : 0; };
        function recalc() {
          var lines = [];
          if (n(f('labour')) > 0) lines.push({ label: 'Labour', amount: Math.round(n(f('labour'))) });
          if (n(f('metalG')) > 0 && n(f('rate')) > 0) lines.push({
            label: 'Metal added ' + n(f('metalG')).toFixed(2) + ' g @ ₹' + Math.round(n(f('rate'))).toLocaleString('en-IN') + '/g',
            amount: Math.round(n(f('metalG')) * n(f('rate'))) });
          if (n(f('stones')) > 0) lines.push({ label: 'Stones', amount: Math.round(n(f('stones'))) });
          if (n(f('other')) > 0) lines.push({ label: f('otherLabel') || 'Other', amount: Math.round(n(f('other'))) });
          var total = lines.reduce(function (s, l) { return s + l.amount; }, 0);
          var amt = document.getElementById('amount');
          var free = document.getElementById('freeCheck');
          document.getElementById('costLines').value = lines.length ? JSON.stringify(lines) : '';
          if (lines.length && !(free && free.checked)) { amt.value = String(total); amt.readOnly = true; }
          else if (!(free && free.checked)) { amt.readOnly = false; }
          document.getElementById('bdTotal').textContent = lines.length
            ? 'Estimate = ₹' + total.toLocaleString('en-IN') + ' (' + lines.length + ' line' + (lines.length > 1 ? 's' : '') + ')'
            : 'Fill any row and the estimate becomes their total.';
        }
        Array.prototype.forEach.call(document.querySelectorAll('.bd'), function (el) { el.addEventListener('input', recalc); });
      })();
      </script>`;
}

// The breakdown the form posted, sanitised. Anything malformed is "no breakdown", never an error:
// the plain amount box is still there and still valid.
function parseBreakdown(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return S.parseCostLines(S.formatCostLines(arr));
  } catch {
    return [];
  }
}

// ── Mark Complete ────────────────────────────────────────────────────────────

function completeReconcileHtml({ intakeWeight } = {}) {
  const intake = parseFloat(intakeWeight);
  const causes = S.WEIGHT_CAUSES.map(c => `
          <div><label for="wc_${c.key}" style="font-size:12px; color:#666; margin-bottom:4px;">${esc(c.label)} (g)</label>
          <input id="wc_${c.key}" name="wc_${c.key}" class="wc" data-sign="${c.sign}" type="text" inputmode="decimal" placeholder="0.00"></div>`).join('');
  return `
      <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
      <label>Weight accounting <span class="opt-label">(outside piece — required)</span></label>
      <p class="hint" style="margin:0 0 10px;">Weight at intake: <strong>${intake > 0 ? intake.toFixed(2) + ' g' : 'not recorded'}</strong>.
        Enter the gross weight after repair above, then put the change down to its causes. Prints on the repair note for the customer to sign.</p>
      <input type="hidden" id="intakeWt" value="${intake > 0 ? intake : ''}">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">${causes}
      </div>
      <p id="wcStatus" style="font-size:13px; margin:10px 0 6px;"></p>
      <label for="wcNote" style="font-size:12px; color:#666;">Note <span class="opt-label">(required if the causes don't add up)</span></label>
      <input id="wcNote" name="wcNote" type="text" placeholder="e.g. old solder came away">
      <script>
      (function () {
        var gross = document.getElementById('postGrossWt');
        if (gross) gross.required = true;
        var n = function (v) { var x = parseFloat(String(v || '').replace(/,/g, '')); return isFinite(x) ? x : 0; };
        function recalc() {
          var inG = n(document.getElementById('intakeWt').value), outG = n(gross && gross.value);
          var st = document.getElementById('wcStatus');
          if (!(inG > 0) || !(outG > 0)) { st.textContent = 'Enter the gross weight after repair.'; st.style.color = '#999'; return; }
          var explained = 0;
          Array.prototype.forEach.call(document.querySelectorAll('.wc'), function (el) {
            var s = Number(el.getAttribute('data-sign')), g = n(el.value);
            explained += s === 0 ? g : s * Math.abs(g);
          });
          var change = outG - inG, rem = change - explained;
          var fmt = function (x) { return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) + ' g'; };
          var ok = Math.abs(rem) < ${S.WEIGHT_EPSILON};
          st.textContent = 'Change ' + fmt(change) + ' · explained ' + fmt(explained) + (ok ? ' · accounted for ✓' : ' · unexplained ' + fmt(rem) + ' — add a cause or a note');
          st.style.color = ok ? '#1a7f37' : '#b54708';
        }
        Array.prototype.forEach.call(document.querySelectorAll('.wc'), function (el) { el.addEventListener('input', recalc); });
        if (gross) gross.addEventListener('input', recalc);
        recalc();
      })();
      </script>`;
}

// Validate and format what Mark Complete posted for an outside piece. Returns { error } when the
// form must be refused, else { line } — the _wt_reconcile property value.
function parseCompleteReconcile(body, intakeWeight) {
  const out = parseFloat(String(body.postGrossWt || '').replace(/,/g, ''));
  if (!(out > 0)) return { error: 'Gross weight after repair is required for an outside piece.' };
  const causes = {};
  for (const c of S.WEIGHT_CAUSES) causes[c.key] = body[`wc_${c.key}`];
  const r = S.reconcileWeight({ intake: intakeWeight, out, causes });
  // No intake weight means the draft predates the intake form's checks. Record what we have.
  if (!r) return { line: `Out ${out.toFixed(2)} g (no intake weight recorded)` };
  const note = String(body.wcNote || '').trim();
  if (!r.balanced && !note) {
    return { error: `The causes leave ${Math.abs(r.remainder).toFixed(2)} g unexplained — add a cause or a note.` };
  }
  return { line: S.formatReconcile(r, note) };
}

module.exports = { karatOf, estimateBreakdownHtml, parseBreakdown, completeReconcileHtml, parseCompleteReconcile };
