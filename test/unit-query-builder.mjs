// Pure, no-network unit tests for the query-builder parity work
//: count modes (exact + head), nested FK select (now
// resolved server-side — the SDK sends the select verbatim and the worker
// returns nested rows), and single() / maybeSingle().
//
//   npm run build && node test/unit-query-builder.mjs

import { createClient } from '../dist/esm/index.js';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}
function eq(name, actual, expected) {
  check(`${name} (got ${JSON.stringify(actual)})`, JSON.stringify(actual) === JSON.stringify(expected));
}

/** A fetch double whose responder sees the parsed request body. */
function makeClient(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let body = null;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method: init.method, body });
    const r = responder(body, url) ?? { json: { ok: true, data: [] } };
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt', { fetch: fetchImpl });
  return { sw, calls };
}
/** The platform wraps payloads as { ok, data: <payload> }; the SDK unwraps .data. */
const reply = (payload) => ({ json: { ok: true, data: payload } });

async function main() {
  /* ── count: 'exact' returns the total alongside the page ───────────── */
  console.log("select('*', { count: 'exact' })");
  {
    const { sw, calls } = makeClient((body) =>
      body.table === 'todos' ? reply({ data: [{ id: 1 }, { id: 2 }], error: null, count: 42 }) : reply({ data: [] }));
    const res = await sw.from('todos').select('*', { count: 'exact' }).eq('done', false).limit(2);
    const body = calls.at(-1).body;
    eq('body.count', body.count, 'exact');
    check('body has no head', body.head === undefined);
    check('body has no single (resolveType many)', body.single === undefined);
    eq('data is the page', res.data, [{ id: 1 }, { id: 2 }]);
    eq('count is the server total (not page len)', res.count, 42);
    check('no error', res.error === null);
  }

  /* ── count + head: count only, no rows ─────────────────────────────── */
  console.log("select('*', { count: 'exact', head: true })");
  {
    const { sw, calls } = makeClient((body) =>
      body.table === 'todos' ? reply({ data: [], error: null, count: 42 }) : reply({ data: [] }));
    const res = await sw.from('todos').select('*', { count: 'exact', head: true }).eq('done', false);
    const body = calls.at(-1).body;
    eq('body.count', body.count, 'exact');
    eq('body.head', body.head, true);
    check('data is null on head', res.data === null);
    eq('count present on head', res.count, 42);
  }

  /* ── nested select is delegated to the server (one query, verbatim) ── */
  console.log("select('*, customer(*)') — delegated, returned nested");
  {
    const nested = [
      { id: 1, customer_id: 10, total: 99, customer: { id: 10, name: 'Ann' } },
      { id: 2, customer_id: 11, total: 50, customer: { id: 11, name: 'Bob' } },
    ];
    const { sw, calls } = makeClient((body) =>
      body.table === 'orders' ? reply({ data: nested, error: null, count: 2 }) : reply({ data: [] }));
    const res = await sw.from('orders').select('*, customer(*)');
    eq('select sent verbatim (embeds NOT stripped)', calls.at(-1).body.select, '*, customer(*)');
    check('exactly one network call (no client-side embed fetches)', calls.length === 1);
    eq('nested rows passed through as-is', res.data, nested);
  }

  console.log("select('*, posts(id, title)') — has-many delegated");
  {
    const nested = [{ id: 1, name: 'A', posts: [{ id: 11, title: 'x' }] }];
    const { sw, calls } = makeClient((body) =>
      body.table === 'users' ? reply({ data: nested }) : reply({ data: [] }));
    const res = await sw.from('users').select('*, posts(id, title)');
    eq('select verbatim', calls.at(-1).body.select, '*, posts(id, title)');
    check('one call', calls.length === 1);
    eq('arrays passed through', res.data, nested);
  }

  console.log("select('id, buyer:customer(name)') — alias delegated");
  {
    const { sw, calls } = makeClient((body) =>
      body.table === 'orders' ? reply({ data: [{ id: 1, buyer: { name: 'Ann' } }] }) : reply({ data: [] }));
    const res = await sw.from('orders').select('id, buyer:customer(name)');
    eq('alias select verbatim', calls.at(-1).body.select, 'id, buyer:customer(name)');
    eq('aliased embed passed through', res.data, [{ id: 1, buyer: { name: 'Ann' } }]);
  }

  /* ── single() — sends the LIMIT-2 hint + shapes the result ─────────── */
  console.log('single()');
  {
    const one = makeClient(() => reply({ data: [{ id: 7, name: 'X' }] }));
    const r1 = await one.sw.from('t').select('*').eq('id', 7).single();
    eq('body.single hint sent', one.calls.at(-1).body.single, true);
    eq('one row → the object', r1.data, { id: 7, name: 'X' });
    check('no error', r1.error === null);

    const zero = makeClient(() => reply({ data: [] }));
    const r0 = await zero.sw.from('t').select('*').eq('id', 999).single();
    check('zero rows → PGRST116 error', r0.data === null && r0.error?.code === 'PGRST116');

    const many = makeClient(() => reply({ data: [{ id: 1 }, { id: 2 }] }));
    const rm = await many.sw.from('t').select('*').single();
    check('>1 row → PGRST116 error', rm.data === null && rm.error?.code === 'PGRST116');
  }

  /* ── maybeSingle() ─────────────────────────────────────────────────── */
  console.log('maybeSingle()');
  {
    const zero = makeClient(() => reply({ data: [] }));
    const r0 = await zero.sw.from('t').select('*').eq('id', 999).maybeSingle();
    eq('body.single hint sent', zero.calls.at(-1).body.single, true);
    check('zero rows → data null, no error', r0.data === null && r0.error === null);

    const one = makeClient(() => reply({ data: [{ id: 7 }] }));
    const r1 = await one.sw.from('t').select('*').eq('id', 7).maybeSingle();
    eq('one row → the object', r1.data, { id: 7 });
  }

  console.log('');
  if (failures > 0) {
    console.error(`❌ ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('✅ all query-builder parity unit tests passed');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
