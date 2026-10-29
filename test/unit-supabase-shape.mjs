// Pure, no-network unit tests for the Supabase-shape surface added in v0.4.0:
// createClient, projectIdFromUrl, functions.invoke, auth.onAuthStateChange.
// Runs against the built ESM in dist/esm. No SMT_KEY / network required.
//
//   npm run build && node test/unit-supabase-shape.mjs

import {
  Somewhere,
  createClient,
  projectIdFromUrl,
} from '../dist/esm/index.js';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}
async function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(`${name} (got ${a})`, a === e);
}

/** A fetch double that records the last request and replies with a canned body. */
function recorder(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let parsedBody = null;
    if (typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method: init.method, headers: init.headers, body: parsedBody });
    const r = responder ? responder(url, init) : { status: 200, json: { ok: true, data: [] } };
    return new Response(r.body ?? JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

async function main() {
  /* ── projectIdFromUrl ──────────────────────────────────────────── */
  console.log('projectIdFromUrl');
  await eq('subdomain', projectIdFromUrl('https://booking-app.somewhere.tech'), 'booking-app');
  await eq('trailing path', projectIdFromUrl('https://booking-app.somewhere.tech/x'), 'booking-app');
  await eq('api host → undefined', projectIdFromUrl('https://api.somewhere.tech'), undefined);
  await eq('www → undefined', projectIdFromUrl('https://www.somewhere.tech'), undefined);
  await eq('custom domain → undefined', projectIdFromUrl('https://tagthewall.com'), undefined);
  await eq('garbage → undefined', projectIdFromUrl('not a url'), undefined);

  /* ── createClient: shape + key/token detection ─────────────────── */
  console.log('createClient');
  const c1 = createClient('https://demo.somewhere.tech', 'eyJ.jwt.token');
  check('returns a Somewhere instance', c1 instanceof Somewhere);
  check('has .from', typeof c1.from === 'function');
  check('has .auth', !!c1.auth);
  check('has .storage', !!c1.storage);
  check('has .functions.invoke', typeof c1.functions?.invoke === 'function');

  /* ── from().select().eq() builds the structured /db/query body ──── */
  console.log('from().select() body');
  {
    const rec = recorder(() => ({ json: { ok: true, data: [{ id: 1 }] } }));
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt', { fetch: rec.fetchImpl });
    const res = await sw.from('todos').select('*').eq('user_id', 5);
    const call = rec.calls.at(-1);
    check('hits /v1/db/query', call.url.endsWith('/v1/db/query'));
    check('method POST', call.method === 'POST');
    await eq('body.table', call.body.table, 'todos');
    await eq('body.select', call.body.select, '*');
    await eq('body.project_id (derived)', call.body.project_id, 'demo');
    await eq('body.filters', call.body.filters, [{ column: 'user_id', op: 'eq', value: 5 }]);
    check('result is {data,error}', res.error === null && Array.isArray(res.data));
  }

  /* ── functions.invoke: URL, host, auth header, body ────────────── */
  console.log('functions.invoke');
  {
    const rec = recorder(() => ({ json: { ok: true, plan: 'pro' } }));
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt', { fetch: rec.fetchImpl });
    const res = await sw.functions.invoke('checkout', { body: { plan: 'pro' } });
    const call = rec.calls.at(-1);
    await eq('hits project /api/{name}', call.url, 'https://demo.somewhere.tech/api/checkout');
    check('method POST', call.method === 'POST');
    check('Authorization carries the token', call.headers.Authorization === 'Bearer eyJ.jwt');
    check('content-type json', call.headers['Content-Type'] === 'application/json');
    await eq('json body forwarded', call.body, { plan: 'pro' });
    check('returns {data,error}', res.error === null && res.data.plan === 'pro');
  }
  {
    // a slug projectId is not a host: refused before any request
    const rec = recorder(() => ({ json: { ok: true } }));
    const sw = new Somewhere({ key: 'smt_x', projectId: 'myapp', fetch: rec.fetchImpl });
    const res = await sw.functions.invoke('hello');
    check('slug projectId → NO_FUNCTION_HOST, no request', res.error?.code === 'NO_FUNCTION_HOST' && rec.calls.length === 0);
  }
  {
    // a UUID projectId can't become a host → loud NO_FUNCTION_HOST
    const sw = new Somewhere({ key: 'smt_x', projectId: '11111111-2222-3333-4444-555555555555' });
    const res = await sw.functions.invoke('hello');
    check('UUID host → NO_FUNCTION_HOST error', res.data === null && res.error?.code === 'NO_FUNCTION_HOST');
  }
  {
    // non-2xx → error, data null
    const rec = recorder(() => ({ status: 500, json: { error: 'BOOM', message: 'kaboom' } }));
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt', { fetch: rec.fetchImpl });
    const res = await sw.functions.invoke('explode');
    check('5xx → {data:null,error}', res.data === null && res.error?.code === 'BOOM' && res.error?.statusCode === 500);
  }

  /* ── auth.onAuthStateChange ────────────────────────────────────── */
  console.log('auth.onAuthStateChange');
  {
    const rec = recorder((url) => {
      if (url.endsWith('/auth/login')) {
        return { json: { ok: true, data: { user: { id: 'u1', email: 'a@b.c' }, token: 'jwt2', refresh_token: 'r', session_token: 's' } } };
      }
      return { json: { ok: true, data: {} } };
    });
    // developer key — /auth/login is developer-gated on the platform
    const sw = new Somewhere({ key: 'smt_dev', projectId: 'demo', fetch: rec.fetchImpl });
    const events = [];
    const { data: { subscription } } = sw.auth.onAuthStateChange((event) => events.push(event));
    await new Promise((r) => setTimeout(r, 0)); // let INITIAL_SESSION microtask flush
    check('INITIAL_SESSION fires on subscribe', events[0] === 'INITIAL_SESSION');
    const login = await sw.auth.signInWithPassword({ email: 'a@b.c', password: 'pw' });
    check('signIn ok', login.error === null && login.data.user.id === 'u1');
    check('SIGNED_IN fired', events.includes('SIGNED_IN'));
    await sw.auth.signOut();
    check('SIGNED_OUT fired', events.includes('SIGNED_OUT'));
    subscription.unsubscribe();
    const before = events.length;
    await sw.auth.signInWithPassword({ email: 'a@b.c', password: 'pw' });
    check('no events after unsubscribe', events.length === before);
  }

  /* ── rpc(name, args) → functions.invoke ────────────────────────── */
  console.log('rpc');
  {
    const rec = recorder(() => ({ json: { ok: true, total: 42 } }));
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt', { fetch: rec.fetchImpl });
    const res = await sw.rpc('compute_total', { user_id: 5 });
    const call = rec.calls.at(-1);
    await eq('rpc hits /api/{name}', call.url, 'https://demo.somewhere.tech/api/compute_total');
    await eq('rpc forwards args as body', call.body, { user_id: 5 });
    check('rpc returns {data,error}', res.error === null && res.data.total === 42);
  }

  /* ── .or() builds an or-group filter ───────────────────────────── */
  console.log('from().or()');
  {
    const rec = recorder(() => ({ json: { ok: true, data: [] } }));
    const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt', { fetch: rec.fetchImpl });
    await sw.from('todos').select('*').or('status.eq.active,priority.gt.3,tag.in.(a,b)').eq('user_id', 5);
    const body = rec.calls.at(-1).body;
    const orFilter = body.filters.find((f) => f.op === 'or');
    check('or filter present', !!orFilter);
    await eq('or subs parsed + coerced', orFilter.value, [
      { column: 'status', op: 'eq', value: 'active' },
      { column: 'priority', op: 'gt', value: 3 },
      { column: 'tag', op: 'in', value: ['a', 'b'] },
    ]);
    check('and-ed eq still present', body.filters.some((f) => f.column === 'user_id' && f.op === 'eq'));
  }

  console.log('');
  if (failures > 0) {
    console.error(`❌ ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('✅ all Supabase-shape unit tests passed');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
