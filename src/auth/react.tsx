/**
 * @somewhere-tech/sdk/react — the "you never touch a token" layer.
 *
 *   <SomewhereAuthProvider>
 *     <SignedIn><Dashboard/></SignedIn>
 *     <SignedOut><SignIn/></SignedOut>
 *   </SomewhereAuthProvider>
 *
 *   const user = useUser();           // null | User
 *   const auth = useAuth();           // actions + auth.fetch
 *
 * The provider hydrates the user once on mount (validating + refreshing the
 * session) and re-renders on every login / logout / token rotation.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AuthError,
  createSomewhereAuth,
  type SomewhereAuth,
  type SomewhereAuthOptions,
  type User,
  type Session,
  type AuthState,
  type BillingPlan,
} from './client.js';

interface AuthContextValue {
  state: AuthState;
  user: User | null;
  session: Session | null;
  /** True until the initial session check resolves — avoids a flash of the
   *  signed-out UI for an already-logged-in user. */
  loading: boolean;
  auth: SomewhereAuth;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function SomewhereAuthProvider(props: {
  options?: SomewhereAuthOptions;
  /** Pass a pre-created client instead of options, e.g. to share it with
   *  non-React code. */
  client?: SomewhereAuth;
  children: React.ReactNode;
}) {
  // Create the client exactly once.
  const auth = useMemo(() => props.client ?? createSomewhereAuth(props.options), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<AuthState>(() => auth.getState());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const off = auth.onChange(setState);
    // Validate + refresh the session against the backend on mount.
    auth.getUser().finally(() => setLoading(false));
    return off;
  }, [auth]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, user: state.user, session: state.session, loading, auth }),
    [state, loading, auth],
  );
  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}

function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('@somewhere-tech/sdk/auth: hooks must be used inside <SomewhereAuthProvider>.');
  return ctx;
}

/**
 * The session as the backend last reported it: status ('checking' |
 * 'authenticated' | 'signed-out' | 'indeterminate'), the user (last-known and
 * unverified unless 'authenticated'), and the check error. `recheck()` asks
 * /me again. Unlike useUser(), this never presents a cached user as verified.
 */
export function useAuthState(): AuthState & { recheck(): Promise<User | null> } {
  const { state, auth } = useAuthContext();
  return useMemo(() => ({ ...state, recheck: auth.getUser }), [state, auth]);
}

/** The current user, or null. Re-renders on login/logout/rotation. */
export function useUser(): User | null {
  return useAuthContext().user;
}

/** The raw session tokens (rarely needed — prefer auth.fetch). */
export function useSession(): Session | null {
  return useAuthContext().session;
}

/** True until the first session check resolves. */
export function useAuthLoading(): boolean {
  return useAuthContext().loading;
}

/** The client: actions (signIn, signUp, signOut, …) + auth.fetch. */
export function useAuth(): SomewhereAuth {
  return useAuthContext().auth;
}

export function SignedIn({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext();
  if (loading && !user) return null; // cached user paints now; /me verifies in the background (tsk_1288e1c6)
  return user ? <>{children}</> : null;
}

/**
 * Renders `children` when signed out. While a signOut() is waiting for the
 * server (`useAuthState().signingOut`), the server may still accept the
 * session, so it renders `pending` instead (default nothing), e.g.
 * `<SignedOut pending={<p>Signing out…</p>}><SignIn/></SignedOut>`.
 */
export function SignedOut({ children, pending = null }: { children: React.ReactNode; pending?: React.ReactNode }) {
  const { user, loading, state } = useAuthContext();
  if (loading && !user) return null; // cached user paints now; /me verifies in the background (tsk_1288e1c6)
  if (user) return null;
  return state.signingOut ? <>{pending}</> : <>{children}</>;
}

/** Gate a subtree behind auth; shows `fallback` (default null) when signed
 *  out, and `pending` (default null) while a signOut() awaits the server. */
export function Protect({ children, fallback = null, pending = null }: { children: React.ReactNode; fallback?: React.ReactNode; pending?: React.ReactNode }) {
  const { user, loading, state } = useAuthContext();
  if (loading && !user) return null; // cached user paints now; /me verifies in the background (tsk_1288e1c6)
  if (user) return <>{children}</>;
  return state.signingOut ? <>{pending}</> : <>{fallback}</>;
}

function userEntitlements(user: User | null): string[] {
  return Array.isArray(user?.entitlements) ? (user.entitlements as string[]) : [];
}

/**
 * Entitlements for the current user (sw.billing). `has(feature)` is a sync
 * local check against the session — no network. `entitlements` is the granted
 * feature slugs. Re-renders on login/logout/plan change (the feature list
 * rides the user object, refreshed on every /me).
 */
export function useEntitlements(): { has: (feature: string) => boolean; entitlements: string[]; loading: boolean } {
  const { user, loading } = useAuthContext();
  const entitlements = userEntitlements(user);
  return {
    has: (feature: string) => entitlements.includes(feature),
    entitlements,
    loading,
  };
}

/**
 * Gate a subtree behind a billing FEATURE (sw.billing) — the entitlement
 * mirror of <Protect>. Shows `fallback` (default null) when the current user's
 * plan doesn't grant `feature` (or they're signed out).
 *
 *   <Gate feature="export" fallback={<Upsell/>}><ExportButton/></Gate>
 */
export function Gate({
  feature,
  children,
  fallback = null,
}: {
  feature: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { user, loading } = useAuthContext();
  if (loading && !user) return null; // cached user paints now; /me verifies in the background
  return userEntitlements(user).includes(feature) ? <>{children}</> : <>{fallback}</>;
}

function formatPlanPrice(p: BillingPlan): string {
  if (p.price_cents == null || p.price_cents === 0) return 'Free';
  let amount: string;
  try {
    amount = (p.price_cents / 100).toLocaleString(undefined, {
      style: 'currency',
      currency: (p.currency || 'usd').toUpperCase(),
    });
  } catch {
    amount = `$${(p.price_cents / 100).toFixed(2)}`;
  }
  const per = p.interval === 'month' ? '/mo' : p.interval === 'year' ? '/yr' : '';
  return amount + per;
}

/**
 * Pricing page (sw.billing). Renders the project's code-defined plans,
 * highlights the user's current plan, and a Subscribe button runs checkout for
 * the signed-in user (the worker resolves the plan's price from the catalog).
 *
 *   <PricingTable/>   // that's it
 *
 * Logic-only / unstyled — theme it with the `sw-*` class hooks (sw-pricing-table,
 * sw-plan[data-current], sw-plan-name/-price/-features/-feature/-cta). Pass
 * `onSubscribe` to override the default redirect-to-Stripe behavior, `onError`
 * to surface failures.
 */
export function PricingTable(props: {
  className?: string;
  /** Current plan from an explicit server billing observation. */
  currentPlan?: string | null;
  onSubscribe?: (planSlug: string) => void;
  onError?: (message: string) => void;
}) {
  const auth = useAuth();
  const [plans, setPlans] = useState<BillingPlan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    auth.billing
      .plans()
      .then((p) => { if (!cancelled) setPlans(p.filter((x) => x.active)); })
      .catch((e: unknown) => props.onError?.(e instanceof Error ? e.message : 'Could not load plans.'));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  if (plans === null) return <div className={`sw-pricing-table sw-pricing-loading${props.className ? ' ' + props.className : ''}`} />;

  const subscribe = async (slug: string) => {
    if (props.onSubscribe) return props.onSubscribe(slug);
    setBusy(slug);
    try {
      await auth.billing.subscribe(slug); // redirects to Stripe on success
    } catch (e: unknown) {
      props.onError?.(e instanceof Error ? e.message : 'Could not start checkout.');
      setBusy(null);
    }
  };

  return (
    <div className={`sw-pricing-table${props.className ? ' ' + props.className : ''}`}>
      {plans.map((p) => {
        const current = typeof props.currentPlan === 'string' && props.currentPlan === p.slug;
        return (
          <div key={p.slug} className="sw-plan" data-plan={p.slug} data-current={current || undefined}>
            <div className="sw-plan-name">{p.name}</div>
            {p.description ? <div className="sw-plan-description">{p.description}</div> : null}
            <div className="sw-plan-price">{formatPlanPrice(p)}</div>
            {p.features.length > 0 ? (
              <ul className="sw-plan-features">
                {p.features.map((f) => (
                  <li key={f.feature} className="sw-plan-feature">{f.feature}</li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              className="sw-plan-cta"
              disabled={current || busy === p.slug}
              onClick={() => subscribe(p.slug)}
            >
              {current ? 'Current plan' : busy === p.slug ? 'Redirecting…' : 'Subscribe'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One-click "manage subscription" (sw.billing) — opens the Stripe billing portal
 * for the signed-in user (update card, cancel, see invoices). Renders a button;
 * pass children to set the label (default "Manage billing"). The user can only
 * ever reach their OWN portal (resolved server-side from their session).
 *
 *   <BillingPortal/>            // default label
 *   <BillingPortal>Manage plan</BillingPortal>
 */
export function BillingPortal(props: {
  children?: React.ReactNode;
  className?: string;
  onError?: (message: string) => void;
}) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      await auth.billing.openBillingPortal(); // redirects to the portal on success
    } catch (e: unknown) {
      props.onError?.(e instanceof Error ? e.message : 'Could not open the billing portal.');
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={`sw-billing-portal${props.className ? ' ' + props.className : ''}`}
      disabled={busy}
      onClick={open}
    >
      {props.children ?? (busy ? 'Opening…' : 'Manage billing')}
    </button>
  );
}

/**
 * Drop this component at an OAuth callback route (the redirect_uri). It
 * reads `?code=` and completes sign-in, then calls onDone (or navigates to '/').
 * The app writes no code-exchange logic.
 */
export function AuthCallback(props: {
  provider?: 'google' | 'github' | 'discord';
  onDone?: (user: User) => void;
  onError?: (message: string) => void;
  children?: React.ReactNode;
}) {
  const auth = useAuth();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const done = (user: User) => {
    if (props.onDone) props.onDone(user);
    else window.location.replace('/');
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) {
      const msg = 'Missing ?code in the callback URL.';
      setError(msg);
      props.onError?.(msg);
      return;
    }
    const complete = props.provider === 'github'
      ? auth.completeGithubSignIn
      : props.provider === 'discord'
        ? auth.completeDiscordSignIn
        : auth.completeGoogleSignIn;
    complete({ code })
      .then(done)
      .catch((e: unknown) => {
        if (e instanceof AuthError && e.code === 'MFA_REQUIRED') {
          setMfaRequired(true);
          return;
        }
        const msg = e instanceof Error ? e.message : 'Sign-in failed.';
        setError(msg);
        props.onError?.(msg);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (mfaRequired) return (
    <form className="sw-auth-mfa" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !mfaCode.trim()) return;
      setBusy(true);
      setError(null);
      auth.completeMfa({ code: mfaCode.trim() }).then(done).catch((e: unknown) => {
        const message = e instanceof Error ? e.message : 'Could not complete sign-in.';
        setError(message);
        props.onError?.(message);
      }).finally(() => { setBusy(false); setMfaCode(''); });
    }}>
      <label>Authenticator or backup code
        <input autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} disabled={busy} autoFocus />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={busy || !mfaCode.trim()}>{busy ? 'Signing in…' : 'Finish signing in'}</button>
    </form>
  );
  if (error) return <>{props.children ?? error}</>;
  return <>{props.children ?? 'Signing you in…'}</>;
}
