import { mfaChallenge } from './continuation.js';

/**
 * @somewhere-tech/sdk/server — the backend half, so the app writes ~zero auth code.
 *
 * Mount it from a single deployed function that handles your /api/auth/* routes:
 *
 *   // api/auth/[...path].ts
 *   import { somewhereAuth } from '@somewhere-tech/sdk/server';
 *   export default (req, sw) => somewhereAuth(req, sw);
 *
 * It wires the standard endpoints the @somewhere-tech/sdk/auth client talks to onto
 * `sw.auth.*` — which already owns the Google OAuth client, JWT validation, and
 * the bearer-token rotation contract. login/signup are developer-key-gated on the
 * platform (can't be called from the browser), which is exactly why this thin
 * server shim exists.
 *
 * SESSION TRANSPORT: a successful sign-in sets the session as httpOnly
 * `__Host-` cookies and answers `{ user, cookie_session: true }` — tokens
 * never reach page JS. That is the answer for every caller that does not opt
 * out, including a plain `fetch('/api/auth/login', { credentials: 'include' })`
 * with no header (pfb_e1254f754222). Only an explicit
 * `X-Sw-Auth-Mode: header` (aliases `token`, `bearer`) — a server or native
 * client that holds its own session — receives the token pair in the body, and
 * then no cookie is set. A runtime that cannot set the cookie refuses
 * (COOKIE_SESSION_UNAVAILABLE) instead of falling back to tokens.
 *
 * Covered today: email/password (signup, login, logout), magic-link/OTP,
 * email verification for the signed-in account, Google/GitHub/Discord OAuth
 * (url + exchange), and `me` (validate + refresh).
 */

/** The slice of the platform `sw` namespace this handler uses. */
export interface SwAuthNamespace {
  auth: {
    signup(opts: { email: string; password: string; display_name?: string }): Promise<unknown>;
    login(opts: { email: string; password: string }): Promise<unknown>;
    loginWithCookie?(req: Request, email: string, password: string): Promise<unknown>;
    signupWithCookie?(
      req: Request,
      email: string,
      password: string,
      opts?: { display_name?: string },
    ): Promise<unknown>;
    mfa?: {
      challenge?(opts: { mfa_token: string; code: string }): Promise<unknown>;
      challengeWithCookie?(opts: { mfa_token: string; code: string }): Promise<unknown>;
    };
    logout(opts: Record<string, unknown>): Promise<unknown>;
    fromRequest(req: Request, enrich?: unknown): Promise<unknown>;
    refreshSession?(req: Request): Promise<unknown>;
    /** Exchanges take the callback's ?code= and its public ?attempt=, which
     *  selects this browser's attempt cookie; the runtime presents only that
     *  original request cookie and the platform proves it before spending. */
    /** Start browser-bound social sign-in: stages this attempt's HttpOnly
     *  verifier cookie on the response and resolves the provider start URL.
     *  Optional so the handler answers 501 on a runtime that predates it. The
     *  old googleUrl/githubUrl/discordUrl builders are not part of this slice:
     *  current runtimes refuse them, so a current runtime context must satisfy
     *  this type without them. */
    oauthStart?(provider: 'google' | 'github' | 'discord', opts: { redirect_uri: string }): Promise<string>;
    googleExchange(opts: { code: string; attempt?: string }): Promise<unknown>;
    githubExchange(opts: { code: string; attempt?: string }): Promise<unknown>;
    discordExchange(opts: { code: string; attempt?: string }): Promise<unknown>;
    signInWithOtp(opts: { email: string; redirect_uri?: string }): Promise<unknown>;
    verifyOtp(opts: { token: string }): Promise<unknown>;
    /** Cookie-session primitives (tsk_1dd4e1b4) — optional so the handler
     *  degrades to token bodies on runtimes that predate them. */
    setSessionCookies?(access: string, refresh: string): void;
    logoutWithCookie?(req: Request): Promise<unknown>;
    /** Email verification for the request's own session — optional so the
     *  handler answers 501 on a runtime that predates them. */
    requestEmailVerificationWithCookie?(req: Request): Promise<unknown>;
    verifyEmailWithCookie?(req: Request, opts: { code: string }): Promise<unknown>;
  };
  /** Entitlements (sw.billing) — optional so the handler degrades cleanly on a
   *  runtime that predates it (the /plans route 404s instead of throwing). */
  billing?: {
    plans(): Promise<unknown>;
  };
  /** Payments (sw.payments) — drives the <PricingTable>/<BillingPortal> flows.
   *  Optional so the handler degrades cleanly on an older runtime. */
  payments?: {
    // The runtime derives the buyer from the request's signed-in user; it takes
    // no user id (runtime v2, 2026-08-02). The handler returns the result as-is;
    // a checkout session's url may be null.
    checkoutForUser(opts: { plan: string; success_url?: string; cancel_url?: string }): Promise<{ url?: string | null }>;
    portalForUser(opts: { return_url?: string }): Promise<{ url?: string | null }>;
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A refused verification call, keeping the platform's code and 4xx status. */
function verificationFailed(err: unknown): Response {
  const e = (err && typeof err === 'object' ? err : {}) as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : 'EMAIL_VERIFICATION_FAILED';
  const status = typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 502;
  const message = typeof e.message === 'string' && e.message ? e.message : 'Email verification failed.';
  return json({ error: code, message }, status);
}

function logoutRefused(code: string, message: string, status: number): Response {
  return json({ ok: false, error: code, message }, status);
}

/** A sign-out the platform did not confirm: its code when it is a code, its
 *  status when it is a 4xx, otherwise 502. Never a 2xx. The outcome is unknown
 *  here, so the message never claims the session stayed signed in. */
function logoutFailed(err: unknown): Response {
  const e = (err && typeof err === 'object' ? err : {}) as { code?: unknown; status?: unknown };
  const code = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : 'SIGN_OUT_FAILED';
  const status = typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 502;
  return logoutRefused(code, 'Could not confirm sign-out.', status);
}

interface TokenBundle {
  token?: string;
  access_token?: string;
  refresh_token?: string;
  user?: unknown;
  expires_at?: number;
  expires_in?: number;
  data?: TokenBundle;
}

/**
 * When the session just issued expires, in epoch ms: the runtime's expires_at; else the `exp` of the
 * access token actually issued; else the issuer's expires_in. Every cookie-mode session reply carries
 * it, so the client schedules its refresh from the real expiry. A reply without one made the client
 * refresh at once, and a page change mid-refresh orphaned its pending marker (platform
 * pfb_01e440702f31). Undefined only when the bundle says nothing about expiry.
 */
function issuedExpiresAt(d: TokenBundle): number | undefined {
  if (typeof d.expires_at === 'number' && Number.isFinite(d.expires_at) && d.expires_at > 0) return d.expires_at;
  const access = d.token ?? d.access_token;
  if (typeof access === 'string') {
    try {
      const exp = Number(JSON.parse(atob(access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp);
      if (Number.isFinite(exp) && exp > 0) return exp * 1000;
    } catch { /* not a JWT: fall through to expires_in */ }
  }
  if (typeof d.expires_in === 'number' && Number.isFinite(d.expires_in) && d.expires_in > 0) return Date.now() + d.expires_in * 1000;
  return undefined;
}

/**
 * Runtime response-contract compatibility (platform tsk_72c4b4d2, A-F05).
 * Runtime 2026081605+ cookie helpers return the documented { user } envelope;
 * older baked bundles return the bare user object (or null). Accept both so
 * one SDK version serves projects on either runtime generation.
 */
function unwrapAuthUser(result: unknown): unknown {
  if (result && typeof result === 'object' && 'user' in (result as Record<string, unknown>)) {
    return (result as { user?: unknown }).user ?? null;
  }
  return result ?? null;
}

export async function somewhereAuth(req: Request, sw: SwAuthNamespace): Promise<Response> {
  const url = new URL(req.url);
  // The path after the (last) `/auth` segment — robust to whatever prefix the
  // app mounts the handler at (/api/auth, /auth, …).
  const m = url.pathname.match(/\/auth(\/[A-Za-z0-9/_-]*)?$/);
  const sub = (m && m[1]) || '/';
  const method = req.method.toUpperCase();

  // SESSION COOKIES ARE THE ONLY DEFAULT (platform tsk_d05a6cfb, pfb_e1254f754222).
  //
  // A browser must never receive the token pair: a body the page can read is
  // a session any injected script can steal. Before 0.10.0 a caller with no
  // `X-Sw-Auth-Mode` header got the cookie AND the 0.1.x token bundle in the
  // body, so a plain-fetch browser sign-in handed JS-readable tokens to the
  // page. What each caller sees now:
  //   no header, or `cookie`    — cookies + `{ user, cookie_session: true }`.
  //   `header` (or `token`/`bearer`) — the explicit opt-in for a server or
  //                               native client that holds its own session:
  //                               the token bundle, and no cookie is set.
  // An app that sets its OWN cookie is untouched either way: this handler only
  // ever adds the platform `__Host-` pair, and never reads or clears another
  // name.
  const modeHint = (req.headers.get('X-Sw-Auth-Mode') || '').toLowerCase();
  const tokenMode = modeHint === 'header' || modeHint === 'token' || modeHint === 'bearer';
  const wantsCookie = !tokenMode;
  // Optional on the namespace: an older baked runtime without it answers
  // COOKIE_SESSION_UNAVAILABLE below, never the token pair.
  const canCookie = wantsCookie && typeof sw.auth.setSessionCookies === 'function';

  // Set the httpOnly pair from a platform token bundle. Returns the unwrapped
  // bundle when the session was staged, or null when there is no pair to stage
  // (e.g. mfa_required, or an opted-out/older runtime) so the caller answers
  // with the token body.
  const stageSessionCookies = (bundle: unknown): TokenBundle | null => {
    if (!canCookie) return null;
    const b = (bundle ?? {}) as TokenBundle;
    const d = b.data ?? b;
    const access = d.token ?? d.access_token;
    const refresh = d.refresh_token;
    if (!access || !refresh) return null;
    sw.auth.setSessionCookies!(String(access), String(refresh));
    return d;
  };

  // Answer a sign-in: the token bundle only to an explicit opt-in; everyone
  // else gets the cookie handshake. A bundle with no token pair (an MFA
  // challenge) carries no session and passes through. A pair this runtime
  // cannot put in a cookie is refused, never handed to the caller.
  const sessionResponse = (bundle: unknown): Response => {
    const challenge = mfaChallenge(bundle);
    if (challenge) return json(challenge);
    if (tokenMode) return json(bundle);
    const staged = stageSessionCookies(bundle);
    if (staged) return json({ user: staged.user ?? null, cookie_session: true, expires_at: issuedExpiresAt(staged) });
    const b = (bundle ?? {}) as TokenBundle;
    const d = b.data ?? b;
    if (d.token || d.access_token || d.refresh_token) {
      return json({
        error: 'COOKIE_SESSION_UNAVAILABLE',
        message: 'This deploy cannot set a session cookie, so the sign-in was not completed. Redeploy to pick up the current runtime. A server or native client that holds its own session can send X-Sw-Auth-Mode: header to receive tokens instead.',
      }, 501);
    }
    return json(bundle);
  };

  const readBody = async (): Promise<Record<string, unknown>> => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  try {
    if (method === 'POST' && sub === '/signup') {
      const b = await readBody();
      if (wantsCookie && typeof sw.auth.signupWithCookie === 'function') {
        const result = await sw.auth.signupWithCookie(
          req,
          String(b.email ?? ''),
          String(b.password ?? ''),
          { display_name: (b.display_name ?? b.displayName) as string | undefined },
        );
        return mfaChallenge(result) ? json(mfaChallenge(result)) : json({ user: unwrapAuthUser(result), cookie_session: true, expires_at: (result as TokenBundle).expires_at });
      }
      const d = await sw.auth.signup({
        email: String(b.email ?? ''),
        password: String(b.password ?? ''),
        display_name: (b.display_name ?? b.displayName) as string | undefined,
      });
      return sessionResponse(d);
    }
    if (method === 'POST' && sub === '/login') {
      const b = await readBody();
      if (wantsCookie && typeof sw.auth.loginWithCookie === 'function') {
        const result = await sw.auth.loginWithCookie(
          req,
          String(b.email ?? ''),
          String(b.password ?? ''),
        );
        return mfaChallenge(result) ? json(mfaChallenge(result)) : json({ user: unwrapAuthUser(result), cookie_session: true, expires_at: (result as TokenBundle).expires_at });
      }
      const d = await sw.auth.login({ email: String(b.email ?? ''), password: String(b.password ?? '') });
      return sessionResponse(d);
    }
    if (method === 'POST' && sub === '/mfa/challenge') {
      const b = await readBody();
      if (typeof b.mfa_token !== 'string' || !b.mfa_token || typeof b.code !== 'string' || !b.code.trim()) {
        return json({ error: 'VALIDATION_ERROR', message: 'A pending MFA challenge and code are required.' }, 400);
      }
      const complete = wantsCookie ? sw.auth.mfa?.challengeWithCookie : sw.auth.mfa?.challenge;
      if (!complete) return json({ error: 'MFA_UNAVAILABLE', message: 'This deploy does not support MFA completion. Redeploy with the current runtime.' }, 501);
      const result = await complete.call(sw.auth.mfa, { mfa_token: b.mfa_token, code: b.code });
      return wantsCookie
        ? json({ user: unwrapAuthUser(result), cookie_session: true, expires_at: (result as TokenBundle).expires_at })
        : sessionResponse(result);
    }
    if (method === 'POST' && sub === '/logout') {
      // Header mode: the platform revokes a session by its refresh token, which
      // the client sends as X-Refresh-Token; the access bearer alone revokes
      // nothing. Only a confirmed revoke answers 2xx. Every refusal stays
      // non-2xx — SESSION_NOT_FOUND included, because a rotated-away token can
      // miss a newer live session — so the client keeps the sign-out owed.
      const headerRefresh = req.headers.get('X-Refresh-Token');
      if (headerRefresh !== null) {
        if (!headerRefresh.trim()) return logoutRefused('VALIDATION_ERROR', 'X-Refresh-Token is empty; nothing was signed out.', 400);
        let result: unknown;
        try {
          result = await sw.auth.logout({ refresh_token: headerRefresh });
        } catch (err) {
          return logoutFailed(err);
        }
        if ((result as { logged_out?: unknown } | null)?.logged_out !== true) {
          return logoutRefused('SIGN_OUT_UNCONFIRMED', 'Could not confirm sign-out.', 502);
        }
        return json({ ok: true });
      }
      // A bearer with no refresh token is a header client that cannot be signed
      // out here (SDK 0.11.4 and earlier sent only the bearer). Refuse instead of
      // answering ok for a session that stays live.
      if (/^bearer\s/i.test(req.headers.get('Authorization') || '')) {
        return logoutRefused('LOGOUT_REFRESH_REQUIRED', 'Header sign-out needs the session refresh token in X-Refresh-Token; nothing was signed out.', 400);
      }
      // Cookie mode: logoutWithCookie revokes the session from the refresh
      // cookie and parks the Set-Cookie expirations. Only its confirmed
      // { ok: true } answers 2xx; a refusal or unconfirmed revocation keeps its
      // code and stays non-2xx, so the client keeps the sign-out owed.
      if (typeof sw.auth.logoutWithCookie !== 'function') {
        // A runtime without the cookie helper cannot revoke a cookie session;
        // nothing is called, so nothing was signed out.
        return logoutRefused('COOKIE_SESSION_UNAVAILABLE', 'This runtime cannot sign out a cookie session; nothing was signed out.', 501);
      }
      let cookieResult: unknown;
      try {
        cookieResult = await sw.auth.logoutWithCookie(req);
      } catch (err) {
        return logoutFailed(err);
      }
      if ((cookieResult as { ok?: unknown } | null)?.ok !== true) {
        return logoutRefused('SIGN_OUT_UNCONFIRMED', 'Could not confirm sign-out.', 502);
      }
      return json({ ok: true });
    }
    if (method === 'POST' && sub === '/refresh') {
      if (!sw.auth.refreshSession) return json({ error: 'REFRESH_UNAVAILABLE' }, 501);
      try { return json(await sw.auth.refreshSession(req)); } catch (err) { return verificationFailed(err); }
    }
    if (method === 'GET' && sub === '/me') {
      const user = await sw.auth.fromRequest(req);
      return json({ user: user ?? null });
    }
    // Email verification. The account is the request's own session (the
    // httpOnly cookie, or a Bearer header); no token is read here or returned.
    if (method === 'GET' && sub === '/verify-email') {
      const user = (await sw.auth.fromRequest(req)) as { email_verified?: unknown } | null;
      if (!user) return json({ error: 'AUTH_REQUIRED', message: 'Sign in required.' }, 401);
      return json({ email_verified: user.email_verified === true });
    }
    if (method === 'POST' && (sub === '/request-email-verification' || sub === '/verify-email')) {
      if (typeof sw.auth.requestEmailVerificationWithCookie !== 'function' || typeof sw.auth.verifyEmailWithCookie !== 'function') {
        return json({ error: 'EMAIL_VERIFICATION_UNAVAILABLE', message: 'This deploy predates email verification for cookie sessions. Redeploy to pick up the current runtime.' }, 501);
      }
      try {
        if (sub === '/request-email-verification') return json(await sw.auth.requestEmailVerificationWithCookie(req));
        const b = await readBody();
        return json(await sw.auth.verifyEmailWithCookie(req, { code: String(b.code ?? '') }));
      } catch (err) {
        return verificationFailed(err);
      }
    }
    if (method === 'POST' && sub === '/magic-link') {
      const b = await readBody();
      const d = await sw.auth.signInWithOtp({
        email: String(b.email ?? ''),
        redirect_uri: typeof b.redirect_uri === 'string' ? b.redirect_uri : undefined,
      });
      return json(d);
    }
    if (method === 'POST' && sub === '/magic-link/verify') {
      const b = await readBody();
      const d = await sw.auth.verifyOtp({ token: String(b.token ?? '') });
      return sessionResponse(d);
    }
    // Entitlements (sw.billing): the project's plan catalog, for a pricing page.
    // The catalog is project-wide and non-secret. 404s on a runtime without
    // sw.billing so an older deploy degrades instead of throwing.
    if (method === 'GET' && sub === '/plans') {
      if (typeof sw.billing?.plans !== 'function') {
        return json({ error: 'NOT_FOUND', message: 'Entitlements are not available on this runtime.' }, 404);
      }
      const result = (await sw.billing.plans()) as { plans?: unknown };
      return json({ plans: result?.plans ?? [] });
    }
    // Start a subscription checkout for the SIGNED-IN user (<PricingTable>'s
    // Subscribe button). SECURITY: the runtime derives the buyer from the
    // request's signed-in user — NEVER a body-supplied id — so there's no IDOR
    // on a money op; fromRequest here only answers a clean 401 first. The only
    // client input is which plan slug to buy. The worker resolves that plan's
    // price from the billing catalog.
    if (method === 'POST' && sub === '/billing/checkout') {
      if (typeof sw.payments?.checkoutForUser !== 'function') {
        return json({ error: 'NOT_FOUND', message: 'Billing is not available on this runtime.' }, 404);
      }
      const me = (await sw.auth.fromRequest(req)) as { id?: string } | null;
      if (!me || !me.id) return json({ error: 'AUTH_REQUIRED', message: 'Sign in required.' }, 401);
      const b = await readBody();
      if (typeof b.plan !== 'string' || !b.plan) {
        return json({ error: 'VALIDATION_ERROR', message: 'plan is required.' }, 400);
      }
      const result = await sw.payments.checkoutForUser({
        plan: b.plan,
        success_url: typeof b.success_url === 'string' ? b.success_url : undefined,
        cancel_url: typeof b.cancel_url === 'string' ? b.cancel_url : undefined,
      });
      return json(result);
    }
    // Open the Stripe billing portal for the SIGNED-IN user (<BillingPortal>).
    // SECURITY: same as checkout — the runtime resolves this user's
    // stripe_customer_id from their session server-side; no id crosses from
    // the browser, so a user can only ever manage their OWN subscription.
    if (method === 'POST' && sub === '/billing/portal') {
      if (typeof sw.payments?.portalForUser !== 'function') {
        return json({ error: 'NOT_FOUND', message: 'Billing is not available on this runtime.' }, 404);
      }
      const me = (await sw.auth.fromRequest(req)) as { id?: string } | null;
      if (!me || !me.id) return json({ error: 'AUTH_REQUIRED', message: 'Sign in required.' }, 401);
      const b = await readBody();
      const result = await sw.payments.portalForUser({
        return_url: typeof b.return_url === 'string' ? b.return_url : undefined,
      });
      return json(result);
    }
    // Social sign-in is bound to the browser that starts it: the runtime stages
    // this attempt's verifier cookie on this response and only its challenge
    // travels in the URL. There is no unbound fallback to the old URL builders.
    const oauthStartRoute = method === 'GET' ? /^\/(google|github|discord)-url$/.exec(sub) : null;
    if (oauthStartRoute) {
      if (typeof sw.auth.oauthStart !== 'function') {
        return json({ error: 'OAUTH_START_UNAVAILABLE', message: 'This deploy predates browser-bound social sign-in. Redeploy to pick up the current runtime.' }, 501);
      }
      const provider = oauthStartRoute[1] as 'google' | 'github' | 'discord';
      const redirectUri = url.searchParams.get('redirect_uri') || `${url.origin}/api/auth/callback`;
      return json({ url: await sw.auth.oauthStart(provider, { redirect_uri: redirectUri }) });
    }
    if (method === 'POST' && sub === '/google') {
      const b = await readBody();
      const d = await sw.auth.googleExchange({ code: String(b.code ?? ''), attempt: String(b.attempt ?? '') });
      return sessionResponse(d);
    }
    if (method === 'POST' && sub === '/github') {
      const b = await readBody();
      const d = await sw.auth.githubExchange({ code: String(b.code ?? ''), attempt: String(b.attempt ?? '') });
      return sessionResponse(d);
    }
    if (method === 'POST' && sub === '/discord') {
      const b = await readBody();
      const d = await sw.auth.discordExchange({ code: String(b.code ?? ''), attempt: String(b.attempt ?? '') });
      return sessionResponse(d);
    }
    return json({ error: 'NOT_FOUND', message: `No @somewhere-tech/sdk/auth route for ${method} ${sub}` }, 404);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'MFA_REQUIRED' && 'mfa_token' in err && typeof err.mfa_token === 'string' && err.mfa_token) {
      return json({ mfa_required: true, mfa_token: err.mfa_token });
    }
    // The runtime could not adjudicate the session (outage, timeout, malformed
    // answer). Keep that classification, with a fixed message, so a client
    // reads it as "unknown", never as signed out.
    if (err && typeof err === 'object' && 'code' in err && err.code === 'AUTH_VERIFY_UNAVAILABLE') {
      return json({ error: 'AUTH_VERIFY_UNAVAILABLE', message: 'Identity verification is temporarily unavailable. Please retry.' }, 503);
    }
    const status = (err as { status?: number })?.status ?? 400;
    return json({ error: 'AUTH_ERROR', message: (err as Error)?.message || 'Auth failed' }, status);
  }
}
