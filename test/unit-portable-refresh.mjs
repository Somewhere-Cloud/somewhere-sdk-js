import assert from 'node:assert/strict';
import { createSomewhereAuth } from '../dist/esm/auth/client.js';
import { somewhereAuth } from '../dist/esm/auth/server.js';
const realNow = Date.now, realFetch = globalThis.fetch;
let now = realNow(); Date.now = () => now;
const user = { id: 'alice', email: 'alice@example.test' };
const storage = () => { const map = new Map(); return { getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k) }; };
const token = (exp) => 'header.'+Buffer.from(JSON.stringify({exp:Math.floor(exp/1000)})).toString('base64url')+'.signature';
const bundle = () => ({ user, access_token:token(now+60_000),refresh_token:'refresh-'+now,expires_at:now+60_000 });
const response = b => Response.json(b);
try {
  // Header clients need no browser timer. A resumed/late request refreshes once,
  // and concurrent app requests all wait for the same refreshed pair.
  let refreshes=0, appCalls=0, release;
  globalThis.fetch=async (input,init={})=> {
    const path=new URL(String(input),'https://app.test').pathname;
    if(path.endsWith('/login'))return response(bundle());
    if(path.endsWith('/refresh')) { refreshes++; await new Promise(r=>release=r); return response(bundle()); }
    appCalls++; assert.equal(new Headers(init.headers).get('Authorization'),'Bearer '+token(now+60_000)); return response({ok:true});
  };
  const auth=createSomewhereAuth({mode:'header',storage:storage(),baseUrl:'https://app.test'});
  await auth.signIn({email:user.email,password:'test'});
  await auth.fetch('https://app.test/data'); assert.equal(refreshes,0);
  now+=61_000;
  const pending=Array.from({length:100},()=>auth.fetch('https://app.test/data'));
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(refreshes,1); assert.equal(appCalls,1,'no protected request sent while refresh is pending');
  release(); await Promise.all(pending); assert.equal(appCalls,101);assert.equal(refreshes,1);
  // Unknown outcome may have consumed a one-use refresh credential. No retry.
  now+=61_000;
  globalThis.fetch=async()=>{refreshes++;throw new TypeError('network after commit');};
  await assert.rejects(auth.fetch('https://app.test/data'));
  await assert.rejects(auth.fetch('https://app.test/data'),e=>e.code==='REFRESH_OUTCOME_UNKNOWN');
  assert.equal(refreshes,2);
  globalThis.fetch=async()=>response(bundle());
  await auth.signIn({email:user.email,password:'test'});
  await auth.fetch('https://app.test/data');assert.equal(auth.getState().status,'authenticated');

  // Cookie handshake must propagate the actual (possibly almost expired)
  // absolute expiry without exposing either credential.
  const shortExpiry=now+1000;
  const sw={auth:{loginWithCookie:async()=>({user,expires_at:shortExpiry})}};
  const login=await somewhereAuth(new Request('https://app.test/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),sw);
  const body=await login.json();assert.equal(body.expires_at,shortExpiry);assert.equal(body.cookie_session,true);
  assert.equal(body.access_token,undefined);assert.equal(body.refresh_token,undefined);
  const realTimeout=globalThis.setTimeout, realClear=globalThis.clearTimeout;
  const timers=[];
  globalThis.window={addEventListener(){}};
  globalThis.setTimeout=(fn,ms)=>{const t={fn,ms};timers.push(t);return t;};
  globalThis.clearTimeout=()=>{};
  try {
    globalThis.fetch=async()=>response(body);
    const cookie=createSomewhereAuth({mode:'cookie',storage:storage(),baseUrl:'https://app.test'});
    await cookie.signIn({email:user.email,password:'test'});
    assert.ok(timers.some(t=>t.ms===0),'one-second token is due immediately, not after 45s');
  } finally { delete globalThis.window;globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClear; }

  // Two same-origin clients serialize cookie mutations under the same Web Lock.
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let chain=Promise.resolve(),inside=0,maxInside=0;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request(_key,_opts,fn){const p=chain.then(fn);chain=p.catch(()=>{});return p;}}}});
  try {
    globalThis.fetch=async()=>{inside++;maxInside=Math.max(maxInside,inside);await Promise.resolve();inside--;return response({...body,expires_at:now+60_000});};
    const a=createSomewhereAuth({mode:'cookie',storage:storage(),baseUrl:'https://app.test'});
    const b=createSomewhereAuth({mode:'cookie',storage:storage(),baseUrl:'https://app.test'});
    await Promise.all([a.signIn({email:user.email,password:'test'}),b.signIn({email:user.email,password:'test'})]);
    assert.equal(maxInside,1);
  } finally {if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;}
  // A lost refresh response in tab A blocks replay by tab B, including a
  // page-load /me that could otherwise auto-rotate the same old cookie.
  const shared = storage(); let attempts=0;
  globalThis.fetch=async()=>response({...body,expires_at:now+60_000});
  const tabA=createSomewhereAuth({mode:'cookie',storage:shared,baseUrl:'https://app.test'});
  const tabB=createSomewhereAuth({mode:'cookie',storage:shared,baseUrl:'https://app.test'});
  await tabA.signIn({email:user.email,password:'test'});await tabB.signIn({email:user.email,password:'test'});
  now+=61_000;
  globalThis.fetch=async()=>{attempts++;throw new TypeError('response lost after rotation');};
  await assert.rejects(tabA.fetch('https://app.test/data'));
  await assert.rejects(tabB.fetch('https://app.test/data'));
  const tabC=createSomewhereAuth({mode:'cookie',storage:shared,baseUrl:'https://app.test'});
  // Tab C may reconcile, but only with a /me that cannot rotate (pfb_01e440702f31): no ride-along
  // refresh token and X-No-Auto-Refresh. It never sends /refresh or a rotating /me.
  const probes=[];
  globalThis.fetch=async(input,init={})=>{attempts++;probes.push({path:new URL(String(input),'https://app.test').pathname,headers:new Headers(init.headers)});throw new TypeError('still offline');};
  await tabC.getUser();
  assert.equal(attempts,2,'one reconciliation probe, nothing else');
  assert.equal(probes[0].path,'/api/auth/me');
  assert.equal(probes[0].headers.get('X-No-Auto-Refresh'),'1','other tabs cannot replay an uncertain rotation');
  assert.equal(probes[0].headers.get('X-Refresh-Token'),null);
  assert.equal(tabC.getState().status,'indeterminate','an unanswered probe is never a sign-out');
  assert.ok(shared.getItem('sw_auth_user:refresh-pending'),'the marker stays until the outcome is resolved');
  // Fresh sign-in is the recovery path and clears shared uncertainty.
  globalThis.fetch=async()=>response({...body,expires_at:now+60_000});
  await tabC.signIn({email:user.email,password:'test'});assert.equal(shared.getItem('sw_auth_user:refresh-pending'),null);

  const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');let q=Promise.resolve();
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request(_k,_o,fn){const p=q.then(fn);q=p.catch(()=>{});return p;}}}});
  try {
    const restoredStorage=storage();restoredStorage.setItem('sw_auth_user',JSON.stringify(user));
    const one=createSomewhereAuth({mode:'cookie',storage:restoredStorage,baseUrl:'https://app.test'});
    const two=createSomewhereAuth({mode:'cookie',storage:restoredStorage,baseUrl:'https://app.test'});
    let active=0,max=0;
    globalThis.fetch=async()=>{active++;max=Math.max(max,active);await Promise.resolve();active--;return new Response(JSON.stringify({user}),{headers:{'X-Sw-Access-Expires':String(now+60_000)}});};
    await Promise.all([one.getUser(),two.getUser()]);assert.equal(max,1,'page restore checks serialize potential cookie rotation');
  } finally { if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator; }
  // A timed-out /me must not clear a newer operation's pending marker when
  // an uncooperative transport finally resolves after its lock was released.
  const lateStore=storage();let answerLate;
  globalThis.fetch=async()=>new Promise(r=>answerLate=r);
  const lateClient=createSomewhereAuth({mode:'cookie',storage:lateStore,baseUrl:'https://app.test',mutationTimeoutMs:20});
  await lateClient.getUser();
  globalThis.fetch=async()=>response({...body,expires_at:now+60_000});
  await lateClient.signIn({email:user.email,password:'test'});
  lateStore.setItem('sw_auth_user:refresh-pending','newer-operation');
  answerLate(new Response(JSON.stringify({user}),{headers:{'X-Sw-Access-Expires':String(now+1000)}}));
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(lateStore.getItem('sw_auth_user:refresh-pending'),'newer-operation');
  console.log('PASS portable refresh: actual expiry, cookie privacy, nonbrowser deadline, 100-request single flight, unknown outcome no replay, cross-tab mutation lock.');
} finally { Date.now=realNow;globalThis.fetch=realFetch; }
