/*
 * Timanti "Your Benefits" card — cart drawer (app embed) and cart page (app block).
 *
 * Sits under the drawer's "Price Breakdown" and is built from the drawer's own classes, so it carries
 * the theme's type, borders and buttons:
 *
 *   Your Benefits
 *   Gold member · 5% off diamonds                 [ Apply ]   → "Gold benefit applied · ₹984 off   Remove"
 *   [ Voucher or discount code ]                  [ Apply ]
 *   Other available offers ›                                  → click to list the customer's vouchers
 *
 * Logged out: "Log in to unlock your loyalty benefit [Log in]" and the code box.
 *
 * Codes are applied to the Shopify cart (GoKwik checkout carries them through and has its own code
 * entry switched off). Loyalty stacks with one voucher / code; Shopify's combination settings refuse a
 * promo code alongside loyalty, and this card says so. A one-time loyalty code is made for one set of
 * cart contents; if the cart changes after loyalty was applied, it is re-applied once, quietly.
 */
(function () {
  if (window.__tlLoyalty) return;
  window.__tlLoyalty = true;

  var LOY = /^LOY-/i;
  var KEY_ON = 'tl-loyalty-on';
  var KEY_SIG = 'tl-loyalty-auto-sig';
  var KEY_DRAWER = 'tl-open-drawer';
  var KEY_MSG = 'tl-msg';
  var cfgEl = document.querySelector('[data-tl-config]');
  var LOGGED_IN = !!(cfgEl && cfgEl.getAttribute('data-logged-in') === 'true') ||
    !!document.querySelector('[data-tl-benefits][data-logged-in="true"]');
  var LOGIN_URL = (cfgEl && cfgEl.getAttribute('data-login-url')) || '/account/login?return_url=/cart';
  var HEADING = (cfgEl && cfgEl.getAttribute('data-heading')) || 'Your Benefits';

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
  function codeSaving(cart, code) {
    var total = 0;
    (cart.items || []).forEach(function (i) {
      (i.line_level_discount_allocations || []).forEach(function (a) {
        var app = a.discount_application || {};
        if (String(app.title || app.key || '').toUpperCase() === String(code).toUpperCase()) total += (a.amount || 0) / 100;
      });
    });
    (cart.cart_level_discount_applications || []).forEach(function (a) {
      if (String(a.title || a.key || '').toUpperCase() === String(code).toUpperCase()) total += (a.total_allocated_amount || 0) / 100;
    });
    return total;
  }

  var benefitsPromise = null;
  function getBenefits() {
    if (!LOGGED_IN) return Promise.resolve({ loggedIn: false });
    if (!benefitsPromise) {
      benefitsPromise = fetch('/apps/loyalty/benefits', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .catch(function () { benefitsPromise = null; return { found: false }; });
    }
    return benefitsPromise;
  }

  function reload(inDrawer, msg) {
    if (inDrawer) store.set(KEY_DRAWER, '1');
    if (msg) store.set(KEY_MSG, msg);
    window.location.reload();
  }

  // ── actions ────────────────────────────────────────────────────────────────────────────────
  function applyLoyalty(cart, ctx) {
    ctx.say('Applying your benefit…');
    var lines = (cart.items || []).map(function (i) { return { variant_id: i.variant_id, quantity: i.quantity }; });
    return fetch('/apps/loyalty/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ lines: lines }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) { ctx.say(res.reason || 'Your benefit could not be applied.'); ctx.unlock(); return; }
      // Keep any other code already on the cart (a voucher stacks); drop an older loyalty code.
      var keep = cartCodes(cart).filter(function (c) { return !LOY.test(c); });
      return setCodes(keep.concat([res.code])).then(function () {
        store.set(KEY_ON, '1');
        store.set(KEY_SIG, cartSig(cart));
        reload(ctx.inDrawer);
      });
    }).catch(function () { ctx.say('Something went wrong. Please try again.'); ctx.unlock(); });
  }

  function applyCode(cart, code, ctx) {
    code = String(code || '').trim();
    if (!code) { ctx.say('Enter a voucher or discount code.'); ctx.unlock(); return; }
    var codes = cartCodes(cart);
    if (codes.some(function (c) { return c.toUpperCase() === code.toUpperCase(); })) { ctx.say(code + ' is already applied.'); ctx.unlock(); return; }
    ctx.say('Applying ' + code + '…');
    return setCodes(codes.concat([code])).then(function () { return getCart(); }).then(function (after) {
      var entry = (after.discount_codes || []).filter(function (d) { return String(d.code).toUpperCase() === code.toUpperCase(); })[0];
      if (!entry || entry.applicable === false) {
        // Not valid for this cart, or it cannot be combined with what is already applied.
        return setCodes(cartCodes(after).filter(function (c) { return c.toUpperCase() !== code.toUpperCase(); })).then(function () {
          var loy = cartCodes(after).some(function (c) { return LOY.test(c); });
          ctx.say(loy ? code + ' cannot be combined with your loyalty benefit.' : code + ' is not valid for this cart.');
          ctx.unlock();
        });
      }
      reload(ctx.inDrawer, code + ' applied.');
    }).catch(function () { ctx.say('The code could not be applied.'); ctx.unlock(); });
  }

  function removeCode(cart, code, ctx) {
    if (LOY.test(code)) { store.del(KEY_ON); store.del(KEY_SIG); }
    return setCodes(cartCodes(cart).filter(function (c) { return c.toUpperCase() !== String(code).toUpperCase(); }))
      .then(function () { reload(ctx.inDrawer); });
  }

  // ── building blocks (drawer classes first, own fallbacks for the cart page) ──────────────────
  function row(label, control) {
    var r = el('div', 'cart-drawer__price-breakdown-item tl-card__row');
    r.appendChild(el('span', 'cart-drawer__price-breakdown-label tl-card__label', label));
    if (control) r.appendChild(control);
    return r;
  }
  function primary(label, onClick) {
    var b = el('button', 'button tl-card__btn', label);
    b.type = 'button';
    b.addEventListener('click', function () { b.disabled = true; onClick(b); });
    return b;
  }
  function textLink(label, onClick) {
    var b = el('button', 'tl-card__link', label);
    b.type = 'button';
    b.addEventListener('click', function () { b.disabled = true; onClick(b); });
    return b;
  }

  function render(card) {
    var inDrawer = card.getAttribute('data-tl-drawer') === 'true';
    var body = card.querySelector('.tl-card__body');
    var msg = card.querySelector('.tl-card__msg');
    var ctx = {
      inDrawer: inDrawer,
      say: function (t) { msg.textContent = t || ''; },
      unlock: function () { card.querySelectorAll('button[disabled]').forEach(function (b) { b.disabled = false; }); },
    };
    var flash = store.get(KEY_MSG);
    if (flash) { store.del(KEY_MSG); ctx.say(flash); }

    Promise.all([getBenefits(), getCart()]).then(function (res) {
      var b = res[0] || {};
      var cart = res[1] || {};
      if (!(cart.items || []).length) { card.hidden = true; return; }
      card.hidden = false;
      body.innerHTML = '';
      var codes = cartCodes(cart);
      var loyCode = codes.filter(function (c) { return LOY.test(c); })[0];
      var otherCodes = codes.filter(function (c) { return !LOY.test(c); });

      // 1. Loyalty
      if (!LOGGED_IN) {
        var login = el('a', 'button tl-card__btn', 'Log in');
        login.href = LOGIN_URL;
        body.appendChild(row('Log in to unlock your loyalty benefit', login));
      } else if (b.found && b.enabled !== false && b.tier) {
        var occ = b.occasion && b.occasion.length ? ' (' + b.occasion.join(' & ') + ' bonus)' : '';
        if (!loyCode && store.get(KEY_ON) === '1' && store.get(KEY_SIG) !== cartSig(cart)) {
          // Applied earlier, cart changed since → re-apply for the new contents, once.
          store.set(KEY_SIG, cartSig(cart));
          body.appendChild(row(b.tier.name + ' member · ' + b.rate + '% off diamonds' + occ, null));
          applyLoyalty(cart, ctx);
        } else if (loyCode) {
          var saved = codeSaving(cart, loyCode);
          body.appendChild(row(b.tier.name + ' benefit applied · ' + (saved > 0 ? inr(saved) + ' off' : b.rate + '% off diamonds'),
            textLink('Remove', function () { removeCode(cart, loyCode, ctx); })));
        } else {
          body.appendChild(row(b.tier.name + ' member · ' + b.rate + '% off diamonds' + occ,
            primary('Apply', function () { applyLoyalty(cart, ctx); })));
        }
      } else if (b.found && b.next) {
        body.appendChild(row(inr(b.next.gap) + ' more to unlock ' + b.next.name + ' · ' + b.next.pct + '% off diamonds', null));
      }

      // 2. Codes already on the cart (vouchers, discount codes)
      otherCodes.forEach(function (c) {
        var saved = codeSaving(cart, c);
        body.appendChild(row(c + ' applied' + (saved > 0 ? ' · ' + inr(saved) + ' off' : ''),
          textLink('Remove', function () { removeCode(cart, c, ctx); })));
      });

      // 3. Code box
      var form = el('form', 'tl-card__code');
      var field = el('div', 'field tl-card__field');
      var input = el('input', 'field__input');
      input.type = 'text'; input.id = 'tl-code-' + (inDrawer ? 'd' : 'p'); input.placeholder = 'Voucher or discount code';
      input.autocomplete = 'off'; input.setAttribute('aria-label', 'Voucher or discount code');
      var label = el('label', 'field__label', 'Voucher or discount code');
      label.setAttribute('for', input.id);
      field.appendChild(input); field.appendChild(label);
      var go = el('button', 'button tl-card__btn tl-card__btn--outline', 'Apply');
      go.type = 'submit';
      form.appendChild(field); form.appendChild(go);
      form.addEventListener('submit', function (e) { e.preventDefault(); go.disabled = true; applyCode(cart, input.value, ctx); });
      body.appendChild(form);

      // 4. Other available offers — the customer's vouchers, collapsed until asked for
      var offers = (b.vouchers || []).filter(function (v) {
        return !codes.some(function (c) { return c.toUpperCase() === String(v.code).toUpperCase(); });
      }).sort(function (x, y) { return (y.value || 0) - (x.value || 0); });
      if (offers.length) {
        var toggle = el('button', 'tl-card__link tl-card__toggle', 'Other available offers (' + offers.length + ') ›');
        toggle.type = 'button';
        var list = el('div', 'tl-card__offers');
        list.hidden = true;
        offers.forEach(function (v) {
          var exp = v.expires_at ? ' · till ' + new Date(v.expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
          list.appendChild(row('Voucher ' + inr(v.value) + exp, textLink('Use', function () { applyCode(cart, v.code, ctx); })));
        });
        toggle.addEventListener('click', function () {
          list.hidden = !list.hidden;
          toggle.textContent = 'Other available offers (' + offers.length + ') ' + (list.hidden ? '›' : '⌄');
        });
        body.appendChild(toggle);
        body.appendChild(list);
      }
    }).catch(function () { card.hidden = true; });
  }

  function makeCard(inDrawer) {
    var card = el('div', 'cart-drawer__price-breakdown tl-card' + (inDrawer ? ' tl-card--drawer' : ''));
    card.setAttribute('data-tl-mounted', 'true');
    card.setAttribute('data-tl-drawer', inDrawer ? 'true' : 'false');
    card.appendChild(el('h3', 'cart-drawer__price-breakdown-title tl-card__title', HEADING));
    card.appendChild(el('div', 'cart-drawer__price-breakdown-items tl-card__body'));
    var msg = el('p', 'tl-card__msg');
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');
    card.appendChild(msg);
    return card;
  }

  // ── Cart page block ──────────────────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-tl-benefits]').forEach(function (holder) {
    if (holder.querySelector('[data-tl-mounted]')) return;
    var card = makeCard(false);
    holder.appendChild(card);
    render(card);
  });

  // ── Cart drawer (app embed): directly under "Price Breakdown" ────────────────────────────────
  if (!cfgEl) return;
  var DRAWER = 'cart-drawer, #CartDrawer, .cart-drawer, [id*="CartDrawer"], [class*="cart-drawer"]';

  function mountInDrawer() {
    var drawer = document.querySelector('cart-drawer') || document.querySelector(DRAWER);
    if (!drawer || drawer.querySelector('[data-tl-mounted]')) return;
    var after = drawer.querySelector('.cart-drawer__price-breakdown:not(.tl-card)');
    var card = makeCard(true);
    if (after) {
      after.parentNode.insertBefore(card, after.nextSibling);
    } else {
      // No breakdown card in this theme: above the footer row, never inside it.
      var anchor = drawer.querySelector('.cart__ctas, [name="checkout"], .cart-drawer__footer');
      if (!anchor) return;
      var target = anchor.closest('.cart__ctas') || anchor;
      while (target.parentElement && target.parentElement !== drawer) {
        var cs = window.getComputedStyle(target.parentElement);
        if (cs.display.indexOf('flex') === -1 || cs.flexDirection.indexOf('row') !== 0) break;
        target = target.parentElement;
      }
      target.parentNode.insertBefore(card, target);
    }
    render(card);
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
