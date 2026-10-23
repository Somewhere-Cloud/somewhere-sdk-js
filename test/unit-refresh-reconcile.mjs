// A refresh whose outcome is unknown (pfb_01e440702f31): the magic-link landing refreshed at once
// for want of an expiry, location.replace cut it off, and the orphaned ':refresh-pending' marker left
// every later page 'indeterminate' with Retry doing nothing. Now:
//  - every cookie-mode session reply carries the issued expiry, and an unknown expiry never
//    schedules an immediate refresh;
//  - an orphaned marker or an uncertain refresh is reconciled by a /me that cannot rotate: a
//    still-valid access credential keeps the user (used, never rotated); one that no longer answers
//    clears the dead local marker/session and asks for a sign-in; an unanswered probe stays
//    indeterminate and the next getUser() probes again.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { somewhereAuth } from '../dist/esm/auth/server.js';

const realNow = Date.now, realFetch = globalThis.fetch, realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
let now = realNow(); Date.now = () => now;
const user = { id: 'alice', email: 'alice@example.test' };
const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map }; };
const token = (exp) => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url') + '.signature';
const MARKER = 'sw_auth_user:refresh-pending';
const calls = [];
const route = (handlers) => async (input, init = {}) => {
  const path = new URL(String(input), 'https://app.test').pathname;
  const headers = new Headers(init.headers);
  calls.push({ path, headers });
  const h = handlers[path];
  if (!h) throw new Error('unexpected request ' + path);
  return h(headers);
};
const meWith = (body, status = 200, extra = {}) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
// A refresh cut off `agoMs` ago (a page change or timeout mid-request): its marker records when it began.
const orphaned = (agoMs = 120_000) => { const s = storage(); s.setItem(MARKER, String(now - agoMs) + ':0.5'); s.setItem('sw_auth_user', JSON.stringify(user)); return s; };
let passed = 0;
const test = async (name, fn) => { calls.length = 0; await fn(); passed++; console.log('  ok   ' + name); };

try {
  await test('orphaned marker, the PRE-refresh access still answers: signed in on a non-rotating /me; used, never rotated', async () => {
    // Cut off 5 s ago; the held access was issued before that refresh (it expires 8 s from now), so the
    // refresh credential beside it may be the one the cut-off refresh rotated: the outcome stays unknown.
    const s = orphaned(5_000);
    globalThis.fetch = route({
      '/api/auth/me': meWith({ user }, 200, { 'X-Sw-Access-Expires': String(now + 8_000) }),
      '/data': () => Response.json({ ok: true }),
    });
    const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: 'https://app.test' });
    assert.deepEqual(await auth.getUser(), user);
    assert.equal(auth.getState().status, 'authenticated');
    assert.equal(calls.length, 1); assert.equal(calls[0].headers.get('X-No-Auto-Refresh'), '1'); assert.equal(calls[0].headers.get('X-Refresh-Token'), null);
    const res = await auth.fetch('https://app.test/data');
    assert.equal(res.status, 200);
    assert.equal(calls[1].headers.get('X-No-Auto-Refresh'), '1', 'requests ride the valid access without rotating');
    assert.ok(!calls.some(c => c.path.endsWith('/refresh')), 'never /refresh while the outcome is unknown');
    assert.ok(s.getItem(MARKER), 'the marker stays: the refresh credential is still unconfirmed');
  });

  await test('orphaned marker, the access was RE-ISSUED after the refresh began (keepalive delivered its cookies): the outcome is known, normal refresh resumes', async () => {
    // Cut off 5 s ago, but the access answering now expires 55 s from now: it was issued after that refresh
    // began, and the runtime writes the access and refresh cookies as one pair, so the jar holds that pair.
    const s = orphaned(5_000);
    globalThis.fetch = route({
      '/api/auth/me': meWith({ user }, 200, { 'X-Sw-Access-Expires': String(now + 55_000) }),
      '/data': () => Response.json({ ok: true }),
    });
    const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: 'https://app.test' });
    assert.deepEqual(await auth.getUser(), user);
    assert.equal(auth.getState().status, 'authenticated');
    assert.equal(calls[0].headers.get('X-No-Auto-Refresh'), '1', 'the reconciling probe itself never rotates');
    assert.equal(s.getItem(MARKER), null, 'the unknown outcome is resolved: the marker is cleared');
    const res = await auth.fetch('https://app.test/data');
    assert.equal(res.status, 200);
    assert.equal(calls[1].headers.get('X-No-Auto-Refresh'), null, 'requests go out the normal way again');
  });

  await test('orphaned marker, access no longer answers: the dead marker and session are cleared and a sign-in is asked for', async () => {
    for (const reply of [meWith({ user: null }), meWith({ error: 'AUTH_REQUIRED' }, 401)]) {
      const s = orphaned();
      globalThis.fetch = route({ '/api/auth/me': reply });
      const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: 'https://app.test' });
      assert.equal(await auth.getUser(), null);
      const state = auth.getState();
      assert.equal(state.status, 'signed-out');
      assert.equal(state.error?.code, 'SIGN_IN_REQUIRED', 'an actionable sign-in, not a silent loop');
      assert.equal(s.getItem(MARKER), null); assert.equal(s.getItem('sw_auth_user'), null);
    }
  });

  await test('Retry is never a permanent no-op: an unanswered probe stays indeterminate and the next getUser() probes again', async () => {
    const s = orphaned();
    let online = false;
    globalThis.fetch = route({ '/api/auth/me': () => { if (!online) throw new TypeError('offline'); return Response.json({ user }); } });
    const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: 'https://app.test' });
    await auth.getUser();
    assert.equal(auth.getState().status, 'indeterminate');
    online = true;
    assert.deepEqual(await auth.getUser(), user, 'Retry reaches the server');
    assert.equal(calls.filter(c => c.path === '/api/auth/me').length, 2);
    assert.ok(calls.every(c => c.headers.get('X-No-Auto-Refresh') === '1'));
  });

  await test('a sign-in reply without an expiry schedules no immediate refresh', async () => {
    const timers = [];
    globalThis.window = { addEventListener() {} };
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
    globalThis.clearTimeout = () => {};
    try {
      globalThis.fetch = route({ '/api/auth/magic-link/verify': () => Response.json({ user, cookie_session: true }) });
      const auth = createSomewhereAuth({ mode: 'cookie', storage: storage(), baseUrl: 'https://app.test' });
      await auth.verifyMagicLink?.({ token: 'link' }) ?? assert.fail('verifyMagicLink missing');
      assert.equal(auth.getState().status, 'authenticated');
      assert.ok(!timers.includes(0), 'no refresh at 0 ms: ' + JSON.stringify(timers));
      assert.ok(!calls.some(c => c.path.endsWith('/refresh')));
    } finally { delete globalThis.window; globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear; }
  });

  await test('server: a cookie-mode session reply carries the issued expiry even when the runtime gave none', async () => {
    const exp = now + 60_000;
    for (const bundle of [
      { user, access_token: token(exp), refresh_token: 'r' },
      { data: { user, token: token(exp), refresh_token: 'r' } },
    ]) {
      const set = [];
      const sw = { auth: { verifyOtp: async () => bundle, setSessionCookies: (a, r) => set.push([a, r]) } };
      const res = await somewhereAuth(new Request('https://app.test/api/auth/magic-link/verify', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Sw-Auth-Mode': 'cookie', Origin: 'https://app.test' }, body: JSON.stringify({ token: 'link' }),
      }), sw);
      const body = await res.json();
      assert.equal(body.cookie_session, true); assert.equal(set.length, 1);
      assert.equal(body.expires_at, Math.floor(exp / 1000) * 1000, 'expires_at from the issued access token');
    }
    const sw = { auth: { verifyOtp: async () => ({ user, access_token: 'opaque', refresh_token: 'r', expires_in: 60 }), setSessionCookies() {} } };
    const res = await somewhereAuth(new Request('https://app.test/api/auth/magic-link/verify', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Sw-Auth-Mode': 'cookie', Origin: 'https://app.test' }, body: JSON.stringify({ token: 'link' }),
    }), sw);
    assert.equal((await res.json()).expires_at, now + 60_000, "else from the issuer's expires_in");
  });
} finally {
  Date.now = realNow; globalThis.fetch = realFetch;
}
console.log(`PASS refresh reconcile: ${passed} scenarios`);
