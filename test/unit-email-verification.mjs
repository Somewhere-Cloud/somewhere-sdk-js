/**
 * Email verification through the packaged handler (platform tsk_5b2ff298).
 *
 * GET /verify-email reports whether the signed-in account is verified;
 * POST /request-email-verification and POST /verify-email call the runtime's
 * cookie-session helpers with the request itself, so the account is the
 * request's own session and no token is read, returned or handled by page code.
 * A refusal keeps the platform's code and 4xx status; a runtime without the
 * helpers answers 501 before calling anything. The client methods ride the
 * session through auth.fetch.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { somewhereAuth } from '@somewhere-cloud/sdk/server';
import { createSomewhereAuth, AuthError } from '@somewhere-cloud/sdk/auth';

const ORIGIN = 'https://app.somewhere.site';
const err = (code, status) => Object.assign(new Error(`platform ${code}`), { code, status });

function platform({ helpers = true, user = { id: 'u1', email: 'a@x.test', email_verified: false } } = {}) {
  const calls = [];
  const codes = { u1: '123456' };
  const auth = {
    async fromRequest(req) { calls.push(['fromRequest', req.headers.get('cookie')]); return req.headers.get('cookie') ? user : null; },
  };
  if (helpers) {
    auth.requestEmailVerificationWithCookie = async (req) => {
      calls.push(['request', req.headers.get('cookie')]);
      if (!req.headers.get('cookie')) throw err('AUTH_REQUIRED', 401);
      return { sent: true, code_created: true, expires_in_seconds: 900 };
    };
    auth.verifyEmailWithCookie = async (req, opts) => {
      calls.push(['verify', req.headers.get('cookie'), opts]);
      if (!req.headers.get('cookie')) throw err('AUTH_REQUIRED', 401);
      if (!/^[0-9]{6}$/.test(opts.code)) throw err('VALIDATION_ERROR', 400);
      if (opts.code !== codes[user.id]) throw err('AUTH_INVALID_CODE', 400);
      user.email_verified = true;
      return { verified: true };
    };
  }
  return { sw: { auth }, calls, user };
}

const call = async (p, method, path, body, cookie = '__Host-token=t; __Host-sw_refresh_token=r') => {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) };
  const res = await somewhereAuth(new Request(ORIGIN + '/api/auth' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), p.sw);
  return { status: res.status, body: await res.json() };
};

test('status, request and verify use the request session and return no token', async () => {
  const p = platform();
  assert.deepEqual(await call(p, 'GET', '/verify-email'), { status: 200, body: { email_verified: false } });
  const sent = await call(p, 'POST', '/request-email-verification', {});
  assert.deepEqual(sent, { status: 200, body: { sent: true, code_created: true, expires_in_seconds: 900 } });
  const ok = await call(p, 'POST', '/verify-email', { code: '123456' });
  assert.deepEqual(ok, { status: 200, body: { verified: true } });
  assert.deepEqual(await call(p, 'GET', '/verify-email'), { status: 200, body: { email_verified: true } });
  assert.deepEqual(p.calls.filter(([name]) => name !== 'fromRequest').map(([name, cookie]) => [name, cookie]),
    [['request', '__Host-token=t; __Host-sw_refresh_token=r'], ['verify', '__Host-token=t; __Host-sw_refresh_token=r']],
    'the helpers receive the request itself, so its session decides the account');
  assert.doesNotMatch(JSON.stringify([sent.body, ok.body]), /token|refresh/i);
});

test('refusals keep the platform code and status', async () => {
  const p = platform();
  assert.deepEqual(await call(p, 'GET', '/verify-email', undefined, null), { status: 401, body: { error: 'AUTH_REQUIRED', message: 'Sign in required.' } });
  const signedOut = await call(p, 'POST', '/verify-email', { code: '123456' }, null);
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.body.error, 'AUTH_REQUIRED');
  const wrong = await call(p, 'POST', '/verify-email', { code: '654321' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'AUTH_INVALID_CODE');
  assert.equal(p.user.email_verified, false, 'a wrong code verifies nothing');
  const malformed = await call(p, 'POST', '/verify-email', {});
  assert.equal(malformed.body.error, 'VALIDATION_ERROR', 'a missing code reaches the runtime as an empty string and is refused there');
  const broken = platform();
  broken.sw.auth.verifyEmailWithCookie = async () => { throw new Error('upstream down'); };
  const unknown = await call(broken, 'POST', '/verify-email', { code: '123456' });
  assert.equal(unknown.status, 502, 'a non-4xx failure is never reported as success or as the caller\'s fault');
});

test('a runtime without the helpers answers 501 before calling anything', async () => {
  const p = platform({ helpers: false });
  for (const path of ['/request-email-verification', '/verify-email']) {
    const r = await call(p, 'POST', path, { code: '123456' });
    assert.equal(r.status, 501);
    assert.equal(r.body.error, 'EMAIL_VERIFICATION_UNAVAILABLE');
  }
  assert.deepEqual(p.calls, []);
});

test('client methods ride the session through the packaged handler', async () => {
  const p = platform();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? new URL(input, ORIGIN).toString() : input.url;
    const headers = new Headers(init.headers);
    headers.set('Cookie', '__Host-token=t; __Host-sw_refresh_token=r'); // what the browser attaches
    headers.set('Origin', ORIGIN);
    return somewhereAuth(new Request(target, { ...init, headers }), p.sw);
  };
  try {
    const auth = createSomewhereAuth({ baseUrl: ORIGIN });
    assert.equal(await auth.emailVerified(), false);
    await auth.requestEmailVerification();
    await assert.rejects(() => auth.verifyEmail({ code: '000000' }), (e) => e instanceof AuthError && e.status === 400);
    assert.equal(await auth.emailVerified(), false);
    await auth.verifyEmail({ code: '123456' });
    assert.equal(await auth.emailVerified(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
