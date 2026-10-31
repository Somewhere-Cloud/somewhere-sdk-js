import assert from 'node:assert/strict';
import { createSomewhereAuth, AuthError } from '@somewhere-cloud/sdk/auth';
import { somewhereAuth } from '@somewhere-cloud/sdk/server';
import { createClient } from '@somewhere-cloud/sdk';

const user = { id: 'mfa-user', email: 'mfa@example.test' };
const challenge = { mfa_required: true, mfa_token: 'private-pending-ticket' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const storage = () => ({ values: new Map(), getItem(k) { return this.values.get(k) ?? null; }, setItem(k,v) { this.values.set(k,v); }, removeItem(k) { this.values.delete(k); } });
const runtime = {
  auth: {
    login: async () => challenge,
    loginWithCookie: async () => challenge,
    signup: async () => challenge,
    signupWithCookie: async () => ({ user: challenge }),
    verifyOtp: async () => challenge,
    googleExchange: async () => challenge,
    githubExchange: async () => challenge,
    discordExchange: async () => challenge,
    fromRequest: async () => null,
    logoutWithCookie: async () => ({ logged_out: true }),
    setSessionCookies: () => { throw new Error('a challenge must not set cookies'); },
    mfa: {
      challengeWithCookie: async ({mfa_token, code}) => {
        assert.equal(mfa_token, challenge.mfa_token);
        if (code !== 'backup-code') throw Object.assign(new Error('Incorrect code.'), { status: 400 });
        return { user };
      },
      challenge: async () => ({ user, token: 'access', refresh_token: 'refresh' }),
    },
  },
};
for (const route of ['/login','/signup','/magic-link/verify','/google','/github','/discord']) {
  const response = await somewhereAuth(new Request(`https://app.test/api/auth${route}`, { method:'POST', body:'{}' }), runtime);
  assert.deepEqual(await response.json(), challenge, route);
}
const unavailable = await somewhereAuth(new Request('https://app.test/api/auth/mfa/challenge', { method:'POST', body:JSON.stringify({mfa_token:'pending',code:'123456'}) }), { auth: { ...runtime.auth, mfa: undefined } });
assert.equal(unavailable.status, 501);
const header = await somewhereAuth(new Request('https://app.test/api/auth/mfa/challenge', { method:'POST',headers:{'X-Sw-Auth-Mode':'header'},body:JSON.stringify({mfa_token:'pending',code:'123456'}) }), runtime);
assert.equal((await header.json()).token, 'access');

const originalFetch = globalThis.fetch;
try {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url:String(url),body:init?.body});
    return somewhereAuth(new Request(url,init), runtime);
  };
  const cache = storage();
  const auth = createSomewhereAuth({baseUrl:'https://app.test',mode:'cookie',storage:cache});
  for (const method of [() => auth.signIn({email:'e',password:'p'}), () => auth.verifyMagicLink({token:'link'}), () => auth.completeGoogleSignIn({code:'oauth'})]) {
    await assert.rejects(method(), e => e instanceof AuthError && e.code === 'MFA_REQUIRED' && !JSON.stringify(e).includes(challenge.mfa_token));
    assert.equal(auth.getCachedUser(), null);
    assert.ok(!JSON.stringify([...cache.values]).includes(challenge.mfa_token));
  }
  await assert.rejects(auth.completeMfa({code:'wrong'}));
  assert.equal((await auth.completeMfa({code:'backup-code'})).id, user.id);
  await assert.rejects(auth.completeMfa({code:'backup-code'}), e => e.code === 'MFA_CHALLENGE_REQUIRED');
  await assert.rejects(auth.signIn({email:'e',password:'p'}));
  await auth.signOut();
  await assert.rejects(auth.completeMfa({code:'backup-code'}), e => e.code === 'MFA_CHALLENGE_REQUIRED');

  const root = createClient('https://app.test', undefined, {projectId:'p',authMode:'cookie',authPath:'https://app.test/api/auth'});
  const pending = await root.auth.signIn({email:'e',password:'p'});
  assert.equal(pending.error.code,'MFA_REQUIRED');
  assert.ok(!JSON.stringify(pending).includes(challenge.mfa_token));
  assert.equal((await root.auth.getSession()).data.session,null);
  assert.equal((await root.auth.completeMfa({code:'wrong'})).error.code,'AUTH_ERROR');
  assert.equal((await root.auth.completeMfa({code:'backup-code'})).data.user.id,user.id);
  assert.equal((await root.auth.completeMfa({code:'backup-code'})).error.code,'MFA_CHALLENGE_REQUIRED');

  // Superseded challenges cannot install a pending credential after sign-out.
  let release;
  globalThis.fetch = async (url,init) => String(url).endsWith('/login')
    ? await new Promise(resolve => { release = () => resolve(json(challenge)); })
    : json({ok:true});
  const ordered = createSomewhereAuth({baseUrl:'https://app.test',mode:'cookie',storage:storage()});
  const old = ordered.signIn({email:'e',password:'p'});
  await new Promise(resolve => setImmediate(resolve));
  const out = ordered.signOut();
  release();
  await assert.rejects(old,e => e.code === 'AUTH_SUPERSEDED');
  await out;
  await assert.rejects(ordered.completeMfa({code:'backup-code'}),e => e.code === 'MFA_CHALLENGE_REQUIRED');

  // A late response after a bounded deadline likewise cannot resurrect a ticket.
  let late;
  globalThis.fetch = async (url) => String(url).endsWith('/login') ? new Promise(resolve => { late=resolve; }) : json({user:null});
  const timed = createSomewhereAuth({baseUrl:'https://app.test',mode:'cookie',storage:storage(),mutationTimeoutMs:5});
  await assert.rejects(timed.signIn({email:'e',password:'p'}),e => e.code === 'AUTH_TIMEOUT');
  late(json(challenge));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(timed.completeMfa({code:'backup-code'}),e => e.code === 'MFA_CHALLENGE_REQUIRED');

  globalThis.fetch = async () => json({cookie_session:true,user:{mfa_token:'must-not-cache'}});
  const malformed = createSomewhereAuth({baseUrl:'https://app.test',mode:'cookie',storage:storage()});
  await assert.rejects(malformed.signIn({email:'e',password:'p'}),e => e.code === 'INVALID_AUTH_RESPONSE');
  assert.equal(malformed.getCachedUser(),null);
  console.log('MFA continuation: server routes, both clients, no persistence, retry, completion, sign-out, stale/deadline, invalid user PASS');
} finally { globalThis.fetch = originalFetch; }

// Root Result surface: header compatibility, supersession, and malformed users.
{
  const key = 'smt_fixture_only';
  const root = createClient('https://app.test', key, {projectId:'p',authMode:'header',fetch:async (_url,init) => {
    const payload = JSON.parse(init.body);
    return json(payload.mfa_token ? {ok:true,data:{user,token:'header-access',refresh_token:'header-refresh'}} : {ok:true,data:challenge});
  }});
  assert.equal((await root.auth.signIn({email:'e',password:'p'})).error.code,'MFA_REQUIRED');
  assert.equal((await root.auth.completeMfa({code:'backup-code'})).data.session.access_token,'header-access');
  assert.equal((await root.auth.getSession()).data.session.user.id,user.id);

  let release;
  const ordered = createClient('https://app.test',undefined,{projectId:'p',authMode:'cookie',fetch:async (url) => String(url).endsWith('/login')
    ? new Promise(resolve => { release = resolve; }) : json({ok:true})});
  const pending = ordered.auth.signIn({email:'e',password:'p'});
  await new Promise(resolve => setImmediate(resolve));
  const signedOut = ordered.auth.signOut();
  release(json(challenge));
  assert.equal((await pending).error.code,'AUTH_SUPERSEDED');
  await signedOut;
  assert.equal((await ordered.auth.completeMfa({code:'backup-code'})).error.code,'MFA_CHALLENGE_REQUIRED');

  const malformed = createClient('https://app.test',undefined,{authMode:'cookie',fetch:async () => json({user:{id:'',mfa_token:'must-not-cache'},cookie_session:true})});
  assert.equal((await malformed.auth.signIn({email:'e',password:'p'})).error.code,'INVALID_AUTH_RESPONSE');
  assert.equal((await malformed.auth.getSession()).data.session,null);
}

// The default OAuth callback exposes a usable code form over the SAME auth
// instance. A tiny hook renderer exercises component handlers without a browser.
{
  const {readFileSync,mkdtempSync,writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const ts = (await import('typescript')).default;
  const source = readFileSync(new URL('../src/auth/react.tsx',import.meta.url),'utf8');
  const component = source.slice(source.indexOf('export function AuthCallback'));
  let values=[], cursor=0, effects=[], calls=[], received;
  const ref={current:false};
  const auth = {
    async completeGoogleSignIn() { calls.push('google'); throw new AuthError('MFA required',200,'MFA_REQUIRED'); },
    async completeMfa(input) { calls.push(input); return user; },
    async resendMfaCode() { calls.push('resend'); return { sent: true, delivery: 'sent', expires_in: 240 }; },
  };
  globalThis.__callbackFixture={
    React:{createElement:(type,props,...children)=>({type,props:props??{},children})},
    AuthError,useAuth:()=>auth,useRef:()=>ref,
    useState:(initial)=>{const slot=cursor++;if(!(slot in values))values[slot]=initial;return[values[slot],v=>{values[slot]=v;}];},
    useEffect:(fn)=>{effects.push(fn);},
  };
  const oldWindow=globalThis.window;
  globalThis.window={location:{search:'?code=one-use',replace:()=>{throw new Error('onDone should handle this');}}};
  try {
    const dir=mkdtempSync(join(tmpdir(),'sdk-mfa-callback-'));
    const path=join(dir,'callback.mjs');
    writeFileSync(path,'const {React,AuthError,useAuth,useRef,useState,useEffect}=globalThis.__callbackFixture;\n'+ts.transpileModule(component,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText);
    const {AuthCallback}=await import(path);
    const render=()=>{cursor=0;return AuthCallback({onDone:u=>{received=u;}});};
    render();effects.shift()();
    await new Promise(resolve=>setImmediate(resolve));
    const form=render(); assert.equal(form.type,'form');
    const input=form.children[0].children[1];
    assert.match(form.children[0].children[0],/code we emailed you/,'the form asks for the emailed code');
    const resendButton=form.children.find((child)=>child&&child.type==='button'&&child.props.type==='button');
    resendButton.props.onClick();
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,['google','resend'],'Send a new code asks for a new code without completing anything');
    calls.splice(1);
    input.props.onChange({target:{value:'backup-code'}});
    render().props.onSubmit({preventDefault(){}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(received.id,user.id);
    assert.deepEqual(calls,['google',{code:'backup-code'}]);
    effects.at(-1)();assert.equal(calls.length,2,'strict-effect replay never exchanges proof twice');
    console.log('MFA continuation: root header/generation and default React callback PASS');
  } finally {globalThis.window=oldWindow;delete globalThis.__callbackFixture;}
}

// A legacy cookie handler's token-only response is verified using a private
// per-request bearer. A hung/late /me never installs a shared credential.
{
  const originalTimer = globalThis.setTimeout;
  let release, reads=0;
  const root = createClient('https://app.test',undefined,{projectId:'p',authMode:'cookie',headers:{'X-Fixture':'retained'},fetch:async (url,init) => {
    reads++;
    if (String(url).endsWith('/login')) return json({token:'fallback-access',refresh_token:'fallback-refresh'});
    assert.equal(init.headers.Authorization,'Bearer fallback-access');
    assert.equal(init.headers['X-Fixture'],'retained');
    return await new Promise(resolve => {release=resolve;});
  }});
  // Test the production 30s boundary without waiting 30s or changing options.
  globalThis.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms === 30_000 ? 5 : ms,...args);
  try {
    const result=await root.auth.signIn({email:'e',password:'p'});
    assert.equal(result.error.code,'AUTH_TIMEOUT');
    assert.equal((await root.auth.getSession()).data.session,null);
    const before=reads;
    assert.equal((await root.auth.updateUser({display_name:'none'})).error.code,'COOKIE_MODE_BACKEND_ROUTE_REQUIRED');
    assert.equal(reads,before,'no shared bearer adopted before /me verification');
    release(json({ok:true,data:{user}}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await root.auth.getSession()).data.session,null);
    assert.equal((await root.auth.updateUser({display_name:'none'})).error.code,'COOKIE_MODE_BACKEND_ROUTE_REQUIRED');
    assert.equal(reads,before,'late /me cannot adopt a bearer or authenticate');
    console.log('MFA continuation: hung/late legacy fallback retains caller headers and zero shared credential PASS');
  } finally {globalThis.setTimeout=originalTimer;}
}

// Email sign-in codes (tsk_8fe91eb5): the copy names the emailed code, a pending sign-in can ask for a new code, and
// the signed-in account turns codes on (enrol, verify) and off (password, then challenge_id and code) through the
// app's auth route with its own session. The route runs the runtime's sw.auth.mfa.*WithCookie with the same request.
{
  const seen = [];
  const refuse = (code, status, message) => { throw Object.assign(new Error(message), { code, status }); };
  const emailRuntime = { auth: { ...runtime.auth, mfa: {
    ...runtime.auth.mfa,
    resend: async (o) => { seen.push(['resend', o]); return { sent: true, delivery: 'sent', expires_in: 240 }; },
    enrollWithCookie: async (req) => { seen.push(['enroll', req.headers.get('cookie') ?? req.headers.get('authorization')]); return { challenge_id: 'enroll:s:1', delivery: 'sent', expires_in: 300 }; },
    verifyWithCookie: async (_req, o) => { seen.push(['verify', o]); if (o.code !== '111111') refuse('AUTH_INVALID_CREDS', 401, 'That code is not correct.'); return { enrolled: true, method: 'email' }; },
    unenrollWithCookie: async (_req, o) => { seen.push(['unenroll', o]);
      if ('password' in o && o.password === 'required-app') refuse('AUTH_MFA_REQUIRED_BY_APP', 409, 'This app requires a sign-in code for every account.');
      return 'password' in o ? { challenge_id: 'unenroll:s:1', delivery: 'sent', expires_in: 300 } : { enrolled: false }; },
  } } };
  const route = (path, body, headers = {}) => somewhereAuth(new Request(`https://app.test/api/auth${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), emailRuntime);

  // The handler's routes.
  let r = await route('/mfa/challenge', { mfa_token: 'pending-ticket', resend: true });
  assert.deepEqual([r.status, await r.json()], [200, { sent: true, delivery: 'sent', expires_in: 240 }]);
  assert.deepEqual(seen.at(-1), ['resend', { mfa_token: 'pending-ticket' }], 'resend sends only the ticket');
  assert.equal((await route('/mfa/challenge', { resend: true })).status, 400, 'resend needs the pending ticket');
  r = await route('/mfa/enroll', {}, { cookie: '__Host-sw_access_token=a' });
  assert.deepEqual(await r.json(), { challenge_id: 'enroll:s:1', delivery: 'sent', expires_in: 300 });
  assert.deepEqual(seen.at(-1), ['enroll', '__Host-sw_access_token=a'], 'the request (its own session) is what the runtime reads');
  r = await route('/mfa/verify', { challenge_id: 'enroll:s:1', code: '111111', extra: 'dropped' });
  assert.deepEqual([r.status, await r.json()], [200, { enrolled: true, method: 'email' }]);
  assert.deepEqual(seen.at(-1), ['verify', { challenge_id: 'enroll:s:1', code: '111111' }]);
  r = await route('/mfa/verify', { challenge_id: 'enroll:s:1', code: '000000' });
  assert.deepEqual([r.status, (await r.json()).error], [401, 'AUTH_INVALID_CREDS'], 'a refusal keeps the platform code and status');
  r = await route('/mfa/unenroll', { password: 'p' });
  assert.deepEqual([r.status, (await r.json()).challenge_id], [200, 'unenroll:s:1']);
  assert.deepEqual(seen.at(-1), ['unenroll', { password: 'p' }], 'step 1 sends only the password');
  r = await route('/mfa/unenroll', { challenge_id: 'unenroll:s:1', code: '222222', password: 'ignored' });
  assert.deepEqual(await r.json(), { enrolled: false });
  assert.deepEqual(seen.at(-1), ['unenroll', { challenge_id: 'unenroll:s:1', code: '222222' }], 'step 2 sends only the challenge and code');
  r = await route('/mfa/unenroll', { password: 'required-app' });
  assert.deepEqual([r.status, (await r.json()).error], [409, 'AUTH_MFA_REQUIRED_BY_APP']);
  for (const path of ['/mfa/enroll', '/mfa/verify', '/mfa/unenroll']) {
    const old = await somewhereAuth(new Request(`https://app.test/api/auth${path}`, { method: 'POST', body: '{}' }), runtime);
    assert.deepEqual([old.status, (await old.json()).error], [501, 'MFA_UNAVAILABLE'], `${path} on a runtime that predates email codes`);
  }
  const oldResend = await somewhereAuth(new Request('https://app.test/api/auth/mfa/challenge', { method: 'POST', body: JSON.stringify({ mfa_token: 't', resend: true }) }), runtime);
  assert.equal(oldResend.status, 501);

  const originalFetch2 = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => somewhereAuth(new Request(url, init), emailRuntime);
    // The browser client (createSomewhereAuth).
    const auth = createSomewhereAuth({ baseUrl: 'https://app.test', mode: 'cookie', storage: storage() });
    await assert.rejects(auth.resendMfaCode(), (e) => e.code === 'MFA_CHALLENGE_REQUIRED', 'no pending sign-in, no resend');
    await assert.rejects(auth.signIn({ email: 'e', password: 'p' }),
      (e) => e.code === 'MFA_REQUIRED' && /emailed you/.test(e.message) && !/authenticator|backup/i.test(e.message));
    assert.deepEqual(await auth.resendMfaCode(), { sent: true, delivery: 'sent', expires_in: 240 });
    assert.deepEqual(seen.at(-1), ['resend', { mfa_token: challenge.mfa_token }], 'the pending ticket stays private but is what resend uses');
    assert.equal((await auth.completeMfa({ code: 'backup-code' })).id, user.id, 'resend leaves the pending sign-in completable');
    assert.equal((await auth.enrollMfa()).challenge_id, 'enroll:s:1');
    assert.deepEqual(await auth.verifyMfaEnrollment({ challenge_id: 'enroll:s:1', code: '111111' }), { enrolled: true, method: 'email' });
    await assert.rejects(auth.verifyMfaEnrollment({ challenge_id: 'enroll:s:1', code: '000000' }), (e) => e instanceof AuthError && e.status === 401 && e.code === 'AUTH_INVALID_CREDS');
    assert.equal((await auth.unenrollMfa({ password: 'p' })).challenge_id, 'unenroll:s:1');
    assert.deepEqual(await auth.unenrollMfa({ challenge_id: 'unenroll:s:1', code: '222222' }), { enrolled: false });
    await assert.rejects(auth.unenrollMfa({ password: 'required-app' }), (e) => e.status === 409 && e.code === 'AUTH_MFA_REQUIRED_BY_APP');

    // The root client in cookie mode: the same routes through authPath.
    const root = createClient('https://app.test', undefined, { projectId: 'p', authMode: 'cookie', authPath: 'https://app.test/api/auth' });
    assert.equal((await root.auth.resendMfaCode()).error.code, 'MFA_CHALLENGE_REQUIRED');
    const pending = await root.auth.signIn({ email: 'e', password: 'p' });
    assert.ok(/emailed you/.test(pending.error.message) && !/authenticator/i.test(pending.error.message));
    assert.deepEqual((await root.auth.resendMfaCode()).data, { sent: true, delivery: 'sent', expires_in: 240 });
    assert.equal((await root.auth.enrollMfa()).data.challenge_id, 'enroll:s:1');
    assert.deepEqual((await root.auth.verifyMfaEnrollment({ challenge_id: 'enroll:s:1', code: '111111' })).data, { enrolled: true, method: 'email' });
    assert.equal((await root.auth.unenrollMfa({ password: 'p' })).data.challenge_id, 'unenroll:s:1');
    assert.deepEqual((await root.auth.unenrollMfa({ challenge_id: 'unenroll:s:1', code: '222222' })).data, { enrolled: false });
    const refused = await root.auth.unenrollMfa({ password: 'required-app' });
    assert.deepEqual([refused.status, refused.error.code], [409, 'AUTH_MFA_REQUIRED_BY_APP']);
  } finally { globalThis.fetch = originalFetch2; }

  // The root client in header mode talks to the platform directly: resend with the developer key and the project;
  // the account steps with the session token.
  const sent = [];
  const header = createClient('https://app.test', 'smt_fixture_only', { projectId: 'p', authMode: 'header', fetch: async (url, init) => {
    const payload = JSON.parse(init.body);
    sent.push({ path: new URL(url).pathname, auth: init.headers.Authorization, payload });
    if (payload.resend) return json({ ok: true, data: { sent: true, delivery: 'sent', expires_in: 200 } });
    if (payload.mfa_token) return json({ ok: true, data: { user, token: 'header-access', refresh_token: 'header-refresh' } });
    if (new URL(url).pathname.endsWith('/auth/login')) return json({ ok: true, data: challenge });
    return json({ ok: true, data: payload.password ? { challenge_id: 'unenroll:s:9', delivery: 'sent', expires_in: 300 } : payload.method ? { challenge_id: 'enroll:s:9', delivery: 'sent', expires_in: 300 } : { enrolled: !!payload.challenge_id?.startsWith('enroll') } });
  } });
  assert.equal((await header.auth.signIn({ email: 'e', password: 'p' })).error.code, 'MFA_REQUIRED');
  assert.equal((await header.auth.resendMfaCode()).data.sent, true);
  assert.deepEqual(sent.at(-1).payload, { mfa_token: challenge.mfa_token, resend: true, project_id: 'p' });
  assert.ok(sent.at(-1).path.endsWith('/auth/mfa/challenge') && sent.at(-1).auth === 'Bearer smt_fixture_only');
  assert.equal((await header.auth.completeMfa({ code: '123456' })).data.session.access_token, 'header-access');
  assert.equal((await header.auth.enrollMfa()).data.challenge_id, 'enroll:s:9');
  assert.deepEqual(sent.at(-1), { path: sent.at(-1).path, auth: 'Bearer header-access', payload: { method: 'email' } }, 'the account steps use the session token');
  assert.ok(sent.at(-1).path.endsWith('/auth/mfa/enroll'));
  assert.equal((await header.auth.unenrollMfa({ password: 'p' })).data.challenge_id, 'unenroll:s:9');
  assert.deepEqual(sent.at(-1).payload, { password: 'p' });
  await header.auth.unenrollMfa({ challenge_id: 'unenroll:s:9', code: '333333' });
  assert.deepEqual(sent.at(-1).payload, { challenge_id: 'unenroll:s:9', code: '333333' });
  console.log('MFA email codes: emailed-code copy, resend, enrol/verify, two-step unenrol, platform refusals, older runtimes, both clients and both modes PASS');
}
