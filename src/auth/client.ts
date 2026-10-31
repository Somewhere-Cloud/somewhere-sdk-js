import { earlySessionNames, takeEarlySession, type EarlySession } from './early-session.js';
import { isAuthUser, mfaChallenge } from './continuation.js';

/**
 * @somewhere-cloud/sdk/auth — framework-agnostic session client.
 *
 * ONLY-PATH CONTRACT (tsk_acd56ee8): a browser uses same-origin httpOnly
 * cookie sessions and holds zero credentials. This package is an optional UI
 * adapter over that runtime contract, not a new transport.
 *
 * Explicit header mode exists for scripts/native clients and compatibility
 * with older browser integrations. In that mode it wraps fetch so that:
 *
 *   1. Every authed request carries `Authorization: Bearer <access>` AND
 *      `X-Refresh-Token: <refresh>` (the ride-along), letting the server
 *      auto-refresh an expired access token in-band.
 *   2. When the server rotates the session it returns `X-New-Access-Token` +
 *      `X-New-Refresh-Token`; we persist the NEW PAIR ATOMICALLY (one write,
 *      both or neither). A half-write is how sessions desync.
 *   3. A network blip (fetch throws) NEVER clears the session — we re-throw
 *      and keep the tokens. Logging the user out because their wifi hiccuped
 *      is the single most common hand-rolled-auth bug.
 *   4. CROSS-TAB: when another tab rotates the session, this tab picks the
 *      new pair up off the `storage` event instead of riding its stale copy
 *      past the server's reuse-grace window (which reads as a phantom
 *      logout in every background tab). A 401 on a request that carried a
 *      since-rotated pair retries ONCE with the freshest stored pair before
 *      concluding the session is dead.
 *
 * COOKIE MODE (0.2.0+, the BROWSER DEFAULT): instead of holding tokens in
 * localStorage (XSS-exfiltratable), the backend sets the session as httpOnly
 * cookies and the browser owns it — this client stores NO tokens, sends
 * `credentials: 'include'`, and caches only the (non-secret) user object for
 * optimistic rendering. Mode is negotiated per sign-in: the client hints
 * `X-Sw-Auth-Mode: cookie`; only a server that actually set the cookies
 * replies `cookie_session: true`. A backend that doesn't (its handler omits
 * cookie mode) gets a typed `AuthError` with code
 * `COOKIE_SESSION_NOT_CONFIRMED` and NOTHING is stored — the client never
 * quietly puts a token pair where page scripts can read it (0.9.0). An
 * EXISTING stored header session is adopted as-is (no forced re-auth) and
 * migrates to cookies transparently on the next login.
 *
 * SESSION STATE AND ORDERING (tsk_166b8ddf): `getState()` and
 * `onChange` report what the backend last said: 'checking' before any answer
 * (a cached user is unverified), 'authenticated', 'signed-out', or
 * 'indeterminate' when a check failed (network, 5xx, unreadable body) — the
 * last-known user is kept but is not verified. Identity changes are ordered:
 *
 *   - Each sign-in/sign-up/completion and signOut() advances a generation when
 *     it is CALLED. A /me answer, a 401, or a token rotation that started under
 *     an earlier generation never writes user, session or status.
 *   - Cookie-changing calls from one client (login, signup, magic-link verify,
 *     OAuth completions, logout) run one at a time in call order, so their
 *     Set-Cookie responses cannot land out of order. A sign-in answered after a
 *     newer signOut()/sign-in rejects with code 'AUTH_SUPERSEDED' and changes
 *     nothing locally; the queued logout still runs after it on the server.
 *   - This orders one client instance only. Another tab, or a request the
 *     server processes late, can still change the shared cookies; the next
 *     check reports it. A timed-out call (mutationTimeoutMs covers the
 *     request, its body and any follow-up /me) is abandoned locally and writes
 *     nothing afterwards, but the server may still have acted on it.
 *   - signOut() drops local credentials at once and retains the last-known user
 *     while `signingOut` is true. Only a successful /logout confirms server
 *     sign-out; a failure clears the local user but leaves `signOutUnconfirmed`
 *     true so the next signOut() retries it.
 *
 * The token trio originates from the app's own backend (login/signup are
 * developer-key-gated on the platform, so they can't be called from the
 * browser). Mount `somewhereAuth` from `@somewhere-cloud/sdk/server` at
 * `/api/auth/*` to expose the standard endpoints this client talks to.
 */

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export type AppUserRole = 'user' | 'admin';

export interface User {
  id: string;
  email: string | null;
  /** Platform-owned app role. Optional while cached users and older servers
   *  roll forward. Use it for UI rendering only; enforce admin access
   *  server-side with sw.auth.requireUser(req, { role: 'admin' }). */
  role?: AppUserRole;
  [key: string]: unknown;
}

/** One plan from the project's code-defined catalog (sw.billing). */
export interface BillingPlan {
  slug: string;
  name: string;
  description: string | null;
  price_cents: number | null;
  currency: string;
  interval: string | null;
  stripe_price_id: string | null;
  sort_order: number;
  is_default: boolean;
  active: boolean;
  features: Array<{ feature: string; limit_value: number | null }>;
}

/** Explicit catalog and checkout operations. Paid access is checked server-side. */
export interface BillingClient {
  /** @deprecated Identity has no paid assertions. Use a server endpoint calling await sw.billing.has(feature). */
  has(feature: string): never;
  /** @deprecated Identity has no paid assertions. Use a server endpoint calling await sw.billing.entitlements(). */
  entitlements(): never;
  /** The project's plan catalog (network). */
  plans(): Promise<BillingPlan[]>;
  /** Start a subscription checkout for the CURRENT user and (by default) redirect
   *  the browser to Stripe. success/cancel default to the current page. The
   *  buyer is the signed-in user — resolved server-side, never passed from here. */
  subscribe(plan: string, opts?: { successUrl?: string; cancelUrl?: string; redirect?: boolean }): Promise<{ url: string }>;
  /** Open the Stripe billing portal for the CURRENT user (manage / cancel) and
   *  (by default) redirect there. return_url defaults to the current page. */
  openBillingPortal(opts?: { returnUrl?: string; redirect?: boolean }): Promise<{ url: string }>;
}

/**
 * What this client last learned from the backend about the session.
 *   checking       no answer yet since the client was created, or sign-out is pending;
 *                  `user` is cached, unverified
 *   authenticated  the backend confirmed `user` (a sign-in response, or /me with a user)
 *   signed-out     no identity in this client: the backend confirmed no session
 *                  (/me 401 or { user: null }, a 401 on the current identity), or
 *                  signOut() finished locally. `signOutUnconfirmed` means the
 *                  server did not confirm that sign-out.
 *   indeterminate  the last check failed (network error, non-401 error status,
 *                  unreadable body); `user` is the last-known identity, unverified
 */
export type AuthStatus = 'checking' | 'authenticated' | 'signed-out' | 'indeterminate';

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
  /** 'SESSION_CHECK_FAILED' in 'indeterminate'; 'SIGN_OUT_UNCONFIRMED' while a
   *  sign-out is still owed to the server. */
  error: AuthError | null;
  /** True after an unconfirmed signOut(), including a reload before its reply:
   *  the server session may still exist. Cleared by confirmed logout or a new
   *  successful sign-in. Cookie logout intent survives page reload. */
  signOutUnconfirmed: boolean;
  /** True from a signOut() call until its /logout is answered (or fails or
   *  times out). The last-known `user` remains while pending so user-null UI
   *  cannot imply completion. Show a pending state and disable private actions. */
  signingOut: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 'cookie' — httpOnly cookie session set by the backend; no tokens in JS.
 * 'header' — compatibility/non-browser mode: Bearer + refresh ride-along
 * with tokens in `storage`. Do not select this for a new browser app.
 * Default: 'cookie' in a browser (document exists), 'header' elsewhere
 * (Node / CLI / native — where httpOnly cookies don't exist).
 */
export type AuthMode = 'cookie' | 'header';

export interface SomewhereAuthOptions {
  /** Base URL of the app's backend auth routes. Default '' (same-origin). */
  baseUrl?: string;
  /** Path prefix the backend handler is mounted at. Default '/api/auth'. */
  authPath?: string;
  /** Header-mode token storage. Unused by a cookie-native browser session. */
  storage?: StorageLike;
  /** localStorage key. Default 'sw_auth'. */
  storageKey?: string;
  /** Session transport. Default: 'cookie' in browsers, 'header' elsewhere. */
  mode?: AuthMode;
  /** How long one queued sign-in/sign-out call may take, including reading the
   *  response and any follow-up /me, before it is abandoned (AuthError
   *  'AUTH_TIMEOUT') so later calls can run. 1 to 2147483647 ms; default 30000. */
  mutationTimeoutMs?: number;
}

const ACCESS_ROTATE_HEADER = 'X-New-Access-Token';
const REFRESH_ROTATE_HEADER = 'X-New-Refresh-Token';
const RIDE_ALONG_HEADER = 'X-Refresh-Token';
// Sent on every sign-in call: `cookie` when this client prefers cookies (a
// cookie-capable backend sets the httpOnly pair and replies
// `cookie_session: true`; one that ignores the hint is refused with
// COOKIE_SESSION_NOT_CONFIRMED), `header` in header mode — the explicit
// opt-in the packaged handler requires before it returns tokens.
const MODE_HINT_HEADER = 'X-Sw-Auth-Mode';

function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* access can throw in sandboxed iframes */
  }
  return memoryStorage();
}

export interface SomewhereAuth {
  /** fetch wrapper that rides the session + persists rotation. Use it for
   *  every request to your backend that needs the user. */
  fetch: typeof fetch;
  signUp(input: { email: string; password: string; displayName?: string }): Promise<User>;
  signIn(input: { email: string; password: string }): Promise<User>;
  /** Send a magic-link / OTP email. The link/code completes via verifyMagicLink. */
  sendMagicLink(input: { email: string; redirectUri?: string }): Promise<void>;
  verifyMagicLink(input: { token: string }): Promise<User>;
  /** Whether the signed-in account's email address is verified. */
  emailVerified(): Promise<boolean>;
  /** Email the signed-in account a 6-digit verification code. The session
   *  decides the account; no token is handled in page code. */
  requestEmailVerification(): Promise<void>;
  /** Check that code; resolves once the address is verified. */
  verifyEmail(input: { code: string }): Promise<void>;
  /** Get the platform-owned Google OAuth URL (no Google project needed). */
  googleSignInUrl(input?: { redirectUri?: string }): Promise<string>;
  /** Exchange a Google `?code=` (from the callback) for a session. Pass the
   *  callback's `?attempt=` too; on the callback page it is read from the URL. */
  completeGoogleSignIn(input: { code: string; attempt?: string }): Promise<User>;
  /** Get the platform-owned GitHub OAuth URL. */
  githubSignInUrl(input?: { redirectUri?: string }): Promise<string>;
  /** Exchange a GitHub `?code=` (from the callback) for a session. Pass the
   *  callback's `?attempt=` too; on the callback page it is read from the URL. */
  completeGithubSignIn(input: { code: string; attempt?: string }): Promise<User>;
  /** Get the platform-owned Discord OAuth URL. */
  discordSignInUrl(input?: { redirectUri?: string }): Promise<string>;
  /** Exchange a Discord `?code=` (from the callback) for a session. Pass the
   *  callback's `?attempt=` too; on the callback page it is read from the URL. */
  completeDiscordSignIn(input: { code: string; attempt?: string }): Promise<User>;
  /** Complete the pending sign-in (after `MFA_REQUIRED`) with the 6-digit code from the email. */
  completeMfa(input: { code: string }): Promise<User>;
  /** Mail a new code for the pending sign-in (at most one a minute and 5 an hour per account). */
  resendMfaCode(): Promise<{ sent: boolean; delivery: 'sent' | 'pending' | 'unknown'; expires_in: number }>;
  /** Turn on email sign-in codes for the signed-in account (the app's policy must be optional or required): a code
   *  goes to its verified address. Resolves `{ enrolled: true }` when codes are already on. */
  enrollMfa(): Promise<MfaCodeSent | { enrolled: true; method: 'email' }>;
  /** Confirm `enrollMfa` with its `challenge_id` and the emailed code. No session ends. */
  verifyMfaEnrollment(input: { challenge_id: string; code: string }): Promise<{ enrolled: true; method: 'email' }>;
  /** Turn email sign-in codes off in two steps: `{ password }` mails a code (resolves `{ challenge_id }`), then
   *  `{ challenge_id, code }` turns them off (`{ enrolled: false }`). Refused (409) when the app requires codes. */
  unenrollMfa(input: { password: string } | { challenge_id: string; code: string }): Promise<MfaCodeSent | { enrolled: false }>;
  signOut(): Promise<void>;
  /** Re-fetch the current user from the backend (validates + refreshes). */
  getUser(): Promise<User | null>;
  /** Current session from memory (no network). Always null for a cookie
   *  session — the tokens are httpOnly, deliberately unreadable from JS;
   *  use getCachedUser()/getUser() for signed-in state. */
  getSession(): Session | null;
  getCachedUser(): User | null;
  /** Status, user, session and error as of now (no network). */
  getState(): AuthState;
  /** Subscribe to session/user/status changes (login, logout, rotation, checks). */
  onChange(listener: (state: AuthState) => void): () => void;
  /** Entitlements (sw.billing) — `has(feature)` / `entitlements()` / `plans()`. */
  billing: BillingClient;
}

interface TokenResponse {
  token?: string;
  access_token?: string;
  refresh_token?: string;
  user?: User;
  cookie_session?: boolean;
  data?: { token?: string; access_token?: string; refresh_token?: string; user?: User; cookie_session?: boolean };
}

/** The social callback's public attempt id: passed explicitly, or read from the
 *  callback page's own URL. It only selects which of this browser's attempt
 *  cookies the server presents; the platform proves it before the code counts. */
/** A code was mailed to the account's verified address; the next step names `challenge_id`. */
export interface MfaCodeSent { challenge_id: string; delivery: 'sent' | 'pending' | 'unknown'; expires_in: number }

/** An MFA step's answer from the auth route: its data, or an AuthError with the platform's code and status. */
async function mfaAnswer<T>(res: Response, failure: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { data?: unknown; error?: string; message?: string };
  const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown> & { error?: string; message?: string };
  if (!res.ok) throw new AuthError(data.message || body.message || data.error || body.error || `${failure} (${res.status})`, res.status, data.error || body.error);
  return data as T;
}

function oauthAttempt(input: { attempt?: string }): { attempt?: string } {
  if (typeof input.attempt === 'string') return { attempt: input.attempt };
  if (typeof window === 'undefined') return {};
  const fromUrl = new URL(window.location.href).searchParams.get('attempt');
  return fromUrl ? { attempt: fromUrl } : {};
}

/** undefined → 30000; anything else must be 1..2147483647 ms (setTimeout's range). */
function mutationTimeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError('mutationTimeoutMs must be a number of milliseconds from 1 to 2147483647.');
  }
  return value;
}

export function createSomewhereAuth(options: SomewhereAuthOptions = {}): SomewhereAuth {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const authPath = (options.authPath ?? '/api/auth').replace(/\/$/, '');
  const storage = options.storage ?? defaultStorage();
  const key = options.storageKey ?? 'sw_auth';
  const userKey = `${key}_user`; // cached user JSON for optimistic restore (tsk_1288e1c6)
  // ONLY-PATH CONTRACT (tsk_acd56ee8): browsers use cookie sessions and keep
  // credentials out of page JavaScript. Header mode exists only for non-browser
  // clients and rule-9 compatibility with pre-0.2.0/older-handler sessions.
  const preferCookie = options.mode ? options.mode === 'cookie' : typeof document !== 'undefined';
  // No credentials: retain logout intent across navigation, including navigation
  // before the queued request starts. Only a confirmed new sign-in replaces it.
  //  - `pending:<ms>:<rand>`: the server has not confirmed /logout. Kept until it
  //    does (retried after reload) or a sign-in replaces it. Never expires.
  //  - Once the server confirms /logout the record is removed: the server ended
  //    that session (its rows are deleted), so from then on the server's answer
  //    is the truth. A /me answer sent before the logout may still briefly show
  //    the old user; the next check returns 401. `confirmed:` records left by
  //    0.13.x (which never expired, and made the client ignore new sessions)
  //    are removed when read.
  const signOutKey = `${userKey}:sign-out:${baseUrl}${authPath}`;
  let signOutIntent: string | null = null;
  let signOutStorageAvailable = true;
  function readSignOutIntent(): string | null {
    if (preferCookie && signOutStorageAvailable) {
      try { signOutIntent = storage.getItem(signOutKey); } catch { /* retain memory state */ }
    }
    if (signOutIntent?.startsWith('confirmed:')) writeSignOutIntent(null);
    return signOutIntent;
  }
  function writeSignOutIntent(next: string | null) {
    signOutIntent = next;
    if (preferCookie) {
      try {
        if (next === null) storage.removeItem(signOutKey);
        else storage.setItem(signOutKey, next);
      } catch { signOutStorageAvailable = false; }
    }
  }
  const restoredSignOut = readSignOutIntent();

  let session: Session | null = restoredSignOut ? null : loadSession();
  // Optimistic restore: seed the user from cache so a fresh page load paints
  // the signed-in UI immediately and a transient /me failure (offline, 5xx)
  // never flashes logged-out. In header mode only trust the cache when a
  // session exists — no tokens means no user, don't show a ghost. In cookie
  // mode the tokens are httpOnly (unreadable here), so the cached user IS our
  // best knowledge of the session; /me validates it in the background.
  //
  // Note: when `session` is non-null under preferCookie, this is an EXISTING
  // header-mode session from a pre-0.2.0 install. We adopt it as-is (header
  // transport) so the upgrade logs nobody out; it migrates to cookies on the
  // next sign-in.
  let pendingMfa: string | null = null;
  let user: User | null = !restoredSignOut && (session || preferCookie) ? loadUser() : null;
  // A cached user is unverified until the backend answers.
  let status: AuthStatus = !restoredSignOut && (session || preferCookie) ? 'checking' : 'signed-out';
  let error: AuthError | null = restoredSignOut?.startsWith('pending:')
    ? new AuthError('Sign-out has not been confirmed by the server.', 0, 'SIGN_OUT_UNCONFIRMED') : null;
  // Advances when an identity change is REQUESTED (sign-in family, signOut) or
  // arrives from another tab. Responses to requests started under an earlier
  // generation never write user, session or status.
  let generation = 0;
  // Cookie-changing calls run one at a time, in call order. The chain keeps
  // going after a rejection; each call is bounded by mutationTimeoutMs.
  let mutations: Promise<unknown> = Promise.resolve();
  let pendingMutations = 0;
  const mutationTimeoutMs = mutationTimeout(options.mutationTimeoutMs);
  // A sign-out the server has not confirmed. It stays owed (state
  // signOutUnconfirmed + error) and the next signOut() retries it, with the
  // header session it was for, until /logout succeeds or a sign-in replaces
  // the session. Cookie clients retain intent across reload as well.
  let owedSignOut: { session: Session | null; error: AuthError } | null = error ? { session: null, error } : null;
  // signOut() calls whose /logout has not settled yet (AuthState.signingOut).
  let signOutsInFlight = 0;
  // At most one /me per generation; concurrent getUser() calls share it.
  let check: { generation: number; promise: Promise<User | null> } | null = null;
  const listeners = new Set<(s: AuthState) => void>();

  let refreshFlight: Promise<void> | null = null;
  // True while the in-flight refresh was started in the background (timer or focus), while the
  // held access token was still valid. Requests then need not wait for it (see authFetch).
  let refreshInBackground = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let nextRefreshAt = 0;
  // Best-effort cross-tab de-dupe: a tab that refreshed records when the next
  // refresh is due, and other tabs skip theirs until then. Not a lock: two tabs
  // refreshing together is harmless (the server accepts a concurrent refresh).
  const refreshStampKey = userKey + ':refresh-at';
  // 0.13.x wrote an "unknown refresh outcome" marker here; nothing reads it now.
  try { storage.removeItem(userKey + ':refresh-pending'); } catch { /* storage unavailable */ }
  const earlyNames = earlySessionNames(key, baseUrl, authPath);
  // The page's early session check (early-session.ts) is adopted at most once.
  let earlyTaken = false;
  let earlyActive: EarlySession | null = null;
  // Rejects the client's wait on the early check at once (set while waiting).
  let earlyCancel: (() => void) | null = null;
  /** A sign-in or sign-out is starting: the early /me must not be adopted.
   *  It is aborted, like any other interrupted request. */
  function abortEarly() {
    if (earlyCancel) { earlyCancel(); return; }
    if (earlyActive) { earlyActive.abort(); return; }
    if (earlyTaken) return;
    earlyTaken = true;
    takeEarlySession(earlyNames)?.abort();
  }
  /** Wait for `work` until the absolute deadline or a sign-in/sign-out start,
   *  whichever is first, even if `work` itself never settles. Either way the
   *  early request is aborted. */
  function waitEarly<T>(early: EarlySession, work: Promise<T>, deadlineAt: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (ok: boolean, value: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        earlyCancel = null;
        if (ok) resolve(value as T); else reject(value);
      };
      const timer = setTimeout(() => { early.abort(); finish(false, timedOut()); }, Math.max(0, deadlineAt - Date.now()));
      earlyCancel = () => { early.abort(); finish(false, superseded()); };
      work.then((v) => finish(true, v), (e) => finish(false, e));
    });
  }
  let accessExpiresAt = session ? tokenExpiry(session.accessToken) : 0;
  function tokenExpiry(token: string): number {
    try { return Number(JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp) * 1000 || 0; }
    catch { return 0; }
  }
  function loadSession(): Session | null {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<Session>;
      if (parsed && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string') {
        return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
      }
    } catch {
      /* corrupt → treat as logged out */
    }
    return null;
  }

  function loadUser(): User | null {
    try {
      const raw = storage.getItem(userKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as User;
      if (isAuthUser(parsed)) return parsed as User;
      storage.removeItem(userKey);
      return null;
    } catch {
      return null;
    }
  }

  function snapshot(): AuthState {
    return { status, user, session, error, signOutUnconfirmed: owedSignOut !== null, signingOut: signOutsInFlight > 0 };
  }

  function emit() {
    const state = snapshot();
    for (const l of listeners) l(state);
  }

  /** ATOMIC: persist the whole session as one value, or clear it. There is no
   *  code path that writes one token without the other. */
  function writeSession(next: Session | null) {
    session = next;
    accessExpiresAt = next ? tokenExpiry(next.accessToken) : 0;
    try {
      if (next) storage.setItem(key, JSON.stringify(next));
      else storage.removeItem(key);
    } catch {
      /* storage unavailable — keep the in-memory session anyway */
    }
  }

  function writeUser(next: User | null) {
    user = next;
    try {
      const raw = next ? JSON.stringify(next) : null;
      // Identical writes are skipped so other tabs only hear real changes.
      if (storage.getItem(userKey) !== raw) {
        if (raw === null) storage.removeItem(userKey);
        else storage.setItem(userKey, raw);
      }
    } catch {
      /* storage unavailable — keep the in-memory user anyway */
    }
  }

  function setSession(next: Session | null) {
    writeSession(next);
    emit();
  }

  /** A definitive state. An owed sign-out keeps reporting its error. */
  function settle(next: 'authenticated' | 'signed-out', nextUser: User | null) {
    if (next === 'authenticated' && !isAuthUser(nextUser)) throw new AuthError('Auth response did not include a valid user.', 502, 'INVALID_AUTH_RESPONSE');
    writeUser(nextUser);
    status = next;
    scheduleRefresh();
    error = owedSignOut?.error ?? null;
    emit();
  }

  /** A check failed without an answer: keep the last-known user, unverified. */
  function indeterminate(httpStatus: number) {
    status = 'indeterminate';
    error = new AuthError(
      httpStatus
        ? `The session check failed (${httpStatus}); the sign-in state is unknown.`
        : 'The session check could not reach the server; the sign-in state is unknown.',
      httpStatus,
      'SESSION_CHECK_FAILED',
    );
    emit();
  }

  function superseded(): AuthError {
    return new AuthError('A newer sign-in or sign-out replaced this request.', 0, 'AUTH_SUPERSEDED');
  }

  function timedOut(): AuthError {
    return new AuthError('The auth request timed out; the server may still have completed it.', 0, 'AUTH_TIMEOUT');
  }

  /** Run a cookie-changing call after every earlier one has settled. The
   *  deadline covers the whole call (request, body, follow-up /me): at
   *  mutationTimeoutMs the call is aborted and rejected so the queue moves on,
   *  and the task must write nothing once `signal.aborted` is true. */
  function enqueue<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    pendingMutations++;
    const run = mutations
      .then(() => new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
          reject(timedOut());
        }, mutationTimeoutMs);
        task(controller.signal)
          .then(resolve, (e: unknown) => reject(controller.signal.aborted ? timedOut() : e))
          .finally(() => clearTimeout(timer));
      }))
      .finally(() => {
        pendingMutations--;
      });
    mutations = run.catch(() => undefined);
    return run;
  }

  // Cross-tab sync: `storage` fires only in OTHER tabs/windows of the same
  // origin. A rotated header pair for the same identity is adopted (the
  // multi-tab refresh footgun this package exists to kill). A different
  // identity is NOT trusted: status goes to 'checking' and /me re-checks.
  // key === null means storage.clear().
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== null && e.key !== key && e.key !== userKey && e.key !== signOutKey) return;
      const intent = readSignOutIntent();
      if (intent) {
        generation++;
        writeSession(null);
        owedSignOut = intent.startsWith('pending:')
          ? { session: null, error: new AuthError('Sign-out has not been confirmed by the server.', 0, 'SIGN_OUT_UNCONFIRMED') } : null;
        settle('signed-out', null);
        return;
      }
      const nextSession = loadSession();
      const nextUser = nextSession || preferCookie ? loadUser() : null;
      const identityChanged = (nextUser?.id ?? null) !== (user?.id ?? null) || !nextSession !== !session;
      if (!identityChanged) {
        if (nextSession?.accessToken !== session?.accessToken || nextSession?.refreshToken !== session?.refreshToken) {
          session = nextSession;
          accessExpiresAt = nextSession ? tokenExpiry(nextSession.accessToken) : 0;
          scheduleRefresh();
          emit();
        }
        return;
      }
      generation++;
      session = nextSession;
      user = nextUser;
      status = 'checking';
      error = null;
      emit();
      void getUser();
    });
  }

  // Standard short access-token refresh. Timers are an optimization: a resumed
  // client also refreshes before sending protected work. No password is involved.
  function scheduleRefresh(delay?: number) {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    if (status !== 'authenticated' || readSignOutIntent()) return;
    // An unknown expiry is not an expired one: refreshing at once raced the page change that follows
    // a sign-in (pfb_01e440702f31). The next session check learns the expiry (X-Sw-Access-Expires).
    if (delay === undefined) {
      if (!(accessExpiresAt > 0)) { nextRefreshAt = Number.POSITIVE_INFINITY; return; }
      delay = Math.max(0, accessExpiresAt - Date.now() - 10_000 - Math.random() * 3000);
    }
    nextRefreshAt = Date.now() + delay;
    if (typeof window === 'undefined') return;
    refreshTimer = setTimeout(() => { void refreshSession(true).catch(() => undefined); }, delay);
  }
  function refreshSession(background = false): Promise<void> {
    if (readSignOutIntent()) return Promise.resolve();
    if (refreshFlight) return refreshFlight;
    const started = generation;
    const run = async (signal: AbortSignal) => {
      if (started !== generation || status === 'signed-out' || readSignOutIntent()) return;
      // Another browser tab may have refreshed recently.
      let sharedAt = 0;
      try { sharedAt = Number(storage.getItem(refreshStampKey)); } catch { /* storage can be unavailable */ }
      if (Number.isFinite(sharedAt) && sharedAt > Date.now()) {
        if (!preferCookie) { session = loadSession(); accessExpiresAt = session ? tokenExpiry(session.accessToken) : 0; }
        scheduleRefresh(Math.max(1000, sharedAt - Date.now()));
        return;
      }
      const headers: Record<string, string> = { 'X-Sw-Auth-Mode': preferCookie ? 'cookie' : 'header' };
      if (session) { headers.Authorization = 'Bearer ' + session.accessToken; headers[RIDE_ALONG_HEADER] = session.refreshToken; }
      // Cookie refresh must not outlive its document and overwrite cookies from
      // a newer sign-in. An interrupted refresh is a failed request: the next
      // refresh or /me rotates normally (the server accepts a replay within its
      // grace window, and a later one ends only this session).
      const res = await fetch(url('/refresh'), { method: 'POST', credentials: 'include', headers, signal, keepalive: !preferCookie });
      if (started !== generation || signal.aborted || readSignOutIntent()) return;
      if (res.status === 401 || res.status === 403) {
        writeSession(null); settle('signed-out', null); return;
      }
      if (!res.ok) throw new AuthError('Session refresh unavailable.', res.status);
      const body = await res.json() as TokenResponse & { expires_at?: number };
      if (started !== generation || signal.aborted || readSignOutIntent()) return;
      if (!preferCookie) {
        const tokens = pickTokens(body);
        if (!tokens) throw new AuthError('Refresh did not return credentials.', 502);
        writeSession({ accessToken: tokens.access, refreshToken: tokens.refresh });
      }
      if (body.user) writeUser(body.user);
      accessExpiresAt = body.expires_at ?? (session ? tokenExpiry(session.accessToken) : 0);
      if (!Number.isFinite(accessExpiresAt) || accessExpiresAt <= Date.now()) throw new AuthError('Refresh returned an expired access token.', 502);
      const delay = Math.max(1000, accessExpiresAt - Date.now() - 10_000 - Math.random() * 3000);
      try { storage.setItem(refreshStampKey, String(Date.now() + delay)); } catch { /* memory still works */ }
      scheduleRefresh(delay);
    };
    // The mutation queue serializes refresh against sign-in/out in this client.
    // A failure changes no state: the next request or /me tries again.
    refreshInBackground = background;
    refreshFlight = enqueue(run).finally(() => { refreshFlight = null; refreshInBackground = false; });
    return refreshFlight;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => { if (status === 'authenticated' && Date.now() >= nextRefreshAt) void refreshSession(true).catch(() => undefined); });
  }

  // A background refresh starts while the held access token is still valid (10-13 s before
  // expiry). A read sent meanwhile need not wait for it: it goes out on the still-valid token
  // with X-No-Auto-Refresh (and no ride-along refresh token), so the server can never rotate the
  // refresh credential the background refresh is already rotating, and the response carries no
  // pair that could overwrite the new one. If the token is rejected anyway (clock skew), the read
  // waits for the refresh to settle and is sent ONCE more the normal way; it is never treated as
  // a sign-out while the refresh is pending. Only GET/HEAD qualify: a mutation still waits, so a
  // mutation is never sent twice. A demand refresh (token expired or about to be) still blocks.
  const CONCURRENT_READ_MIN_MS = 5_000;
  const authFetch: typeof fetch = (input, init = {}) => send(input, init, true);
  const sendDuringRefresh = (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-No-Auto-Refresh', '1');
    headers.delete(RIDE_ALONG_HEADER);
    const target = input instanceof Request ? input.clone() : (input as RequestInfo);
    // Cookie transport: the browser attaches the cookies; the opt-out keeps the server from
    // rotating them in-band, so no Set-Cookie can race the background refresh.
    if (preferCookie && !session) return fetch(target, { credentials: 'include', ...init, headers });
    if (session) headers.set('Authorization', `Bearer ${session.accessToken}`);
    return fetch(target, { ...init, headers });
  };
  const send = async (input: RequestInfo | URL, init: RequestInit = {}, mayOverlapRefresh: boolean): Promise<Response> => {
    if (readSignOutIntent()) {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete('Authorization');
      headers.delete(RIDE_ALONG_HEADER);
      return fetch(input, { ...init, headers, credentials: 'omit' });
    }
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const flight = refreshFlight;
    const overlap = mayOverlapRefresh && flight !== null && refreshInBackground
      && (method === 'GET' || method === 'HEAD')
      && Number.isFinite(accessExpiresAt) && accessExpiresAt - Date.now() >= CONCURRENT_READ_MIN_MS;
    if (flight && !overlap) await flight;
    else if (!flight && pendingMutations === 0 && status === 'authenticated' && Date.now() >= nextRefreshAt) await refreshSession();
    if (readSignOutIntent()) return send(input, init, false);
    const started = generation;
    if (overlap && flight) {
      const res = await sendDuringRefresh(input, init);
      if (res.status !== 401) return res;
      await flight.catch(() => undefined);
      if (started !== generation) return res;
      return send(input, init, false);
    }
    // Cookie path: no held tokens — the browser attaches the httpOnly pair
    // and the server refreshes it in-band (re-issued via Set-Cookie). Taken
    // only when no header session exists, so an adopted pre-0.2.0 session
    // keeps its header transport untouched.
    if (preferCookie && !session) {
      // NETWORK BLIP — if fetch throws, the request never reached the server;
      // the throw propagates and the cached user stays. A fetch failure is
      // NOT a 401.
      const res = await fetch(input, { credentials: 'include', ...init });
      // The server had the refresh cookie and still rejected: the session is
      // genuinely dead — unless a newer sign-in/out happened meanwhile.
      if (res.status === 401 && started === generation && status !== 'signed-out') settle('signed-out', null);
      return res;
    }

    const attempt = async (sess: Session | null): Promise<Response> => {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      if (sess) {
        headers.set('Authorization', `Bearer ${sess.accessToken}`);
        headers.set(RIDE_ALONG_HEADER, sess.refreshToken);
      }
      // Clone Request inputs so a body can survive the one stale-session
      // retry below (a consumed body throws on re-send).
      const target = input instanceof Request ? input.clone() : (input as RequestInfo);
      // NETWORK BLIP — if fetch throws, the request never reached the
      // server. The throw propagates untouched; the session stays.
      return fetch(target, { ...init, headers });
    };

    // Rotation: only when BOTH new tokens are present, and only for the
    // identity this request started under. Atomic swap.
    const applyRotation = (res: Response) => {
      const newAccess = res.headers.get(ACCESS_ROTATE_HEADER);
      const newRefresh = res.headers.get(REFRESH_ROTATE_HEADER);
      if (newAccess && newRefresh && started === generation) {
        setSession({ accessToken: newAccess, refreshToken: newRefresh });
      }
    };

    const used = session;
    let res = await attempt(used);
    applyRotation(res);

    // 401 with a since-rotated pair: another tab may have refreshed while
    // this request was in flight. Re-read storage; if a DIFFERENT pair for
    // the SAME identity is there, retry ONCE with it. Never retry under a
    // newer identity.
    if (res.status === 401 && used && started === generation) {
      const stored = loadSession();
      if (stored && (stored.accessToken !== used.accessToken || stored.refreshToken !== used.refreshToken)) {
        setSession(stored);
        res = await attempt(stored);
        applyRotation(res);
      }
    }

    // A 401 on the freshest pair means refresh already failed server-side
    // (it had the ride-along refresh token and still couldn't mint a
    // session). The session is genuinely dead — clear it, if it is still the
    // identity this request started under. Any other status leaves it intact.
    if (res.status === 401 && session && started === generation) {
      writeSession(null);
      settle('signed-out', null);
    }

    return res;
  };

  function url(path: string): string {
    return `${baseUrl}${authPath}${path}`;
  }

  function pickTokens(body: TokenResponse): { access: string; refresh: string; user: User | null } | null {
    const d = body.data ?? body;
    const access = d.token ?? d.access_token;
    const refresh = d.refresh_token;
    if (!access || !refresh) return null;
    return { access, refresh, user: d.user ?? null };
  }

  /** Reads `{ user }` / `{ data: { user } }`. undefined = unreadable answer. */
  function readUser(body: unknown): User | null | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const b = body as { user?: unknown; data?: { user?: unknown } };
    const value = 'user' in b ? b.user : b.data && typeof b.data === 'object' && 'user' in b.data ? b.data.user : undefined;
    if (value === null) return null;
    if (isAuthUser(value)) return value as User;
    return undefined;
  }

  function postForSession(path: string, payload: unknown, completingMfa = false): Promise<User> {
    if (!completingMfa) pendingMfa = null;
    // Intent: from this call on, earlier checks and updates no longer apply.
    const mine = ++generation;
    abortEarly();
    try { storage.removeItem(refreshStampKey); } catch { /* optional cross-tab coordination */ }
    const run = enqueue(async (signal) => {
      // Before any write: a timed-out or superseded call changes nothing.
      const stillCurrent = () => {
        if (signal.aborted) throw timedOut();
        if (generation !== mine) throw superseded();
      };
      try { storage.removeItem(refreshStampKey); } catch { /* optional cross-tab coordination */ }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // Header mode must ASK for tokens: a handler answers a request without
      // the hint with a cookie session only (pfb_e1254f754222).
      headers[MODE_HINT_HEADER] = preferCookie ? 'cookie' : 'header';
      const res = await fetch(url(path), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal,
        ...(preferCookie ? { credentials: 'include' as RequestCredentials } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; message?: string };
      stillCurrent();
      const challenge = mfaChallenge(body);
      if (challenge) {
        pendingMfa = challenge.mfa_token;
        if (status === 'checking') settle('signed-out', null);
        throw new AuthError('Enter the 6-digit code we emailed you to finish signing in.', res.status, 'MFA_REQUIRED');
      }
      if (!res.ok) throw new AuthError(body.message || body.error || `Request failed (${res.status})`, res.status);
      // Cookie handshake confirmed: the backend set the httpOnly pair and the
      // browser owns the session — no tokens in the body, nothing to store.
      // This is also the transparent header→cookie migration point: any legacy
      // localStorage pair from a pre-0.2.0 install is purged here.
      const d = body.data ?? body;
      accessExpiresAt = Number((d as { expires_at?: number }).expires_at) || 0;
      if (preferCookie && (d.cookie_session === true || body.cookie_session === true)) {
        if (session) { writeSession(null); accessExpiresAt = Number((d as { expires_at?: number }).expires_at) || 0; }
        if (d.user) {
          if (!isAuthUser(d.user)) throw new AuthError('Auth response did not include a valid user.', 502, 'INVALID_AUTH_RESPONSE');
          owedSignOut = null; // this confirmed identity replaces the owed session
          writeSignOutIntent(null);
          settle('authenticated', d.user);
        } else await checkNow(mine, signal, true);
        stillCurrent();
        if (!isAuthUser(user)) throw new AuthError('Auth response did not include a valid user.', 502, 'INVALID_AUTH_RESPONSE');
        pendingMfa = null;
        return user;
      }
      // Cookie mode was requested and the server did not confirm it: the
      // handler omitted cookie mode (a pasted or pre-0.2.0 handler). Storing the
      // tokens it returned would leave the session where page scripts can read
      // it, so fail loudly and store nothing (pfb_961179f4970e).
      if (preferCookie) {
        throw new AuthError(
          `Sign-in reached ${url(path)} but the server did not confirm a cookie session, so nothing was stored. ` +
            `The handler there does not support cookie mode: mount the SDK's handler ` +
            `(export { somewhereAuth as default } from '@somewhere-cloud/sdk/server'), or make yours set the ` +
            `session cookies and reply { user, cookie_session: true } when the request has X-Sw-Auth-Mode: cookie.`,
          res.status,
          'COOKIE_SESSION_NOT_CONFIRMED',
        );
      }
      // Header mode (explicit, or the non-browser default): the caller asked
      // for tokens in storage.
      const tokens = pickTokens(body);
      if (!tokens) throw new AuthError('Auth response did not include a session.', res.status);
      if (tokens.user && !isAuthUser(tokens.user)) throw new AuthError('Auth response did not include a valid user.', 502, 'INVALID_AUTH_RESPONSE');
      writeSession({ accessToken: tokens.access, refreshToken: tokens.refresh });
      accessExpiresAt = Number((d as { expires_at?: number }).expires_at) || accessExpiresAt;
      owedSignOut = null;
      if (tokens.user) settle('authenticated', tokens.user);
      else await checkNow(mine, signal);
      stillCurrent();
      if (!isAuthUser(user)) throw new AuthError('Auth response did not include a valid user.', 502, 'INVALID_AUTH_RESPONSE');
      pendingMfa = null;
      return user;
    });
    // Any failure of the current call (server refusal, network, timeout) that
    // invalidated the first check: ask /me so the state leaves 'checking'.
    // A failure after a newer sign-in/out changes nothing.
    return run.catch((e: unknown) => {
      if (generation === mine && status === 'checking' && !(e instanceof AuthError && e.code === 'MFA_REQUIRED')) void getUser();
      throw e;
    });
  }

  /** One /me round-trip. Writes state only if `started` is still current and
   *  the caller's `signal` (a queued call's deadline) has not fired. */
  async function checkNow(started: number, signal?: AbortSignal, completingSignIn = false): Promise<User | null> {
    const stale = () => started !== generation || signal?.aborted === true || (!completingSignIn && !!readSignOutIntent());
    if (stale()) return user;
    const cookie = !session && preferCookie;
    if (!cookie && !session) {
      if (!stale()) settle('signed-out', null);
      return null;
    }
    let res: Response;
    try {
      // Cookie mode: the browser owns the session, so always probe /me with
      // credentials — even with no cached user (the cookie can outlive a
      // cleared cache). Header mode rides authFetch (refresh + rotation).
      // /me may rotate an expired cookie in-band; an interrupted one is just a
      // failed check, and the next /me rotates normally.
      const cookieCheck = async (checkSignal: AbortSignal) => {
        const reply = await fetch(url('/me'), { method: 'GET', credentials: 'include', signal: checkSignal });
        if (checkSignal.aborted || started !== generation) return reply;
        const expiry = Number(reply.headers.get('X-Sw-Access-Expires'));
        if (Number.isFinite(expiry) && expiry > Date.now()) accessExpiresAt = expiry;
        return reply;
      };
      // The page's early check (early-session.ts) is this same first /me,
      // started during HTML parse. Adopted only for the first check of an
      // untouched page: generation 0, nothing queued, the page not hidden or
      // frozen since it began, and no session change seen by this tab while it
      // waited (another tab's completed sign-in or started sign-out advances
      // `generation`). Otherwise discarded.
      //
      // Timeout coverage: ONE absolute deadline (now + mutationTimeoutMs)
      // covers the request, the headers AND the body; a sign-in/sign-out start
      // in this tab ends the wait at once. On either, the early request is
      // aborted at whatever stage it is in, and the wait ends even if the early
      // promise never settles. An aborted or failed early /me is a failed check
      // (indeterminate); the next check sends its own /me.
      const early = cookie && !earlyTaken && started === 0 && pendingMutations === 0 ? (earlyTaken = true, takeEarlySession(earlyNames)) : null;
      let adopted: Response | null = null;
      if (early) {
        earlyActive = early;
        const deadlineAt = Date.now() + mutationTimeoutMs;
        let answer: { res: Response } | null = null;
        let text: string | null = null;
        try {
          answer = await waitEarly(early, early.promise, deadlineAt);
          if (answer && !early.void && started === generation) text = await waitEarly(early, answer.res.text(), deadlineAt);
        } finally {
          earlyActive = null;
          early.done();
        }
        // Another tab's sign-in completion or sign-out start reaches this tab as a
        // storage event that advances `generation`, so a stale early answer fails here.
        if (answer && text !== null && !early.void && started === generation) {
          const r = answer.res;
          adopted = new Response(text, { status: r.status, statusText: r.statusText, headers: r.headers });
          const expiry = Number(r.headers.get('X-Sw-Access-Expires'));
          if (Number.isFinite(expiry) && expiry > Date.now()) accessExpiresAt = expiry;
        }
      }
      // A check that went stale while it waited (a newer generation runs its own) sends nothing.
      if (!adopted && stale()) return user;
      res = adopted ?? (cookie
        ? await (signal ? cookieCheck(signal) : enqueue(cookieCheck))
        : await authFetch(url('/me'), { method: 'GET', signal }));
    } catch {
      // Network blip: never a logout. Keep the last-known user, unverified.
      if (!stale()) indeterminate(0);
      return user;
    }
    if (stale()) return user;
    // 401 or an explicit { user: null } is DEFINITIVE signed-out, which also
    // settles an owed sign-out: the server holds no session for this browser.
    if (res.status === 401) {
      owedSignOut = null;
      settle('signed-out', null);
      return null;
    }
    if (!res.ok) {
      indeterminate(res.status);
      return user;
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (stale()) return user;
    const u = readUser(body);
    if (u === undefined) {
      indeterminate(res.status);
      return user;
    }
    if (completingSignIn && !u) throw new AuthError('Auth response did not include a valid user.', 502, 'INVALID_AUTH_RESPONSE');
    // Only an explicit successful sign-in can replace durable logout intent.
    owedSignOut = null;
    if (completingSignIn && u) writeSignOutIntent(null);
    settle(u ? 'authenticated' : 'signed-out', u);
    return u;
  }

  /** Validate the session against /me. Runs after queued sign-ins/outs and is
   *  shared by concurrent callers within one generation. */
  function getUser(): Promise<User | null> {
    if (check && check.generation === generation) return check.promise;
    const started = generation;
    const promise: Promise<User | null> = mutations
      .then(() => {
        if (started !== generation) return user;
        const intent = readSignOutIntent();
        if (intent) {
          if (intent.startsWith('pending:')) return client.signOut().then(() => null);
          settle('signed-out', null);
          return null;
        }
        return checkNow(started);
      })
      .finally(() => {
        if (check?.promise === promise) check = null;
      });
    check = { generation: started, promise };
    return promise;
  }

  const client: SomewhereAuth = {
    fetch: authFetch,
    signUp: (i) => postForSession('/signup', { email: i.email, password: i.password, display_name: i.displayName }),
    signIn: (i) => postForSession('/login', { email: i.email, password: i.password }),
    sendMagicLink: async (i) => {
      const res = await fetch(url('/magic-link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: i.email, redirect_uri: i.redirectUri }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new AuthError(b.message || b.error || `Could not send magic link (${res.status})`, res.status);
      }
    },
    verifyMagicLink: (i) => postForSession('/magic-link/verify', { token: i.token }),
    emailVerified: async () => {
      const res = await authFetch(url('/verify-email'), { method: 'GET' });
      const b = (await res.json().catch(() => ({}))) as { email_verified?: unknown; message?: string; error?: string };
      if (!res.ok) throw new AuthError(b.message || b.error || `Could not check the email address (${res.status})`, res.status);
      return b.email_verified === true;
    },
    requestEmailVerification: async () => {
      const res = await authFetch(url('/request-email-verification'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new AuthError(b.message || b.error || `Could not send the verification code (${res.status})`, res.status);
      }
    },
    verifyEmail: async (i) => {
      const res = await authFetch(url('/verify-email'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: i.code }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new AuthError(b.message || b.error || `Could not verify the code (${res.status})`, res.status);
      }
    },
    googleSignInUrl: async (i) => {
      const res = await fetch(url(`/google-url${i?.redirectUri ? `?redirect_uri=${encodeURIComponent(i.redirectUri)}` : ''}`));
      const b = (await res.json().catch(() => ({}))) as { url?: string; data?: { url?: string } };
      const u = b.url ?? b.data?.url;
      if (!u) throw new AuthError('Could not get the Google sign-in URL.', res.status);
      return u;
    },
    completeGoogleSignIn: (i) => postForSession('/google', { code: i.code, ...oauthAttempt(i) }),
    githubSignInUrl: async (i) => {
      const res = await fetch(url(`/github-url${i?.redirectUri ? `?redirect_uri=${encodeURIComponent(i.redirectUri)}` : ''}`));
      const b = (await res.json().catch(() => ({}))) as { url?: string; data?: { url?: string } };
      const u = b.url ?? b.data?.url;
      if (!u) throw new AuthError('Could not get the GitHub sign-in URL.', res.status);
      return u;
    },
    completeGithubSignIn: (i) => postForSession('/github', { code: i.code, ...oauthAttempt(i) }),
    discordSignInUrl: async (i) => {
      const res = await fetch(url(`/discord-url${i?.redirectUri ? `?redirect_uri=${encodeURIComponent(i.redirectUri)}` : ''}`));
      const b = (await res.json().catch(() => ({}))) as { url?: string; data?: { url?: string } };
      const u = b.url ?? b.data?.url;
      if (!u) throw new AuthError('Could not get the Discord sign-in URL.', res.status);
      return u;
    },
    completeDiscordSignIn: (i) => postForSession('/discord', { code: i.code, ...oauthAttempt(i) }),
    completeMfa: (input) => {
      if (!pendingMfa) return Promise.reject(new AuthError('There is no pending MFA sign-in. Start signing in again.', 400, 'MFA_CHALLENGE_REQUIRED'));
      return postForSession('/mfa/challenge', { mfa_token: pendingMfa, code: input.code }, true);
    },
    resendMfaCode: async () => {
      if (!pendingMfa) throw new AuthError('There is no pending MFA sign-in. Start signing in again.', 400, 'MFA_CHALLENGE_REQUIRED');
      // No session exists yet: the pending ticket is the only authority, so this is a plain request.
      const res = await fetch(url('/mfa/challenge'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', [MODE_HINT_HEADER]: preferCookie ? 'cookie' : 'header' },
        body: JSON.stringify({ mfa_token: pendingMfa, resend: true }),
        ...(preferCookie ? { credentials: 'include' as RequestCredentials } : {}),
      });
      return mfaAnswer(res, 'Could not send a new code');
    },
    enrollMfa: async () => mfaAnswer(await authFetch(url('/mfa/enroll'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'email' }),
    }), 'Could not turn on sign-in codes'),
    verifyMfaEnrollment: async (i) => mfaAnswer(await authFetch(url('/mfa/verify'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge_id: i.challenge_id, code: i.code }),
    }), 'Could not confirm the code'),
    unenrollMfa: async (i) => mfaAnswer(await authFetch(url('/mfa/unenroll'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('challenge_id' in i ? { challenge_id: i.challenge_id, code: i.code } : { password: i.password }),
    }), 'Could not turn off sign-in codes'),
    signOut: () => {
      pendingMfa = null;
      const existingIntent = readSignOutIntent();
      // An owed sign-out is retried with the header session it was for.
      const had = session ?? owedSignOut?.session ?? null;
      // Something to end server-side: an owed sign-out, a header session, a
      // known or pending cookie identity, or a sign-in queued ahead of this call.
      const serverWork = existingIntent?.startsWith('pending:') || owedSignOut !== null || !!had
        || (preferCookie && (!!user || status !== 'signed-out' || pendingMutations > 0));
      // Invalidate earlier checks/rotations and drop credentials immediately.
      // Retain the last-known user until settlement: a user-null UI can trigger
      // navigation before this queued request has even started.
      const mine = ++generation;
      abortEarly();
      writeSession(null);
      // Pending until /logout is answered: consumers show "signing out", not
      // "signed out", while the server may still accept the session.
      if (!serverWork) { settle('signed-out', null); return Promise.resolve(); }
      const intent = existingIntent?.startsWith('pending:') ? existingIntent : `pending:${Date.now()}:${Math.random()}`;
      if (preferCookie) writeSignOutIntent(intent);
      signOutsInFlight++;
      status = 'checking';
      scheduleRefresh();
      emit();
      const unconfirmed = (failure: AuthError) => {
        // Owed only for this call's generation: a newer sign-in replaced the
        // session, and a newer signOut() retries it itself.
        if (generation !== mine) return;
        owedSignOut = { session: had, error: failure };
        error = failure;
        emit();
      };
      // Server-side revoke (and, in cookie mode, the Set-Cookie expirations
      // that actually end the browser session), after every earlier queued
      // call. Resolves either way; a failure stays owed (signOutUnconfirmed,
      // error 'SIGN_OUT_UNCONFIRMED') and the next signOut() retries it.
      return enqueue(async (signal) => {
        // A new sign-in in another tab may have replaced this queued logout.
        if (preferCookie && readSignOutIntent() !== intent) return;
        let res: Response;
        try {
          res = await fetch(url('/logout'), {
            method: 'POST',
            // Cookie logout is resumed from durable intent after navigation.
            // Do not let the old document's late Set-Cookie erase a newer login.
            // Header revocation has no browser cookie response to race.
            keepalive: !preferCookie,
            // A header session is revoked by its refresh token, sent as the same
            // ride-along header authFetch uses; the access bearer alone revokes
            // nothing. `had` is captured at call time, so a retry resends the
            // credential of the session it is for, never a newer one.
            headers: had
              ? { 'Content-Type': 'application/json', Authorization: `Bearer ${had.accessToken}`, [RIDE_ALONG_HEADER]: had.refreshToken }
              : { 'Content-Type': 'application/json' },
            signal,
            ...(preferCookie ? { credentials: 'include' as RequestCredentials } : {}),
          });
        } catch {
          if (!signal.aborted) unconfirmed(new AuthError('Sign-out could not reach the server; the session may still be active.', 0, 'SIGN_OUT_UNCONFIRMED'));
          return;
        }
        if (signal.aborted) return;
        if (!res.ok) {
          unconfirmed(new AuthError(`The server did not confirm sign-out (${res.status}).`, res.status, 'SIGN_OUT_UNCONFIRMED'));
          return;
        }
        // /logout's finite JSON response should finish being read. Header
        // success already confirms logout; body latency/failure must not hold
        // the mutation queue or change that confirmation.
        if (res.body !== null && res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
          void res.text().catch(() => {});
        }
        // Confirmed: no obligation is left; the server's answer is the truth now.
        if (preferCookie && readSignOutIntent() === intent) writeSignOutIntent(null);
        owedSignOut = null;
        if (error?.code === 'SIGN_OUT_UNCONFIRMED') error = null;
        emit();
      }).catch(() => {
        // Only the deadline rejects here.
        unconfirmed(new AuthError('Sign-out timed out; the session may still be active.', 0, 'SIGN_OUT_UNCONFIRMED'));
      }).finally(() => {
        signOutsInFlight--;
        if (generation === mine) settle('signed-out', null);
        else emit();
      });
    },
    getUser,
    getSession: () => session,
    getCachedUser: () => user,
    getState: snapshot,
    onChange: (listener) => {
      listeners.add(listener);
      listener(snapshot());
      return () => void listeners.delete(listener);
    },
    billing: {
      has: (_feature) => { throw new AuthError('Paid access is no longer part of sign-in identity. Check it in a server endpoint with await sw.billing.has(feature).', 0, 'BILLING_EXPLICIT_CHECK_REQUIRED'); },
      entitlements: () => { throw new AuthError('Paid access is no longer part of sign-in identity. Read it in a server endpoint with await sw.billing.entitlements().', 0, 'BILLING_EXPLICIT_CHECK_REQUIRED'); },
      plans: async () => {
        const res = await authFetch(url('/plans'), { method: 'GET' });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new AuthError(b.message || b.error || `Could not load plans (${res.status})`, res.status);
        }
        const body = (await res.json().catch(() => ({}))) as { plans?: BillingPlan[]; data?: { plans?: BillingPlan[] } };
        return body.plans ?? body.data?.plans ?? [];
      },
      subscribe: async (plan, opts) => {
        const here = typeof window !== 'undefined' ? window.location.href : undefined;
        const res = await authFetch(url('/billing/checkout'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plan,
            success_url: opts?.successUrl ?? here,
            cancel_url: opts?.cancelUrl ?? here,
          }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new AuthError(b.message || b.error || `Could not start checkout (${res.status})`, res.status);
        }
        const body = (await res.json().catch(() => ({}))) as { url?: string; data?: { url?: string } };
        const u = body.url ?? body.data?.url;
        if (!u) throw new AuthError('Checkout did not return a URL.', res.status);
        if (opts?.redirect !== false && typeof window !== 'undefined') window.location.assign(u);
        return { url: u };
      },
      openBillingPortal: async (opts) => {
        const here = typeof window !== 'undefined' ? window.location.href : undefined;
        const res = await authFetch(url('/billing/portal'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ return_url: opts?.returnUrl ?? here }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new AuthError(b.message || b.error || `Could not open the billing portal (${res.status})`, res.status);
        }
        const body = (await res.json().catch(() => ({}))) as { url?: string; data?: { url?: string } };
        const u = body.url ?? body.data?.url;
        if (!u) throw new AuthError('Billing portal did not return a URL.', res.status);
        if (opts?.redirect !== false && typeof window !== 'undefined') window.location.assign(u);
        return { url: u };
      },
    },
  };
  return client;
}

export class AuthError extends Error {
  status: number;
  /** Set when the client itself refuses a response, e.g.
   *  'COOKIE_SESSION_NOT_CONFIRMED', and for the email sign-in code steps the platform's code (e.g.
   *  'AUTH_MFA_LOCKED', 'AUTH_MFA_REQUIRED_BY_APP'). Otherwise undefined for server-reported failures. */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}
