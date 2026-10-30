// Early session check (platform tsk_c09746b9): the page starts the client's
// first GET /api/auth/me during HTML parse and the client adopts that answer.
// Proves, both directions, with the REAL inline script source, the built client and
// whatever lock support the runtime has (Node 22: none, so the no-lock path; Node 24+:
// real Web Locks). The real-lock regressions live in unit-early-session-locks.mjs.
//  - adopted: one /me in total, signed-in and signed-out alike;
//  - stands down (no request) on a recorded sign-out or an unknown refresh outcome;
//  - discarded, never written, after a sign-in/sign-out started in this tab, or one
//    STARTED in another tab (cross-tab mutation marker), including a late answer;
//  - not adopted by a client with other names, which waits for it before its own /me;
//  - consumed once; the unknown-outcome marker protocol is the client's own.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { N, user, bob, page, me, runEarlyScript, flush, meCalls, suite, stalledBody } from './early-session-harness.mjs';

const { test, done } = suite();
console.log(typeof globalThis.navigator?.locks?.request === 'function'
  ? '  (runtime has Web Locks: early script and client use them)'
  : '  (runtime has NO Web Locks: no-lock path; lock regressions are NOT run here, see unit-early-session-locks.mjs)');

await test('control: without the early script the client sends its own single /me', async () => {
  const p = page();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  await flush();
  assert.equal(meCalls(p.calls).length, 1);
  p.calls[0].resolve(me(user));
  assert.deepEqual(await got, user);
});

await test('signed in: the early /me is adopted; one request in total; marker cleared', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  assert.equal(meCalls(p.calls).length, 1, 'started by the page, before the client exists');
  assert.equal(p.calls[0].init.credentials, 'include');
  assert.ok(p.storage.getItem(N.pending), 'same unknown-outcome marker as the client before a possibly-rotating /me');
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].resolve(me(user));
  assert.deepEqual(await got, user);
  assert.equal(auth.getState().status, 'authenticated');
  assert.equal(meCalls(p.calls).length, 1, 'the client sent no /me of its own');
  assert.equal(p.storage.getItem(N.pending), null, 'definitive answer clears the marker');
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

await test('an unknown refresh outcome: the page sends nothing; the client reconciles without rotating', async () => {
  const p = page();
  p.storage.setItem(N.pending, 'earlier:marker');
  runEarlyScript();
  await flush();
  assert.equal(p.calls.length, 0, 'never a second possibly-rotating request');
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  await flush();
  assert.equal(meCalls(p.calls).length, 1);
  assert.equal(p.calls[0].headers.get('X-No-Auto-Refresh'), '1', 'the client\'s own non-rotating reconcile probe');
  p.calls[0].resolve(me(user));
  assert.deepEqual(await got, user);
});

await test('another tab refreshed recently (shared stamp ahead): the early /me writes no marker', async () => {
  const p = page();
  p.storage.setItem(N.stamp, String(Date.now() + 60_000));
  runEarlyScript();
  await flush();
  assert.equal(meCalls(p.calls).length, 1);
  assert.equal(p.storage.getItem(N.pending), null);
  p.calls[0].resolve(me(user));
});

await test('a sign-out in THIS tab while the early /me is in flight: its late answer is never written', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const check = auth.getUser();
  await flush();
  const markBefore = p.storage.getItem(N.mutation);
  const out = auth.signOut();
  assert.notEqual(p.storage.getItem(N.mutation), markBefore, 'mutation marker written at sign-out START (before /logout answers)');
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
  assert.ok(p.storage.getItem(N.mutation), 'mutation marker written at sign-in START');
  login.resolve(Response.json({ user: bob, cookie_session: true }));
  await signIn;
  assert.deepEqual(auth.getState().user, bob);
  assert.equal(auth.getState().status, 'authenticated', 'the early 401 did not sign the new session out');
});

await test('storage refuses the mutation marker: this tab\'s own sign-in still blocks adoption (generation)', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const setItem = p.storage.setItem;
  p.storage.setItem = (k, v) => { if (k === N.mutation) throw new Error('quota'); return setItem(k, v); };
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const signIn = auth.signIn({ email: bob.email, password: 'x' });
  const check = auth.getUser(); // queued behind the sign-in, generation 1
  await flush();
  p.calls[0].resolve(new Response(null, { status: 401 })); // the early answer predates the sign-in
  await flush();
  p.calls.find((c) => c.path.endsWith('/login')).resolve(Response.json({ user: bob, cookie_session: true }));
  await signIn;
  await flush();
  const own = meCalls(p.calls).slice(1);
  for (const c of own) c.resolve(me(bob));
  await check;
  assert.deepEqual(auth.getState().user, bob);
  assert.equal(auth.getState().status, 'authenticated', 'the stale early 401 was not adopted after this tab signed in');
});

await test('a session change STARTED in another tab while the early /me was out: discarded, checked again', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const first = auth.getUser();
  await flush();
  p.otherTab(N.mutation, 'other-tab:sign-out-started'); // start, not completion
  await flush();
  assert.equal(auth.getState().status, 'checking', 'nothing in flight may settle the state now');
  p.calls[0].resolve(me(user)); // the early answer, from before the other tab's change
  await first;
  await flush();
  const again = meCalls(p.calls);
  assert.equal(again.length, 2, 'the client asked again');
  again[1].resolve(new Response(null, { status: 401 }));
  await flush();
  assert.equal(auth.getState().status, 'signed-out', 'the late early "signed in" answer was not adopted');
});

await test('a cross-tab start the event has not reached yet: the marker comparison alone discards the answer', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  p.storage.setItem(N.mutation, 'other-tab:sign-in-started'); // no storage event delivered yet
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].resolve(new Response(null, { status: 401 }));
  await flush();
  const own = meCalls(p.calls);
  assert.equal(own.length, 2, 'not adopted: the client sent its own /me');
  own[1].resolve(me(bob));
  assert.deepEqual(await got, bob);
});

await test('a client with other names never adopts it, and waits for it before its own /me', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage, storageKey: 'other' });
  const got = auth.getUser();
  await flush();
  assert.equal(meCalls(p.calls).length, 1, 'no second /me while the early one may still rotate');
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

await test('an early /me lost to the network keeps the unknown outcome; the client reconciles without rotating', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].reject(new TypeError('network'));
  await flush();
  assert.ok(p.storage.getItem(N.pending), 'outcome unknown: marker kept');
  const reconcile = meCalls(p.calls)[1];
  assert.ok(reconcile, 'the client probes again');
  assert.equal(reconcile.headers.get('X-No-Auto-Refresh'), '1', 'without rotating');
  reconcile.resolve(me(user));
  assert.deepEqual(await got, user);
});

await test('the page script holds the client\'s own refresh lock name while its /me is out', async () => {
  const p = page();
  const names = [];
  let lockSignal = null;
  const locks = { request(name, options, cb) { names.push(name); lockSignal = options?.signal; return Promise.resolve().then(cb); } };
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
  try { runEarlyScript(); await flush(); }
  finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator; }
  assert.deepEqual(names, [N.stamp]);
  assert.ok(lockSignal instanceof AbortSignal, 'the lock request itself is cancellable');
  p.calls[0].resolve(me(user));
});

await test('a never-settling early /me a never-settling early /me: a sign-out aborts it and completes', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const out = auth.signOut();
  await flush();
  assert.equal(p.calls[0].aborted, true, 'the sign-out aborted the hung early /me');
  assert.ok(p.storage.getItem(N.pending), 'outcome unknown: its marker is kept, never retried');
  const logout = p.calls.find((c) => c.path.endsWith('/logout'));
  assert.ok(logout, 'the queued logout got the lock and went out');
  logout.resolve(Response.json({ ok: true }));
  await out;
  assert.equal(auth.getState().status, 'signed-out');
  assert.equal(meCalls(p.calls).length, 1, 'no rotating retry');
});

await test('a never-settling early /me adopted by the first check: aborted at the client deadline, reconciled without rotating', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage, mutationTimeoutMs: 50 });
  const got = auth.getUser();
  await new Promise((r) => setTimeout(r, 80));
  await flush();
  assert.equal(p.calls[0].aborted, true, 'aborted at the deadline');
  const probes = meCalls(p.calls);
  assert.equal(probes.length, 2, 'one follow-up probe');
  assert.equal(probes[1].headers.get('X-No-Auto-Refresh'), '1', 'the follow-up never rotates');
  probes[1].resolve(me(user));
  assert.deepEqual(await got, user, 'first auth completes');
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
  assert.ok(p.storage.getItem(N.pending), 'possibly rotated: marker kept for the client to reconcile');
});

await test('storage cannot read the mutation marker at page start: the script does not start', async () => {
  const p = page();
  const getItem = p.storage.getItem;
  p.storage.getItem = (k) => { if (k === N.mutation) throw new Error('SecurityError'); return getItem(k); };
  runEarlyScript();
  await flush();
  assert.equal(p.calls.length, 0);
  assert.equal(globalThis.__swEarlySession, undefined);
});

await test('storage cannot read the mutation marker at adoption: fail closed, the client checks itself', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  const getItem = p.storage.getItem;
  p.storage.getItem = (k) => { if (k === N.mutation) throw new Error('SecurityError'); return getItem(k); };
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const got = auth.getUser();
  p.calls[0].resolve(me(user));
  await flush();
  const own = meCalls(p.calls);
  assert.equal(own.length, 2, 'not adopted: freshness could not be shown');
  own[1].resolve(new Response(null, { status: 401 }));
  assert.equal(await got, null);
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

await test('audit: a sign-in STARTED in another tab makes this tab re-check before it settles; the completion event re-checks again', async () => {
  const p = page();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const first = auth.getUser();
  await flush();
  p.calls[0].resolve(new Response(null, { status: 401 }));
  assert.equal(await first, null);
  p.otherTab(N.mutation, 'other-tab:sign-in-started');
  await flush();
  const during = meCalls(p.calls)[1];
  assert.ok(during, 'the start alone triggers a fresh /me');
  during.resolve(new Response(null, { status: 401 })); // answered before the other tab's sign-in settles
  await flush();
  assert.equal(auth.getState().status, 'signed-out', 'the start marker alone does NOT deliver the post-change state');
  p.otherTab('sw_auth_user', JSON.stringify(bob)); // the other tab's completion
  await flush();
  const after = meCalls(p.calls)[2];
  assert.ok(after, 'its completion triggers another check');
  after.resolve(me(bob));
  await flush();
  assert.deepEqual(auth.getState().user, bob, 'the post-change state arrives with the completion, not the start');
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
  assert.equal(p.storage.getItem(N.pending), null, 'the status already settled the rotation outcome');
  assert.equal(meCalls(p.calls).length, 1, 'no follow-up probe needed');
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
