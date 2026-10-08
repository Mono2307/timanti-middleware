/*
 * "My benefits" cart block. Lists what the logged-in customer can use — their loyalty benefit and
 * their open vouchers — and applies them as cart discount codes. GoKwik checkout carries the cart's
 * codes through and does not let customers enter codes itself, so the cart is the only place codes
 * are applied.
 *
 * Rules enforced here (Shopify enforces the same through each code's combination settings):
 *   - at most one loyalty code and one voucher on the cart;
 *   - loyalty never sits with a promo code — applying loyalty takes promo codes off.
 *
 * Talks to the middleware through the Shopify app proxy (/apps/loyalty/*), which signs each request
 * with the logged-in customer's id.
 */
(function () {
  var root = document.querySelector('[data-tl-benefits]');
  if (!root || root.getAttribute('data-logged-in') !== 'true') return;
  var body = root.querySelector('[data-tl-body]');
  var msg = root.querySelector('[data-tl-msg]');
  var LOY = /^LOY-/i;
  var VCH = /^VCH/i;

  function inr(v) { return '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN'); }
  function say(text) { if (msg) msg.textContent = text || ''; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function getCart() { return fetch('/cart.js', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function cartCodes(cart) {
    return (cart.discount_codes || []).map(function (d) { return d.code; }).filter(Boolean);
  }
  function setCodes(codes) {
    return fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ discount: codes.join(',') }),
    }).then(function (r) { if (!r.ok) throw new Error('cart'); return r.json(); });
  }
  function done(text) { say(text); setTimeout(function () { window.location.reload(); }, 900); }

  function applyLoyalty(btn) {
    btn.disabled = true;
    say('Applying your loyalty benefit…');
    getCart().then(function (cart) {
      var lines = (cart.items || []).map(function (i) { return { variant_id: i.variant_id, quantity: i.quantity }; });
      return fetch('/apps/loyalty/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ lines: lines }),
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res.ok) { btn.disabled = false; say(res.reason || 'Your benefit could not be applied.'); return; }
        // Keep a voucher if there is one; drop old loyalty codes and any promo code.
        var keep = cartCodes(cart).filter(function (c) { return VCH.test(c); });
        var dropped = cartCodes(cart).filter(function (c) { return !VCH.test(c) && !LOY.test(c); });
        return setCodes(keep.concat([res.code])).then(function () {
          done('Loyalty applied: ' + inr(res.amount) + ' off the diamond value (' + res.rate + '%).' +
            (dropped.length ? ' Promo code ' + dropped.join(', ') + ' was removed — it cannot be combined with loyalty.' : ''));
        });
      });
    }).catch(function () { btn.disabled = false; say('Something went wrong. Please try again.'); });
  }

  function applyVoucher(code, btn) {
    btn.disabled = true;
    getCart().then(function (cart) {
      // One voucher at a time; loyalty and other codes stay.
      var keep = cartCodes(cart).filter(function (c) { return !VCH.test(c); });
      return setCodes(keep.concat([code])).then(function () { done('Voucher ' + code + ' applied.'); });
    }).catch(function () { btn.disabled = false; say('The voucher could not be applied.'); });
  }

  function removeCode(code, btn) {
    btn.disabled = true;
    getCart().then(function (cart) {
      return setCodes(cartCodes(cart).filter(function (c) { return c.toUpperCase() !== code.toUpperCase(); }))
        .then(function () { done(code + ' removed.'); });
    }).catch(function () { btn.disabled = false; say('Could not remove ' + code + '.'); });
  }

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

  Promise.all([fetch('/apps/loyalty/benefits', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }), getCart()])
    .then(function (res) {
      var b = res[0] || {};
      var codes = cartCodes(res[1]);
      body.innerHTML = '';
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
    })
    .catch(function () { body.innerHTML = ''; body.appendChild(el('p', 'tl-benefits__muted', 'Your benefits could not be loaded.')); });
})();
