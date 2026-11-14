// The packaged /api/auth route keeps a refusal's retry delay (tsk_37190ca1). The platform's sign-in
// lockout (production's known-account lockout and a preview's per-address lockout) and its rate
// limits answer retry_after_ms; the runtime puts it on the thrown error. The route used to answer
// { error: 'AUTH_ERROR', message } and drop it, so "a later attempt is accepted after retry_after_ms"
// named a value nobody received. Now the body keeps it and Retry-After says it in whole seconds.
// Refusals without a delay answer exactly as before.
//
//   npm run build && node test/unit-auth-retry-after.mjs

import { somewhereAuth } from '@somewhere-cloud/sdk/server';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`OK   ${name}`);
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
};

const login = (headers = {}) => new Request('https://app.example/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.example', ...headers },
  body: JSON.stringify({ email: 'person@example.com', password: 'wrong-password' }),
});
/** The runtime's error for a platform refusal (context-head.ts __sw_platformError keeps retry_after_ms). */
const refusal = (status, code, message, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });
const swThrowing = (error) => ({ auth: {
  loginWithCookie: async () => { throw error; },
  login: async () => { throw error; },
} });

const LOCKED = 'Too many failed sign-ins for this address in this preview. A later attempt is accepted after retry_after_ms.';
for (const [mode, headers] of [['cookie session', {}], ['header session', { 'X-Sw-Auth-Mode': 'header' }]]) {
  const res = await somewhereAuth(login(headers), swThrowing(refusal(429, 'RATE_LIMITED', LOCKED, { retry: true, retry_after_ms: 899_001 })));
  const body = await res.json();
  check(`${mode}: lockout keeps its status`, res.status === 429, res.status);
  check(`${mode}: lockout keeps retry_after_ms`, body.retry_after_ms === 899_001, body);
  check(`${mode}: lockout sends Retry-After in whole seconds, rounded up`, res.headers.get('Retry-After') === '900', res.headers.get('Retry-After'));
  check(`${mode}: message unchanged`, body.error === 'AUTH_ERROR' && body.message === LOCKED, body);
}
const now = await somewhereAuth(login(), swThrowing(refusal(429, 'RATE_LIMITED', 'Try again now.', { retry_after_ms: 0 })));
check('a zero delay says Retry-After: 0', now.headers.get('Retry-After') === '0' && (await now.json()).retry_after_ms === 0);
// Production's unknown address and a wrong password: 401 with no delay, exactly as before.
const wrong = await somewhereAuth(login(), swThrowing(refusal(401, 'AUTH_INVALID_CREDS', 'Wrong email or password.')));
const wrongBody = await wrong.json();
check('a refusal without a delay answers as before', wrong.status === 401 && wrong.headers.get('Retry-After') === null
  && JSON.stringify(wrongBody) === JSON.stringify({ error: 'AUTH_ERROR', message: 'Wrong email or password.' }), wrongBody);
for (const bad of ['900', -1, Number.NaN, Infinity, null]) {
  const res = await somewhereAuth(login(), swThrowing(refusal(429, 'RATE_LIMITED', 'Slow down.', { retry_after_ms: bad })));
  const body = await res.json();
  check(`a malformed delay (${String(bad)}) is not repeated`, res.headers.get('Retry-After') === null && !('retry_after_ms' in body), body);
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nunit-auth-retry-after: all checks passed');
