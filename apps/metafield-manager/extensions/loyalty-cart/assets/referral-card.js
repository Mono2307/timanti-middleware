/*
 * Timanti "Refer a friend" card (theme app block, for a page such as /pages/refer).
 *
 * Reads the logged-in customer's link through the app proxy (GET /apps/loyalty/referral →
 * src/modules/loyalty/referral.js viewFor). KwikPass logs the customer in on the storefront, so
 * Liquid's `customer` and the proxy's logged_in_customer_id both work here; the customer-account
 * pages are not involved.
 *
 *   Refer a friend
 *   Share your link. When a friend makes their first purchase, you get 10% off …
 *   [ timanti.in/?ref=PRIYA7K ]  [ Copy ]
 *   [ Share on WhatsApp ]  [ Share ]          (Share only where the phone offers it)
 *   1 reward ready to use · till 12 Nov 2027
 *   Friends who shopped: 2
 */
(function () {
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function date(iso) { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fill(t, v) { return String(t || '').replace(/\[pct\]/g, v.pct).replace(/\[link\]/g, v.link || ''); }

  function render(card) {
    var body = card.querySelector('.tl-ref__body');
    var loggedIn = card.getAttribute('data-logged-in') === 'true';
    function show(nodes) { body.innerHTML = ''; nodes.forEach(function (n) { body.appendChild(n); }); }
    function note(text) { return el('p', 'tl-ref__muted', text); }

    if (!loggedIn) {
      var login = el('a', 'button tl-ref__btn', 'Log in');
      login.href = card.getAttribute('data-login-url') || '/account/login';
      show([note('Log in to get your referral link.'), login]);
      return;
    }
    fetch('/apps/loyalty/referral', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        if (!v || v.error || v.found === false) { show([note('Your referral link is not available right now. Please try again later.')]); return; }
        if (!v.enabled) { show([note('Referrals are paused at the moment.')]); return; }
        if (!v.eligible && v.reason === 'first-purchase') {
          show([note('Your referral link unlocks after your first Timanti purchase.')]);
          return;
        }
        if (!v.eligible && v.reason === 'top-tier') {
          show([note('As a ' + (v.tierName || 'top-tier') + ' member, your loyalty benefit already gives you more than a referral reward, so referral links are not offered on your tier.')]);
          return;
        }
        if (!v.eligible) { show([note('Your referral link is not available right now.')]); return; }

        var nodes = [el('p', 'tl-ref__intro', fill(card.getAttribute('data-intro'), v))];

        var linkRow = el('div', 'tl-ref__row');
        var input = el('input', 'field__input tl-ref__link');
        input.type = 'text'; input.readOnly = true; input.value = v.link; input.setAttribute('aria-label', 'Your referral link');
        input.addEventListener('focus', function () { input.select(); });
        var copy = el('button', 'button button--secondary tl-ref__btn', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', function () {
          var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 2000); };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v.link).then(done, function () { input.select(); });
          else { input.select(); try { document.execCommand('copy'); done(); } catch (e) { /* the text is selected */ } }
        });
        linkRow.appendChild(input); linkRow.appendChild(copy);
        nodes.push(linkRow);

        var message = fill(card.getAttribute('data-share-text'), v);
        if (message.indexOf(v.link) === -1) message += ' ' + v.link;
        var shareRow = el('div', 'tl-ref__row');
        var wa = el('a', 'button tl-ref__btn', 'Share on WhatsApp');
        wa.href = 'https://wa.me/?text=' + encodeURIComponent(message);
        wa.target = '_blank'; wa.rel = 'noopener';
        shareRow.appendChild(wa);
        if (navigator.share) {
          var more = el('button', 'button button--secondary tl-ref__btn', 'Share');
          more.type = 'button';
          more.addEventListener('click', function () { navigator.share({ text: message }).catch(function () { /* closed */ }); });
          shareRow.appendChild(more);
        }
        nodes.push(shareRow);

        if (v.available > 0) {
          var soonest = v.rewards && v.rewards[0] && v.rewards[0].expires_at;
          nodes.push(el('p', 'tl-ref__reward',
            v.available + (v.available === 1 ? ' reward' : ' rewards') + ' ready to use: ' + v.pct + '% off the diamond value' +
            (soonest ? ' · use by ' + date(soonest) : '') + '. It applies at checkout or in store.'));
        }
        nodes.push(note('Friends who shopped: ' + (v.friends || 0) + '. Each reward works on one purchase for ' + v.months +
          ' months and does not combine with your loyalty benefit: we apply whichever saves you more.'));
        show(nodes);
      })
      .catch(function () { show([note('Your referral link is not available right now. Please try again later.')]); });
  }

  document.querySelectorAll('[data-tl-referral]').forEach(function (card) {
    if (card.getAttribute('data-tl-mounted')) return;
    card.setAttribute('data-tl-mounted', 'true');
    render(card);
  });
})();
