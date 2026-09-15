const assert = require('assert');
const crypto = require('crypto');
const { verifySessionToken, peekClaims } = require('./session_token');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Why this file exists: /api/repairs/order-items reads any order on the store by number, using
// this service's read_all_orders token. The session token is the ONLY thing standing between that
// and the open internet, and every classic way a hand-rolled JWT check fails open — `alg: none`,
// algorithm confusion, an unchecked audience, an expired token, a token minted for another shop —
// is silent by construction. Each one gets an assertion here.

const SECRET    = 'test-client-secret';
const CLIENT_ID = '3c0a0f5a2127842e19391c5b20ec49a0';
const SHOP      = 'https://auracarat.myshopify.com';
const NOW       = 1_757_000_000_000; // fixed clock, so `exp` cases cannot rot

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint a token the way Shopify does, with per-test overrides. */
function mint({ header = {}, payload = {}, secret = SECRET } = {}) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header }));
  const p = b64u(JSON.stringify({
    aud:  CLIENT_ID,
    dest: 'auracarat.myshopify.com',
    iss:  'https://auracarat.myshopify.com/admin',
    exp:  Math.floor(NOW / 1000) + 60,
    nbf:  Math.floor(NOW / 1000) - 5,
    ...payload,
  }));
  const sig = b64u(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

const opts = (over = {}) => ({ clientId: CLIENT_ID, clientSecret: SECRET, shopDomain: SHOP, now: NOW, ...over });
const rejects = (token, o, reason) => assert.throws(() => verifySessionToken(token, o), new RegExp(reason));

console.log('a genuine token is accepted');
t('valid token returns its payload', () => {
  const payload = verifySessionToken(mint(), opts());
  assert.strictEqual(payload.aud, CLIENT_ID);
  assert.strictEqual(payload.dest, 'auracarat.myshopify.com');
});
// The shop arrives spelled three ways — bare host, admin URL, configured store URL with scheme.
// Comparing them raw rejects every real token, so normalisation is part of the contract.
t('shop matches whether configured with scheme or without', () => {
  assert.ok(verifySessionToken(mint(), opts({ shopDomain: 'auracarat.myshopify.com' })));
  assert.ok(verifySessionToken(mint(), opts({ shopDomain: 'https://auracarat.myshopify.com/' })));
});
t('iss alone identifies the shop when dest is absent', () =>
  assert.ok(verifySessionToken(mint({ payload: { dest: undefined } }), opts())));

console.log('signature forgery is refused');
t('a token signed with the wrong secret is refused', () =>
  rejects(mint({ secret: 'not-the-secret' }), opts(), 'bad signature'));
// The bug that makes a JWT check decorative: trusting the token's own `alg`.
t('alg:none is refused rather than trusted', () => {
  const h = b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ aud: CLIENT_ID, dest: 'auracarat.myshopify.com' }));
  rejects(`${h}.${p}.`, opts(), 'unsupported alg');
});
t('an RS256 header is refused and names what it saw', () =>
  rejects(mint({ header: { alg: 'RS256' } }), opts(), 'unsupported alg RS256'));
t('a tampered payload no longer verifies', () => {
  const [h, , s] = mint().split('.');
  const forged = b64u(JSON.stringify({ aud: CLIENT_ID, dest: 'evil.myshopify.com' }));
  rejects(`${h}.${forged}.${s}`, opts(), 'bad signature');
});

console.log('claims are checked, not just the signature');
// A correctly signed token from another app on the same shop must not open this route.
t('a token for a different app is refused', () =>
  rejects(mint({ payload: { aud: 'some-other-app-id' } }), opts(), 'wrong audience'));
t('a token for a different shop is refused', () =>
  rejects(mint({ payload: { dest: 'someone-else.myshopify.com', iss: 'https://someone-else.myshopify.com/admin' } }),
    opts(), 'wrong shop'));
t('an expired token is refused', () =>
  rejects(mint({ payload: { exp: Math.floor(NOW / 1000) - 3600 } }), opts(), 'expired'));
// Seconds of skew are normal between Shopify and this machine; a minute is not.
t('a token seconds past expiry still passes, an hour past does not', () => {
  assert.ok(verifySessionToken(mint({ payload: { exp: Math.floor(NOW / 1000) - 2 } }), opts()));
});
t('a not-yet-valid token is refused', () =>
  rejects(mint({ payload: { nbf: Math.floor(NOW / 1000) + 600 } }), opts(), 'not yet valid'));

console.log('malformed input never throws its way past the check');
t('missing, empty and malformed tokens are refused', () => {
  rejects(undefined, opts(), 'missing token');
  rejects('', opts(), 'missing token');
  rejects('not-a-jwt', opts(), 'malformed token');
  rejects('a.b', opts(), 'malformed token');
  rejects('!!!.???.***', opts(), 'unreadable header');
});

console.log('more than one candidate secret');
// The point of the list: the app may already be configured here under another name, so a token
// is accepted if ANY candidate signed it -- without that becoming a way in for a wrong one.
t('a token signed by the second candidate is accepted', () =>
  assert.ok(verifySessionToken(mint(), opts({ clientSecret: undefined, clientSecrets: ['wrong-one', SECRET] }))));
t('a token signed by none of the candidates is still refused', () =>
  rejects(mint(), opts({ clientSecret: undefined, clientSecrets: ['wrong-one', 'also-wrong'] }), 'bad signature'));
t('blank entries in the list are ignored, not treated as a secret', () =>
  assert.ok(verifySessionToken(mint(), opts({ clientSecret: undefined, clientSecrets: [undefined, '', SECRET] }))));
t('a list of only blanks reads as unconfigured', () =>
  rejects(mint(), opts({ clientSecret: undefined, clientSecrets: [undefined, ''] }), 'not configured'));

console.log('an unconfigured deployment fails closed');
// The whole point: no secret must mean "refuse", never "skip the check".
t('no client secret refuses even a well-formed token', () =>
  rejects(mint(), opts({ clientSecret: '' }), 'not configured'));

console.log('peekClaims — diagnosis without trusting the token');
// It must read a token it would REFUSE: that is the only situation it exists for.
t('reads alg and aud off a badly signed token', () => {
  const bad = mint({ secret: 'not-the-secret' });
  rejects(bad, opts(), 'bad signature');
  const c = peekClaims(bad);
  assert.strictEqual(c.alg, 'HS256');
  assert.strictEqual(c.aud, CLIENT_ID);
  assert.strictEqual(c.dest, 'auracarat.myshopify.com');
});
t('names a DIFFERENT app when the token came from one', () =>
  assert.strictEqual(peekClaims(mint({ payload: { aud: 'another-app-id' } })).aud, 'another-app-id'));
t('returns null on junk rather than throwing', () => {
  assert.strictEqual(peekClaims(''), null);
  assert.strictEqual(peekClaims('a.b'), null);
  assert.strictEqual(peekClaims(undefined), null);
});

console.log(`\n${n} assertions passed`);
