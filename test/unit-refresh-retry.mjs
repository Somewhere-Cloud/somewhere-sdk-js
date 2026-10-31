// An interrupted refresh is a failed request (audit S2, platform tsk_c09746b9).
// The server (core #1219) accepts a replay of a rotated refresh credential
// within its grace window (10 s on in-band /me, 30 s on POST /refresh) and ends
// only the replayed session after it. So the client keeps no "refresh outcome
// unknown" state, no cross-tab lock and no marker:
//  - a /me or refresh cut mid-flight is a failed request; the next one rotates normally;
//  - a 401 is signed out (no SIGN_IN_REQUIRED, no reconcile probe);
//  - two tabs refreshing at once both succeed and stay signed in;
//  - the refresh-at stamp is only a best-effort de-dupe between tabs;
//  - the client writes no storage key other than the user, the header session,
//    the sign-out intent and the refresh-at stamp.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { somewhereAuth } from '../dist/esm/auth/server.js';

const realNow = Date.now, realFetch = globalThis.fetch, realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
let now = realNow(); Date.now = () => now;
const user = { id: 'alice', email: 'alice@example.test' };
const BASE = 'https://app.test';
const SIGN_OUT_KEY = 'sw_auth_user:sign-out:https://app.test/api/auth';
const ALLOWED_KEYS = new Set(['sw_auth', 'sw_auth_user', 'sw_auth_user:refresh-at', SIGN_OUT_KEY]);
const written = new Set();
const storage = () => {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => { written.add(k); map.set(k, String(v)); }, removeItem: k => map.delete(k), map };
};
const token = (exp) => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url') + '.signature';

// A browser cookie jar shared by every tab, and a server whose rotation follows
// live core in grace mode.
function platform() {
  const tokens = new Map(); // refresh credential -> { sid, rotatedAt }
  const sessions = new Set();
  const jar = { refresh: null, accessExp: 0 };
  const calls = [];
  let n = 0, inflight = 0, maxInflight = 0, cut = null;
  const mint = (sid) => { const t = 'r' + (++n); tokens.set(t, { sid, rotatedAt: null }); return { refresh: t, accessExp: now + 60_000 }; };
  const rotate = (credential, grace) => {
    const row = tokens.get(credential);
    if (!row || !sessions.has(row.sid)) return null;
    if (row.rotatedAt !== null && now - row.rotatedAt > grace) { sessions.delete(row.sid); return null; } // reuse after grace: this session only
    if (row.rotatedAt === null) row.rotatedAt = now;
    return mint(row.sid);
  };
  const handle = (path, sent) => {
    if (path === '/api/auth/login') {
      const sid = 's' + (++n); sessions.add(sid);
      const cookies = mint(sid);
      return { body: { user, cookie_session: true, expires_at: cookies.accessExp }, cookies };
    }
    if (path === '/api/auth/me') {
      if (sent.refresh && sent.accessExp > now && sessions.has(tokens.get(sent.refresh)?.sid)) {
        return { body: { user }, headers: { 'X-Sw-Access-Expires': String(sent.accessExp) } };
      }
      const cookies = sent.refresh && !sent.noRotate ? rotate(sent.refresh, 10_000) : null; // X-No-Auto-Refresh: never rotate
      if (!cookies) return { status: 401, body: { error: 'AUTH_REQUIRED' } };
      return { body: { user }, headers: { 'X-Sw-Access-Expires': String(cookies.accessExp) }, cookies };
    }
    if (path === '/api/auth/refresh') {
      const cookies = sent.refresh ? rotate(sent.refresh, 30_000) : null;
      if (!cookies) return { status: 401, body: { error: 'AUTH_INVALID_CREDS' } };
      return { body: { user, expires_at: cookies.accessExp }, cookies };
    }
    if (path === '/data') return sent.accessExp > now ? { body: { ok: true } } : { status: 401, body: { error: 'AUTH_REQUIRED' } };
    throw new Error('unexpected request ' + path);
  };
  const fetch = async (input, init = {}) => {
    const path = new URL(String(input), BASE).pathname;
    const headers = new Headers(init.headers);
    const sent = { ...jar, noRotate: headers.get('X-No-Auto-Refresh') === '1' }; // the browser attaches the cookies it has when the request is sent
    calls.push({ path, init, headers });
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try {
      await Promise.resolve();
      await Promise.resolve();
      const out = handle(path, sent); // the server commits
      if (cut === path) { cut = null; throw new DOMException('The operation was aborted.', 'AbortError'); } // ... and the response is lost
      if (out.cookies) Object.assign(jar, out.cookies);
      return Response.json(out.body, { status: out.status ?? 200, headers: out.headers });
    } finally { inflight--; }
  };
  return {
    fetch, calls, jar, sessions,
    cutNext(path) { cut = path; },
    count: (path) => calls.filter(c => c.path === path).length,
    get maxInflight() { return maxInflight; },
  };
}

const assertOnlyAllowedKeys = () => {
  for (const k of written) assert.ok(ALLOWED_KEYS.has(k), 'unexpected storage key written: ' + k);
};
const noOptOut = (calls) => assert.ok(calls.every(c => c.headers.get('X-No-Auto-Refresh') === null), 'no non-rotating probe');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok   ' + name); };

try {
  await test('a /me cut mid-flight on page 1, then a normal page 2 boot: signed in (no SIGN_IN_REQUIRED, no marker)', async () => {
    const s = storage(); const p = platform(); globalThis.fetch = p.fetch;
    await createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE }).signIn({ email: user.email, password: 'x' });
    now += 61_000; // the access cookie expired: page 1's boot /me rotates in-band
    p.cutNext('/api/auth/me'); // ... the server committed the rotation, the navigation lost the response
    const page1 = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
    await page1.getUser();
    assert.equal(page1.getState().status, 'indeterminate', 'a lost response is a failed check, not a sign-out');
    now += 1_000;
    const page2 = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
    assert.deepEqual(await page2.getUser(), user);
    const state = page2.getState();
    assert.equal(state.status, 'authenticated');
    assert.equal(state.error, null);
    assert.equal(p.count('/api/auth/me'), 2, 'one /me per page');
    noOptOut(p.calls);
    assert.equal(s.getItem('sw_auth_user:refresh-pending'), null);
    assertOnlyAllowedKeys();
  });

  await test('the same cut, page 2 after the grace window: the server ends that session; plain signed-out', async () => {
    const s = storage(); const p = platform(); globalThis.fetch = p.fetch;
    await createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE }).signIn({ email: user.email, password: 'x' });
    now += 61_000;
    p.cutNext('/api/auth/me');
    await createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE }).getUser();
    now += 15_000;
    const page2 = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
    assert.equal(await page2.getUser(), null);
    assert.equal(page2.getState().status, 'signed-out');
    assert.equal(page2.getState().error, null, 'a 401 is signed out, nothing more');
    assertOnlyAllowedKeys();
  });

  await test('an aborted refresh is a failed request: never signed out, and the next request just tries again', async () => {
    const s = storage(); const p = platform(); globalThis.fetch = p.fetch;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
    await auth.signIn({ email: user.email, password: 'x' });
    now += 61_000;
    p.cutNext('/api/auth/refresh');
    await assert.rejects(auth.fetch(BASE + '/data'), e => e.name === 'AbortError');
    assert.notEqual(auth.getState().status, 'signed-out');
    now += 2_000;
    const res = await auth.fetch(BASE + '/data');
    assert.equal(res.status, 200);
    assert.equal(p.count('/api/auth/refresh'), 2, 'tried again, with the same credential (accepted within grace)');
    assert.equal(auth.getState().status, 'authenticated');
    assertOnlyAllowedKeys();
  });

  await test('a refresh that times out (mutation deadline) is bounded, and the next request tries again', async () => {
    const s = storage(); const p = platform();
    globalThis.fetch = p.fetch;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE, mutationTimeoutMs: 30 });
    await auth.signIn({ email: user.email, password: 'x' });
    now += 61_000;
    globalThis.fetch = (input, init = {}) => new URL(String(input), BASE).pathname === '/api/auth/refresh'
      ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      : p.fetch(input, init);
    await assert.rejects(auth.fetch(BASE + '/data'), e => e.code === 'AUTH_TIMEOUT');
    globalThis.fetch = p.fetch;
    assert.equal((await auth.fetch(BASE + '/data')).status, 200);
    assert.equal(auth.getState().status, 'authenticated');
  });

  await test('cookie refresh is a cancellable POST (no keepalive), so it cannot outlive its document', async () => {
    const p = platform(); globalThis.fetch = p.fetch;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: storage(), baseUrl: BASE });
    await auth.signIn({ email: user.email, password: 'x' });
    now += 61_000;
    assert.equal((await auth.fetch(BASE + '/data')).status, 200);
    const refresh = p.calls.find(c => c.path === '/api/auth/refresh');
    assert.equal(refresh.init.method, 'POST');
    assert.equal(refresh.init.keepalive, false);
  });

  await test('a definitive 401 from refresh signs out', async () => {
    const p = platform(); globalThis.fetch = p.fetch;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: storage(), baseUrl: BASE });
    await auth.signIn({ email: user.email, password: 'x' });
    p.sessions.clear(); // ended on the server
    now += 61_000;
    await auth.fetch(BASE + '/data').catch(() => undefined);
    assert.equal(auth.getState().status, 'signed-out');
    assert.equal(auth.getState().error, null);
  });

  await test('two tabs refreshing in the same second both succeed, take no lock, and stay signed in', async () => {
    const s = storage(); const p = platform(); globalThis.fetch = p.fetch;
    const lockCalls = [];
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (...a) => { lockCalls.push(a[0]); return Promise.reject(new Error('no lock expected')); } } } });
    try {
      const tabA = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
      await tabA.signIn({ email: user.email, password: 'x' });
      const tabB = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
      assert.deepEqual(await tabB.getUser(), user);
      now += 61_000;
      const [a, b] = await Promise.all([tabA.fetch(BASE + '/data'), tabB.fetch(BASE + '/data')]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      assert.equal(p.count('/api/auth/refresh'), 2, 'both tabs refreshed');
      assert.ok(p.maxInflight >= 2, 'concurrently: nothing serialised them across tabs');
      assert.equal(tabA.getState().status, 'authenticated');
      assert.equal(tabB.getState().status, 'authenticated');
      now += 120_000;
      assert.equal((await tabA.fetch(BASE + '/data')).status, 200);
      assert.equal((await tabB.fetch(BASE + '/data')).status, 200);
      assert.deepEqual(await tabA.getUser(), user);
      assert.deepEqual(await tabB.getUser(), user);
      assert.equal(tabA.getState().status, 'authenticated', 'still signed in two minutes later');
      assert.equal(tabB.getState().status, 'authenticated');
      assert.deepEqual(lockCalls, [], 'no Web Lock requested');
      assertOnlyAllowedKeys();
    } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator; }
  });

  await test('the refresh-at stamp still de-dupes: a tab that sees a recent refresh skips its own', async () => {
    const s = storage(); const p = platform(); globalThis.fetch = p.fetch;
    const tabA = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
    await tabA.signIn({ email: user.email, password: 'x' });
    const tabB = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
    await tabB.getUser();
    now += 61_000;
    assert.equal((await tabA.fetch(BASE + '/data')).status, 200);
    assert.ok(Number(s.getItem('sw_auth_user:refresh-at')) > now, 'stamp written');
    assert.equal((await tabB.fetch(BASE + '/data')).status, 200);
    assert.equal(p.count('/api/auth/refresh'), 1, 'tab B used the cookies tab A refreshed');
  });

  await test('header mode: a refresh lost to the network is tried again on the next request', async () => {
    let refreshes = 0, fail = true;
    const bundle = () => ({ user, access_token: token(now + 60_000), refresh_token: 'refresh-' + now, expires_at: now + 60_000 });
    globalThis.fetch = async (input) => {
      const path = new URL(String(input), BASE).pathname;
      if (path.endsWith('/login')) return Response.json(bundle());
      if (path.endsWith('/refresh')) { refreshes++; if (fail) throw new TypeError('network after commit'); return Response.json(bundle()); }
      return Response.json({ ok: true });
    };
    const s = storage();
    const auth = createSomewhereAuth({ mode: 'header', storage: s, baseUrl: BASE });
    await auth.signIn({ email: user.email, password: 'x' });
    now += 61_000;
    await assert.rejects(auth.fetch(BASE + '/data'));
    assert.notEqual(auth.getState().status, 'signed-out');
    fail = false;
    assert.equal((await auth.fetch(BASE + '/data')).status, 200);
    assert.equal(refreshes, 2);
    assert.equal(auth.getState().status, 'authenticated');
    assertOnlyAllowedKeys();
  });

  await test('a pending sign-out writes only the intent key; nothing else', async () => {
    const s = storage(); const p = platform(); globalThis.fetch = p.fetch;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: BASE });
    await auth.signIn({ email: user.email, password: 'x' });
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    await auth.signOut();
    assert.ok(s.getItem(SIGN_OUT_KEY)?.startsWith('pending:'), 'owed sign-out kept for retry after reload');
    assertOnlyAllowedKeys();
  });

  await test('a sign-in reply without an expiry schedules no immediate refresh', async () => {
    const timers = [];
    globalThis.window = { addEventListener() {} };
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
    globalThis.clearTimeout = () => {};
    try {
      const paths = [];
      globalThis.fetch = async (input) => { paths.push(new URL(String(input), BASE).pathname); return Response.json({ user, cookie_session: true }); };
      const auth = createSomewhereAuth({ mode: 'cookie', storage: storage(), baseUrl: BASE });
      await auth.verifyMagicLink({ token: 'link' });
      assert.equal(auth.getState().status, 'authenticated');
      assert.ok(!timers.includes(0), 'no refresh at 0 ms: ' + JSON.stringify(timers));
      assert.ok(!paths.some(p => p.endsWith('/refresh')));
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
      const res = await somewhereAuth(new Request(BASE + '/api/auth/magic-link/verify', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Sw-Auth-Mode': 'cookie', Origin: BASE }, body: JSON.stringify({ token: 'link' }),
      }), sw);
      const body = await res.json();
      assert.equal(body.cookie_session, true); assert.equal(set.length, 1);
      assert.equal(body.expires_at, Math.floor(exp / 1000) * 1000, 'expires_at from the issued access token');
    }
    const sw = { auth: { verifyOtp: async () => ({ user, access_token: 'opaque', refresh_token: 'r', expires_in: 60 }), setSessionCookies() {} } };
    const res = await somewhereAuth(new Request(BASE + '/api/auth/magic-link/verify', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Sw-Auth-Mode': 'cookie', Origin: BASE }, body: JSON.stringify({ token: 'link' }),
    }), sw);
    assert.equal((await res.json()).expires_at, now + 60_000, "else from the issuer's expires_in");
  });
} finally {
  Date.now = realNow; globalThis.fetch = realFetch;
}
console.log(`PASS refresh retry: ${passed} scenarios`);
