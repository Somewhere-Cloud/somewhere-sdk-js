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
