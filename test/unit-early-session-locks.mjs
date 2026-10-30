// Real Web Locks regressions for the early session check (platform tsk_c09746b9).
// MANDATORY where it runs: it fails (exit 1), never skips, on a runtime without
// navigator.locks. CI runs it in its own Node 24 job (.github/workflows/pr-checks.yml);
// the package's supported runtimes (engines >=18, CI Node 22) run unit-early-session.mjs.
// Proves with the browser's lock semantics: the early request holds the client's
// refresh lock only while its /me is out; one QUEUED behind another holder is withdrawn,
// with nothing sent, by the page timer, the client deadline and a sign-out; a stalled
// body never holds the lock.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { N, user, page, me, runEarlyScript, flush, meCalls, suite, stalledBody } from './early-session-harness.mjs';

if (typeof globalThis.navigator?.locks?.query !== 'function' || typeof globalThis.navigator?.locks?.request !== 'function') {
  console.error(`unit-early-session-locks: this runtime (${process.version}) has no Web Locks (navigator.locks). These regressions are mandatory and were NOT run. Use Node 24 or later.`);
  process.exit(1);
}
console.log(`  (real Web Locks: ${process.version})`);
const { test, done } = suite();
const heldLocks = async () => (await navigator.locks.query()).held.map((l) => l.name);

async function holdLock() {
  let release;
  const held = new Promise((r) => { release = r; });
  let granted;
  const got = new Promise((r) => { granted = r; });
  void navigator.locks.request(N.stamp, () => { granted(); return held; });
  await got;
  return release;
}
// Node's lock manager keeps listing an aborted pending request in query() until the
// holder releases, but never runs its callback; so "withdrawn" is shown by the request
// settling at once and by nothing being sent after the holder lets go.
const pendingLocks = async () => (await navigator.locks.query()).pending.map((l) => l.name);

await test('a never-settling early /me holds the real refresh lock; a sign-out aborts it and completes', async () => {
  const p = page();
  runEarlyScript();
  await flush();
  assert.deepEqual(await heldLocks(), [N.stamp], 'the early request holds the client\'s refresh lock');
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
  assert.deepEqual(await heldLocks(), [], 'no lock left held');
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
  assert.deepEqual(await heldLocks(), []);
});

await test('with no client at all, the script\'s own deadline aborts the request and releases the lock', async () => {
  const p = page();
  const realSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  globalThis.setTimeout = (fn, ms, ...rest) => (ms === 30_000 ? (deadlines.push(fn), 0) : realSetTimeout(fn, ms, ...rest));
  try { runEarlyScript(); } finally { globalThis.setTimeout = realSetTimeout; }
  await flush();
  assert.deepEqual(await heldLocks(), [N.stamp]);
  assert.equal(deadlines.length, 1, 'a 30 s deadline was armed');
  deadlines[0]();
  await flush();
  assert.equal(p.calls[0].aborted, true);
  assert.deepEqual(await heldLocks(), [], 'lock released');
  assert.ok(p.storage.getItem(N.pending), 'possibly rotated: marker kept for the client to reconcile');
});

await test('queued behind a lock that is never released: the page timer withdraws it; nothing is ever sent', async () => {
  const p = page();
  const release = await holdLock();
  const realSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  globalThis.setTimeout = (fn, ms, ...rest) => (ms === 30_000 ? (deadlines.push(fn), 0) : realSetTimeout(fn, ms, ...rest));
  try { runEarlyScript(); } finally { globalThis.setTimeout = realSetTimeout; }
  const early = globalThis.__swEarlySession;
  await flush();
  assert.deepEqual(await pendingLocks(), [N.stamp], 'the early request is waiting for the lock');
  deadlines[0]();
  await assert.rejects(early.promise, (e) => e.name === 'AbortError', 'the queued request settles');
  assert.equal(early.dispatched, false);
  assert.equal(p.calls.length, 0, 'no /me sent');
  assert.equal(p.storage.getItem(N.pending), null, 'no marker: nothing could have rotated');
  release();
  await flush();
  assert.equal(p.calls.length, 0, 'still nothing sent after the holder lets go');
});

await test('queued behind a never-released lock, adopted by the first check: the client deadline settles it with no request and no unknown outcome', async () => {
  const p = page();
  const release = await holdLock();
  runEarlyScript();
  await flush();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage, mutationTimeoutMs: 50 });
  const started = Date.now();
  const got = auth.getUser();
  await got;
  assert.ok(Date.now() - started < 1000, 'the first check settled at its deadline');
  assert.equal(auth.getState().status, 'indeterminate', 'a failed check, not a sign-out');
  assert.equal(p.calls.length, 0, 'nothing sent');
  assert.equal(p.storage.getItem(N.pending), null, 'not dispatched: no unknown-outcome marker');
  release();
  await flush();
  assert.equal(p.calls.length, 0, 'and it never fires later');
});

await test('queued behind a never-released lock: a sign-out cancels the early wait at once, sends no /me, and logs out once the lock frees', async () => {
  const p = page();
  const release = await holdLock();
  runEarlyScript();
  await flush();
  const early = globalThis.__swEarlySession;
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const check = auth.getUser();
  await flush();
  const out = auth.signOut();
  await check; // the stale first check ends now, not at a deadline
  await assert.rejects(early.promise, (e) => e.name === 'AbortError');
  assert.equal(early.dispatched, false);
  assert.equal(p.calls.length, 0, 'nothing sent while the other tab holds the lock');
  release();
  await flush();
  const logout = p.calls.find((c) => c.path.endsWith('/logout'));
  assert.ok(logout, 'logout went out once the other tab released');
  logout.resolve(Response.json({ ok: true }));
  await out;
  assert.equal(auth.getState().status, 'signed-out');
  assert.equal(meCalls(p.calls).length, 0, 'no /me was ever sent');
});

await test('headers arrive, the body stalls: the client deadline covers the body; first auth settles; the lock is free', async () => {
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
  assert.deepEqual(await heldLocks(), [], 'the lock was released at the headers');
});

done();
