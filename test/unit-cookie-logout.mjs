/**
 * Cookie-mode sign-out answers 2xx only for a confirmed revocation (tsk_8d8751a9).
 *
 * The packaged handler's POST /logout in cookie mode calls the runtime's
 * sw.auth.logoutWithCookie. Only its { ok: true } is a confirmed sign-out. A
 * thrown refusal keeps its code (and its status when 4xx); any other failure or
 * a malformed answer is a non-2xx "Could not confirm sign-out." Without the
 * helper the handler refuses before calling anything.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { somewhereAuth } from '@somewhere-cloud/sdk/server';

const err = (code, status, extra = {}) => Object.assign(new Error(`platform ${code}`), { code, status, ...extra });
const logoutRequest = (headers = {}) => new Request('https://app.somewhere.site/api/auth/logout', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: '__Host-token=a; __Host-sw_refresh_token=r', ...headers },
});

function platform(helper) {
  const calls = [];
  const auth = {
    async logout(opts) { calls.push(['logout', opts]); return { logged_out: true }; },
    async fromRequest() { return null; },
  };
  if (helper) auth.logoutWithCookie = async (req) => { calls.push(['logoutWithCookie']); return helper(req); };
  return { sw: { auth }, calls };
}

async function signOut(helper, headers) {
  const p = platform(helper);
  const res = await somewhereAuth(logoutRequest(headers), p.sw);
  return { status: res.status, body: await res.json(), calls: p.calls };
}

test('confirmed revocation answers ok', async () => {
  const r = await signOut(async () => ({ ok: true }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(r.calls, [['logoutWithCookie']]);
});

test('a request with no auth cookies: the helper\'s local cleanup still answers ok', async () => {
  const r = await signOut(async () => ({ ok: true }), { Cookie: '' });
  assert.equal(r.status, 200);
});

for (const [label, thrown, status, code] of [
  ['network failure', new TypeError('fetch failed'), 502, 'SIGN_OUT_FAILED'],
  ['platform 5xx', err('UPSTREAM_ERROR', 503), 502, 'UPSTREAM_ERROR'],
  ['SESSION_NOT_FOUND', err('SESSION_NOT_FOUND', 404), 404, 'SESSION_NOT_FOUND'],
  ['missing refresh with an access cookie', err('LOGOUT_REFRESH_REQUIRED', 400), 400, 'LOGOUT_REFRESH_REQUIRED'],
  ['unconfirmed revocation', err('SIGN_OUT_UNCONFIRMED', 502), 502, 'SIGN_OUT_UNCONFIRMED'],
  ['visitor failure after a confirmed account revocation', err('VISITOR_SIGN_OUT_UNCONFIRMED', 503, { partial: true }), 502, 'VISITOR_SIGN_OUT_UNCONFIRMED'],
]) {
  test(`${label} is never a 2xx and keeps its code`, async () => {
    const r = await signOut(async () => { throw thrown; });
    assert.equal(r.status, status);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, code);
    assert.equal(r.body.message, 'Could not confirm sign-out.');
  });
}

for (const [label, answer] of [['empty object', {}], ['ok: false', { ok: false }], ['undefined', undefined], ['ok: "true"', { ok: 'true' }]]) {
  test(`a malformed helper answer (${label}) is unconfirmed`, async () => {
    const r = await signOut(async () => answer);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'SIGN_OUT_UNCONFIRMED');
    assert.equal(r.body.message, 'Could not confirm sign-out.');
  });
}

test('without the cookie helper the handler refuses and calls nothing', async () => {
  const r = await signOut(null);
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'COOKIE_SESSION_UNAVAILABLE');
  assert.deepEqual(r.calls, [], 'never falls back to logout({})');
});

test('the header path is unchanged: X-Refresh-Token revokes through logout, not the cookie helper', async () => {
  const r = await signOut(async () => ({ ok: true }), { Cookie: '', Authorization: 'Bearer a', 'X-Refresh-Token': 'r' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls, [['logout', { refresh_token: 'r' }]]);
});
