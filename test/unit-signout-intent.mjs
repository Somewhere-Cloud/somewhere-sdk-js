// Sign-out intent lifetime (platform tsk_c09746b9; audit F4).
//  - `pending:` (the server has not confirmed /logout) never expires: it is retried after any
//    delay and keeps the page signed out (tsk_9b75bdf8 — must not regress).
//  - `confirmed:` is only a short fence (120 s) against a /me answer sent before the logout.
//    After it, the client asks the server again, so a session made by another path (a server
//    form login, another client) is honoured instead of being ignored forever as in 0.13.x.
//  - 0.13.x confirmed records (which never expired) are cleared once they are older than the fence.
import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { user, page, me, flush, meCalls, suite } from './early-session-harness.mjs';

const { test, done } = suite();
const KEY = 'sw_auth_user:sign-out:/api/auth';
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const logoutCalls = (calls) => calls.filter((c) => c.path === '/api/auth/logout');

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
  return p;
}

try {
  await test('a confirmed /logout leaves only a timestamped fence', async () => {
    const p = await signedOutConfirmed();
    assert.equal(p.storage.getItem(KEY), `confirmed:${now}`);
  });

  await test('inside the fence: a fresh page stays signed out without asking /me, and auth.fetch sends no credentials', async () => {
    const p = await signedOutConfirmed();
    now += 10_000;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(auth.getState().status, 'signed-out');
    const before = meCalls(p.calls).length;
    assert.equal(await auth.getUser(), null);
    assert.equal(meCalls(p.calls).length, before, 'no /me inside the fence');
    void auth.fetch('/api/data');
    await flush();
    assert.equal(p.calls.at(-1).init.credentials, 'omit');
    p.calls.at(-1).resolve(new Response('{}'));
  });

  await test('after the fence: the server is asked again and a session made elsewhere is honoured', async () => {
    const p = await signedOutConfirmed();
    now += 121_000;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(auth.getState().status, 'checking', 'not answered locally any more');
    assert.equal(p.storage.getItem(KEY), null, 'the expired fence is removed');
    const got = auth.getUser();
    await flush();
    const asked = meCalls(p.calls).at(-1);
    asked.resolve(me(user)); // e.g. a server-handled form login set new cookies
    assert.deepEqual(await got, user);
    assert.equal(auth.getState().status, 'authenticated');
    void auth.fetch('/api/data');
    await flush();
    assert.notEqual(p.calls.at(-1).init.credentials, 'omit', 'credentials are sent again');
    p.calls.at(-1).resolve(new Response('{}'));
  });

  await test('a 0.13.x confirmed record (never expired) older than the fence is cleared; the client checks /me', async () => {
    const p = page();
    p.storage.setItem(KEY, `confirmed:${now - 3 * 24 * 3600_000}:0.123`);
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(p.storage.getItem(KEY), null);
    const got = auth.getUser();
    await flush();
    assert.equal(meCalls(p.calls).length, 1);
    meCalls(p.calls)[0].resolve(new Response(null, { status: 401 }));
    assert.equal(await got, null, 'the server says signed out; nothing else changes');
  });

  await test('a 0.13.x confirmed record inside the fence still fences', async () => {
    const p = page();
    p.storage.setItem(KEY, `confirmed:${now - 5_000}:0.123`);
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(await auth.getUser(), null);
    assert.equal(meCalls(p.calls).length, 0);
  });

  await test('an unreadable confirmed record is removed, not trusted', async () => {
    const p = page();
    p.storage.setItem(KEY, 'confirmed:garbage');
    createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(p.storage.getItem(KEY), null);
  });

  await test('pending: never expires — 31 days later the page is still signed out and retries /logout, never /me', async () => {
    const p = page();
    p.storage.setItem(KEY, `pending:${now}:0.5`);
    now += 31 * 24 * 3600_000;
    const auth = createSomewhereAuth({ mode: 'cookie', storage: p.storage });
    assert.equal(auth.getState().status, 'signed-out');
    assert.equal(auth.getState().signOutUnconfirmed, true);
    const got = auth.getUser();
    await flush();
    assert.equal(meCalls(p.calls).length, 0, 'no /me while the logout is owed');
    const retry = logoutCalls(p.calls)[0];
    assert.ok(retry, 'the owed logout is retried');
    retry.resolve(Response.json({ ok: true }));
    assert.equal(await got, null);
    assert.equal(auth.getState().signOutUnconfirmed, false);
    assert.equal(p.storage.getItem(KEY), `confirmed:${now}`);
  });

  done();
} finally {
  Date.now = realNow;
}
