// A background (timer) refresh starts while the access token is still valid. Reads sent during
// it must not wait for it, and must not be able to cause a second rotation, a stale pair
// overwrite, a false sign-out, or a replayed mutation.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';

const realNow = Date.now, realFetch = globalThis.fetch, realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
let now = realNow(); Date.now = () => now;
const user = { id: 'alice', email: 'alice@example.test' };
const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }; };
const token = (exp, tag = '') => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000), tag })).toString('base64url') + '.signature';
let issued = 0;
const bundle = () => { issued++; return { user, access_token: token(now + 60_000, 'a' + issued), refresh_token: 'refresh-' + issued, expires_at: now + 60_000 }; };
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const timers = [];
globalThis.window = { addEventListener() {} };
globalThis.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
globalThis.clearTimeout = () => {};
const fireRefreshTimer = () => { const t = timers.pop(); assert.ok(t, 'a refresh timer is scheduled'); t.fn(); };

// One programmable fake platform. /refresh blocks until released.
function platform() {
  const st = { refreshes: 0, release: null, refreshStatus: 200, app: [], appStatus: () => 200, appHeaders: () => ({}) };
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input instanceof Request ? input.url : input), 'https://app.test').pathname;
    if (path.endsWith('/login')) return Response.json(bundle());
    if (path.endsWith('/refresh')) {
      st.refreshes++;
      await new Promise(r => { st.release = r; });
      return st.refreshStatus === 200 ? Response.json(bundle()) : Response.json({ error: 'AUTH_INVALID_CREDS' }, { status: st.refreshStatus });
    }
    const h = new Headers(init.headers);
    const call = { method: (init.method ?? 'GET').toUpperCase(), auth: h.get('Authorization'), ride: h.get('X-Refresh-Token'), optOut: h.get('X-No-Auto-Refresh'), credentials: init.credentials };
    st.app.push(call);
    return new Response('{}', { status: st.appStatus(call), headers: st.appHeaders(call) });
  };
  return st;
}

async function signedInHeader() {
  const st = platform();
  const auth = createSomewhereAuth({ mode: 'header', storage: storage(), baseUrl: 'https://app.test' });
  await auth.signIn({ email: user.email, password: 'x' });
  return { st, auth };
}

try {
  // 1. Header mode: a GET during a background refresh goes out at once on the still-valid token,
  //    with the opt-out and WITHOUT the ride-along refresh token.
  {
    const { st, auth } = await signedInHeader();
    const before = token(now + 60_000, 'a' + issued);
    now += 48_000; // 12 s left: the timer refresh has started
    fireRefreshTimer(); await tick();
    assert.equal(st.refreshes, 1);
    const res = await auth.fetch('https://app.test/data');
    assert.equal(res.status, 200, 'answered while the refresh is still pending');
    const call = st.app.at(-1);
    assert.equal(call.auth, 'Bearer ' + before, 'the still-valid token');
    assert.equal(call.optOut, '1');
    assert.equal(call.ride, null, 'no refresh credential rides along, so the server cannot rotate it');
    st.release(); await tick();
  }
  // 2. A mutation still waits for the refresh, so it is sent exactly once, with the new pair.
  {
    const { st, auth } = await signedInHeader();
    now += 48_000; fireRefreshTimer(); await tick();
    const pending = auth.fetch('https://app.test/write', { method: 'POST', body: '{}' });
    await tick(); assert.equal(st.app.length, 0, 'POST not sent while the refresh is pending');
    st.release(); const res = await pending; assert.equal(res.status, 200);
    assert.equal(st.app.length, 1); assert.equal(st.app[0].method, 'POST');
    assert.equal(st.app[0].auth, 'Bearer ' + token(now + 60_000, 'a' + issued), 'sent with the refreshed token');
    assert.equal(st.app[0].optOut, null);
  }
  // 3. Too close to expiry (< 5 s): a GET waits like a demand refresh.
  {
    const { st, auth } = await signedInHeader();
    now += 56_000; fireRefreshTimer(); await tick();
    const pending = auth.fetch('https://app.test/data');
    await tick(); assert.equal(st.app.length, 0, 'GET waits when the token is about to expire');
    st.release(); await pending; assert.equal(st.app.length, 1);
  }
  // 4. Rejected anyway (clock skew): no sign-out while the refresh is pending; after it settles
  //    the read is sent ONCE more with the new token.
  {
    const { st, auth } = await signedInHeader();
    now += 48_000; fireRefreshTimer(); await tick();
    st.appStatus = call => (call.optOut === '1' ? 401 : 200);
    const pending = auth.fetch('https://app.test/data');
    await tick();
    assert.equal(st.app.length, 1); assert.equal(auth.getState().status, 'authenticated', 'not signed out while refresh pends');
    st.release(); const res = await pending;
    assert.equal(res.status, 200); assert.equal(st.app.length, 2, 'exactly one resend');
    assert.equal(st.app[1].auth, 'Bearer ' + token(now + 60_000, 'a' + issued));
    assert.equal(auth.getState().status, 'authenticated');
  }
  // 5. A pair on an overlapping response is never adopted (no stale overwrite of the new pair).
  {
    const { st, auth } = await signedInHeader();
    now += 48_000; fireRefreshTimer(); await tick();
    st.appHeaders = () => ({ 'X-New-Access-Token': token(now + 60_000, 'stale'), 'X-New-Refresh-Token': 'refresh-stale' });
    await auth.fetch('https://app.test/data');
    st.release(); await tick();
    st.appHeaders = () => ({});
    await auth.fetch('https://app.test/data');
    assert.equal(st.app.at(-1).auth, 'Bearer ' + token(now + 60_000, 'a' + issued), 'the refreshed pair, not the overlapping one');
  }
  // 6. If the background refresh itself fails (401), the overlapping read's 401 leads to the
  //    refresh's own sign-out; the read is not resent with a dead pair more than once.
  {
    const { st, auth } = await signedInHeader();
    now += 48_000; fireRefreshTimer(); await tick();
    st.refreshStatus = 401; st.appStatus = () => 401;
    const pending = auth.fetch('https://app.test/data');
    await tick(); st.release();
    const res = await pending;
    assert.equal(res.status, 401);
    assert.equal(auth.getState().status, 'signed-out');
    assert.ok(st.app.length <= 2, 'at most one resend');
  }
  // 7. Cookie mode: the read goes out at once with the browser's cookies and the opt-out, so the
  //    server cannot rotate the cookies in-band and race the refresh's Set-Cookie.
  {
    const st = platform();
    globalThis.fetch = (orig => async (input, init = {}) => {
      const path = new URL(String(input), 'https://app.test').pathname;
      if (path.endsWith('/login')) return Response.json({ user, expires_at: now + 60_000, cookie_session: true });
      if (path.endsWith('/refresh')) { st.refreshes++; await new Promise(r => { st.release = r; }); return Response.json({ user, expires_at: now + 60_000, cookie_session: true }); }
      return orig(input, init);
    })(globalThis.fetch);
    const auth = createSomewhereAuth({ mode: 'cookie', storage: storage(), baseUrl: 'https://app.test' });
    await auth.signIn({ email: user.email, password: 'x' });
    now += 48_000; fireRefreshTimer(); await tick();
    assert.equal(st.refreshes, 1);
    const res = await auth.fetch('https://app.test/data');
    assert.equal(res.status, 200);
    const call = st.app.at(-1);
    assert.equal(call.optOut, '1'); assert.equal(call.credentials, 'include'); assert.equal(call.auth, null);
    st.release(); await tick();
  }
  // 8. Negative control: a DEMAND refresh (token already expired) still blocks every request.
  {
    const { st, auth } = await signedInHeader();
    now += 61_000;
    const pending = auth.fetch('https://app.test/data');
    await tick(); assert.equal(st.refreshes, 1); assert.equal(st.app.length, 0, 'expired token: wait for the refresh');
    st.release(); await pending; assert.equal(st.app.length, 1); assert.equal(st.app[0].optOut, null);
  }
  console.log('PASS valid-token reads during background refresh: no wait, no ride-along, opt-out; mutations and near-expiry wait; skew 401 waits then one resend; no stale pair adopted; refresh failure signs out once; cookie mode opt-out; demand refresh still blocks');
} finally {
  Date.now = realNow; globalThis.fetch = realFetch; globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear; delete globalThis.window;
}
