// Sign-in hardening (0.9.0). Pure, no-network; runs against the built package.
//
//   1. pfb_961179f4970e — a cookie-mode client whose server does not confirm
//      `cookie_session: true` throws a typed AuthError and stores NOTHING;
//      a confirmed cookie session writes no token to storage; explicit
//      header mode still stores its pair (both directions).
//   2. pfb_3bbdbee14d7d — the packaged /billing/checkout and /billing/portal
//      routes call sw.payments.checkoutForUser(opts) / portalForUser(opts),
//      the runtime's actual signature, against a stub that behaves like the
//      runtime (worker/src/runtime/payments.ts): the user is derived, not
//      passed, and a missing opts.plan throws VALIDATION_ERROR.
//
//   npm run build && node test/unit-signin-hardening.mjs

import { createSomewhereAuth, AuthError } from '@somewhere-tech/sdk/auth';
import { somewhereAuth } from '@somewhere-tech/sdk/server';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`OK   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
};

const USER = { id: 'u1', email: 'person@example.com' };

/** Storage that records every write. */
function recordingStorage() {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => { writes.push([k, v]); values.set(k, v); },
    removeItem: (k) => void values.delete(k),
  };
}

/** Point global fetch at one canned /login (and /me) response. */
function serve(loginBody) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), 'https://app.example').pathname;
    calls.push({ path, headers: init.headers ?? {} });
    const body = path.endsWith('/login') ? loginBody : { user: USER };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const tokenLeaked = (storage) => storage.writes.some(([, v]) => /acc_jwt|ref_tok/.test(v));

async function signInResult(auth) {
  try {
    return { user: await auth.signIn({ email: USER.email, password: 'pw' }) };
  } catch (error) {
    return { error };
  }
}

console.log('cookie mode: server confirms cookie_session → no token stored');
{
  const storage = recordingStorage();
  const calls = serve({ user: USER, cookie_session: true });
  const auth = createSomewhereAuth({ mode: 'cookie', storage });
  const r = await signInResult(auth);
  check('signIn resolves the user', r.user?.id === 'u1', r.error?.message);
  check('client sent X-Sw-Auth-Mode: cookie', calls[0]?.headers['X-Sw-Auth-Mode'] === 'cookie');
  check('no write to the token key (sw_auth)', !storage.writes.some(([k]) => k === 'sw_auth'), storage.writes);
  check('no token value anywhere in storage', !tokenLeaked(storage));
  check('getSession() is null (tokens are httpOnly)', auth.getSession() === null);
}

for (const [label, body] of [
  ['server returns a token bundle (handler ignores cookie mode)', { token: 'acc_jwt', refresh_token: 'ref_tok', user: USER }],
  ['server returns { user } only (handler omits cookie_session)', { user: USER }],
  ['server returns an enveloped token bundle', { data: { access_token: 'acc_jwt', refresh_token: 'ref_tok', user: USER } }],
]) {
  console.log(`cookie mode: ${label} → typed error, nothing stored`);
  const storage = recordingStorage();
  serve(body);
  const auth = createSomewhereAuth({ mode: 'cookie', storage });
  const r = await signInResult(auth);
  check('signIn rejects', !!r.error && !r.user);
  check('error is an AuthError', r.error instanceof AuthError, r.error?.name);
  check('error.code is COOKIE_SESSION_NOT_CONFIRMED', r.error?.code === 'COOKIE_SESSION_NOT_CONFIRMED', r.error?.code);
  check('message names the handler fix', /cookie_session: true/.test(r.error?.message ?? '') && /somewhereAuth/.test(r.error?.message ?? ''), r.error?.message);
  check('no credentials written to storage', !storage.values.has('sw_auth') && !tokenLeaked(storage), storage.writes);
  check('getSession() stays null', auth.getSession() === null);
  check('getCachedUser() stays null', auth.getCachedUser() === null);
}
{
  // Printed so the exact customer-facing string is visible in test output.
  serve({ token: 'acc_jwt', refresh_token: 'ref_tok', user: USER });
  const r = await signInResult(createSomewhereAuth({ mode: 'cookie', storage: recordingStorage() }));
  console.log(`     message: ${r.error?.message}`);
}

console.log('cookie mode: signUp and magic-link verify refuse the same way');
{
  const storage = recordingStorage();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ token: 'acc_jwt', refresh_token: 'ref_tok', user: USER }), { status: 200 });
  const auth = createSomewhereAuth({ mode: 'cookie', storage });
  const up = await auth.signUp({ email: USER.email, password: 'pw' }).catch((e) => e);
  const ml = await auth.verifyMagicLink({ token: 't' }).catch((e) => e);
  await auth.getUser(); // Drain the queued recovery check before replacing the fetch fixture.
  check('signUp → COOKIE_SESSION_NOT_CONFIRMED', up?.code === 'COOKIE_SESSION_NOT_CONFIRMED');
  check('verifyMagicLink → COOKIE_SESSION_NOT_CONFIRMED', ml?.code === 'COOKIE_SESSION_NOT_CONFIRMED');
  check('no credentials written to storage', !storage.values.has('sw_auth') && !tokenLeaked(storage), storage.writes);
}

console.log('cookie mode: a server error still surfaces the server message, not the handshake error');
{
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }), { status: 401 });
  const r = await signInResult(createSomewhereAuth({ mode: 'cookie', storage: recordingStorage() }));
  check('401 → server message', r.error?.message === 'Invalid email or password.' && r.error?.status === 401 && r.error?.code === undefined);
}

console.log('header mode (explicit): token bundle is still stored');
{
  const storage = recordingStorage();
  const calls = serve({ token: 'acc_jwt', refresh_token: 'ref_tok', user: USER });
  const auth = createSomewhereAuth({ mode: 'header', storage });
  const r = await signInResult(auth);
  check('signIn resolves the user', r.user?.id === 'u1', r.error?.message);
  check('header mode asks for tokens explicitly (X-Sw-Auth-Mode: header)', calls.find(c => c.path.endsWith('/login'))?.headers['X-Sw-Auth-Mode'] === 'header');
  check('token pair stored under sw_auth', JSON.parse(storage.values.get('sw_auth') ?? '{}').accessToken === 'acc_jwt');
}

/* ── PricingTable / BillingPortal → runtime signature ───────────────── */

// Mirrors worker/src/runtime/payments.ts (runtime v2): one `opts` argument,
// user derived from the request, VALIDATION_ERROR without opts.plan.
const runtimeCalls = [];
function runtimePayments(signedIn) {
  const requireSubject = (label) => {
    if (!signedIn) {
      const err = new Error(`${label} requires a signed-in user.`);
      err.status = 401;
      throw err;
    }
    return USER.id;
  };
  return {
    async checkoutForUser(opts) {
      runtimeCalls.push(['checkoutForUser', [...arguments]]);
      opts = opts || {};
      if (!opts.plan) {
        const err = new Error('sw.payments.checkoutForUser: opts.plan is required');
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const userId = requireSubject('sw.payments.checkoutForUser');
      return { url: `https://checkout.example/${opts.plan}?u=${userId}&s=${encodeURIComponent(opts.success_url ?? '')}` };
    },
    async portalForUser(opts) {
      runtimeCalls.push(['portalForUser', [...arguments]]);
      opts = opts || {};
      requireSubject('sw.payments.portalForUser');
      return { url: `https://portal.example/?r=${encodeURIComponent(opts.return_url ?? '')}` };
    },
  };
}
const swFor = (signedIn) => ({
  auth: { fromRequest: async () => (signedIn ? USER : null) },
  payments: runtimePayments(signedIn),
});
const post = (path, body) =>
  new Request(`https://app.example/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

console.log('billing: Subscribe reaches the runtime with its (opts) signature');
{
  runtimeCalls.length = 0;
  const res = await somewhereAuth(post('/billing/checkout', { plan: 'pro', success_url: 'https://app.example/ok' }), swFor(true));
  const body = await res.json();
  check('200 with a checkout url', res.status === 200 && body.url?.startsWith('https://checkout.example/pro'), { status: res.status, body });
  const [, args] = runtimeCalls[0] ?? [];
  check('called with exactly one argument', args?.length === 1, args);
  check('that argument carries plan + success_url, no user id', args?.[0]?.plan === 'pro' && args?.[0]?.success_url === 'https://app.example/ok' && !JSON.stringify(args).includes('"u1"'), args);
}
{
  runtimeCalls.length = 0;
  const res = await somewhereAuth(post('/billing/portal', { return_url: 'https://app.example/account' }), swFor(true));
  const body = await res.json();
  check('portal: 200 and return_url reaches the runtime', res.status === 200 && body.url === `https://portal.example/?r=${encodeURIComponent('https://app.example/account')}`, body);
  check('portal: called with exactly one argument', runtimeCalls[0]?.[1]?.length === 1, runtimeCalls[0]);
}
console.log('billing: refusals still hold');
{
  runtimeCalls.length = 0;
  const anon = await somewhereAuth(post('/billing/checkout', { plan: 'pro' }), swFor(false));
  check('signed out → 401 AUTH_REQUIRED, runtime never called', anon.status === 401 && (await anon.json()).error === 'AUTH_REQUIRED' && runtimeCalls.length === 0);
  const noPlan = await somewhereAuth(post('/billing/checkout', {}), swFor(true));
  check('no plan → 400 VALIDATION_ERROR, runtime never called', noPlan.status === 400 && runtimeCalls.length === 0);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
