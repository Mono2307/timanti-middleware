/*
 * Timanti Loyalty bar — one quiet, centred line in the cart page and the cart drawer.
 *
 *   logged out   Timanti Loyalty · Log in to see your diamond discount
 *   member       Gold member · 5% off diamonds — Apply
 *   applied      Gold benefit applied · ₹984 off — Remove
 *   below tier   ₹1,20,000 more to unlock Silver · 3% off diamonds
 *
 * Loyalty only — nothing else is listed here. Applying asks the middleware (Shopify app proxy
 * /apps/loyalty/apply) for a one-time code worth the diamond-only discount on this cart and puts it on
 * the cart; GoKwik checkout carries cart codes through. A voucher already on the cart is kept; promo
 * codes are dropped because loyalty never combines with them.
 *
 * A one-time code is made for one set of cart contents. If the cart changes after the customer applied
 * loyalty, the bar quietly applies it again for the new contents, so they never press Apply twice.
 */
(function () {
  if (window.__tlLoyalty) return;
  window.__tlLoyalty = true;

  var LOY = /^LOY-/i;
  var VCH = /^VCH/i;
  var KEY_ON = 'tl-loyalty-on';
  var KEY_SIG = 'tl-loyalty-auto-sig';
  var KEY_DRAWER = 'tl-open-drawer';
  var cfgEl = document.querySelector('[data-tl-config]');
  var LOGGED_IN = !!(cfgEl && cfgEl.getAttribute('data-logged-in') === 'true') ||
    !!document.querySelector('[data-tl-benefits][data-logged-in="true"]');
  var LOGIN_URL = (cfgEl && cfgEl.getAttribute('data-login-url')) || '/account/login?return_url=/cart';

  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* blocked */ } },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) { /* blocked */ } },
  };
  function inr(v) { return '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN'); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function getCart() { return fetch('/cart.js', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function cartCodes(cart) { return (cart.discount_codes || []).map(function (d) { return d.code; }).filter(Boolean); }
  function cartSig(cart) { return (cart.items || []).map(function (i) { return i.variant_id + 'x' + i.quantity; }).sort().join(','); }
  function setCodes(codes) {
    return fetch('/cart/update.js', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ discount: codes.join(',') }),
    }).then(function (r) { if (!r.ok) throw new Error('cart'); return r.json(); });
  }
  // Rupees the loyalty code takes off this cart, from Shopify's own allocations.
  function loyaltySaving(cart, code) {
    var total = 0;
    (cart.items || []).forEach(function (i) {
      (i.line_level_discount_allocations || []).forEach(function (a) {
        var app = a.discount_application || {};
        if (String(app.title || app.key || '').toUpperCase() === String(code).toUpperCase()) total += (a.amount || 0) / 100;
      });
    });
    return total;
  }

  var benefitsPromise = null;
  function getBenefits() {
    if (!benefitsPromise) {
      benefitsPromise = fetch('/apps/loyalty/benefits', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .catch(function () { benefitsPromise = null; return { found: false }; });
    }
    return benefitsPromise;
  }

  function reload(inDrawer) {
    if (inDrawer) store.set(KEY_DRAWER, '1');
    window.location.reload();
  }

  function applyLoyalty(cart, inDrawer, line) {
    if (line) line.textContent = 'Applying your benefit…';
    var lines = (cart.items || []).map(function (i) { return { variant_id: i.variant_id, quantity: i.quantity }; });
    return fetch('/apps/loyalty/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ lines: lines }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) { if (line) line.textContent = res.reason || 'Your benefit could not be applied.'; return false; }
      var keep = cartCodes(cart).filter(function (c) { return VCH.test(c); });
      return setCodes(keep.concat([res.code])).then(function () {
        store.set(KEY_ON, '1');
        store.set(KEY_SIG, cartSig(cart));
        reload(inDrawer);
        return true;
      });
    }).catch(function () { if (line) line.textContent = 'Something went wrong. Please try again.'; return false; });
  }

  function removeLoyalty(cart, inDrawer) {
    store.del(KEY_ON);
    store.del(KEY_SIG);
    return setCodes(cartCodes(cart).filter(function (c) { return !LOY.test(c); })).then(function () { reload(inDrawer); });
  }

  function action(label, onClick) {
    var b = el('button', 'tl-loyalty__action', label);
    b.type = 'button';
    b.addEventListener('click', function () { b.disabled = true; onClick(); });
    return b;
  }

  function render(box) {
    var inDrawer = box.getAttribute('data-tl-drawer') === 'true';
    var line = box.querySelector('.tl-loyalty__line');

    if (!LOGGED_IN) {
      line.innerHTML = '';
      line.appendChild(el('span', 'tl-loyalty__brand', 'Timanti Loyalty'));
      line.appendChild(el('span', 'tl-loyalty__sep', '·'));
      var a = el('a', 'tl-loyalty__action', 'Log in');
      a.href = LOGIN_URL;
      line.appendChild(a);
      line.appendChild(el('span', '', ' to see your diamond discount'));
      return;
    }

    Promise.all([getBenefits(), getCart()]).then(function (res) {
      var b = res[0] || {};
      var cart = res[1] || {};
      if (!(cart.items || []).length || !b.found || b.enabled === false) { box.hidden = true; return; }
      box.hidden = false;
      line.innerHTML = '';
      var loyCode = cartCodes(cart).filter(function (c) { return LOY.test(c); })[0];

      if (!b.tier) {
        if (!b.next) { box.hidden = true; return; }
        line.appendChild(el('span', 'tl-loyalty__muted',
          inr(b.next.gap) + ' more to unlock ' + b.next.name + ' · ' + b.next.pct + '% off diamonds'));
        return;
      }

      // Applied earlier but the cart has changed since → apply again for the new contents, once.
      if (!loyCode && store.get(KEY_ON) === '1' && store.get(KEY_SIG) !== cartSig(cart)) {
        store.set(KEY_SIG, cartSig(cart));
        applyLoyalty(cart, inDrawer, line);
        return;
      }

      var occ = b.occasion && b.occasion.length ? ' (' + b.occasion.join(' & ') + ' bonus)' : '';
      if (loyCode) {
        var saved = loyaltySaving(cart, loyCode);
        line.appendChild(el('span', 'tl-loyalty__strong', b.tier.name + ' benefit applied'));
        line.appendChild(el('span', 'tl-loyalty__sep', '·'));
        line.appendChild(el('span', '', (saved > 0 ? inr(saved) + ' off' : b.rate + '% off diamonds') + occ));
        line.appendChild(el('span', 'tl-loyalty__sep', '—'));
        line.appendChild(action('Remove', function () { removeLoyalty(cart, inDrawer); }));
      } else {
        line.appendChild(el('span', 'tl-loyalty__strong', b.tier.name + ' member'));
        line.appendChild(el('span', 'tl-loyalty__sep', '·'));
        line.appendChild(el('span', '', b.rate + '% off diamonds' + occ));
        line.appendChild(el('span', 'tl-loyalty__sep', '—'));
        line.appendChild(action('Apply', function () { applyLoyalty(cart, inDrawer, line); }));
      }
    }).catch(function () { box.hidden = true; });
  }

  function makeBox(inDrawer) {
    var box = el('div', 'tl-loyalty' + (inDrawer ? ' tl-loyalty--drawer' : ''));
    box.setAttribute('data-tl-mounted', 'true');
    box.setAttribute('data-tl-drawer', inDrawer ? 'true' : 'false');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.appendChild(el('p', 'tl-loyalty__line'));
    return box;
  }

  // ── Cart page block ──────────────────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-tl-benefits]').forEach(function (holder) {
    if (holder.querySelector('[data-tl-mounted]')) return;
    var box = makeBox(false);
    holder.appendChild(box);
    render(box);
  });

  // ── Cart drawer (app embed) ──────────────────────────────────────────────────────────────────
  if (!cfgEl) return;
  var DRAWER = 'cart-drawer, #CartDrawer, .cart-drawer, [id*="CartDrawer"], [class*="cart-drawer"]';
  var ANCHORS = ['.gokwik-checkout', '[class*="gokwik"]', '.cart__ctas', '[name="checkout"]', '.cart-drawer__footer'];

  function mountInDrawer() {
    var drawer = document.querySelector('cart-drawer') || document.querySelector(DRAWER);
    if (!drawer || drawer.querySelector('[data-tl-mounted]')) return;
    var anchor = null;
    for (var i = 0; i < ANCHORS.length && !anchor; i++) anchor = drawer.querySelector(ANCHORS[i]);
    if (!anchor) return;
    // Above the footer row, never inside it: drawer footers lay totals and buttons out as one flex
    // row, and anything placed in that row is squeezed into a column.
    var target = anchor.closest('.cart__ctas') || anchor;
    while (target.parentElement && target.parentElement !== drawer) {
      var cs = window.getComputedStyle(target.parentElement);
      if (cs.display.indexOf('flex') === -1 || cs.flexDirection.indexOf('row') !== 0) break;
      target = target.parentElement;
    }
    var box = makeBox(true);
    target.parentNode.insertBefore(box, target);
    render(box);
  }

  var pending = false;
  new MutationObserver(function () {
    if (pending) return;
    pending = true;
    setTimeout(function () { pending = false; mountInDrawer(); }, 150);
  }).observe(document.body, { childList: true, subtree: true });
  mountInDrawer();

  if (store.get(KEY_DRAWER) === '1') {
    store.del(KEY_DRAWER);
    var d = document.querySelector('cart-drawer');
    if (d && typeof d.open === 'function') setTimeout(function () { d.open(); }, 300);
  }
})();
