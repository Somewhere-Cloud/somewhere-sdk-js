// A refresh cut off after the server may have committed its rotation (platform tsk_8c5a0244 tcm_53f1f276).
// MITIGATION only, not full network-loss recovery and not a proven fix for the Journey incident:
//  - the refresh POST is sent with keepalive, so a page change no longer cancels it and its Set-Cookie can land;
//  - an interrupted, aborted or timed-out refresh stays OUTCOME-UNKNOWN (indeterminate), never a sign-out,
//    and is never retried by the client; only a definitive 401/403 signs out;
//  - another tab sharing the storage never starts a second rotation while that outcome is unknown;
//  - the next page resolves the outcome WITHOUT rotating when the access answering was re-issued after the
//    refresh began (keepalive delivered the pair), and resumes the normal refresh.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';

const realNow = Date.now, realFetch = globalThis.fetch;
let now = realNow(); Date.now = () => now;
const user = { id: 'alice', email: 'alice@example.test' };
const MARKER = 'sw_auth_user:refresh-pending';
const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map }; };
const calls = [];
const route = (handlers) => async (input, init = {}) => {
  const path = new URL(String(input), 'https://app.test').pathname;
  calls.push({ path, init, headers: new Headers(init.headers) });
  const h = handlers[path];
  if (!h) throw new Error('unexpected request ' + path);
  return h(init);
};
const session = () => Response.json({ user, cookie_session: true, expires_at: now + 60_000 });
const refreshes = () => calls.filter(c => c.path === '/api/auth/refresh').length;
async function signedIn(s = storage(), extra = {}) {
  globalThis.fetch = route({ '/api/auth/login': session });
  const auth = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: 'https://app.test', ...extra });
  await auth.signIn({ email: user.email, password: 'test' });
  assert.equal(auth.getState().status, 'authenticated');
  return { auth, s };
}
let passed = 0;
const test = async (name, fn) => { calls.length = 0; await fn(); passed++; console.log('  ok   ' + name); };

try {
  await test('the refresh POST is sent with keepalive (a page change no longer cancels it)', async () => {
    const { auth } = await signedIn();
    now += 61_000;
    globalThis.fetch = route({ '/api/auth/refresh': session, '/data': () => Response.json({ ok: true }) });
    assert.equal((await auth.fetch('https://app.test/data')).status, 200);
    const refresh = calls.find(c => c.path === '/api/auth/refresh');
    assert.ok(refresh, 'a demand refresh ran');
    assert.equal(refresh.init.keepalive, true);
    assert.equal(refresh.init.method, 'POST');
  });

  await test('an aborted refresh (page change, client gone) is OUTCOME-UNKNOWN: indeterminate, never signed-out, never retried', async () => {
    const { auth, s } = await signedIn();
    now += 61_000;
    globalThis.fetch = route({ '/api/auth/refresh': () => { throw new DOMException('The operation was aborted.', 'AbortError'); } });
    await assert.rejects(auth.fetch('https://app.test/data'));
    assert.equal(auth.getState().status, 'indeterminate', 'a network interruption is not an auth answer');
    assert.ok(s.getItem(MARKER), 'the unknown outcome is remembered across pages');
    await assert.rejects(auth.fetch('https://app.test/data'), e => e.code === 'REFRESH_OUTCOME_UNKNOWN');
    assert.equal(refreshes(), 1, 'no client retry of a possibly-committed rotation');
  });

  await test('a refresh that times out (mutation deadline) is OUTCOME-UNKNOWN too, and bounded', async () => {
    const { auth, s } = await signedIn(storage(), { mutationTimeoutMs: 30 });
    now += 61_000;
    globalThis.fetch = route({ '/api/auth/refresh': (init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
    await assert.rejects(auth.fetch('https://app.test/data'), e => e.code === 'AUTH_TIMEOUT' || e.code === 'REFRESH_OUTCOME_UNKNOWN');
    assert.equal(auth.getState().status, 'indeterminate');
    assert.ok(s.getItem(MARKER));
    assert.equal(refreshes(), 1);
  });

  await test('a DEFINITIVE 401 from refresh still signs out', async () => {
    const { auth, s } = await signedIn();
    now += 61_000;
    globalThis.fetch = route({ '/api/auth/refresh': () => Response.json({ error: 'AUTH_INVALID_CREDS' }, { status: 401 }) });
    await auth.fetch('https://app.test/data').catch(() => undefined);
    assert.equal(auth.getState().status, 'signed-out');
    assert.equal(s.getItem(MARKER), null, 'a definitive answer clears the marker');
  });

  await test('a concurrent tab sharing the storage never starts a second rotation while the outcome is unknown', async () => {
    const shared = storage();
    const tabA = await signedIn(shared);
    globalThis.fetch = route({ '/api/auth/login': session });
    const tabB = createSomewhereAuth({ mode: 'cookie', storage: shared, baseUrl: 'https://app.test' });
    await tabB.signIn({ email: user.email, password: 'test' });
    now += 61_000;
    globalThis.fetch = route({ '/api/auth/refresh': () => { throw new TypeError('network lost after commit'); } });
    await assert.rejects(tabA.auth.fetch('https://app.test/data'));
    assert.ok(shared.getItem(MARKER), 'tab A left the outcome unknown');
    const before = refreshes();
    globalThis.fetch = route({ '/api/auth/refresh': session, '/data': () => Response.json({ ok: true }) });
    await tabB.fetch('https://app.test/data').catch(() => undefined);
    assert.equal(refreshes(), before, 'tab B did not rotate the possibly-rotated credential');
    assert.notEqual(tabB.getState().status, 'signed-out', 'and is not signed out by it');
  });

  await test('the next page resolves the outcome without rotating when the pair was re-issued after the refresh began', async () => {
    const { auth, s } = await signedIn();
    now += 61_000;
    globalThis.fetch = route({ '/api/auth/refresh': () => { throw new DOMException('aborted', 'AbortError'); } });
    await assert.rejects(auth.fetch('https://app.test/data'));
    assert.ok(s.getItem(MARKER));
    now += 2_000; // the next page, after keepalive delivered the rotated pair (the access now lasts ~58 s more)
    globalThis.fetch = route({
      '/api/auth/me': () => Response.json({ user }, { headers: { 'X-Sw-Access-Expires': String(now + 58_000) } }),
      '/data': () => Response.json({ ok: true }),
    });
    const next = createSomewhereAuth({ mode: 'cookie', storage: s, baseUrl: 'https://app.test' });
    assert.deepEqual(await next.getUser(), user);
    const probe = calls.find(c => c.path === '/api/auth/me');
    assert.equal(probe.headers.get('X-No-Auto-Refresh'), '1', 'the reconciling probe cannot rotate');
    assert.equal(next.getState().status, 'authenticated');
    assert.equal(s.getItem(MARKER), null, 'resolved');
    assert.equal((await next.fetch('https://app.test/data')).status, 200);
    assert.equal(calls.at(-1).headers.get('X-No-Auto-Refresh'), null, 'normal requests again');
  });
} finally {
  Date.now = realNow; globalThis.fetch = realFetch;
}
console.log(`PASS refresh outcome unknown: ${passed} scenarios`);
