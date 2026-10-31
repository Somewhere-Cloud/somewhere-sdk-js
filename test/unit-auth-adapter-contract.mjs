import assert from 'node:assert/strict';
/**
 * Exhaustive public-client ↔ server-adapter contract.
 *
 * This is deliberately a matrix, not a few hand-picked route tests. Adding a
 * public client method without classifying and exercising its adapter contract
 * must fail this suite before the package can publish again.
 */
import { createSomewhereAuth } from '@somewhere-cloud/sdk/auth';
import { somewhereAuth } from '@somewhere-cloud/sdk/server';
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
const check = (name, condition) => {
  if (condition) {
    passed++;
    process.stdout.write(`OK   ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}\n`);
  }
};

const authModule = await import('@somewhere-cloud/sdk/auth');
const reactModule = await import('@somewhere-cloud/sdk/react');
const serverModule = await import('@somewhere-cloud/sdk/server');
check('auth subpath exports the complete framework-agnostic runtime surface',
  JSON.stringify(Object.keys(authModule).sort()) === JSON.stringify([
    'AuthError',
    'createSomewhereAuth',
  ]));
check('react subpath exports every provider, hook, gate, callback, and billing component',
  JSON.stringify(Object.keys(reactModule).sort()) === JSON.stringify([
    'AuthCallback',
    'BillingPortal',
    'Gate',
    'PricingTable',
    'Protect',
    'SignedIn',
    'SignedOut',
    'SomewhereAuthProvider',
    'useAuth',
    'useAuthLoading',
    'useAuthState',
    'useEntitlements',
    'useSession',
    'useUser',
  ]));
check('server subpath exports the auth adapter handler',
  JSON.stringify(Object.keys(serverModule).sort()) === JSON.stringify(['somewhereAuth']));

const authDeclarations = readFileSync(
  new URL('../dist/types/auth/client.d.ts', import.meta.url),
  'utf8',
);
const userDeclaration = authDeclarations.match(/export interface User \{([\s\S]*?)\n\}/)?.[1] ?? '';
check('auth declarations export the complete AppUserRole union',
  /export type AppUserRole = 'user' \| 'admin';/.test(authDeclarations));
check('User.role stays optional for pre-RBAC consumers',
  /^\s*role\?: AppUserRole;$/m.test(userDeclaration));

const contract = [
  { client: 'fetch', kind: 'passthrough' },
  { client: 'signUp', route: 'POST /api/auth/signup', runtime: 'auth.signupWithCookie' },
  { client: 'signIn', route: 'POST /api/auth/login', runtime: 'auth.loginWithCookie' },
  { client: 'sendMagicLink', route: 'POST /api/auth/magic-link', runtime: 'auth.signInWithOtp' },
  { client: 'verifyMagicLink', route: 'POST /api/auth/magic-link/verify', runtime: 'auth.verifyOtp' },
  { client: 'emailVerified', route: 'GET /api/auth/verify-email', runtime: 'auth.fromRequest' },
  { client: 'requestEmailVerification', route: 'POST /api/auth/request-email-verification', runtime: 'auth.requestEmailVerificationWithCookie' },
  { client: 'verifyEmail', route: 'POST /api/auth/verify-email', runtime: 'auth.verifyEmailWithCookie' },
  { client: 'googleSignInUrl', route: 'GET /api/auth/google-url', runtime: 'auth.oauthStart' },
  { client: 'completeGoogleSignIn', route: 'POST /api/auth/google', runtime: 'auth.googleExchange' },
  { client: 'githubSignInUrl', route: 'GET /api/auth/github-url', runtime: 'auth.oauthStart' },
  { client: 'completeGithubSignIn', route: 'POST /api/auth/github', runtime: 'auth.githubExchange' },
  { client: 'discordSignInUrl', route: 'GET /api/auth/discord-url', runtime: 'auth.oauthStart' },
  { client: 'completeDiscordSignIn', route: 'POST /api/auth/discord', runtime: 'auth.discordExchange' },
  { client: 'completeMfa', route: 'POST /api/auth/mfa/challenge', runtime: 'auth.mfa.challengeWithCookie' },
  { client: 'resendMfaCode', route: 'POST /api/auth/mfa/challenge', runtime: 'auth.mfa.resend' },
  { client: 'enrollMfa', route: 'POST /api/auth/mfa/enroll', runtime: 'auth.mfa.enrollWithCookie' },
  { client: 'verifyMfaEnrollment', route: 'POST /api/auth/mfa/verify', runtime: 'auth.mfa.verifyWithCookie' },
  { client: 'unenrollMfa', route: 'POST /api/auth/mfa/unenroll', runtime: 'auth.mfa.unenrollWithCookie' },
  { client: 'signOut', route: 'POST /api/auth/logout', runtime: 'auth.logoutWithCookie' },
  { client: 'getUser', route: 'GET /api/auth/me', runtime: 'auth.fromRequest' },
  { client: 'getSession', kind: 'local' },
  { client: 'getCachedUser', kind: 'local' },
  { client: 'getState', kind: 'local' },
  { client: 'onChange', kind: 'local' },
  { client: 'billing.has', kind: 'local' },
  { client: 'billing.entitlements', kind: 'local' },
  { client: 'billing.plans', route: 'GET /api/auth/plans', runtime: 'billing.plans' },
  { client: 'billing.subscribe', route: 'POST /api/auth/billing/checkout', runtime: 'payments.checkoutForUser' },
  { client: 'billing.openBillingPortal', route: 'POST /api/auth/billing/portal', runtime: 'payments.portalForUser' },
];

const runtimeCalls = [];
const routeCalls = [];
const called = (name, result) => async (...args) => {
  runtimeCalls.push({ name, args });
  return typeof result === 'function' ? result(...args) : result;
};
const user = { id: 'u1', email: 'person@example.com', entitlements: ['export'] };
const expires_at = Date.now() + 60_000;
const tokenBundle = { token: 'access', refresh_token: 'refresh', user, expires_at };

const sw = {
  auth: {
    signup: called('auth.signup', tokenBundle),
    login: called('auth.login', tokenBundle),
    signupWithCookie: called('auth.signupWithCookie', { user, expires_at }),
    loginWithCookie: called('auth.loginWithCookie', { user, expires_at }),
    logout: called('auth.logout', { ok: true }),
    fromRequest: called('auth.fromRequest', user),
    oauthStart: called('auth.oauthStart', (provider) => `https://${provider}.example/authorize`),
    googleExchange: called('auth.googleExchange', tokenBundle),
    githubExchange: called('auth.githubExchange', tokenBundle),
    discordExchange: called('auth.discordExchange', tokenBundle),
    signInWithOtp: called('auth.signInWithOtp', { ok: true }),
    verifyOtp: called('auth.verifyOtp', tokenBundle),
    setSessionCookies: (...args) => runtimeCalls.push({ name: 'auth.setSessionCookies', args }),
    mfa: {
      challengeWithCookie: called('auth.mfa.challengeWithCookie', { user, expires_at }),
      resend: called('auth.mfa.resend', { sent: true, delivery: 'sent', expires_in: 240 }),
      enrollWithCookie: called('auth.mfa.enrollWithCookie', { challenge_id: 'enroll:s:1', delivery: 'sent', expires_in: 300 }),
      verifyWithCookie: called('auth.mfa.verifyWithCookie', { enrolled: true, method: 'email' }),
      unenrollWithCookie: called('auth.mfa.unenrollWithCookie', { challenge_id: 'unenroll:s:1', delivery: 'sent', expires_in: 300 }),
    },
    logoutWithCookie: called('auth.logoutWithCookie', { ok: true }),
    requestEmailVerificationWithCookie: called('auth.requestEmailVerificationWithCookie', { sent: true, code_created: true, expires_in_seconds: 900 }),
    verifyEmailWithCookie: called('auth.verifyEmailWithCookie', { verified: true }),
  },
  billing: {
    plans: called('billing.plans', { plans: [{ slug: 'pro', name: 'Pro' }] }),
  },
  payments: {
    checkoutForUser: called('payments.checkoutForUser', { url: 'https://billing.example/checkout' }),
    portalForUser: called('payments.portalForUser', { url: 'https://billing.example/portal' }),
  },
};

globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url);
  routeCalls.push(`${req.method} ${url.pathname}`);
  if (url.origin === 'https://app.example' && url.pathname.startsWith('/api/auth')) {
    return somewhereAuth(req, sw);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const storage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, value); },
  removeItem(key) { this.values.delete(key); },
};
const auth = createSomewhereAuth({ baseUrl: 'https://app.example', mode: 'cookie', storage });

const actualMethods = [
  ...Object.entries(auth).filter(([, value]) => typeof value === 'function').map(([name]) => name),
  ...Object.entries(auth.billing).filter(([, value]) => typeof value === 'function').map(([name]) => `billing.${name}`),
].sort();
const matrixMethods = contract.map(({ client }) => client).sort();
check('matrix classifies every advertised runtime method exactly once',
  JSON.stringify(actualMethods) === JSON.stringify(matrixMethods));

const invoke = {
  fetch: () => auth.fetch('https://app.example/api/notes'),
  signUp: () => auth.signUp({ email: user.email, password: 'password', displayName: 'Person' }),
  signIn: () => auth.signIn({ email: user.email, password: 'password' }),
  sendMagicLink: () => auth.sendMagicLink({ email: user.email, redirectUri: 'https://app.example/after-login' }),
  verifyMagicLink: () => auth.verifyMagicLink({ token: 'magic-token' }),
  emailVerified: () => auth.emailVerified(),
  requestEmailVerification: () => auth.requestEmailVerification(),
  verifyEmail: () => auth.verifyEmail({ code: '123456' }),
  googleSignInUrl: () => auth.googleSignInUrl(),
  completeGoogleSignIn: () => auth.completeGoogleSignIn({ code: 'google-code' }),
  githubSignInUrl: () => auth.githubSignInUrl(),
  completeGithubSignIn: () => auth.completeGithubSignIn({ code: 'github-code' }),
  discordSignInUrl: () => auth.discordSignInUrl(),
  completeDiscordSignIn: () => auth.completeDiscordSignIn({ code: 'discord-code' }),
  completeMfa: async () => {
    const original = sw.auth.loginWithCookie;
    sw.auth.loginWithCookie = async () => ({ mfa_required: true, mfa_token: 'matrix-pending' });
    try { await auth.signIn({ email: user.email, password: 'password' }); } catch (error) {
      if (error.code !== 'MFA_REQUIRED') throw error;
    } finally { sw.auth.loginWithCookie = original; }
    return auth.completeMfa({ code: '123456' });
  },
  resendMfaCode: async () => {
    const original = sw.auth.loginWithCookie;
    sw.auth.loginWithCookie = async () => ({ mfa_required: true, mfa_token: 'matrix-pending' });
    try { await auth.signIn({ email: user.email, password: 'password' }); } catch (error) {
      if (error.code !== 'MFA_REQUIRED') throw error;
    } finally { sw.auth.loginWithCookie = original; }
    return auth.resendMfaCode();
  },
  enrollMfa: () => auth.enrollMfa(),
  verifyMfaEnrollment: () => auth.verifyMfaEnrollment({ challenge_id: 'enroll:s:1', code: '123456' }),
  unenrollMfa: () => auth.unenrollMfa({ password: 'password' }),
  signOut: () => auth.signOut(),
  getUser: () => auth.getUser(),
  getSession: () => auth.getSession(),
  getCachedUser: () => auth.getCachedUser(),
  getState: () => auth.getState(),
  onChange: () => auth.onChange(() => {})(),
  'billing.has': () => auth.billing.has('export'),
  'billing.entitlements': () => auth.billing.entitlements(),
  'billing.plans': () => auth.billing.plans(),
  'billing.subscribe': () => auth.billing.subscribe('pro', { redirect: false }),
  'billing.openBillingPortal': () => auth.billing.openBillingPortal({ redirect: false }),
};

// Exercise signOut after a cookie session exists, and getUser before signOut
// clears the cached projection.
const executionOrder = contract
  .filter(({ client }) => client !== 'signOut')
  .concat(contract.find(({ client }) => client === 'signOut'));

for (const entry of executionOrder) {
  const routeBefore = routeCalls.length;
  const runtimeBefore = runtimeCalls.length;
  if (['billing.has', 'billing.entitlements'].includes(entry.client)) {
    assert.throws(invoke[entry.client], error => error.code === 'BILLING_EXPLICIT_CHECK_REQUIRED');
  } else await invoke[entry.client]();

  if (entry.route) {
    check(`${entry.client} reaches ${entry.route}`,
      routeCalls.slice(routeBefore).includes(entry.route));
    check(`${entry.client} delegates to ${entry.runtime}`,
      runtimeCalls.slice(runtimeBefore).some(({ name }) => name === entry.runtime));
  } else {
    check(`${entry.client} is explicitly classified as ${entry.kind}`,
      entry.kind === 'local' || entry.kind === 'passthrough');
  }
}

const magicStart = runtimeCalls.find(({ name }) => name === 'auth.signInWithOtp');
check('sendMagicLink forwards email + redirect_uri to signInWithOtp',
  magicStart?.args[0]?.email === user.email
    && magicStart?.args[0]?.redirect_uri === 'https://app.example/after-login');
const magicVerify = runtimeCalls.find(({ name }) => name === 'auth.verifyOtp');
check('verifyMagicLink forwards the token to verifyOtp',
  magicVerify?.args[0]?.token === 'magic-token');
const emailVerify = runtimeCalls.find(({ name }) => name === 'auth.verifyEmailWithCookie');
check('verifyEmail forwards the code with the request (its session decides the account)',
  emailVerify?.args[0] instanceof Request && emailVerify?.args[1]?.code === '123456');
check('requestEmailVerification forwards the request itself',
  runtimeCalls.find(({ name }) => name === 'auth.requestEmailVerificationWithCookie')?.args[0] instanceof Request);
check('default handler path is /api/auth',
  routeCalls.some((route) => route === 'POST /api/auth/login')
    && !routeCalls.some((route) => route.includes(' /auth/')));
check('OAuth starts go through oauthStart per provider, with callbacks under /api/auth',
  ['google', 'github', 'discord'].every((provider) => {
    const call = runtimeCalls.find((candidate) => candidate.name === 'auth.oauthStart' && candidate.args[0] === provider);
    return call?.args[1]?.redirect_uri === 'https://app.example/api/auth/callback';
  }));

// ── Runtime response-contract generations (platform tsk_72c4b4d2, A-F05) ──
// The matrix above runs against OLD-generation doubles (cookie helpers return
// the BARE user). Runtime 2026081605+ returns the wrapped { user } envelope.
// somewhereAuth must emit the identical flat { user, cookie_session } body
// for BOTH generations — a double-wrapped { user: { user } } is the failure
// this section exists to catch.
{
  const wrappedSw = {
    auth: {
      signupWithCookie: async () => ({ user }),
      loginWithCookie: async () => ({ user }),
      logoutWithCookie: async () => ({ ok: true }),
      fromRequest: async () => user,
    },
  };
  const mk = (path, body) => new Request('https://app.example' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sw-Auth-Mode': 'cookie', Cookie: '__Host-token=t' },
    body: JSON.stringify(body),
  });
  const loginRes = await somewhereAuth(mk('/api/auth/login', { email: user.email, password: 'pw' }), wrappedSw);
  const loginBody = await loginRes.json();
  check('new-generation login: flat user, not double-wrapped',
    loginBody?.user?.id === user.id && loginBody?.user?.user === undefined && loginBody?.cookie_session === true);
  const signupRes = await somewhereAuth(mk('/api/auth/signup', { email: user.email, password: 'pw' }), wrappedSw);
  const signupBody = await signupRes.json();
  check('new-generation signup: flat user, not double-wrapped',
    signupBody?.user?.id === user.id && signupBody?.user?.user === undefined && signupBody?.cookie_session === true);
  // Old generation stays covered by the matrix doubles above; assert its login
  // response here too so both generations are pinned side by side.
  const oldSw = { auth: { loginWithCookie: async () => user, fromRequest: async () => user } };
  const oldBody = await (await somewhereAuth(mk('/api/auth/login', { email: user.email, password: 'pw' }), oldSw)).json();
  check('old-generation login: flat user preserved', oldBody?.user?.id === user.id && oldBody?.cookie_session === true);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
process.stdout.write('[ OK  @somewhere-cloud/sdk ] exhaustive client ↔ adapter contract matrix verified\n');
