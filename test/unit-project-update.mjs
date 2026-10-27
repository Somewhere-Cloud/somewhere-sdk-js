import assert from 'node:assert/strict';
import {Somewhere,SomewhereError} from '../dist/esm/index.js';
const calls=[];let reply={status:200,body:{ok:true,data:{updated:true,analytics_consent:{mode:'required',policy_version:'v1'}}}};
const fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(reply.body),{status:reply.status,headers:{'Content-Type':'application/json'}});};
const sw=new Somewhere({key:'smt_test',projectId:'my-app',fetch});
const settings={analytics_consent:{mode:'required',policy_version:'v1'}};
const result=await sw.projects.update(settings);
assert.equal(calls[0].url,'https://api.somewhere.cloud/v1/projects/my-app');assert.equal(calls[0].init.method,'PATCH');assert.equal(calls[0].init.headers.Authorization,'Bearer smt_test');assert.deepEqual(JSON.parse(calls[0].init.body),settings);assert.deepEqual(result.data,reply.body.data);assert.equal(result.error,null);
await sw.projects.update({analytics_consent:{mode:'off',policy_version:'v2'}},'other/ space-é');assert(calls[1].url.endsWith('/projects/other%2F%20space-%C3%A9'));assert.equal(JSON.parse(calls[1].init.body).analytics_consent.mode,'off');
for(const code of ['VALIDATION_ERROR','FORBIDDEN']){reply={status:code==='FORBIDDEN'?403:400,body:{ok:false,error:code,message:'Policy refused'}};const res=await sw.projects.update(settings);assert(res.error instanceof SomewhereError);assert.equal(res.error.code,code);assert.equal(res.status,reply.status);assert.equal(res.data,null);}
for(const pid of [undefined,'']){const before=calls.length;const missing=new Somewhere({key:'smt_test',fetch});await assert.rejects(missing.projects.update(settings,pid),/requires a projectId/);assert.equal(calls.length,before);}
const before=calls.length;await assert.rejects(sw.projects.update(settings,''),/requires a projectId/);assert.equal(calls.length,before,'empty explicit ID must not fall back');
const tokenOnly=new Somewhere({token:'eyJ.token',projectId:'my-app',fetch});const denied=await tokenOnly.projects.update(settings);assert(denied.error instanceof SomewhereError);assert.equal(denied.error.code,'INVALID_API_KEY');assert.equal(calls.length,before);
console.log('PASS project update: exact PATCH/policy/developer auth, default/encoded override, Result errors, missing/empty IDs and app-user refusal before network.');
