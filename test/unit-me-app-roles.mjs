/**
 * GET /api/auth/me?app_roles=1 asks the runtime for the caller's own app-role names (platform
 * tables-finish slice 1, sw.auth.fromRequest(req, { appRoles: true })). Without the query the
 * session check is unchanged and asks for nothing extra; a failed role read keeps its code.
 */
import { somewhereAuth } from '@somewhere-cloud/sdk/server';

let passed = 0;
let failed = 0;
const check = (name, condition) => {
  if (condition) { passed++; process.stdout.write(`OK   ${name}\n`); }
  else { failed++; process.stdout.write(`FAIL ${name}\n`); }
};

const calls = [];
let fail = null;
const sw = { auth: { async fromRequest(_req, options) {
  calls.push(options);
  if (options && options.appRoles === true) {
    if (fail) throw fail;
    return { id: 'usr_1', appRoles: ['staff'] };
  }
  return { id: 'usr_1' };
} } };
const me = (query = '') => somewhereAuth(new Request('https://app.somewhere.site/api/auth/me' + query, { method: 'GET' }), sw);

let res = await me();
let body = await res.json();
check('plain /me: unchanged, no option passed', res.status === 200 && body.user.id === 'usr_1' && body.user.appRoles === undefined && calls.at(-1) === undefined);
res = await me('?app_roles=1');
body = await res.json();
check('/me?app_roles=1: the runtime is asked for appRoles and the user carries them', res.status === 200 && body.user.appRoles.join() === 'staff' && calls.at(-1)?.appRoles === true);
fail = Object.assign(new Error('The caller\'s app roles could not be read; nothing was assumed. Retry the request.'), { code: 'APP_ROLES_UNAVAILABLE', status: 503 });
res = await me('?app_roles=1');
body = await res.json();
check('a failed role read answers with its own code and status, never an empty role list', res.status === 503 && body.error === 'APP_ROLES_UNAVAILABLE' && body.user === undefined);
fail = Object.assign(new Error('Groups are not set up for this app yet.'), { code: 'POLICY_UNAVAILABLE', status: 503 });
res = await me('?app_roles=1');
body = await res.json();
check('a refusal keeps its code', body.error === 'POLICY_UNAVAILABLE');

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
