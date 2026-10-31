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
  // A refresh lost to the network is a failed request; the next request tries again.
  now+=61_000;
  globalThis.fetch=async()=>{refreshes++;throw new TypeError('network after commit');};
  await assert.rejects(auth.fetch('https://app.test/data'));
  await assert.rejects(auth.fetch('https://app.test/data'),e=>e instanceof TypeError);
  assert.equal(refreshes,3);
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
  console.log('PASS portable refresh: actual expiry, cookie privacy, nonbrowser deadline, 100-request single flight, a lost refresh is tried again.');
} finally { Date.now=realNow;globalThis.fetch=realFetch; }
