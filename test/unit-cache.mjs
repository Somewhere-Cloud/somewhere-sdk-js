// Pure, no-network unit tests for the DEFAULT-ON client query cache
// ( — productize prong A, "platform intelligence"). Covers:
// request dedup, ~1s staleTime cache, invalidate-on-write, the `.fresh()`
// + `cache:false` opt-outs, prefetch warming, cache-key isolation, and the
// no-shared-mutation guarantee. Executes current TypeScript source in memory;
// no credentials or network required. Source mode requires Node registerHooks.
// Pass --built to verify the emitted package with the same behavioral cases.
//
//   node test/unit-cache.mjs

import assert from 'node:assert/strict';
const built = process.argv.includes('--built');
if (!built) await import('./source-loader.mjs');
const { createClient, QueryCache, SomewhereQueryBuilder, SomewhereError } = await import(built ? '../dist/esm/index.js' : '../src/index.ts');
const { Client } = await import(built ? '../dist/esm/client.js' : '../src/client.ts');

const URL_ = 'https://demo.somewhere.tech';
const TOKEN = 'eyJ.jwt.token';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

/**
 * A fetch double for `POST /v1/db/query`. Counts how many times the network
 * was actually hit, distinguishes reads (body has `select`) from writes, and
 * can stall each response by `delayMs` so concurrency (dedup) is observable.
 */
function dbRecorder({ rows = [{ id: 1, name: 'A' }], delayMs = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init.method, body });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    // The real /db/query envelope is double-nested: the outer `data` is the
    // platform `{ok,data}` envelope, the inner `data` is the query payload.
    return new Response(
      JSON.stringify({ ok: true, data: { data: rows, count: rows.length } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const isQuery = (c) => c.method === 'POST' && c.url.endsWith('/v1/db/query');
  // A "read" is a select query; writes carry insert/update/upsert/delete keys.
  const readCount = () => calls.filter((c) => isQuery(c) && c.body && 'select' in c.body).length;
  return { fetchImpl, calls, readCount };
}

function client(opts) {
  const rec = dbRecorder(opts?.recorder);
  const sw = createClient(URL_, TOKEN, { fetch: rec.fetchImpl, ...opts?.create });
  return { sw, rec };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Explicit response gates make overlap and completion ordering deterministic.
function gatedDb() {
  const reads = [];
  let failWrite = false;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!('select' in body)) {
      return Response.json(failWrite
        ? { ok: false, error: 'TEST_WRITE', message: 'Synthetic write failure' }
        : { ok: true, data: { data: [] } }, { status: failWrite ? 400 : 200 });
    }
    const gate = deferred();
    reads.push({ body, authorization: init.headers.Authorization, ...gate });
    return gate.promise;
  };
  const release = (index, label = 'current') => {
    const read = reads[index];
    const counts = { exact: 11, planned: 12, estimated: 13 };
    read.resolve(Response.json({ ok: true, data: {
      data: read.body.head ? [] : [{ id: 1, name: label }],
      ...(read.body.count ? { count: counts[read.body.count] } : {}),
    } }));
  };
  return { fetchImpl, reads, release, failWrites() { failWrite = true; } };
}

async function regressionTests() {
  console.log('request shape isolation, in both completion orders');
  const variants = [undefined, 'exact', 'planned', 'estimated']
    .flatMap((count) => [false, true].map((head) => ({ count, head })));
  for (const reverse of [false, true]) {
    const rec = gatedDb();
    const sw = createClient(URL_, TOKEN, { fetch: rec.fetchImpl });
    const pending = variants.map((options) => sw.from('items').select('*', options).then((r) => r));
    assert.equal(rec.reads.length, variants.length, 'every count/head combination has its own flight');
    const order = variants.map((_, i) => i);
    if (reverse) order.reverse();
    for (const i of order) rec.release(i);
    const results = await Promise.all(pending);
    for (const [i, options] of variants.entries()) {
      const expected = { exact: 11, planned: 12, estimated: 13 }[options.count] ?? (options.head ? null : 1);
      assert.equal(results[i].count, expected);
      assert.deepEqual(results[i].data, options.head ? null : [{ id: 1, name: 'current' }]);
      assert.deepEqual(await sw.from('items').select('*', options), results[i]);
    }
    assert.equal(rec.reads.length, variants.length, 'settled shapes remain separately cached');
  }

  console.log('post-write reads and older completion cleanup');
  for (const action of ['insert', 'update', 'upsert', 'delete']) {
    for (const oldFirst of [false, true]) {
      for (const fresh of [false, true]) {
        const rec = gatedDb();
        const sw = createClient(URL_, TOKEN, { fetch: rec.fetchImpl });
        let builder = sw.from('items').select('*');
        if (fresh) builder = builder.fresh();
        const old = builder.then((r) => r);
        const write = await sw.from('items')[action]({ name: 'new' });
        assert.equal(write.error, null);
        const current = sw.from('items').select('*').then((r) => r);
        assert.equal(rec.reads.length, 2, `${action}: post-write read starts a new flight`);
        let joined;
        if (oldFirst) {
          rec.release(0, 'old');
          assert.equal((await old).data[0].name, 'old');
          joined = sw.from('items').select('*').then((r) => r);
          assert.equal(rec.reads.length, 2, 'old cleanup preserves the new flight');
          rec.release(1, 'new');
        } else {
          rec.release(1, 'new');
          await current;
          rec.release(0, 'old');
          await old;
        }
        const result = await current;
        assert.equal(result.data[0].name, 'new');
        if (joined) {
          const copy = await joined;
          result.data[0].name = 'caller mutation';
          assert.equal(copy.data[0].name, 'new', 'coalesced callers receive isolated copies');
        }
        assert.equal((await sw.from('items').select('*')).data[0].name, 'new');
        assert.equal(rec.reads.length, 2, 'old completion cannot replace the new cached value');
      }
    }
  }

  console.log('fresh reads bypass dedup; unrelated writes preserve pending reads');
  {
    const rec = gatedDb();
    const sw = createClient(URL_, TOKEN, { fetch: rec.fetchImpl });
    const normal = sw.from('items').select('*').then((r) => r);
    const fresh = sw.from('items').select('*').fresh().then((r) => r);
    const otherFresh = sw.from('items').select('*').fresh().then((r) => r);
    assert.equal(rec.reads.length, 3, 'each concurrent fresh read always fetches');
    await sw.from('other_items').insert({ id: 2 });
    rec.release(1);
    rec.release(2);
    await Promise.all([fresh, otherFresh]);
    // A separate filter checks pending invalidation without a warmed cache hit.
    const filtered = sw.from('items').select('*').eq('id', 3).then((r) => r);
    await sw.from('other_items').insert({ id: 3 });
    const joined = sw.from('items').select('*').eq('id', 3).then((r) => r);
    assert.equal(rec.reads.length, 4, 'unrelated write leaves the pending flight intact');
    rec.release(0);
    rec.release(3);
    await Promise.all([normal, filtered, joined]);
  }

  console.log('failed writes retain current cache generation');
  {
    const rec = gatedDb();
    const sw = createClient(URL_, TOKEN, { fetch: rec.fetchImpl });
    const pending = sw.from('items').select('*').then((r) => r);
    rec.failWrites();
    assert.notEqual((await sw.from('items').insert({ id: 2 })).error, null);
    const joined = sw.from('items').select('*').then((r) => r);
    assert.equal(rec.reads.length, 1);
    rec.release(0);
    await Promise.all([pending, joined]);
    await sw.from('items').select('*');
    assert.equal(rec.reads.length, 1);
  }

  console.log('explicit session transitions clear entries and pending generations');
  for (const transition of ['set', 'clear']) {
    for (const oldFirst of [false, true]) {
      for (const fresh of [false, true]) {
        const rec = gatedDb();
        const client = new Client({ baseUrl: URL_, token: TOKEN, fetch: rec.fetchImpl });
        client.setSessionToken('synthetic-session-a');
        const query = () => new SomewhereQueryBuilder(client, 'items').select('*');
        const old = (fresh ? query().fresh() : query()).then((r) => r);
        if (transition === 'set') client.setSessionToken('synthetic-session-b');
        else client.clearSession();
        const current = query().then((r) => r);
        assert.equal(rec.reads.length, 2, 'session transition starts a new flight');
        assert.equal(rec.reads[1].authorization, `Bearer ${transition === 'set' ? 'synthetic-session-b' : TOKEN}`);
        if (oldFirst) {
          rec.release(0, 'previous');
          await old;
          const joined = query().then((r) => r);
          assert.equal(rec.reads.length, 2);
          rec.release(1, 'current');
          await joined;
        } else {
          rec.release(1, 'current');
          await current;
          rec.release(0, 'previous');
          await old;
        }
        assert.equal((await current).data[0].name, 'current');
        assert.equal((await query()).data[0].name, 'current');
        assert.equal(rec.reads.length, 2);
        if (transition === 'set') client.setSessionToken('synthetic-session-c');
        else client.clearSession();
        const afterCachedTransition = query().then((r) => r);
        assert.equal(rec.reads.length, 3, 'session transition also drops settled entries');
        rec.release(2, 'latest');
        assert.equal((await afterCachedTransition).data[0].name, 'latest');
      }
    }
  }

  console.log('cache errors, rejected flights, expiry, and clear before first invalidation');
  const success = (name) => ({ data: [{ name }], error: null, status: 200 });
  for (const reject of [false, true]) {
    const cache = new QueryCache();
    const gate = deferred();
    const old = cache.read('k', 'items', () => gate.promise);
    const oldObserved = old.catch((err) => err);
    cache.invalidate('items');
    const newerGate = deferred();
    const newer = cache.read('k', 'items', () => newerGate.promise);
    const error = new SomewhereError({ code: 'TEST', message: 'Synthetic failure', statusCode: 400 });
    if (reject) gate.reject(error);
    else gate.resolve({ data: null, error, status: 400 });
    await oldObserved;
    let unexpected = 0;
    const joined = cache.read('k', 'items', async () => { unexpected++; return success('unexpected'); });
    assert.equal(unexpected, 0, 'failed old flight cannot remove a newer one');
    newerGate.resolve(success('new'));
    await Promise.all([newer, joined]);
    const failing = cache.read('failure', 'items', () => reject ? Promise.reject(error) : Promise.resolve({ data: null, error, status: 400 }));
    await failing.catch(() => {});
    assert.deepEqual(await cache.read('failure', 'items', async () => success('retry')), success('retry'));
  }
  {
    let now = 0;
    const cache = new QueryCache({ staleTime: 10 }, () => now);
    const oldGate = deferred();
    const old = cache.read('k', 'untouched', () => oldGate.promise);
    cache.clear();
    assert.deepEqual(await cache.read('k', 'untouched', async () => success('new')), success('new'));
    oldGate.resolve(success('old'));
    await old;
    assert.deepEqual(await cache.read('k', 'untouched', async () => success('wrong')), success('new'));
    now = 10;
    assert.deepEqual(await cache.read('k', 'untouched', async () => success('expired')), success('expired'));
  }
  {
    const { sw } = client();
    const result = await sw.from('items').select('*').fresh();
    result.data[0].name = 'caller mutation';
    assert.equal((await sw.from('items').select('*')).data[0].name, 'A', 'fresh cache warming isolates copies');
  }
  check('all deterministic cache contract regressions', true);
}

async function main() {
  /* ── dedup: two concurrent awaits of the same query share one fetch ── */
  console.log('request dedup (always on)');
  {
    const { sw, rec } = client({ recorder: { delayMs: 20 } });
    const [a, b] = await Promise.all([
      sw.from('todos').select('*').eq('user_id', 5),
      sw.from('todos').select('*').eq('user_id', 5),
    ]);
    check('2 concurrent identical awaits → 1 fetch', rec.readCount() === 1);
    check('both awaits resolve with data', Array.isArray(a.data) && Array.isArray(b.data));
  }

  /* ── staleTime: a repeat read within the window is served from cache ── */
  console.log('staleTime cache');
  {
    const { sw, rec } = client({ create: { cache: { staleTime: 5000 } } });
    await sw.from('todos').select('*').eq('id', 1);
    await sw.from('todos').select('*').eq('id', 1);
    check('repeat read within staleTime → 1 fetch', rec.readCount() === 1);
  }
  {
    // default-on: no cache option at all still caches (within the 1s default)
    const { sw, rec } = client();
    await sw.from('todos').select('*').eq('id', 1);
    await sw.from('todos').select('*').eq('id', 1);
    check('cache DEFAULT-ON: repeat read → 1 fetch', rec.readCount() === 1);
  }
  {
    // distinct filters are distinct cache keys — must not collide
    const { sw, rec } = client({ create: { cache: { staleTime: 5000 } } });
    await sw.from('todos').select('*').eq('id', 1);
    await sw.from('todos').select('*').eq('id', 2);
    check('distinct filters → distinct keys → 2 fetches', rec.readCount() === 2);
  }

  /* ── invalidate-on-write: a write clears the table so the next read is fresh ── */
  console.log('invalidate-on-write');
  {
    const { sw, rec } = client({ create: { cache: { staleTime: 5000 } } });
    await sw.from('users').select('*');
    await sw.from('users').insert({ name: 'B' });
    await sw.from('users').select('*');
    check('write then read → fresh fetch (2 reads despite staleTime)', rec.readCount() === 2);
  }
  {
    // a write to a DIFFERENT table must NOT invalidate an unrelated cache entry
    const { sw, rec } = client({ create: { cache: { staleTime: 5000 } } });
    await sw.from('users').select('*');
    await sw.from('posts').insert({ title: 'X' });
    await sw.from('users').select('*');
    check('write to other table leaves cache intact → 1 read', rec.readCount() === 1);
  }

  /* ── opt-out level 1: createClient({ cache: false }) always fetches ── */
  console.log('opt-out: cache:false');
  {
    const { sw, rec } = client({ create: { cache: false } });
    await sw.from('todos').select('*').eq('id', 1);
    await sw.from('todos').select('*').eq('id', 1);
    check('cache:false → every read fetches (2)', rec.readCount() === 2);
  }

  /* ── opt-out level 2: per-query .fresh() bypasses the cache ── */
  console.log('opt-out: .fresh()');
  {
    const { sw, rec } = client({ create: { cache: { staleTime: 5000 } } });
    await sw.from('todos').select('*').eq('id', 1).fresh();
    await sw.from('todos').select('*').eq('id', 1).fresh();
    check('.fresh() → every read fetches (2)', rec.readCount() === 2);
  }
  {
    // .fresh() still warms the cache for subsequent NORMAL reads
    const { sw, rec } = client({ create: { cache: { staleTime: 5000 } } });
    await sw.from('todos').select('*').eq('id', 1).fresh(); // 1 fetch, warms cache
    await sw.from('todos').select('*').eq('id', 1); // cache hit → no fetch
    check('.fresh() warms cache → following normal read is a hit (1 fetch total)', rec.readCount() === 1);
  }

  /* ── prefetch: warm the cache ahead of need ── */
  console.log('prefetch');
  {
    const { sw, rec } = client({ create: { cache: { staleTime: 5000 } } });
    await sw.prefetch(sw.from('todos').select('*').eq('id', 7));
    const res = await sw.from('todos').select('*').eq('id', 7);
    check('prefetch warms cache → later read served from cache (1 fetch)', rec.readCount() === 1);
    check('prefetched read returns data', Array.isArray(res.data));
  }

  /* ── isolation: a cache hit must hand back a copy, not the stored object ── */
  console.log('no shared-mutation poisoning');
  {
    const { sw, rec } = client({
      recorder: { rows: [{ id: 1, name: 'A' }] },
      create: { cache: { staleTime: 5000 } },
    });
    const r1 = await sw.from('todos').select('*');
    r1.data[0].name = 'MUTATED';
    const r2 = await sw.from('todos').select('*');
    check('cache hit is isolated from caller mutation', r2.data[0].name === 'A');
    check('the mutation test stayed a cache hit (1 fetch)', rec.readCount() === 1);
  }

  await regressionTests();

  console.log('');
  if (failures > 0) {
    console.error(`❌ ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('✅ all cache unit tests passed');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
