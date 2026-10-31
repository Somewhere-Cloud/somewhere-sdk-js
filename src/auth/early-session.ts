// Early session check (platform tsk_c09746b9).
//
// A cookie-session page cannot know who is signed in until its bundle has
// downloaded, run, mounted, and asked GET <authPath>/me. This module provides
// a small inline script, meant to run from the page's <head> before the
// bundle, that starts THAT SAME /me request during HTML parse, so it overlaps
// the bundle download. The auth client adopts the answer instead of sending
// its own: still exactly one /me, answered by the app's own handler, with any
// in-band refresh Set-Cookie applied by the browser as usual.
//
// It is a head start, not a new authority or a hint:
//  - It runs the client's own first-check protocol, under the same names: the
//    same Web Lock, the same durable "refresh outcome unknown" marker written
//    before a possibly-rotating /me and cleared only on a definitive answer, and
//    the same rule that a later shared refresh stamp means "do not rotate".
//  - It does nothing when this browser has a recorded sign-out (owed or done)
//    or an unknown refresh outcome; the client handles those as it always has.
//  - The client adopts it only for its very first check, before any sign-in or
//    sign-out has started in this tab, and only if no session change reached
//    this tab while it waited (another tab's completed sign-in or started
//    sign-out arrives as a storage event that advances the client's
//    generation). Anything else, including a late answer after such a change,
//    is discarded and the client checks normally.
//  - It is BOUNDED. One AbortController covers every stage: waiting for the
//    refresh lock (the lock request carries the signal, so a request queued
//    behind another tab's held lock is withdrawn without being sent), the /me
//    request and its response body. The script aborts it EARLY_SESSION_TIMEOUT_MS
//    after it starts unless the client reports the body consumed (done()); the
//    client aborts it at its own deadline, and at once when this tab starts a
//    sign-in or sign-out. `dispatched` tells the two outcomes apart: not
//    dispatched means no request and no marker; dispatched with a marker that
//    was not cleared means a possibly-rotating /me with an unknown outcome,
//    exactly like the client's own interrupted /me (never retried; the next
//    check reconciles without rotating). The lock is held only until the
//    response headers arrive; the body is read outside it.
//  - It is VOID once the page is hidden for navigation or frozen (`pagehide`,
//    `freeze`): a page restored from the back/forward cache never adopts an
//    answer from before it was hidden, consumed or not. It is also consumed
//    once; any later check asks /me itself.
//
// The script's names are derived from the client's DEFAULT options
// (createSomewhereAuth() with no arguments: storage key 'sw_auth', auth path
// '/api/auth', same origin). A client created with other options never adopts
// it (names differ), so a host must inline it only for an app whose client is
// created with the defaults.

export const EARLY_SESSION_VERSION = 1;
/** Matches the client's default request deadline (mutationTimeoutMs). */
export const EARLY_SESSION_TIMEOUT_MS = 30_000;
export const EARLY_SESSION_GLOBAL = '__swEarlySession';

/** Names shared by the early script and the client, from the client's options. */
export function earlySessionNames(storageKey = 'sw_auth', baseUrl = '', authPath = '/api/auth') {
  const userKey = `${storageKey}_user`;
  const base = baseUrl.replace(/\/$/, '');
  const path = authPath.replace(/\/$/, '');
  return {
    me: `${base}${path}/me`,
    signOut: `${userKey}:sign-out:${base}${path}`,
    stamp: `${userKey}:refresh-at`,
    pending: `${userKey}:refresh-pending`,
  };
}

export type EarlySessionNames = ReturnType<typeof earlySessionNames>;

/** What the inline script leaves on the page for the client. */
export interface EarlySession {
  v: number;
  names: EarlySessionNames;
  /** null: the script stood down under the lock (the client checks normally). */
  promise: Promise<{ res: Response; mayRotate: boolean } | null>;
  /** Abort it at whatever stage it is in (lock wait, request, body). */
  abort(): void;
  /** The client has finished with the response (body consumed): stop the script's deadline. */
  done(): void;
  /** True once /me was actually sent (after the lock was granted). */
  dispatched: boolean;
  /** Set on pagehide/freeze: never adopted afterwards. */
  void?: boolean;
}

/** Take the page's early session check, once. Returns null when absent or not for these names. */
export function takeEarlySession(names: EarlySessionNames): EarlySession | null {
  const g = globalThis as Record<string, unknown>;
  const early = g[EARLY_SESSION_GLOBAL] as EarlySession | undefined;
  if (!early || typeof early !== 'object') return null;
  try { delete g[EARLY_SESSION_GLOBAL]; } catch { g[EARLY_SESSION_GLOBAL] = undefined; }
  if (early.v !== EARLY_SESSION_VERSION || !early.promise || typeof early.promise.then !== 'function'
    || typeof early.abort !== 'function' || typeof early.done !== 'function') return null;
  const n = early.names || ({} as EarlySessionNames);
  const same = (Object.keys(names) as Array<keyof EarlySessionNames>).every((k) => n[k] === names[k]);
  if (!same) {
    // Not ours. Still let it settle before our own check so two /me requests
    // never rotate concurrently in this document.
    // Delegates to the live object (dispatched/void keep updating).
    return Object.create(early, {
      names: { value: n },
      promise: { value: early.promise.then(() => null, () => null) },
    }) as EarlySession;
  }
  return early;
}

/**
 * The inline script (ES5, no imports) for the default client. A host inlines
 * it in <head>, before the bundle, only for an app whose auth client is
 * createSomewhereAuth() with default options and whose <authPath> handler is
 * this package's somewhereAuth. Returns script SOURCE, not a <script> tag.
 */
export function earlySessionScript(): string {
  const names = earlySessionNames();
  return `(function(){try{
var N=${JSON.stringify(names)},w=window,ls;
try{ls=w.localStorage;}catch(e){return;}
if(!ls||typeof w.fetch!=='function')return;
var g=function(k){try{return ls.getItem(k);}catch(e){return null;}};
if(g(N.signOut)||g(N.pending))return;
if(typeof w.AbortController!=='function')return;
var ctl=new w.AbortController(),locks=w.navigator&&w.navigator.locks;
var timer=setTimeout(function(){ctl.abort();},${EARLY_SESSION_TIMEOUT_MS});
var E={v:${EARLY_SESSION_VERSION},names:N,dispatched:false,
abort:function(){ctl.abort();},done:function(){clearTimeout(timer);}};
var run=function(){
if(ctl.signal.aborted||g(N.signOut)||g(N.pending))return null;
var stamp=Number(g(N.stamp)),mayRotate=!(stamp>Date.now()),marker=null;
if(mayRotate){marker=String(Date.now())+':'+Math.random();try{ls.setItem(N.pending,marker);}catch(e){return null;}}
E.dispatched=true;
return w.fetch(N.me,{method:'GET',credentials:'include',signal:ctl.signal}).then(function(res){
if(marker&&(res.ok||res.status===401||res.status===403)&&g(N.pending)===marker){try{ls.removeItem(N.pending);}catch(e){}}
return {res:res,mayRotate:!!marker};
});
};
var p=locks?locks.request(N.stamp,{signal:ctl.signal},run):Promise.resolve().then(run);
p.then(function(v){if(!v)clearTimeout(timer);},function(){clearTimeout(timer);});
E.promise=p;
var stale=function(){E.void=true;};
w.addEventListener('pagehide',stale);w.addEventListener('freeze',stale);
w.${EARLY_SESSION_GLOBAL}=E;
}catch(e){}})();`;
}
