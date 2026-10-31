// Early session check (platform tsk_c09746b9): the page starts the client's
// first GET /api/auth/me during HTML parse and the client adopts that answer.
// Proves, both directions, with the REAL inline script source and the built client:
//  - adopted: one /me in total, signed-in and signed-out alike;
//  - stands down (no request) only on a recorded sign-out; it takes no Web Lock and
//    writes no storage (audit S2: no refresh-pending marker, no cross-tab lock);
//  - an early /me cut by navigation is a failed request: the next page boots normally;
//  - discarded, never written, after a sign-in/sign-out started in this tab, or a
//    sign-out started / sign-in completed in another tab, including a late answer;
//  - another tab merely STARTING (or failing) a sign-in costs this tab nothing;
//  - not adopted by a client with other names, which waits for it before its own /me;
//  - consumed once; void after pagehide/freeze; bounded by one deadline.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { N, user, bob, page, me, runEarlyScript, flush, meCalls, suite, stalledBody } from './early-session-harness.mjs';

const { test, done } = suite();

await test('control: without the early script the client sends its own single /me', async () => {
  const p = page();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  await flush();
  assert.equal(meCalls(p.calls).length, 1);
  p.calls[0].resolve(me(user));
  assert.deepEqual(await got, user);
});

await test('signed in: the early /me is adopted; one request in total; the script writes nothing', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  assert.equal(meCalls(p.calls).length, 1, 'started by the page, before the client exists');
  assert.equal(p.calls[0].init.credentials, 'include');
  assert.equal(p.calls[0].headers.get('X-No-Auto-Refresh'), null, 'a normal /me: it may rotate in-band');
  assert.equal(p.storage.map.size, 0, 'no marker, no stamp');
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].resolve(me(user));
  assert.deepEqual(await got, user);
  assert.equal(auth.getState().status, 'authenticated');
  assert.equal(meCalls(p.calls).length, 1, 'the client sent no /me of its own');
  assert.deepEqual([...p.storage.map.keys()], ['sw_auth_user'], 'only the cached user');
});

await test('signed out: an early 401 is adopted as signed-out; one request', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].resolve(new Response(null, { status: 401 }));
  assert.equal(await got, null);
  assert.equal(auth.getState().status, 'signed-out');
  assert.equal(meCalls(p.calls).length, 1);
});

await test('a recorded sign-out (owed or done): the page sends nothing; the client behaves as before', async () => {
  for (const intent of ['done', 'pending:1:0.5']) {
    const p = page();
    p.storage.setItem(N.signOut, intent);
    runEarlyScript();
    await flush();
    assert.equal(p.calls.length, 0, 'no early request with a recorded sign-out');
    assert.equal(globalThis.__swEarlySession, undefined);
  }
});

await test('a leftover 0.13.x refresh-pending marker or a refresh stamp changes nothing: the early /me is sent and adopted', async () => {
  const p = page();
  p.storage.setItem('sw_auth_user:refresh-pending', 'from-0.13.3:0.5');
  p.storage.setItem('sw_auth_user:refresh-at', String(Date.now() + 60_000));
  runEarlyScript();
  await flush();
  assert.equal(meCalls(p.calls).length, 1, 'no stand-down');
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].resolve(me(user));
  assert.deepEqual(await got, user);
  assert.equal(auth.getState().status, 'authenticated');
  assert.equal(meCalls(p.calls).length, 1, 'no probe of its own');
});

await test('the page script requests no Web Lock', async () => {
  const p = page();
  const names = [];
  const locks = { request(name, _options, cb) { names.push(name); return Promise.resolve().then(cb); } };
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
  try {
    runEarlyScript();
    await flush();
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    const got = auth.getUser();
    p.calls[0].resolve(me(user));
    assert.deepEqual(await got, user);
  } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator; }
  assert.deepEqual(names, [], 'neither the script nor the client took a lock');
});

await test('page 1: the early /me is cut by navigation; page 2 boots normally and is signed in', async () => {
  const p1 = page();
  runEarlyScript();
  await flush();
  const first = createSomewhereAuth({ mode: 'cookie', storage: p1.storage });
  const check = first.getUser();
  await flush();
  p1.lifecycle('pagehide');
  p1.calls[0].reject(new DOMException('The operation was aborted.', 'AbortError')); // the navigation cancels it
  await check;
  await flush();
  assert.equal(meCalls(p1.calls).length, 1, 'page 1 sends nothing more');
  const p2 = page(p1.storage); // the next document, same browser storage
  runEarlyScript();
  await flush();
  assert.equal(meCalls(p2.calls).length, 1, 'page 2 starts its early /me as usual');
  assert.equal(p2.calls[0].headers.get('X-No-Auto-Refresh'), null);
  const second = createSomewhereAuth({ mode: 'cookie', storage: p2.storage });
  const got = second.getUser();
  p2.calls[0].resolve(me(user)); // the server accepts the replay within its grace window
  assert.deepEqual(await got, user);
  assert.equal(second.getState().status, 'authenticated');
  assert.equal(second.getState().error, null, 'no SIGN_IN_REQUIRED');
  assert.equal(meCalls(p2.calls).length, 1);
  assert.deepEqual([...p2.storage.map.keys()], ['sw_auth_user'], 'no marker');
});

await test('a sign-out in THIS tab while the early /me is in flight: its late answer is never written', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const check = auth.getUser();
  await flush();
  const out = auth.signOut();
  await flush();
  p.calls[0].resolve(me(user)); // the pre-sign-out answer arrives late
  await check.catch(() => undefined);
  await flush();
  const logout = p.calls.find((c) => c.path.endsWith('/logout'));
  assert.ok(logout, 'sign-out proceeds');
  logout.resolve(Response.json({ ok: true }));
  await out;
  assert.equal(auth.getState().status, 'signed-out');
  assert.equal(auth.getState().user, null, 'the late early answer never signed the page back in');
});

await test('a sign-in started in THIS tab before the first check: the early answer is never adopted', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const signIn = auth.signIn({ email: bob.email, password: 'x' });
  await flush();
  p.calls[0].resolve(new Response(null, { status: 401 })); // early answer: from before the sign-in
  await flush();
  const login = p.calls.find((c) => c.path.endsWith('/login'));
  assert.ok(login, 'the sign-in went out');
  login.resolve(Response.json({ user: bob, cookie_session: true }));
  await signIn;
  assert.deepEqual(auth.getState().user, bob);
  assert.equal(auth.getState().status, 'authenticated', 'the early 401 did not sign the new session out');
});


await test('another tab STARTS a sign-out while the early /me is out: this tab is signed out at once; the late answer is discarded', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const first = auth.getUser();
  await flush();
  p.otherTab(N.signOut, 'pending:1:0.5'); // the other tab's sign-out intent, written at its start
  await flush();
  assert.equal(auth.getState().status, 'signed-out');
  p.calls[0].resolve(me(user)); // the early answer, from before the other tab's sign-out
  await first;
  await flush();
  assert.equal(auth.getState().status, 'signed-out', 'the late early "signed in" answer was not adopted');
  assert.equal(auth.getState().user, null);
});


await test('a client with other names never adopts it, and waits for it before its own /me', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage, storageKey: 'other' });
  const got = auth.getUser();
  await flush();
  assert.equal(meCalls(p.calls).length, 1, 'one /me at a time in this document');
  p.calls[0].resolve(me(user));
  await flush();
  const own = meCalls(p.calls);
  assert.equal(own.length, 2, 'then its own check');
  own[1].resolve(new Response(null, { status: 401 }));
  assert.equal(await got, null);
});

await test('consumed once: the next check sends its own /me', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const first = auth.getUser();
  p.calls[0].resolve(me(user));
  await first;
  const second = auth.getUser();
  await flush();
  assert.equal(meCalls(p.calls).length, 2);
  p.calls[1].resolve(me(user));
  assert.deepEqual(await second, user);
});

await test('an early /me lost to the network is a failed check; the next check sends a normal /me', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].reject(new TypeError('network'));
  await got;
  assert.equal(auth.getState().status, 'indeterminate');
  assert.equal(meCalls(p.calls).length, 1, 'no probe of its own');
  const retry = auth.getUser();
  await flush();
  const again = meCalls(p.calls)[1];
  assert.ok(again, 'Retry reaches the server');
  assert.equal(again.headers.get('X-No-Auto-Refresh'), null, 'a normal /me');
  again.resolve(me(user));
  assert.deepEqual(await retry, user);
  assert.equal(p.storage.getItem('sw_auth_user:refresh-pending'), null);
});

await test('a never-settling early /me: a sign-out aborts it and completes', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const out = auth.signOut();
  await flush();
  assert.equal(p.calls[0].aborted, true, 'the sign-out aborted the hung early /me');
  const logout = p.calls.find((c) => c.path.endsWith('/logout'));
  assert.ok(logout, 'the queued logout went out');
  logout.resolve(Response.json({ ok: true }));
  await out;
  assert.equal(auth.getState().status, 'signed-out');
  assert.equal(meCalls(p.calls).length, 1, 'signed out: no /me after the logout');
});

await test('a never-settling early /me adopted by the first check: aborted at the client deadline; the next check sends a normal /me', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage, mutationTimeoutMs: 50 });
  const got = auth.getUser();
  await new Promise((r) => setTimeout(r, 80));
  await flush();
  assert.equal(p.calls[0].aborted, true, 'aborted at the deadline');
  await got;
  assert.equal(auth.getState().status, 'indeterminate', 'first auth settles at the deadline');
  const retry = auth.getUser();
  await flush();
  const probes = meCalls(p.calls);
  assert.equal(probes.length, 2);
  assert.equal(probes[1].headers.get('X-No-Auto-Refresh'), null, 'a normal /me');
  probes[1].resolve(me(user));
  assert.deepEqual(await retry, user);
});

await test('with no client at all, the script\'s own deadline aborts the request', async () => {
  const p = page();
  const realSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  globalThis.setTimeout = (fn, ms, ...rest) => (ms === 30_000 ? (deadlines.push(fn), 0) : realSetTimeout(fn, ms, ...rest));
  try { runEarlyScript(); } finally { globalThis.setTimeout = realSetTimeout; }
  await flush();
  assert.equal(deadlines.length, 1, 'a 30 s deadline was armed');
  deadlines[0]();
  await flush();
  assert.equal(p.calls[0].aborted, true);
  assert.equal(p.storage.map.size, 0, 'nothing written');
});



await test('pagehide before the client takes it (page put in the back/forward cache): never adopted after restore', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  p.lifecycle('pagehide'); // frozen with the early answer unconsumed
  p.calls[0].resolve(me(user)); // the pre-freeze answer
  await flush();
  // ... restored later; the client starts now.
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  await flush();
  const own = meCalls(p.calls);
  assert.equal(own.length, 2, 'the restored page asks /me itself');
  own[1].resolve(new Response(null, { status: 401 }));
  assert.equal(await got, null, 'the pre-freeze "signed in" answer was not adopted');
});

await test('freeze while the client is waiting on it: the answer that arrives after resume is discarded', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  await flush();
  p.lifecycle('freeze');
  p.calls[0].resolve(me(user));
  await flush();
  const own = meCalls(p.calls);
  assert.equal(own.length, 2, 'checked again after resume');
  own[1].resolve(me(bob));
  assert.deepEqual(await got, bob);
});

await test('another tab STARTS a sign-in (even one that fails): this tab sends no /me; its COMPLETION re-checks', async () => {
  const p = page();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const first = auth.getUser();
  await flush();
  p.calls[0].resolve(new Response(null, { status: 401 }));
  assert.equal(await first, null);
  // A real other tab reaches this one only through storage events. Starting a
  // sign-in there clears the shared refresh stamp; failing it writes nothing else
  // (an unchanged user is not rewritten). 0.13.2 also wrote a mutation marker here.
  p.otherTab('sw_auth_user:refresh-at', '');
  p.otherTab('sw_auth_user:mutation', 'from-a-0.13.2-tab');
  await flush();
  assert.equal(meCalls(p.calls).length, 1, 'a started or failed sign-in elsewhere costs this tab nothing');
  assert.equal(auth.getState().status, 'signed-out');
  p.otherTab('sw_auth_user', JSON.stringify(bob)); // a sign-in completing in the other tab
  await flush();
  const after = meCalls(p.calls)[1];
  assert.ok(after, 'the completion triggers one check');
  after.resolve(me(bob));
  await flush();
  assert.deepEqual(auth.getState().user, bob, 'the new user arrives with the completion');
});

await test('headers arrive, the body stalls: the client deadline covers the body; first auth settles', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage, mutationTimeoutMs: 50 });
  const got = auth.getUser();
  p.calls[0].resolve(stalledBody());
  const started = Date.now();
  await got;
  assert.ok(Date.now() - started < 1000, 'settled at the deadline despite the stalled body');
  assert.equal(auth.getState().status, 'indeterminate');
  assert.equal(p.calls[0].aborted, true, 'the stalled response was aborted');
  assert.equal(meCalls(p.calls).length, 1, 'no follow-up probe');
});

await test('headers arrive, the body stalls: a sign-out ends the wait at once and logs out without waiting for a deadline', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage, mutationTimeoutMs: 10_000 });
  const check = auth.getUser();
  p.calls[0].resolve(stalledBody());
  await flush();
  const started = Date.now();
  const out = auth.signOut();
  await check;
  await flush();
  const logout = p.calls.find((c) => c.path.endsWith('/logout'));
  assert.ok(logout, 'logout went out immediately');
  logout.resolve(Response.json({ ok: true }));
  await out;
  assert.ok(Date.now() - started < 1000, 'well before the 10 s deadline');
  assert.equal(auth.getState().status, 'signed-out');
});

done();
