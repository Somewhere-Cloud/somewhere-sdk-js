// Session status and ordering (tsk_166b8ddf). Pure, no network; runs
// against the built package. Every race is driven with deferred responses so
// the order is exact, and each guard has a same-generation control proving
// genuine sign-outs and sign-ins still apply.
//
//   npm run build && node test/unit-session-status.mjs

import { createSomewhereAuth } from '@somewhere-cloud/sdk/auth';
import { somewhereAuth } from '@somewhere-cloud/sdk/server';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`OK   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
};

const A = { id: 'usr_a', email: 'a@example.com' };
const B = { id: 'usr_b', email: 'b@example.com' };
const json = (status, body) => new Response(JSON.stringify(body?.cookie_session || body?.token ? { ...body, expires_at: Date.now()+60_000 } : body), { status, headers: { 'Content-Type': 'application/json', ...(status === 200 && body?.user ? { 'X-Sw-Access-Expires': String(Date.now()+60_000) } : {}) } });
const raw = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** Browser-ish globals: cookie mode, a recording localStorage, storage events. */
function browser({ cachedUser = null } = {}) {
  const values = new Map();
  const writes = [];
  const storageHandlers = [];
  globalThis.document = {};
  globalThis.localStorage = {
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => { writes.push(k); values.set(k, v); },
    removeItem: (k) => { writes.push(`-${k}`); values.delete(k); },
  };
  globalThis.window = { addEventListener: (type, fn) => { if (type === 'storage') storageHandlers.push(fn); } };
  if (cachedUser) values.set('sw_auth_user', JSON.stringify(cachedUser));
  return {
    values,
    writes,
    /** Another tab wrote `sw_auth_user`. */
    otherTab(nextUser) {
      if (nextUser) values.set('sw_auth_user', JSON.stringify(nextUser));
      else values.delete('sw_auth_user');
      for (const fn of storageHandlers) fn({ key: 'sw_auth_user' });
    },
  };
}

/** fetch router: `routes[path]` returns a Response, a Promise of one, or throws. */
function server(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input instanceof Request ? input.url : input), 'https://app.example').pathname;
    const entry = { path, init, done: false };
    calls.push(entry);
    try {
      const handler = routes[path];
      if (!handler) return json(404, {});
      const result = await handler(init, entry);
      return result;
    } finally {
      entry.done = true;
    }
  };
  return calls;
}

/** A response that never arrives unless the request is aborted. */
const hang = (init) => new Promise((_, reject) => {
  init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

async function settled(promise) {
  try { return { value: await promise }; } catch (error) { return { error }; }
}

// ---------------------------------------------------------------- status map

{
  browser({ cachedUser: A });
  server({ '/api/auth/me': () => json(200, { user: A }) });
  const auth = createSomewhereAuth();
  const before = auth.getState();
  check('a cached user starts unverified ("checking")', before.status === 'checking' && before.user?.id === 'usr_a');
  const seen = [];
  auth.onChange((s) => seen.push(s.status));
  const u = await auth.getUser();
  check('/me 200 → authenticated, getUser returns the user', auth.getState().status === 'authenticated' && u?.id === 'usr_a');
  check('onChange carries status (superset of { user, session })', seen[0] === 'checking' && seen.at(-1) === 'authenticated' && 'session' in auth.getState());
}

for (const [label, respond] of [['401', () => json(401, {})], ['{ user: null }', () => json(200, { user: null })]]) {
  browser({ cachedUser: A });
  server({ '/api/auth/me': respond });
  const auth = createSomewhereAuth();
  const u = await auth.getUser();
  check(`/me ${label} → signed-out (definitive)`, u === null && auth.getState().status === 'signed-out' && auth.getCachedUser() === null);
}

for (const [label, respond, code] of [
  ['503', () => json(503, {}), 503],
  ['network error', () => { throw new TypeError('fetch failed'); }, 0],
  ['unreadable 200 body', () => raw(200, 'not json'), 200],
  ['200 without a user field', () => json(200, { ok: true }), 200],
  ['200 with a malformed user', () => json(200, { user: { email: 'x' } }), 200],
]) {
  browser({ cachedUser: A });
  server({ '/api/auth/me': respond });
  const auth = createSomewhereAuth();
  const u = await auth.getUser();
  const s = auth.getState();
  check(`/me ${label} → indeterminate, last-known user kept, error ${code}`,
    s.status === 'indeterminate' && s.user?.id === 'usr_a' && u?.id === 'usr_a' && s.error?.code === 'SESSION_CHECK_FAILED' && s.error.status === code, s);
}
// The default server adapter keeps the runtime's verification outage as a
// fixed 503 (never 200 { user: null }); the client keeps the last-known user.
{
  const CANARY = 'CANARY-runtime-prose';
  const adapter = (fromRequest) => somewhereAuth(new Request('https://app.example/api/auth/me'), { auth: { fromRequest } });
  const outage = () => { const e = new Error(CANARY); e.code = 'AUTH_VERIFY_UNAVAILABLE'; e.status = 503; throw e; };
  const res = await adapter(outage);
  const body = await res.clone().json();
  check('adapter: AUTH_VERIFY_UNAVAILABLE → 503 with the fixed code and message',
    res.status === 503 && body.error === 'AUTH_VERIFY_UNAVAILABLE' && body.message === 'Identity verification is temporarily unavailable. Please retry.'
      && !JSON.stringify(body).includes('CANARY') && !('user' in body) && res.headers.get('set-cookie') === null, body);
  const other = await adapter(() => { const e = new Error(CANARY); e.code = 'SOMETHING_ELSE'; e.status = 503; throw e; });
  check('adapter: other codes are not passed through', (await other.json()).error === 'AUTH_ERROR');
  const none = await adapter(async () => null);
  check('adapter: no session stays 200 { user: null }', none.status === 200 && (await none.json()).user === null);

  browser({ cachedUser: A });
  server({ '/api/auth/me': () => adapter(outage) });
  const auth = createSomewhereAuth();
  const u = await auth.getUser();
  const s = auth.getState();
  check('adapter 503 → client indeterminate, last-known user kept',
    s.status === 'indeterminate' && s.user?.id === 'usr_a' && u?.id === 'usr_a' && auth.getCachedUser()?.id === 'usr_a' && s.error?.status === 503, s);

  browser({ cachedUser: A });
  server({ '/api/auth/me': () => adapter(async () => null) });
  const definitive = createSomewhereAuth();
  check('adapter 200 { user: null } → client signed-out (definitive)', (await definitive.getUser()) === null && definitive.getState().status === 'signed-out');
}
{
  browser();
  server({ '/api/auth/me': () => { throw new TypeError('fetch failed'); } });
  const auth = createSomewhereAuth();
  const u = await auth.getUser();
  check('network error with nothing cached → indeterminate, not signed-out', u === null && auth.getState().status === 'indeterminate');
}

// ------------------------------------------------------------ stale responses

{ // R1: a /me answered as A lands after signOut().
  browser({ cachedUser: A });
  const me = deferred();
  server({ '/api/auth/me': () => me.promise, '/api/auth/logout': () => json(200, { ok: true }) });
  const auth = createSomewhereAuth();
  const pending = auth.getUser();
  await tick();
  const signOut = auth.signOut();
  me.resolve(json(200, { user: A }));
  await signOut;
  await pending;
  check('R1: a late /me cannot restore a signed-out user', auth.getState().status === 'signed-out' && auth.getCachedUser() === null);
}

{ // R2: a signed-out /me lands after signIn(B).
  browser();
  const me = deferred();
  server({ '/api/auth/me': () => me.promise, '/api/auth/login': () => json(200, { user: B, cookie_session: true }) });
  const auth = createSomewhereAuth();
  const pending = auth.getUser();
  await tick();
  const signIn = auth.signIn({ email: B.email, password: 'pw' });
  me.resolve(json(200, { user: null }));
  await signIn;
  await pending;
  check('R2: a late signed-out /me cannot wipe a newer sign-in', auth.getState().status === 'authenticated' && auth.getCachedUser()?.id === 'usr_b');
}

{ // R2b: a /me answered as A lands after sign-out + sign-in as B.
  browser({ cachedUser: A });
  const me = deferred();
  server({
    '/api/auth/me': () => me.promise,
    '/api/auth/logout': () => json(200, { ok: true }),
    '/api/auth/login': () => json(200, { user: B, cookie_session: true }),
  });
  const auth = createSomewhereAuth();
  const pending = auth.getUser();
  await tick();
  const signOut = auth.signOut();
  const signIn = auth.signIn({ email: B.email, password: 'pw' });
  me.resolve(json(200, { user: A }));
  await signOut; await signIn;
  await pending;
  check('R2b: a late /me for A cannot replace B', auth.getCachedUser()?.id === 'usr_b' && auth.getState().status === 'authenticated');
}

{ // R3: auth.fetch started as A; its 401 lands after the switch to B.
  browser({ cachedUser: A });
  const api = deferred();
  server({
    '/api/x': () => api.promise,
    '/api/auth/logout': () => json(200, { ok: true }),
    '/api/auth/login': () => json(200, { user: B, cookie_session: true }),
  });
  const auth = createSomewhereAuth();
  const request = auth.fetch('/api/x');
  await tick();
  await auth.signOut();
  await auth.signIn({ email: B.email, password: 'pw' });
  api.resolve(json(401, { error: 'AUTH_REQUIRED' }));
  await request;
  check('R3: a stale 401 cannot clear a newer identity', auth.getCachedUser()?.id === 'usr_b' && auth.getState().status === 'authenticated');
}

{ // Control: a 401 for the current identity still signs out.
  browser({ cachedUser: A });
  server({ '/api/auth/me': () => json(200, { user: A }), '/api/x': () => json(401, {}) });
  const auth = createSomewhereAuth();
  await auth.getUser();
  await auth.fetch('/api/x');
  check('control: a current-generation 401 signs out', auth.getState().status === 'signed-out' && auth.getCachedUser() === null);
}

// -------------------------------------------------------- mutation ordering

{ // signIn, then signOut before the login answers: newer intent wins.
  browser();
  const login = deferred();
  const calls = server({ '/api/auth/login': () => login.promise, '/api/auth/logout': () => json(200, { ok: true }) });
  const auth = createSomewhereAuth();
  const signIn = settled(auth.signIn({ email: B.email, password: 'pw' }));
  await tick();
  const signOut = auth.signOut();
  await tick();
  check('signOut waits for the earlier queued login before calling /logout', calls.map((c) => c.path).join() === '/api/auth/login');
  check('signOut invalidates the earlier login while reporting pending', auth.getState().status === 'checking' && auth.getState().user === null && auth.getState().signingOut);
  login.resolve(json(200, { user: B, cookie_session: true }));
  const result = await signIn;
  await signOut;
  check('the superseded sign-in rejects AUTH_SUPERSEDED', result.error?.code === 'AUTH_SUPERSEDED', result);
  check('…and writes nothing: still signed out', auth.getState().status === 'signed-out' && auth.getCachedUser() === null);
  check('…and the server gets login, then logout', calls.map((c) => c.path).join() === '/api/auth/login,/api/auth/logout');
}

{ // signOut, then signIn: logout goes first, the sign-in stands.
  browser({ cachedUser: A });
  const logout = deferred();
  const calls = server({ '/api/auth/logout': () => logout.promise, '/api/auth/login': () => json(200, { user: B, cookie_session: true }) });
  const auth = createSomewhereAuth();
  const signOut = auth.signOut();
  const signIn = auth.signIn({ email: B.email, password: 'pw' });
  await tick();
  check('a later login waits for the earlier logout', calls.map((c) => c.path).join() === '/api/auth/logout');
  logout.resolve(json(200, { ok: true }));
  await signOut;
  const user = await signIn;
  check('signOut then signIn → authenticated as B, in call order', user?.id === 'usr_b' && auth.getState().status === 'authenticated' && calls.map((c) => c.path).join() === '/api/auth/logout,/api/auth/login');
}

{ // The queue continues after a rejection.
  browser();
  let n = 0;
  server({ '/api/auth/login': () => (++n === 1 ? json(401, { message: 'Wrong email or password.' }) : json(200, { user: B, cookie_session: true })) });
  const auth = createSomewhereAuth();
  const first = await settled(auth.signIn({ email: B.email, password: 'bad' }));
  const second = await settled(auth.signIn({ email: B.email, password: 'good' }));
  check('a failed sign-in rejects with the server message', first.error?.message === 'Wrong email or password.');
  check('the next queued sign-in still runs', second.value?.id === 'usr_b' && auth.getState().status === 'authenticated');
}

{ // A hung call is bounded and does not block the queue.
  browser({ cachedUser: A });
  const calls = server({ '/api/auth/login': (init) => hang(init), '/api/auth/logout': () => json(200, { ok: true }) });
  const auth = createSomewhereAuth({ mutationTimeoutMs: 30 });
  const signIn = settled(auth.signIn({ email: B.email, password: 'pw' }));
  const signOut = auth.signOut();
  const result = await signIn;
  await signOut;
  check('a hung sign-in rejects AUTH_TIMEOUT after mutationTimeoutMs', result.error?.code === 'AUTH_TIMEOUT', result);
  check('…and the queued signOut still reaches /logout', calls.some((c) => c.path === '/api/auth/logout'));
}

{ // A failed sign-in that invalidated the first check does not leave 'checking'.
  browser({ cachedUser: A });
  const me = deferred();
  let meCalls = 0;
  server({
    '/api/auth/me': () => (++meCalls === 1 ? me.promise : json(200, { user: A })),
    '/api/auth/login': () => json(401, { message: 'no' }),
  });
  const auth = createSomewhereAuth();
  const first = auth.getUser();
  await tick();
  const badSignIn = settled(auth.signIn({ email: A.email, password: 'bad' }));
  me.resolve(json(200, { user: A }));
  await badSignIn;
  await first;
  for (let i = 0; i < 5 && auth.getState().status === 'checking'; i++) await tick();
  check('a failed sign-in re-checks instead of staying "checking"', auth.getState().status === 'authenticated' && meCalls === 2, { status: auth.getState().status, meCalls });
}

{ // Checks: coalesced within a generation, and queued behind sign-ins.
  browser();
  const login = deferred();
  const calls = server({ '/api/auth/me': () => json(200, { user: B }), '/api/auth/login': () => login.promise });
  const auth = createSomewhereAuth();
  const one = auth.getUser();
  const two = auth.getUser();
  check('concurrent getUser() calls share one request', one === two);
  await one;
  const signIn = auth.signIn({ email: B.email, password: 'pw' });
  const during = auth.getUser();
  await tick();
  check('a check requested during a sign-in waits for it', calls.map((c) => c.path).join() === '/api/auth/me,/api/auth/login');
  login.resolve(json(200, { user: B, cookie_session: true }));
  await signIn;
  await during;
  check('…then reads /me after the new cookies', calls.map((c) => c.path).join() === '/api/auth/me,/api/auth/login,/api/auth/me');
}

// ---------------------------------------------------------------- sign-out

for (const [label, respond, status] of [['500', () => json(500, {}), 500], ['network error', () => { throw new TypeError('x'); }, 0]]) {
  browser({ cachedUser: A });
  server({ '/api/auth/logout': respond });
  const auth = createSomewhereAuth();
  const result = await settled(auth.signOut());
  const s = auth.getState();
  check(`/logout ${label}: resolves, signed-out locally, error SIGN_OUT_UNCONFIRMED`,
    !result.error && s.status === 'signed-out' && s.error?.code === 'SIGN_OUT_UNCONFIRMED' && s.error.status === status, s);
}
{
  browser();
  const calls = server({ '/api/auth/me': () => json(401, {}) });
  const auth = createSomewhereAuth();
  await auth.getUser();
  await auth.signOut();
  check('signOut when already confirmed signed-out makes no request', calls.every((c) => c.path !== '/api/auth/logout'));
}

// ---------------------------------------------------------------- other tabs

{
  const tab = browser({ cachedUser: A });
  const calls = server({ '/api/auth/me': () => json(200, { user: tab.values.has('sw_auth_user') ? JSON.parse(tab.values.get('sw_auth_user')) : null }) });
  const auth = createSomewhereAuth();
  await auth.getUser();
  const writesBefore = tab.writes.length;
  await auth.getUser();
  check('an identical /me answer does not rewrite the cached user (no cross-tab echo)', tab.writes.length === writesBefore);
  const statuses = [];
  auth.onChange((s) => statuses.push(`${s.status}:${s.user?.id ?? null}`));
  tab.otherTab(B);
  check('another tab\'s identity is not trusted: status → checking', statuses[1] === 'checking:usr_b', statuses);
  tab.otherTab(B); // duplicate event
  await tick(); await tick();
  const meCount = calls.filter((c) => c.path === '/api/auth/me').length;
  check('…one re-check, and a duplicate event adds none', meCount === 3, meCount);
  check('…the re-check confirms B', auth.getState().status === 'authenticated' && auth.getCachedUser()?.id === 'usr_b');
  tab.otherTab({ ...B, plan: 'pro' }); // same identity, new fields
  await tick();
  check('a same-identity update from another tab is ignored (no re-check)', calls.filter((c) => c.path === '/api/auth/me').length === 3);
}

// ---------------------------------------------------------------- header mode

{
  globalThis.document = undefined;
  delete globalThis.document;
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  const api = deferred();
  server({
    '/api/x': () => api.promise,
    '/api/y': () => new Response('{}', { status: 200, headers: { 'X-New-Access-Token': 'acc2', 'X-New-Refresh-Token': 'ref2' } }),
    '/api/auth/login': () => json(200, { token: 'accB', refresh_token: 'refB', user: B }),
    '/api/auth/logout': () => json(200, {}),
  });
  values.set('sw_auth', JSON.stringify({ accessToken: 'accA', refreshToken: 'refA' }));
  const auth = createSomewhereAuth({ mode: 'header', storage });
  await auth.fetch('/api/y');
  check('header: a current-generation rotation is stored atomically', JSON.parse(values.get('sw_auth')).accessToken === 'acc2' && JSON.parse(values.get('sw_auth')).refreshToken === 'ref2');
  const stale = auth.fetch('/api/x');
  await tick();
  await auth.signIn({ email: B.email, password: 'pw' });
  api.resolve(new Response('{}', { status: 200, headers: { 'X-New-Access-Token': 'accOLD', 'X-New-Refresh-Token': 'refOLD' } }));
  await stale;
  check('header: a rotation from before the sign-in is not adopted', auth.getSession()?.accessToken === 'accB');
  const stale401 = deferred();
  server({ '/api/z': () => stale401.promise, '/api/auth/login': () => json(200, { token: 'accC', refresh_token: 'refC', user: A }) });
  const old = auth.fetch('/api/z');
  await tick();
  await auth.signIn({ email: A.email, password: 'pw' });
  stale401.resolve(json(401, {}));
  await old;
  check('header: a 401 from before the sign-in does not clear the new session', auth.getSession()?.accessToken === 'accC' && auth.getState().status === 'authenticated');
  const retried = [];
  server({ '/api/w': (init) => { retried.push(new Headers(init.headers).get('Authorization')); return json(401, {}); } });
  values.set('sw_auth', JSON.stringify({ accessToken: 'accOther', refreshToken: 'refOther' }));
  await auth.fetch('/api/w');
  check('header control: same identity 401 retries once with the freshest pair, then clears', retried.join() === 'Bearer accC,Bearer accOther' && auth.getSession() === null && auth.getState().status === 'signed-out', retried);
}

// ------------------------------------------ owed sign-out (root blocker 1)

{ // Failure -> retry reaches the server again -> confirmed; then no more calls.
  browser({ cachedUser: A });
  let n = 0;
  const calls = server({ '/api/auth/logout': () => (++n === 1 ? json(500, {}) : json(200, { ok: true })) });
  const auth = createSomewhereAuth();
  await auth.signOut();
  let s = auth.getState();
  check('failed /logout: signOutUnconfirmed + SIGN_OUT_UNCONFIRMED, locally signed out',
    s.signOutUnconfirmed === true && s.error?.code === 'SIGN_OUT_UNCONFIRMED' && s.status === 'signed-out' && s.user === null, s);
  await auth.signOut();
  s = auth.getState();
  check('signOut() again retries /logout on the server', calls.filter((c) => c.path === '/api/auth/logout').length === 2);
  check('…and a confirmed /logout clears the obligation and the error', s.signOutUnconfirmed === false && s.error === null, s);
  await auth.signOut();
  check('control: once confirmed, signOut() makes no further request', calls.filter((c) => c.path === '/api/auth/logout').length === 2);
}
{ // Two failures stay owed; local settles do not clear it.
  browser({ cachedUser: A });
  server({ '/api/auth/logout': () => { throw new TypeError('offline'); } });
  const auth = createSomewhereAuth();
  await auth.signOut();
  await auth.signOut();
  check('repeated failures stay owed', auth.getState().signOutUnconfirmed === true);
}
{ // Header mode: the retry carries the token of the session being signed out.
  delete globalThis.document;
  const values = new Map([['sw_auth', JSON.stringify({ accessToken: 'accA', refreshToken: 'refA' })]]);
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  const sent = [];
  let n = 0;
  server({ '/api/auth/logout': (init) => { sent.push(new Headers(init.headers).get('Authorization')); return ++n === 1 ? json(503, {}) : json(200, {}); } });
  const auth = createSomewhereAuth({ mode: 'header', storage });
  await auth.signOut();
  await auth.getUser(); // local answer only (no session): must not clear the obligation
  check('header: a local "no session" answer does not confirm an owed sign-out', auth.getState().signOutUnconfirmed === true);
  await auth.signOut();
  check('header: the retry sends the original session token', sent.join() === 'Bearer accA,Bearer accA' && auth.getState().signOutUnconfirmed === false, sent);
}
for (const [label, respond, expect] of [
  ['/me 401', () => json(401, {}), { status: 'signed-out', owed: false }],
  ['/me with a user', () => json(200, { user: A }), { status: 'authenticated', owed: false }],
  ['/me 503', () => json(503, {}), { status: 'indeterminate', owed: true }],
]) {
  browser({ cachedUser: A });
  server({ '/api/auth/logout': () => json(500, {}), '/api/auth/me': respond });
  const auth = createSomewhereAuth();
  await auth.signOut();
  await auth.getUser();
  const s = auth.getState();
  check(`cookie: after a failed sign-out, ${label} → ${expect.status}, owed=${expect.owed}`, s.status === expect.status && s.signOutUnconfirmed === expect.owed, s);
}
{
  browser({ cachedUser: A });
  server({ '/api/auth/logout': () => json(500, {}), '/api/auth/login': () => json(200, { user: B, cookie_session: true }) });
  const auth = createSomewhereAuth();
  await auth.signOut();
  await auth.signIn({ email: B.email, password: 'pw' });
  check('a sign-in replaces the owed session (obligation cleared)', auth.getState().signOutUnconfirmed === false && auth.getState().error === null);
}
{ // A hung /logout: signOut() still resolves, and the obligation is recorded.
  browser({ cachedUser: A });
  server({ '/api/auth/logout': (init) => hang(init), '/api/auth/login': () => json(200, { user: B, cookie_session: true }) });
  const auth = createSomewhereAuth({ mutationTimeoutMs: 30 });
  const result = await settled(auth.signOut());
  check('a timed-out /logout resolves and stays owed', !result.error && auth.getState().signOutUnconfirmed === true, auth.getState());
  const next = await settled(auth.signIn({ email: B.email, password: 'pw' }));
  check('…and the queue moves on', next.value?.id === 'usr_b');
}

// -------------------------------------- deadline covers the whole call (blocker 2)

{ // Cookie handshake without a user; the fallback /me never answers.
  browser();
  const calls = server({
    '/api/auth/login': () => json(200, { cookie_session: true }),
    '/api/auth/me': (init) => hang(init),
    '/api/auth/logout': () => json(200, { ok: true }),
  });
  const auth = createSomewhereAuth({ mutationTimeoutMs: 30 });
  const signIn = settled(auth.signIn({ email: B.email, password: 'pw' }));
  while (!calls.some((c) => c.path === '/api/auth/me')) await tick(); // the fallback is in flight
  const signOut = auth.signOut();
  const result = await signIn;
  await signOut;
  check('a hung fallback /me times the sign-in out (AUTH_TIMEOUT)', result.error?.code === 'AUTH_TIMEOUT', result);
  check('…the fallback /me received the deadline signal', calls.find((c) => c.path === '/api/auth/me')?.init.signal?.aborted === true);
  check('…and the queued signOut still reaches /logout', calls.some((c) => c.path === '/api/auth/logout'));
}
{ // The fallback /me answers AFTER the deadline: it writes nothing.
  browser();
  const late = deferred();
  let meCalls = 0;
  server({
    '/api/auth/login': () => json(200, { cookie_session: true }),
    '/api/auth/me': () => (++meCalls === 1 ? late.promise : json(401, {})),
  });
  const auth = createSomewhereAuth({ mutationTimeoutMs: 30 });
  const result = await settled(auth.signIn({ email: B.email, password: 'pw' }));
  for (let i = 0; i < 10 && auth.getState().status === 'checking'; i++) await tick();
  const before = auth.getState().status;
  late.resolve(json(200, { user: B }));
  await tick(); await tick();
  check('timed-out sign-in re-checks /me so the state leaves "checking"', result.error?.code === 'AUTH_TIMEOUT' && before === 'signed-out' && meCalls === 2, { before, meCalls });
  check('a fallback /me answered after the deadline does not sign in', auth.getState().status === 'signed-out' && auth.getCachedUser() === null);
}
{ // A login body that never finishes is bounded too.
  browser();
  const calls = server({
    '/api/auth/login': () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    '/api/auth/logout': () => json(200, { ok: true }),
    '/api/auth/me': () => json(401, {}),
  });
  const auth = createSomewhereAuth({ mutationTimeoutMs: 30 });
  const signIn = settled(auth.signIn({ email: B.email, password: 'pw' }));
  const signOut = auth.signOut();
  const result = await signIn;
  await signOut;
  check('a never-ending response body times out', result.error?.code === 'AUTH_TIMEOUT', result);
  check('…and the queued signOut still reaches /logout', calls.some((c) => c.path === '/api/auth/logout'));
}
{
  browser();
  const bad = [0, -1, NaN, Infinity, 2 ** 31, '30000', null];
  const threw = bad.filter((value) => { try { createSomewhereAuth({ mutationTimeoutMs: value }); return false; } catch (e) { return e instanceof RangeError; } });
  check('invalid mutationTimeoutMs values throw RangeError', threw.length === bad.length, { threw: threw.map(String) });
  let ok = true;
  for (const value of [1, 2_147_483_647, undefined]) { try { createSomewhereAuth({ mutationTimeoutMs: value }); } catch { ok = false; } }
  check('control: 1, 2147483647 and the default are accepted', ok);
}

// --------------------------------- current vs stale sign-in network failures

{ // Current generation: a network failure leaves 'checking' via a truthful /me.
  browser();
  let meCalls = 0;
  server({ '/api/auth/login': () => { throw new TypeError('offline'); }, '/api/auth/me': () => { meCalls++; return json(401, {}); } });
  const auth = createSomewhereAuth();
  const result = await settled(auth.signIn({ email: B.email, password: 'pw' }));
  for (let i = 0; i < 10 && auth.getState().status === 'checking'; i++) await tick();
  check('a sign-in network failure while checking re-checks /me (→ signed-out)', result.error instanceof TypeError && auth.getState().status === 'signed-out' && meCalls === 1, auth.getState());
}
{ // Stale: the failure lands after a newer signOut; nothing is re-checked or changed.
  browser({ cachedUser: A });
  const login = deferred();
  let meCalls = 0;
  server({
    '/api/auth/login': () => login.promise,
    '/api/auth/logout': () => json(200, { ok: true }),
    '/api/auth/me': () => { meCalls++; return json(200, { user: A }); },
  });
  const auth = createSomewhereAuth();
  const signIn = settled(auth.signIn({ email: B.email, password: 'pw' }));
  await tick();
  const signOut = auth.signOut();
  login.resolve(Promise.reject(new TypeError('offline')));
  await signIn; await signOut; await tick();
  check('a stale sign-in failure after signOut() changes nothing', auth.getState().status === 'signed-out' && meCalls === 0, { status: auth.getState().status, meCalls });
}

// ------------------------------------- sign-out pending until the server answers

{ // Delayed /logout: keep last-known identity until the answer; credentials drop immediately.
  browser({ cachedUser: A });
  const logout = deferred();
  const calls = server({ '/api/auth/logout': () => logout.promise });
  const auth = createSomewhereAuth();
  const seen = [];
  auth.onChange((s) => seen.push(`${s.status}:${s.signingOut}`));
  const done = auth.signOut();
  let s = auth.getState();
  check('signOut(): last-known user retained and unverified while /logout is pending',
    s.user?.id === A.id && s.session === null && s.status === 'checking' && s.signingOut === true && s.signOutUnconfirmed === false, s);
  await tick(); await tick();
  check('…still pending before the server answers', auth.getState().signingOut === true);
  const logoutCall = calls.find((call) => call.path === '/api/auth/logout');
  check('…logout survives navigation while retaining its deadline and cookies',
    logoutCall?.init.keepalive === true && logoutCall.init.signal instanceof AbortSignal
      && logoutCall.init.credentials === 'include');
  logout.resolve(json(200, { ok: true }));
  await done;
  s = auth.getState();
  check('…signingOut false once /logout is answered (confirmed, no error)', s.user === null && s.status === 'signed-out' && s.signingOut === false && s.signOutUnconfirmed === false && s.error === null, s);
  check('…onChange reported pending, then confirmed', seen.includes('checking:true') && seen.at(-1) === 'signed-out:false', seen);
}
for (const [label, respond, opts] of [
  ['500', () => json(500, {}), {}],
  ['network error', () => { throw new TypeError('offline'); }, {}],
  ['timeout', (init) => hang(init), { mutationTimeoutMs: 30 }],
]) {
  browser({ cachedUser: A });
  server({ '/api/auth/logout': respond });
  const auth = createSomewhereAuth(opts);
  await auth.signOut();
  const s = auth.getState();
  check(`/logout ${label}: pending ends, sign-out reported unconfirmed (not claimed)`, s.signingOut === false && s.signOutUnconfirmed === true && s.error?.code === 'SIGN_OUT_UNCONFIRMED', s);
}
{
  browser();
  server({ '/api/auth/me': () => json(401, {}) });
  const auth = createSomewhereAuth();
  await auth.getUser();
  auth.signOut();
  check('control: no server work → never pending', auth.getState().signingOut === false);
}
{ // Two overlapping sign-outs: pending until both are answered.
  browser({ cachedUser: A });
  const first = deferred();
  let n = 0;
  server({ '/api/auth/logout': () => (++n === 1 ? json(500, {}) : first.promise) });
  const auth = createSomewhereAuth();
  const a = auth.signOut();
  const b = auth.signOut(); // owed after a's failure → retried
  await a;
  check('overlapping sign-outs: still pending while the second /logout is open', auth.getState().signingOut === true);
  first.resolve(json(200, {}));
  await b;
  check('…then confirmed', auth.getState().signingOut === false && auth.getState().signOutUnconfirmed === false);
}
{ // A sign-in queued after a pending sign-out stands once both finish.
  browser({ cachedUser: A });
  const logout = deferred();
  server({ '/api/auth/logout': () => logout.promise, '/api/auth/login': () => json(200, { user: B, cookie_session: true }) });
  const auth = createSomewhereAuth();
  const out = auth.signOut();
  const signIn = auth.signIn({ email: B.email, password: 'pw' });
  logout.resolve(json(200, {}));
  await out; await signIn;
  const s = auth.getState();
  check('sign-in after a pending sign-out: authenticated, not pending', s.status === 'authenticated' && s.user?.id === 'usr_b' && s.signingOut === false, s);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
