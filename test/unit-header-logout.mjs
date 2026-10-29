/**
 * Header-mode sign-out revokes the server session (tsk_3fb8779c).
 *
 * The packaged client and the packaged server handler run together: the
 * client's fetch is answered by `somewhereAuth`, whose `sw.auth` stands in for
 * the platform's POST /v1/auth/logout — a session family is revoked only by its
 * refresh token; an unknown token is 404 SESSION_NOT_FOUND and signs nothing
 * out. Only a confirmed revoke may read as a confirmed sign-out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSomewhereAuth } from '@somewhere-cloud/sdk/auth';
import { somewhereAuth } from '@somewhere-cloud/sdk/server';

const user = { id: 'u1', email: 'person@example.com' };
const platformError = (code, status) => Object.assign(new Error(`platform ${code}`), { code, status });

/** Stub platform: live sessions keyed by refresh token, plus every call. */
const platform = { live: new Set(), calls: [], next: null };
const sw = {
  auth: {
    async logout(opts) {
      platform.calls.push({ name: 'auth.logout', opts });
      if (platform.next) { const answer = platform.next; platform.next = null; return answer(opts); }
      if (!platform.live.has(opts.refresh_token)) throw platformError('SESSION_NOT_FOUND', 404);
      platform.live.delete(opts.refresh_token);
      return { logged_out: true };
    },
    async logoutWithCookie() { platform.calls.push({ name: 'auth.logoutWithCookie' }); return { ok: true }; },
    async login() {
      platform.calls.push({ name: 'auth.login' });
      platform.live.add('refresh-new');
      return { token: 'access-new', refresh_token: 'refresh-new', user };
    },
    async fromRequest() { return user; },
  },
};

/** Transport: every request reaches the packaged handler unless told to fail or hold. */
const transport = { requests: [], failNext: 0, hold: null };
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(String(input), init);
  transport.requests.push({
    path: new URL(req.url).pathname,
    authorization: req.headers.get('authorization'),
    refresh: req.headers.get('x-refresh-token'),
    credentials: init.credentials ?? null,
  });
  if (transport.failNext > 0) { transport.failNext--; throw new TypeError('fixture network failure'); }
  if (transport.hold && req.url.endsWith('/logout')) await transport.hold;
  return somewhereAuth(req, sw);
};

function reset(...live) {
  platform.live = new Set(live);
  platform.calls = [];
  platform.next = null;
  transport.requests = [];
  transport.failNext = 0;
  transport.hold = null;
}
function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
}
function headerClient(accessToken = 'access-a', refreshToken = 'refresh-a') {
  return createSomewhereAuth({
    baseUrl: 'https://app.example', mode: 'header', mutationTimeoutMs: 500,
    storage: memoryStorage({ sw_auth: JSON.stringify({ accessToken, refreshToken }), sw_auth_user: JSON.stringify(user) }),
  });
}
const logoutRequests = () => transport.requests.filter((r) => r.path === '/api/auth/logout');
const logoutCalls = () => platform.calls.filter((c) => c.name === 'auth.logout');
const rawLogout = (headers) => somewhereAuth(new Request('https://app.example/api/auth/logout', { method: 'POST', headers }), sw);

test('cookie mode is unchanged: no token headers, credentials included, cookie revoke path', async () => {
  reset();
  const client = createSomewhereAuth({ baseUrl: 'https://app.example', mode: 'cookie', mutationTimeoutMs: 500,
    storage: memoryStorage({ sw_auth_user: JSON.stringify(user) }) });
  await client.signOut();
  const [request] = logoutRequests();
  assert.equal(request.authorization, null);
  assert.equal(request.refresh, null);
  assert.equal(request.credentials, 'include');
  assert.deepEqual(platform.calls.map((c) => c.name), ['auth.logoutWithCookie']);
  assert.equal(client.getState().signOutUnconfirmed, false);
});

test('header sign-out sends the ride-along refresh token and revokes only that session', async () => {
  reset('refresh-a', 'refresh-b');
  const client = headerClient();
  await client.signOut();
  const [request] = logoutRequests();
  assert.equal(request.authorization, 'Bearer access-a');
  assert.equal(request.refresh, 'refresh-a');
  assert.deepEqual(logoutCalls().map((c) => c.opts), [{ refresh_token: 'refresh-a' }]);
  assert.equal(platform.live.has('refresh-a'), false, 'the signed-out session is revoked');
  assert.equal(platform.live.has('refresh-b'), true, 'another session is not revoked');
  assert.equal(platform.calls.some((c) => c.name === 'auth.logoutWithCookie'), false);
  const state = client.getState();
  assert.equal(state.status, 'signed-out');
  assert.equal(state.signOutUnconfirmed, false);
  assert.equal(state.error, null);
});

test('SESSION_NOT_FOUND is not a confirmed sign-out', async () => {
  reset('refresh-newer'); // e.g. the token rotated away; a newer family may be live
  const client = headerClient();
  await client.signOut();
  const state = client.getState();
  assert.equal(state.signOutUnconfirmed, true);
  assert.equal(state.error?.code, 'SIGN_OUT_UNCONFIRMED');
  assert.equal(state.error?.status, 404);
  assert.equal(platform.live.has('refresh-newer'), true);
});

test('network failure and refusal stay owed; only an explicit retry resends the same credential', async () => {
  for (const fail of ['network', 'refusal']) {
    reset('refresh-a');
    const client = headerClient();
    if (fail === 'network') transport.failNext = 1;
    else platform.next = () => { throw platformError('AUTHORITY_UNAVAILABLE', 503); };
    await client.signOut();
    assert.equal(client.getState().signOutUnconfirmed, true, fail);
    assert.equal(client.getState().error?.code, 'SIGN_OUT_UNCONFIRMED', fail);
    if (fail === 'refusal') assert.equal(client.getState().error?.status, 502, 'a 5xx refusal is reported as 502');
    assert.equal(platform.live.has('refresh-a'), true, `${fail}: nothing was revoked`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(logoutRequests().length, 1, `${fail}: no automatic retry`);
    await client.signOut();
    const retry = logoutRequests()[1];
    assert.equal(retry.refresh, 'refresh-a', `${fail}: the retry resends the owed session's refresh token`);
    assert.equal(retry.authorization, 'Bearer access-a');
    assert.equal(client.getState().signOutUnconfirmed, false, `${fail}: confirmed once revoked`);
    assert.equal(platform.live.has('refresh-a'), false);
  }
});

test('a sign-out that settles late never confirms or revokes the session that replaced it', async () => {
  reset('refresh-a');
  const client = headerClient();
  let release;
  transport.hold = new Promise((resolve) => { release = resolve; });
  const logout = client.signOut();
  const login = client.signIn({ email: user.email, password: 'password' });
  release();
  await logout;
  await login;
  assert.deepEqual(logoutCalls().map((c) => c.opts), [{ refresh_token: 'refresh-a' }], 'only the old session is revoked');
  assert.equal(client.getState().status, 'authenticated');
  assert.equal(client.getSession()?.refreshToken, 'refresh-new');
  assert.equal(platform.live.has('refresh-new'), true, 'the new session stays live');

  // An owed sign-out is replaced by a newer sign-in, and a later sign-out is
  // for the session it sees — never the old credential.
  reset('refresh-a');
  const again = headerClient();
  transport.failNext = 1;
  await again.signOut();
  assert.equal(again.getState().signOutUnconfirmed, true);
  await again.signIn({ email: user.email, password: 'password' });
  assert.equal(again.getState().signOutUnconfirmed, false);
  await again.signOut();
  assert.equal(logoutRequests().at(-1).refresh, 'refresh-new');
  assert.equal(platform.live.has('refresh-new'), false);
});

test('a bearer-only sign-out (SDK 0.11.4 and earlier) is refused, not answered ok', async () => {
  reset('refresh-a');
  const res = await rawLogout({ 'Content-Type': 'application/json', Authorization: 'Bearer access-a' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'LOGOUT_REFRESH_REQUIRED');
  assert.deepEqual(platform.calls, [], 'no revoke attempted, no cookie path');
});

test('an empty X-Refresh-Token is invalid', async () => {
  for (const value of ['', '   ']) {
    reset('refresh-a');
    const res = await rawLogout({ Authorization: 'Bearer access-a', 'X-Refresh-Token': value });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'VALIDATION_ERROR');
    assert.deepEqual(platform.calls, []);
  }
});

test('platform failures map to a safe code and a 4xx or 502, never a 2xx', async () => {
  const cases = [
    [() => { throw platformError('AUTH_INVALID_CREDS', 401); }, 401, 'AUTH_INVALID_CREDS'],
    [() => { throw platformError('SOME_CODE', 403.5); }, 502, 'SOME_CODE'],
    [() => { throw platformError('SOME_CODE', '404'); }, 502, 'SOME_CODE'],
    [() => { throw platformError('UPSTREAM', 500); }, 502, 'UPSTREAM'],
    [() => { throw platformError('not a code <script>', 400); }, 400, 'SIGN_OUT_FAILED'],
    [() => { throw new Error('plain failure'); }, 502, 'SIGN_OUT_FAILED'],
    [() => { throw 'a string'; }, 502, 'SIGN_OUT_FAILED'],
    [() => ({ ok: true }), 502, 'SIGN_OUT_UNCONFIRMED'],
    [() => null, 502, 'SIGN_OUT_UNCONFIRMED'],
  ];
  for (const [answer, status, code] of cases) {
    reset('refresh-a');
    platform.next = answer;
    const res = await rawLogout({ Authorization: 'Bearer access-a', 'X-Refresh-Token': 'refresh-a' });
    const body = await res.json();
    assert.equal(res.status, status, `${code} → ${status}`);
    assert.equal(body.ok, false);
    assert.equal(body.error, code);
    assert.equal(body.message.includes('plain failure'), false, 'the upstream message is not echoed');
  }
});
