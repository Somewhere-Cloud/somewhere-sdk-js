// Sign-out intent lifetime (platform tsk_c09746b9; audit F4).
//  - `pending:` (the server has not confirmed /logout) never expires: it is retried after any
//    delay and keeps the page signed out (tsk_9b75bdf8 — must not regress).
//  - Once the server confirms /logout, the record is REMOVED. The server ended that session
//    (session row and refresh family deleted), so its answer is the truth from then on. A
//    session established afterwards by any path (a server form login, another client) is
//    honoured at once, with its credentials sent.
//  - `confirmed:` records left by 0.13.x (which never expired) are removed when read.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { user, page, me, flush, meCalls, suite } from './early-session-harness.mjs';

const { test, done } = suite();
const KEY = 'sw_auth_user:sign-out:/api/auth';
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const logoutCalls = (calls) => calls.filter((c) => c.path === '/api/auth/logout');

/** Signed in, then a confirmed sign-out, in one page. */
async function signedOutConfirmed() {
  const p = page();
  const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
  const first = auth.getUser();
  await flush();
  p.calls[0].resolve(me(user));
  await first;
  const out = auth.signOut();
  await flush();
  logoutCalls(p.calls)[0].resolve(Response.json({ ok: true }));
  await out;
  return { p, auth };
}

try {
  await test('a confirmed /logout removes the intent record', async () => {
    const { p, auth } = await signedOutConfirmed();
    assert.equal(p.storage.getItem(KEY), null);
    assert.equal(auth.getState().status, 'signed-out');
    assert.equal(auth.getState().signOutUnconfirmed, false);
  });

  await test('external sign-in IMMEDIATELY after a confirmed logout: a fresh page honours it, credentials sent', async () => {
    const { p } = await signedOutConfirmed();
    // e.g. a server-handled form login set new cookies; no clock advance.
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(auth.getState().status, 'checking', 'not answered locally');
    const got = auth.getUser();
    await flush();
    meCalls(p.calls).at(-1).resolve(me(user));
    assert.deepEqual(await got, user);
    assert.equal(auth.getState().status, 'authenticated');
    void auth.fetch('/api/data');
    await flush();
    assert.notEqual(p.calls.at(-1).init.credentials, 'omit', 'credentials are sent');
    p.calls.at(-1).resolve(new Response('{}'));
  });

  await test('external sign-in immediately after a confirmed logout: the SAME client picks it up on its next check', async () => {
    const { p, auth } = await signedOutConfirmed();
    const got = auth.getUser();
    await flush();
    meCalls(p.calls).at(-1).resolve(me(user));
    assert.deepEqual(await got, user);
    assert.equal(auth.getState().status, 'authenticated');
  });

  await test('a 0.13.x confirmed record (any age) is cleared on read; the client asks the server', async () => {
    for (const age of [1_000, 3 * 24 * 3600_000]) {
      const p = page();
      p.storage.setItem(KEY, `confirmed:${now - age}:0.123`);
      const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
      assert.equal(p.storage.getItem(KEY), null);
      const got = auth.getUser();
      await flush();
      assert.equal(meCalls(p.calls).length, 1);
      meCalls(p.calls)[0].resolve(new Response(null, { status: 401 }));
      assert.equal(await got, null, 'the server says signed out');
    }
  });

  await test('an unreadable confirmed record is removed, not trusted', async () => {
    const p = page();
    p.storage.setItem(KEY, 'confirmed:garbage');
    createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(p.storage.getItem(KEY), null);
  });

  await test('owed logout (pending:) never expires — 31 days later: signed out, retries /logout, never /me', async () => {
    const p = page();
    p.storage.setItem(KEY, `pending:${now}:0.5`);
    now += 31 * 24 * 3600_000;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(auth.getState().status, 'signed-out');
    assert.equal(auth.getState().signOutUnconfirmed, true);
    void auth.fetch('/api/data');
    await flush();
    assert.equal(p.calls.at(-1).init.credentials, 'omit', 'no credentials while the logout is owed');
    p.calls.at(-1).resolve(new Response('{}'));
    const got = auth.getUser();
    await flush();
    assert.equal(meCalls(p.calls).length, 0, 'no /me while the logout is owed');
    const retry = logoutCalls(p.calls)[0];
    assert.ok(retry, 'the owed logout is retried');
    retry.resolve(Response.json({ ok: true }));
    assert.equal(await got, null);
    assert.equal(auth.getState().signOutUnconfirmed, false);
    assert.equal(p.storage.getItem(KEY), null, 'confirmed: the record is removed');
  });

  done();
} finally {
  Date.now = realNow;
}
