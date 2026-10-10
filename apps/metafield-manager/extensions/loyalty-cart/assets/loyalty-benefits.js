/*
 * "My benefits" — the customer's loyalty benefit and open vouchers, applied as cart discount codes.
 * GoKwik checkout carries the cart's codes through and does not let customers enter codes itself,
 * so the cart is the only place codes are applied.
 *
 * Two ways onto the page, same code:
 *   - the "My benefits" app BLOCK, placed in the cart page section ([data-tl-benefits]);
 *   - the "My benefits (cart drawer)" app EMBED, which finds the theme's cart drawer and inserts the
 *     box just above its checkout / GoKwik button, again every time the drawer re-renders.
 *
 * Rules enforced here (Shopify enforces the same through each code's combination settings):
 *   - at most one loyalty code and one voucher on the cart;
 *   - loyalty never sits with a promo code — applying loyalty takes promo codes off.
 *
 * Talks to the middleware through the Shopify app proxy (/apps/loyalty/*), which signs each request
 * with the logged-in customer's id.
 */
(function () {
  if (window.__tlBenefits) return;
  window.__tlBenefits = true;

  var LOY = /^LOY-/i;
  var VCH = /^VCH/i;
  var cfgEl = document.querySelector('[data-tl-config]');
  var LOGGED_IN = !!(cfgEl && cfgEl.getAttribute('data-logged-in') === 'true') ||
    !!document.querySelector('[data-tl-benefits][data-logged-in="true"]');
  var LOGIN_URL = (cfgEl && cfgEl.getAttribute('data-login-url')) || '/account/login?return_url=/cart';
  var HEADING = (cfgEl && cfgEl.getAttribute('data-heading')) || 'My benefits';
  var LOGGED_OUT_TEXT = (cfgEl && cfgEl.getAttribute('data-logged-out-text')) || 'Log in to see your loyalty benefit and vouchers.';

  function inr(v) { return '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN'); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function getCart() { return fetch('/cart.js', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function cartCodes(cart) { return (cart.discount_codes || []).map(function (d) { return d.code; }).filter(Boolean); }
  function setCodes(codes) {
    return fetch('/cart/update.js', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ discount: codes.join(',') }),
    }).then(function (r) { if (!r.ok) throw new Error('cart'); return r.json(); });
  }

  // Benefits are per customer, not per cart: fetch once per page view and reuse for every render.
  var benefitsPromise = null;
  function getBenefits() {
    if (!benefitsPromise) {
      benefitsPromise = fetch('/apps/loyalty/benefits', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .catch(function () { benefitsPromise = null; return { found: false }; });
    }
    return benefitsPromise;
  }

  // After a code changes, reload so the theme shows Shopify's own discount lines and totals. If it
  // happened in the drawer, reopen it on the way back.
  function done(box, text, fromDrawer) {
    say(box, text);
    try { if (fromDrawer) sessionStorage.setItem('tl-open-drawer', '1'); } catch (e) { /* storage blocked */ }
    setTimeout(function () { window.location.reload(); }, 900);
  }
  function say(box, text) { var m = box.querySelector('.tl-benefits__msg'); if (m) m.textContent = text || ''; }

  function row(label, sub, btnText, onClick) {
    var r = el('div', 'tl-benefits__row');
    var t = el('div', 'tl-benefits__text');
    t.appendChild(el('div', 'tl-benefits__label', label));
    if (sub) t.appendChild(el('div', 'tl-benefits__muted', sub));
    r.appendChild(t);
    if (btnText) {
      var b = el('button', 'tl-benefits__btn', btnText);
      b.type = 'button';
      b.addEventListener('click', function () { onClick(b); });
      r.appendChild(b);
    }
    return r;
  }

  function render(box) {
    var inDrawer = box.getAttribute('data-tl-drawer') === 'true';
    var body = box.querySelector('.tl-benefits__body');
    if (!LOGGED_IN) {
      body.innerHTML = '';
      body.appendChild(el('p', 'tl-benefits__muted', LOGGED_OUT_TEXT));
      var a = el('a', 'tl-benefits__btn', 'Log in');
      a.href = LOGIN_URL;
      body.appendChild(a);
      return;
    }
    body.innerHTML = '';
    body.appendChild(el('p', 'tl-benefits__muted', 'Checking your benefits…'));

    function applyLoyalty(btn) {
      btn.disabled = true;
      say(box, 'Applying your loyalty benefit…');
      getCart().then(function (cart) {
        var lines = (cart.items || []).map(function (i) { return { variant_id: i.variant_id, quantity: i.quantity }; });
        return fetch('/apps/loyalty/apply', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ lines: lines }),
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.ok) { btn.disabled = false; say(box, res.reason || 'Your benefit could not be applied.'); return; }
          var keep = cartCodes(cart).filter(function (c) { return VCH.test(c); });
          var dropped = cartCodes(cart).filter(function (c) { return !VCH.test(c) && !LOY.test(c); });
          return setCodes(keep.concat([res.code])).then(function () {
            done(box, 'Loyalty applied: ' + inr(res.amount) + ' off the diamond value (' + res.rate + '%).' +
              (dropped.length ? ' Promo code ' + dropped.join(', ') + ' was removed — it cannot be combined with loyalty.' : ''), inDrawer);
          });
        });
      }).catch(function () { btn.disabled = false; say(box, 'Something went wrong. Please try again.'); });
    }
    function applyVoucher(code, btn) {
      btn.disabled = true;
      getCart().then(function (cart) {
        var keep = cartCodes(cart).filter(function (c) { return !VCH.test(c); });
        return setCodes(keep.concat([code])).then(function () { done(box, 'Voucher ' + code + ' applied.', inDrawer); });
      }).catch(function () { btn.disabled = false; say(box, 'The voucher could not be applied.'); });
    }
    function removeCode(code, btn) {
      btn.disabled = true;
      getCart().then(function (cart) {
        return setCodes(cartCodes(cart).filter(function (c) { return c.toUpperCase() !== code.toUpperCase(); }))
          .then(function () { done(box, code + ' removed.', inDrawer); });
      }).catch(function () { btn.disabled = false; say(box, 'Could not remove ' + code + '.'); });
    }

    Promise.all([getBenefits(), getCart()]).then(function (res) {
      var b = res[0] || {};
      var cart = res[1] || {};
      var codes = cartCodes(cart);
      body.innerHTML = '';
      if (!(cart.items || []).length) { box.style.display = 'none'; return; }
      box.style.display = '';
      if (!b.found) { body.appendChild(el('p', 'tl-benefits__muted', 'Your benefits are not available right now.')); return; }
      var loyOn = codes.filter(function (c) { return LOY.test(c); })[0];
      if (b.tier && b.enabled) {
        var occ = b.occasion && b.occasion.length ? ' (incl. ' + b.occasion.join(' & ') + ' month bonus)' : '';
        var label = b.tier.name + ' member: ' + b.rate + '% off the diamond value' + occ;
        body.appendChild(loyOn
          ? row(label, 'Applied to this cart.', 'Remove', function (btn) { removeCode(loyOn, btn); })
          : row(label, 'On eligible pieces in your cart.', 'Apply', applyLoyalty));
      } else if (b.next) {
        body.appendChild(row('Spend ' + inr(b.next.gap) + ' more to unlock ' + b.next.name, b.next.pct + '% off the diamond value of future purchases.', null));
      }
      (b.vouchers || []).forEach(function (v) {
        var on = codes.some(function (c) { return c.toUpperCase() === String(v.code).toUpperCase(); });
        var exp = v.expires_at ? 'Valid till ' + new Date(v.expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        body.appendChild(on
          ? row('Voucher ' + v.code + ' · ' + inr(v.value), 'Applied to this cart.', 'Remove', function (btn) { removeCode(v.code, btn); })
          : row('Voucher ' + v.code + ' · ' + inr(v.value), exp, 'Apply', function (btn) { applyVoucher(v.code, btn); }));
      });
      if (!body.children.length) body.appendChild(el('p', 'tl-benefits__muted', 'No benefits to apply yet.'));
    }).catch(function () { body.innerHTML = ''; body.appendChild(el('p', 'tl-benefits__muted', 'Your benefits could not be loaded.')); });
  }

  function makeBox(inDrawer) {
    var box = el('div', 'tl-benefits' + (inDrawer ? ' tl-benefits--drawer' : ''));
    box.setAttribute('data-tl-mounted', 'true');
    box.setAttribute('data-tl-drawer', inDrawer ? 'true' : 'false');
    box.appendChild(el('h3', 'tl-benefits__title', HEADING));
    box.appendChild(el('div', 'tl-benefits__body'));
    var msg = el('p', 'tl-benefits__msg');
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');
    box.appendChild(msg);
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
  if (!cfgEl) return;   // the embed is not switched on
  var DRAWER = 'cart-drawer, #CartDrawer, .cart-drawer, [id*="CartDrawer"], [class*="cart-drawer"]';
  // Where to insert, most specific first: the GoKwik checkout block, then the theme's own buttons.
  var ANCHORS = ['.gokwik-checkout', '[class*="gokwik"]', '.cart__ctas', '[name="checkout"]', '.cart-drawer__footer'];

  function mountInDrawer() {
    var drawer = document.querySelector('cart-drawer') || document.querySelector(DRAWER);
    if (!drawer || drawer.querySelector('[data-tl-mounted]')) return;
    var anchor = null;
    for (var i = 0; i < ANCHORS.length && !anchor; i++) anchor = drawer.querySelector(ANCHORS[i]);
    if (!anchor) return;
    // Insert above the whole button row so the box spans the drawer width.
    var target = anchor.closest('.cart__ctas') || anchor;
    var box = makeBox(true);
    target.parentNode.insertBefore(box, target);
    render(box);
  }

  // Themes re-render the drawer's contents on every cart change; put the box back each time.
  var pending = false;
  new MutationObserver(function () {
    if (pending) return;
    pending = true;
    setTimeout(function () { pending = false; mountInDrawer(); }, 150);
  }).observe(document.body, { childList: true, subtree: true });
  mountInDrawer();

  // Reopen the drawer after the reload that follows applying a code from it.
  try {
    if (sessionStorage.getItem('tl-open-drawer') === '1') {
      sessionStorage.removeItem('tl-open-drawer');
      var d = document.querySelector('cart-drawer');
      if (d && typeof d.open === 'function') setTimeout(function () { d.open(); }, 300);
    }
  } catch (e) { /* storage blocked */ }
})();
