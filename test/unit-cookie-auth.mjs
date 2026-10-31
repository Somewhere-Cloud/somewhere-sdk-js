// Pure, no-network unit tests for cookie-mode auth (v0.6.0, tsk_0de555b1):
// browser-default httpOnly cookie sessions. Runs against the built ESM in
// dist/esm. No SMT_KEY / network required.
//
//   npm run build && node test/unit-cookie-auth.mjs

import { Somewhere, createClient } from '../dist/esm/index.js';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

/** A fetch double that records requests and replies per-path. */
function recorder(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let parsedBody = null;
    if (typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({
      url,
      method: init.method,
      headers: init.headers ?? {},
      credentials: init.credentials,
      body: parsedBody,
    });
    const r = responder(url, init) ?? { status: 200, json: {} };
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const USER = { id: 'usr_1', email: 'u@example.com', created_at: '2026-01-01T00:00:00Z' };

function cookieClient(responder, opts = {}) {
  const rec = recorder(responder);
  const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt.token', {
    fetch: rec.fetchImpl,
    authMode: 'cookie', // Node has no `document`; force what a browser defaults to
    ...opts,
  });
  return { sw, rec };
}

async function main() {
  /* ── mode defaults ─────────────────────────────────────────────── */
  console.log('mode defaults');
  {
    // No `document` in Node → header mode by default (CLI/native unchanged).
    const rec = recorder(() => ({ json: { ok: true, data: {} } }));
    const sw = createClient('https://demo.somewhere.tech', 'smt_dev_key', { fetch: rec.fetchImpl });
    await sw.auth.signInWithPassword({ email: 'a@b.c', password: 'pw' });
    const call = rec.calls.at(-1);
    check('node default = header mode (hits platform /v1/auth/login)', call.url.endsWith('/v1/auth/login'));
    check('node default sends Authorization', !!call.headers.Authorization);
  }
  {
    // Simulated browser: `document` exists → cookie default.
    globalThis.document = {};
    const rec = recorder(() => ({ json: USER }));
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt.token', { fetch: rec.fetchImpl });
    await sw.auth.signInWithPassword({ email: 'a@b.c', password: 'pw' });
    delete globalThis.document;
    const call = rec.calls.at(-1);
    check('browser default = cookie mode (hits /api/auth/login)', call.url === '/api/auth/login');
  }
  {
    // The happy path no longer requires a placeholder browser JWT merely to
    // construct the cookie client.
    globalThis.document = {};
    const rec = recorder((url) =>
      url === '/api/auth/login' ? { json: { user: USER } } : { json: { ok: true } },
    );
    const sw = createClient('https://demo.somewhere.tech', undefined, { fetch: rec.fetchImpl });
    await sw.auth.signIn({ email: USER.email, password: 'pw' });
    const invoked = await sw.functions.invoke('notes', { body: {} });
    delete globalThis.document;
    check('browser cookie client constructs and signs in with zero credential',
      rec.calls[0].url === '/api/auth/login' && !rec.calls[0].headers.Authorization);
    check('credential-free functions.invoke rides cookies only',
      rec.calls.at(-1).credentials === 'include'
        && !rec.calls.at(-1).headers.Authorization
        && invoked.error === null);
  }

  /* ── cookie sign-in: transport + state ─────────────────────────── */
  console.log('cookie sign-in');
  {
    const { sw, rec } = cookieClient((url) =>
      url === '/api/auth/login' ? { json: USER } : { json: { user: USER } },
    );
    const { data, error } = await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'pw' });
    const call = rec.calls.at(-1);
    check('POSTs the app route, not the platform', call.url === '/api/auth/login');
    check("sends credentials:'include'", call.credentials === 'include');
    check('sends NO Authorization header', !call.headers.Authorization);
    check('uses the shared @somewhere-cloud/sdk/server cookie handshake',
      call.headers['X-Sw-Auth-Mode'] === 'cookie');
    check('no error', error === null);
    check('returns the user', data?.user?.id === 'usr_1');
    check('session is cookie_session with no tokens', data?.session?.cookie_session === true && data?.session?.access_token === undefined);
    const { data: s } = await sw.auth.getSession();
    check('getSession reads the cookie session', s?.session?.cookie_session === true && s?.session?.user?.id === 'usr_1');
  }

  /* ── expected failures are Result errors with the real message ──── */
  console.log('cookie sign-in failures');
  {
    const { sw } = cookieClient(() => ({
      status: 401,
      json: { ok: false, error: 'INVALID_CREDENTIALS', message: 'Wrong email or password.' },
    }));
    const { data, error, status } = await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'nope' });
    check('never throws — error in Result', !!error);
    check('error carries the real code', error?.code === 'INVALID_CREDENTIALS');
    check('error carries the real message', /wrong email or password/i.test(error?.message ?? ''));
    check('status 401', status === 401);
    check('user is null', data?.user === null);
  }
  {
    const { sw } = cookieClient(() => ({
      status: 409,
      json: { ok: false, error: 'EMAIL_EXISTS', message: 'An account with this email already exists.' },
    }));
    const { error } = await sw.auth.signUp({ email: 'taken@example.com', password: 'long-enough' });
    check('signUp duplicate email → EMAIL_EXISTS', error?.code === 'EMAIL_EXISTS');
  }

  /* ── getUser: definitive vs transient ──────────────────────────── */
  console.log('cookie getUser');
  {
    let mode = 'ok';
    const { sw } = cookieClient((url) => {
      if (url === '/api/auth/login') return { json: USER };
      if (mode === 'ok') return { json: { user: USER } };
      if (mode === '401') return { status: 401, json: { user: null } };
      return { status: 500, json: {} };
    });
    await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'pw' });
    let r = await sw.auth.getUser();
    check('getUser probes /me and returns the user', r.data?.user?.id === 'usr_1');
    mode = '500';
    r = await sw.auth.getUser();
    check('5xx keeps the cached user (blip ≠ logout)', r.data?.user?.id === 'usr_1');
    mode = '401';
    r = await sw.auth.getUser();
    check('401 is definitive — user cleared', r.data?.user === null);
    const { data: s } = await sw.auth.getSession();
    check('session gone after definitive 401', s?.session === null);
  }

  /* ── network blip never reads as logout ─────────────────────────── */
  {
    let blow = false;
    const rec = recorder(() => ({ json: { user: USER } }));
    const blippy = async (url, init) => {
      if (blow) throw new TypeError('fetch failed');
      return rec.fetchImpl(url, init);
    };
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt.token', {
      fetch: blippy,
      authMode: 'cookie',
    });
    await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'pw' });
    blow = true;
    const r = await sw.auth.getUser();
    check('fetch throw keeps the cached user', r.data?.user?.id === 'usr_1');
  }

  /* ── signOut ────────────────────────────────────────────────────── */
  console.log('cookie signOut');
  {
    const { sw, rec } = cookieClient((url) =>
      url === '/api/auth/login' ? { json: USER } : { json: { ok: true } },
    );
    await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'pw' });
    const events = [];
    sw.auth.onAuthStateChange((e) => events.push(e));
    await sw.auth.signOut();
    const call = rec.calls.at(-1);
    check('POSTs /api/auth/logout with credentials', call.url === '/api/auth/logout' && call.credentials === 'include');
    const { data: s } = await sw.auth.getSession();
    check('session cleared locally', s?.session === null);
    check('SIGNED_OUT emitted', events.includes('SIGNED_OUT'));
  }

  /* ── dual-mode fallback: a tokens-returning backend → header session ─ */
  console.log('dual-mode fallback');
  {
    const { sw } = cookieClient((url) =>
      url === '/api/auth/login'
        ? { json: { token: 'acc_jwt', refresh_token: 'ref_tok', user: USER } }
        : { json: { user: USER } },
    );
    const { data } = await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'pw' });
    check('token response adopted as header session', data?.session?.access_token === 'acc_jwt');
    const { data: s } = await sw.auth.getSession();
    check('getSession returns the header session', s?.session?.access_token === 'acc_jwt' && !s?.session?.cookie_session);
  }

  /* ── OAuth: zero-code return defaults to the backend callback ───── */
  console.log('cookie OAuth');
  {
    globalThis.location = { origin: 'https://demo.somewhere.tech' };
    const { sw } = cookieClient(() => ({ json: {} }));
    const { data } = await sw.auth.signInWithOAuth({ provider: 'google' });
    delete globalThis.location;
    check(
      'redirect_uri defaults to /api/auth/callback',
      (data?.url ?? '').includes(encodeURIComponent('https://demo.somewhere.tech/api/auth/callback')),
    );
  }

  /* ── functions.invoke rides the cookie ──────────────────────────── */
  console.log('cookie functions.invoke');
  {
    const { sw, rec } = cookieClient(() => ({ json: { ok: true } }));
    await sw.functions.invoke('checkout', { body: { plan: 'pro' } });
    const call = rec.calls.at(-1);
    check('invoke sends credentials', call.credentials === 'include');
    check('invoke omits Authorization (cookie carries identity)', !call.headers.Authorization);
  }
  {
    // Header mode unchanged: Authorization present, no credentials.
    const rec = recorder(() => ({ json: { ok: true } }));
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt.token', {
      fetch: rec.fetchImpl,
      authMode: 'header',
    });
    await sw.functions.invoke('checkout', { body: {} });
    const call = rec.calls.at(-1);
    check('header-mode invoke keeps Authorization', !!call.headers.Authorization);
    check('header-mode invoke sends no credentials field', call.credentials === undefined);
  }

  /* ── platform-endpoint methods teach instead of misleading ──────── */
  console.log('cookie-mode platform endpoints');
  {
    const { sw } = cookieClient((url) =>
      url === '/api/auth/login' ? { json: USER } : { json: { user: USER } },
    );
    await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'pw' });
    const { error } = await sw.auth.updateUser({ display_name: 'X' });
    check('updateUser teaches the backend-route fix', error?.code === 'COOKIE_MODE_BACKEND_ROUTE_REQUIRED');
    check('message names the docs topic', /auth-client/.test(error?.message ?? ''));
  }

  /* ── exhaustive auth method + shared-adapter contract matrix ───── */
  console.log('auth contract matrix');
  {
    const { sw } = cookieClient(() => ({ json: { user: USER } }));
    const internalMethods = new Set([
      'cookieSession',
      'setCookieUser',
      'emit',
      'runCookieSessionFlow',
      'runCookieAction',
      'cookieModeNeedsBackend',
      'runAuthFlow',
      'signedInMfa',
      'runMfaCall',
      'runCookieMfa',
      'sessionMutation',
      'performSignOut',
    ]);
    const runtimeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(sw.auth))
      .filter((name) => name !== 'constructor')
      .filter((name) => typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sw.auth), name)?.value === 'function')
      .filter((name) => !internalMethods.has(name))
      .sort();
    const methodMatrix = [
      ['onAuthStateChange', 'local'],
      ['signUp', 'adapter:POST /api/auth/signup'],
      ['signInWithPassword', 'adapter:POST /api/auth/login'],
      ['signIn', 'adapter:POST /api/auth/login'],
      ['sendMagicLink', 'adapter:POST /api/auth/magic-link'],
      ['verifyMagicLink', 'adapter:POST /api/auth/magic-link/verify'],
      ['signInWithOAuth', 'platform-redirect'],
      ['completeMfa', 'adapter:POST /api/auth/mfa/challenge'],
      ['resendMfaCode', 'adapter:POST /api/auth/mfa/challenge'],
      ['enrollMfa', 'adapter:POST /api/auth/mfa/enroll'],
      ['verifyMfaEnrollment', 'adapter:POST /api/auth/mfa/verify'],
      ['unenrollMfa', 'adapter:POST /api/auth/mfa/unenroll'],
      ['signOut', 'adapter:POST /api/auth/logout'],
      ['getSession', 'local'],
      ['getUser', 'adapter:GET /api/auth/me'],
      ['setSession', 'compatibility:header'],
      ['updateUser', 'compatibility:platform'],
      ['refreshSession', 'cookie-probe-or-compatibility:header'],
      ['updatePassword', 'compatibility:platform'],
      ['resendVerification', 'compatibility:platform'],
      ['verifyEmail', 'compatibility:platform'],
      ['deleteAccount', 'compatibility:platform'],
      ['resetPasswordForEmail', 'compatibility:platform'],
      ['verifyPasswordReset', 'compatibility:platform'],
      ['verifyOtp', 'deprecated-alias:verifyPasswordReset'],
    ];
    check('matrix classifies every advertised AuthClient method exactly once',
      JSON.stringify(runtimeMethods) === JSON.stringify(methodMatrix.map(([name]) => name).sort()));

    const adapterCases = [
      ['signUp', (auth) => auth.signUp({ email: USER.email, password: 'pw' }), 'POST', '/api/auth/signup'],
      ['signInWithPassword', (auth) => auth.signInWithPassword({ email: USER.email, password: 'pw' }), 'POST', '/api/auth/login'],
      ['signIn', (auth) => auth.signIn({ email: USER.email, password: 'pw' }), 'POST', '/api/auth/login'],
      ['sendMagicLink', (auth) => auth.sendMagicLink({ email: USER.email }), 'POST', '/api/auth/magic-link'],
      ['verifyMagicLink', (auth) => auth.verifyMagicLink({ token: 'magic' }), 'POST', '/api/auth/magic-link/verify'],
      ['getUser', (auth) => auth.getUser(), 'GET', '/api/auth/me'],
      ['enrollMfa', (auth) => auth.enrollMfa(), 'POST', '/api/auth/mfa/enroll'],
      ['verifyMfaEnrollment', (auth) => auth.verifyMfaEnrollment({ challenge_id: 'enroll:s:1', code: '111111' }), 'POST', '/api/auth/mfa/verify'],
      ['unenrollMfa', (auth) => auth.unenrollMfa({ password: 'pw' }), 'POST', '/api/auth/mfa/unenroll'],
    ];
    for (const [name, invoke, method, path] of adapterCases) {
      const current = cookieClient((url) =>
        url === '/api/auth/magic-link' ? { json: { sent: true } } : { json: { user: USER } },
      );
      const result = await invoke(current.sw.auth);
      const call = current.rec.calls.at(-1);
      check(`${name} delegates to ${method} ${path}`,
        call.method === method && call.url === path && result.error === null);
    }

    const logout = cookieClient((url) =>
      url === '/api/auth/login' ? { json: { user: USER } } : { json: { ok: true } },
    );
    await logout.sw.auth.signIn({ email: USER.email, password: 'pw' });
    await logout.sw.auth.signOut();
    check('signOut delegates to POST /api/auth/logout',
      logout.rec.calls.at(-1).method === 'POST' && logout.rec.calls.at(-1).url === '/api/auth/logout');
  }

  /* ── browser data warning: states the contract and the supported routes ─ */
  console.log('browser direct-data warnings');
  {
    globalThis.document = {};
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    const rec = recorder((url) => {
      if (url.includes('/db/query')) return { json: { ok: true, data: { data: [] } } };
      if (url.includes('/api/notes')) return { json: { ok: true } };
      return { json: { ok: true, data: {} } };
    });
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt.token', {
      fetch: rec.fetchImpl,
      cache: false,
    });
    const dbResult = await sw.from('todos').select('*');
    const removeResult = await sw.storage.from('avatars').remove(['a.png', 'b.png']);
    const warningCountBeforeFunction = warnings.length;
    const functionResult = await sw.functions.invoke('notes', { body: {} });
    console.warn = originalWarn;
    delete globalThis.document;

    const dbWarning = warnings.find((message) => /Direct browser database API calls are disabled/.test(message));
    const fsWarnings = warnings.filter((message) => /Direct browser file API calls are disabled/.test(message));
    check('direct browser database call warns that it is disabled and names the supported routes',
      !!dbWarning && /somewhere:data/.test(dbWarning) && /declared data rules/.test(dbWarning) && /sw\.db/.test(dbWarning));
    check('direct browser files call warns once, naming somewhere:files and sw.fs',
      fsWarnings.length === 1 && /somewhere:files/.test(fsWarnings[0]) && /sw\.fs/.test(fsWarnings[0]));
    check('the SDK does not block locally: the request is sent and the server answer comes back as a Result',
      dbResult.error === null && removeResult.error === null && removeResult.data?.length === 2
        && rec.calls.some((call) => call.url.includes('/db/query')));
    check('same-origin functions.invoke stays warning-free',
      warnings.length === warningCountBeforeFunction && functionResult.error === null);
    check('no warning says the call still works',
      warnings.every((message) => !/still works/i.test(message)));
  }

  /* ── advanced/manual mode is untouched ──────────────────────────── */
  console.log('header mode (manual) untouched');
  {
    const rec = recorder(() => ({
      json: { ok: true, data: { token: 'acc', refresh_token: 'ref', user: USER } },
    }));
    const sw = new Somewhere({ key: 'smt_dev', projectId: 'demo', fetch: rec.fetchImpl, authMode: 'header' });
    const { data } = await sw.auth.signInWithPassword({ email: 'u@example.com', password: 'pw' });
    check('header sign-in returns tokens', data?.session?.access_token === 'acc');
    const call = rec.calls.at(0);
    check('header sign-in hits the platform', call.url.endsWith('/v1/auth/login'));
  }

  if (failures) {
    console.error(`\n✗ unit-cookie-auth: ${failures} failed`);
    process.exit(1);
  }
  console.log('\n✓ unit-cookie-auth: all passed');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
