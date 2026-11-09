'use strict';

/**
 * Delivery challan — make and cancel from an explicit button.
 *
 * Called by the "Delivery challan" admin action (apps/metafield-manager/extensions/delivery-challan),
 * which sits under More actions on a draft order. It replaces typing the make-memo-custom /
 * cancel-memo-custom tags, which gave no feedback and could fail half-way in silence: the reprice
 * stripped the tag first, and if the store code was blank the mint then logged "skipping" — leaving a
 * repriced draft with no number and nothing on screen to say so. Here every step answers the person
 * who pressed the button, and nothing is written until the inputs are known to be complete.
 *
 *   GET  /api/challan/:draftId          what the draft is now: stores, number (if any), price preview
 *   POST /api/challan/:draftId/make     { origin, deliveryCode, shipOutside } → prices + numbers the challan
 *   POST /api/challan/:draftId/cancel   { reason } → voids the number; prices stay as they are
 *
 * Pricing and numbering are the SAME engine the tags use (ctx.challan → server.js
 * computeChallanReprice / applyChallanReprice, and serialization.mintSerial / cancelSerial), so
 * the two routes cannot drift apart. The tags still work as a fallback.
 *
 * ORDER OF WRITES ON MAKE, and why: number first, then prices.
 *   The mint is idempotent per draft (the ledger is keyed on the resource), so a retry after any
 *   failure returns the same number. The reprice is not safely repeatable — it clears the draft's
 *   discount on its first run — so it runs once, in the same GraphQL write that adds the
 *   `dc-issued` tag. The tag is therefore the record that the prices were applied: a draft with an
 *   active number and no tag is one whose pricing step has not happened yet, and Make finishes it.
 *
 * A CANCELLED NUMBER STAYS DEAD.
 *   mintSerial re-issues on a draft whose ledger row is cancelled, and when that number is still the
 *   tip of the counter it hands the SAME number out again. For a challan that may already have left
 *   the store on paper, that is a reprinted number. So Make refuses a draft whose challan was
 *   cancelled; staff duplicate the draft to raise a fresh one.
 *
 * Auth: the extension's Shopify session token, verified exactly as the outside-repair routes do.
 */

const express = require('express');
const { config } = require('../../core/config');
const { getJson, putJson, postJson } = require('../../core/shopify');
const { log } = require('../../core/logger');
const { verifySessionToken } = require('../after-sales/session_token');
const serialization = require('../serialization');
const { SERIAL_DEPS } = require('../serialization/routes');
const { STORES, DEMO_STORES, isDemo, missingForMake } = require('./rules');

const DOC_TYPE = 'delivery_challan';
const ISSUED_TAG = 'dc-issued';
const CANCELLED_TAG = 'dc-cancelled';
const LEGACY_TAGS = ['make-memo-custom', 'cancel-memo-custom'];

function requireStaffSession(req, res, next) {
  try {
    const h = String(req.headers.authorization || '');
    verifySessionToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '', {
      clientId: config.loyalty.mfmClientId,
      clientSecrets: config.loyalty.proxySecrets,
      shopDomain: config.shopify.storeUrl,
    });
    return next();
  } catch (e) {
    log.warn('challan', `auth refused: ${e.message}`);
    return res.status(e.message === 'not configured' ? 503 : 401).json({ ok: false, error: `auth: ${e.message}` });
  }
}

const numericId = (raw) => String(raw || '').split('/').pop().replace(/\D/g, '');
const normCode  = (v) => String(v || '').trim().toUpperCase();
const splitTags = (t) => String(t || '').split(',').map(x => x.trim()).filter(Boolean);

async function readDraft(id) {
  const { draft_order: draft } = await getJson(`draft_orders/${id}.json`);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  const { metafields = [] } = await getJson(`draft_orders/${id}/metafields.json`);
  const mf = {};
  for (const m of metafields) if (m.namespace === 'custom') mf[m.key] = m.value;
  return { draft, mf, metafields };
}

async function upsertText(id, metafields, key, value) {
  const existing = metafields.find(m => m.namespace === 'custom' && m.key === key);
  if (existing) {
    if (String(existing.value) === String(value)) return;
    await putJson(`metafields/${existing.id}.json`, { metafield: { id: existing.id, value: String(value), type: existing.type || 'single_line_text_field' } });
  } else {
    await postJson(`draft_orders/${id}/metafields.json`, { metafield: { namespace: 'custom', key, type: 'single_line_text_field', value: String(value) } });
  }
}

// Same precedence as assignDocSerial in server.js: a state:XX tag wins over custom.state_code.
function stateTagOf(draft) {
  const t = splitTags(draft.tags).find(x => /^state:/i.test(x));
  return t ? normCode(t.split(':')[1]) : '';
}
function originOf(draft, mf) {
  return stateTagOf(draft) || normCode(mf.state_code);
}

function customerAddress(draft) {
  const a = (draft.shipping_address && draft.shipping_address.address1) ? draft.shipping_address : draft.billing_address;
  if (!a || !a.address1 || !a.province_code) return null;
  return { name: a.name || '', line: [a.address1, a.address2, a.city, a.province, a.zip].filter(Boolean).join(', '), province: a.province_code };
}

async function ledgerRow(supabase, id) {
  const { data } = await supabase.from('serial_ledger')
    .select('serial_code, status, store_code, created_at, cancelled_at')
    .eq('doc_type', DOC_TYPE).eq('resource_id', String(id)).maybeSingle();
  return data || null;
}

function register(app, ctx) {
  const { supabase, challan } = ctx;
  const json = express.json({ limit: '32kb' });

  // Status, plus the price preview Make would apply.
  app.get('/api/challan/:draftId', requireStaffSession, async (req, res) => {
    const id = numericId(req.params.draftId);
    if (!id) return res.status(400).json({ ok: false, error: 'draft id required' });
    try {
      const { draft, mf } = await readDraft(id);
      const tags = splitTags(draft.tags);
      const row = await ledgerRow(supabase, id);
      let preview = null;
      if (challan.enabled && !(row && row.status === 'active' && tags.includes(ISSUED_TAG))) {
        const r = await challan.computeChallanReprice(draft, await ctx.getShopifyToken());
        preview = { lines: r.preview, total: +r.preview.reduce((s, l) => s + l.challan, 0).toFixed(2) };
      }
      return res.json({
        ok: true, enabled: challan.enabled, stores: STORES, demoStores: DEMO_STORES,
        demo: isDemo(originOf(draft, mf)),
        draft: { name: draft.name, status: draft.status, total: +parseFloat(draft.total_price || 0).toFixed(2) },
        origin: originOf(draft, mf),
        // A state:XX tag outranks the metafield in the mint, so the form must not offer to change it.
        originLocked: Boolean(stateTagOf(draft)),
        deliveryCode: normCode(mf.delivery_code),
        shipOutside: String(mf.ship_outside_codes || '').trim().toLowerCase() === 'yes',
        customerAddress: customerAddress(draft),
        challan: row ? {
          number: row.serial_code, status: row.status, issuedAt: row.created_at, cancelledAt: row.cancelled_at,
          // Active with no dc-issued tag: numbered, but the pricing step has not run (or it was
          // raised with the old tag, whose pricing already happened — Make is safe either way).
          priced: tags.includes(ISSUED_TAG),
          cancelReason: mf.challan_cancel_reason || '',
        } : null,
        preview,
      });
    } catch (e) {
      log.error('challan', `status ${id}: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/challan/:draftId/make', requireStaffSession, json, async (req, res) => {
    const id = numericId(req.params.draftId);
    if (!id) return res.status(400).json({ ok: false, error: 'draft id required' });
    if (!challan.enabled) return res.status(503).json({ ok: false, error: 'delivery challans are switched off on the server (SERIAL_MEMO_TRANSFER)' });
    try {
      let { draft, mf, metafields } = await readDraft(id);
      if (draft.status === 'completed') return res.status(409).json({ ok: false, error: 'this draft has already been converted to an order' });

      const row = await ledgerRow(supabase, id);
      if (row && row.status === 'cancelled') {
        return res.status(409).json({ ok: false, error: `this draft's challan ${row.serial_code} was cancelled — duplicate the draft to raise a new challan, so the cancelled number is never reprinted` });
      }

      const shipOutside = req.body?.shipOutside === true;
      const deliveryCode = shipOutside ? normCode(mf.delivery_code) : normCode(req.body?.deliveryCode);
      // From store: chosen in the form and written to custom.state_code — the same field the
      // Jewellery Workspace edits, so the tax invoice and every other reader stay in step. A
      // state:XX tag outranks it in the mint, so a draft carrying one keeps that store.
      const tagOrigin = stateTagOf(draft);
      const requested = normCode(req.body?.origin);
      if (tagOrigin && requested && requested !== tagOrigin) {
        return res.status(422).json({ ok: false, error: `this draft is tagged state:${tagOrigin}, so it can only send from ${tagOrigin}` });
      }
      const origin = tagOrigin || requested || normCode(mf.state_code);
      const address = customerAddress(draft);
      const productLines = (draft.line_items || []).filter(li => parseFloat(li.price) >= 0).length;

      if (!row) {
        const missing = missingForMake({ origin, deliveryCode, shipOutside, address, productLines });
        if (missing.length) return res.status(422).json({ ok: false, error: 'cannot make the challan yet — missing', missing });

        // 1. Where it comes from and goes. Written before the number so the printed document and the ledger row
        //    read the same destination.
        if (!tagOrigin) await upsertText(id, metafields, 'state_code', origin);
        await upsertText(id, metafields, 'ship_outside_codes', shipOutside ? 'Yes' : 'No');
        if (!shipOutside) await upsertText(id, metafields, 'delivery_code', deliveryCode);
      }

      // 2. The number. Idempotent: an active row for this draft comes straight back.
      let number = row && row.serial_code;
      if (!row) {
        const r = await serialization.mintSerial(SERIAL_DEPS(), {
          docType: DOC_TYPE, storeCode: origin, deliveryCode: shipOutside ? '' : deliveryCode,
          resourceType: 'draft_order', resourceId: id, resourceName: draft.name, stamp: true,
        });
        number = r.serial_code;
        if (r.stampErrors?.length) log.warn('challan', `${draft.name}: ${number} minted, stamp errors ${JSON.stringify(r.stampErrors)}`);
        log.info('challan', `${draft.name}: ${number} issued${isDemo(origin) ? ' [DEMO]' : ''} (${origin} → ${shipOutside ? 'customer' : deliveryCode})`);
      }

      // 3. The prices — once, in the same write that adds the dc-issued tag.
      let preview = null;
      ({ draft } = await readDraft(id));   // fresh line items and tags after the metafield writes
      const tags = splitTags(draft.tags).filter(t => !LEGACY_TAGS.includes(t.toLowerCase()));
      if (!tags.includes(ISSUED_TAG)) {
        const r = await challan.applyChallanReprice(draft, [...tags, ISSUED_TAG].join(', '));
        preview = r.preview;
      }
      return res.json({ ok: true, number, priced: true, preview });
    } catch (e) {
      log.error('challan', `make ${id}: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
      return res.status(e.status || 500).json({ ok: false, error: `${e.message} — press Make again: the same number is kept and the step that failed is retried` });
    }
  });

  app.post('/api/challan/:draftId/cancel', requireStaffSession, json, async (req, res) => {
    const id = numericId(req.params.draftId);
    const reason = String(req.body?.reason || '').trim().slice(0, 200);
    if (!id) return res.status(400).json({ ok: false, error: 'draft id required' });
    if (!reason) return res.status(422).json({ ok: false, error: 'a reason is required', missing: ['reason for cancelling'] });
    try {
      const row = await ledgerRow(supabase, id);
      if (!row) return res.status(404).json({ ok: false, error: 'this draft has no delivery challan to cancel' });
      if (row.status === 'cancelled') return res.json({ ok: true, number: row.serial_code, alreadyCancelled: true });

      // 1. The ledger is the record: the number is retired and never handed out again.
      await serialization.cancelSerial(SERIAL_DEPS(), { docType: DOC_TYPE, resourceId: id });
      log.info('challan', `draft ${id}: ${row.serial_code} cancelled — ${reason}`);

      // 2. The draft. Prices are deliberately left as they are. The printed number is marked so a
      //    reprint of this draft cannot pass for a live challan (the template prints serial_code).
      //    Best-effort: the number is already void in the ledger, which is what counts.
      try {
        const { draft, metafields } = await readDraft(id);
        await upsertText(id, metafields, 'challan_cancel_reason', reason);
        await upsertText(id, metafields, 'serial_code', `${row.serial_code} (CANCELLED)`);
        if (draft.status !== 'completed') {
          const tags = splitTags(draft.tags).filter(t => t !== ISSUED_TAG && !LEGACY_TAGS.includes(t.toLowerCase()));
          if (!tags.includes(CANCELLED_TAG)) tags.push(CANCELLED_TAG);
          await putJson(`draft_orders/${id}.json`, { draft_order: { id: Number(id), tags: tags.join(', ') } });
        }
      } catch (e) {
        log.warn('challan', `draft ${id}: ${row.serial_code} void in ledger, but marking the draft failed: ${e.message}`);
        return res.json({ ok: true, number: row.serial_code, warning: 'the number is cancelled, but the draft could not be marked — do not print this draft' });
      }
      return res.json({ ok: true, number: row.serial_code });
    } catch (e) {
      log.error('challan', `cancel ${id}: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { register, missingForMake, STORES };
