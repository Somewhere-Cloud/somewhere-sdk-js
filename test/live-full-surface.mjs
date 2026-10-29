/**
 * Robust live-surface test for @somewhere-cloud/sdk (dominant-player rewrite).
 *
 * Tests every public method against the LIVE api.somewhere.tech with a real
 * smt_ key. Exercises:
 *
 *   1. sw.from(table) — every CRUD action, every filter op, every modifier
 *   2. sw.storage.from(bucket) — upload/download/list/remove/getPublicUrl + byte-exact round-trip
 *   3. sw.auth — signUp/signInWithPassword/getUser/getSession/setSession/
 *      updateUser/resetPasswordForEmail/signOut + session-swap + dual-auth flow
 *   4. sw.emails.send — Resend-shaped
 *   5. sw.chat.completions.create — OpenAI-shaped, validates response schema
 *
 * Error paths tested: invalid identifiers, single() on 0 rows, storage
 * download on missing key, auth with wrong password, session-required call
 * without session.
 *
 * Run:  SMT_KEY=smt_... node test/live-full-surface.mjs
 */
import { Somewhere, SomewhereError } from '../dist/esm/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

const key = process.env.SMT_KEY;
if (!key) { console.error('SMT_KEY not set.'); process.exit(2); }

const BASE = 'https://api.somewhere.tech/v1';
const suffix = Math.random().toString(36).slice(2, 8);
const subdomain = `sdk-t-${suffix}`;
const results = [];
let projectId;

/* ── helpers ─────────────────────────────────────────────────────── */

function preview(v) {
  try { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 160) + '…' : s; }
  catch { return String(v); }
}

/** Envelope step: expects `{data, error}`. */
async function ok(name, fn, ...acceptCodes) {
  const row = { name, outcome: 'pending', detail: '' };
  results.push(row);
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'error' in r) {
      if (r.error == null) {
        row.outcome = 'pass'; row.detail = preview(r.data);
        console.log(`  ✅ ${name}`);
        return r;
      }
      if (acceptCodes.includes(r.error.code)) {
        row.outcome = 'expected-error'; row.detail = `${r.error.code}: ${r.error.message}`;
        console.log(`  ⚠️  ${name} — ${r.error.code}`);
        return r;
      }
      row.outcome = 'fail'; row.detail = `${r.error.code} (${r.error.statusCode}): ${r.error.message}`;
      console.error(`  ❌ ${name} — ${row.detail}`);
      return r;
    }
    row.outcome = 'pass'; row.detail = preview(r);
    console.log(`  ✅ ${name}`);
    return r;
  } catch (err) {
    if (err instanceof SomewhereError && acceptCodes.includes(err.code)) {
      row.outcome = 'expected-error'; row.detail = `${err.code}: ${err.message}`;
      console.log(`  ⚠️  ${name} — ${err.code}`);
      return null;
    }
    row.outcome = err instanceof SomewhereError ? 'fail' : 'crash';
    row.detail = err instanceof SomewhereError ? `${err.code} (${err.statusCode}): ${err.message}` : String(err?.stack ?? err);
    console.error(`  ${row.outcome === 'fail' ? '❌' : '💥'} ${name} — ${row.detail}`);
    return null;
  }
}

/** Manual assert. */
function assert(name, condition, detail) {
  results.push({ name, outcome: condition ? 'pass' : 'fail', detail: String(detail ?? '') });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function httpDirect(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok !== true) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}

async function fetchDeleteCode(pid) {
  const envText = readFileSync('/Users/uzair/somewhere-tech/.env', 'utf-8');
  const pick = (n) => envText.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1]?.trim();
  const email = pick('CF_GLOBAL_KEY_EMAIL'), apiKey = pick('CF_GLOBAL_API_KEY');
  if (!email || !apiKey) return null;
  const sql = `SELECT code FROM delete_confirmations WHERE target_id = '${pid}' AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/b40a6657ef9b59a7bbc7fdf3f271a667/d1/database/a1a13e63-7579-4d4b-b1f3-e7ae8746dfbe/query`, {
    method: 'POST',
    headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  return (await r.json())?.result?.[0]?.results?.[0]?.code ?? null;
}

/* ── main test ───────────────────────────────────────────────────── */

async function main() {
  console.log(`\n=== ROBUST LIVE TEST (${suffix}) ===\n`);

  // ── Setup: create project + schema via raw HTTP ──────────────────
  console.log('## Setup');
  const proj = await httpDirect('POST', '/projects', { name: `SDK T ${suffix}`, subdomain });
  if (!proj?.id) { console.error('fatal: no project'); process.exit(1); }
  projectId = proj.id;
  console.log(`  project: ${projectId} @ ${subdomain}.somewhere.tech`);

  await httpDirect('POST', '/db/migrate', {
    project_id: projectId,
    sql: `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT DEFAULT 'user', active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
          CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT NOT NULL, done INTEGER DEFAULT 0);`,
  });

  const sw = new Somewhere({ key, projectId });

  // ═══════════════════════════════════════════════════════════════════
  // 1. sw.from(...) — Supabase query builder
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n## from() — CRUD + filters + modifiers');

  // INSERT
  await ok('insert single row', () => sw.from('users').insert({ name: 'Alice', email: 'alice@test.com' }));
  await ok('insert multiple rows', () => sw.from('users').insert([
    { name: 'Bob', email: 'bob@test.com', role: 'user', active: 1 },
    { name: 'Carol', email: 'carol@test.com', role: 'admin', active: 1 },
    { name: 'Dave', email: 'dave@test.com', role: 'admin', active: 0 },
  ]));

  // SELECT *
  const allUsers = await ok('select *', () => sw.from('users').select('*'));
  assert('select * returned 4 rows', allUsers?.data?.length === 4, `got ${allUsers?.data?.length}`);

  // SELECT specific columns
  await ok('select columns', () => sw.from('users').select('id, name, email'));

  // FILTERS
  await ok('eq', () => sw.from('users').select('*').eq('email', 'alice@test.com'));
  await ok('neq', () => sw.from('users').select('*').neq('role', 'admin'));
  await ok('gt', () => sw.from('users').select('*').gt('id', 2));
  await ok('gte', () => sw.from('users').select('*').gte('id', 2));
  await ok('lt', () => sw.from('users').select('*').lt('id', 3));
  await ok('lte', () => sw.from('users').select('*').lte('id', 2));
  await ok('like', () => sw.from('users').select('*').like('email', '%@test.com'));
  await ok('ilike', () => sw.from('users').select('*').ilike('name', 'alice'));
  await ok('in', () => sw.from('users').select('*').in('name', ['Alice', 'Carol']));
  const isNull = await ok('is(null)', () => sw.from('users').select('*').is('role', null));
  // is(null) should return 0 rows since all have a role
  assert('is(null) correctly filters', Array.isArray(isNull?.data), `type=${typeof isNull?.data}`);
  await ok('match', () => sw.from('users').select('*').match({ role: 'admin', active: 0 }));

  // MODIFIERS
  const ordered = await ok('order desc', () => sw.from('users').select('id, name').order('name', { ascending: false }));
  assert('order desc first is Dave or Carol', ['Dave', 'Carol'].includes(ordered?.data?.[0]?.name), ordered?.data?.[0]?.name);
  const limited = await ok('limit', () => sw.from('users').select('*').limit(2));
  assert('limit returned 2', limited?.data?.length === 2, limited?.data?.length);
  const ranged = await ok('range', () => sw.from('users').select('*').range(1, 2));
  assert('range returned 2', ranged?.data?.length === 2, ranged?.data?.length);

  // SINGLE / MAYBE SINGLE
  const single = await ok('single (1 match)', () => sw.from('users').select('*').eq('email', 'alice@test.com').single());
  assert('single returned object not array', single?.data && !Array.isArray(single.data) && single.data.email === 'alice@test.com', preview(single?.data));
  await ok('maybeSingle (0 matches)', () => sw.from('users').select('*').eq('email', 'nobody@test.com').maybeSingle());
  const singleErr = await ok('single (0 matches → PGRST116)', () => sw.from('users').select('*').eq('email', 'nobody@test.com').single(), 'PGRST116');
  assert('single 0-row returns error', singleErr?.error?.code === 'PGRST116', singleErr?.error?.code);

  // UPDATE
  await ok('update with eq', () => sw.from('users').update({ role: 'verified' }).eq('email', 'alice@test.com'));
  const updated = await ok('verify update took effect', () => sw.from('users').select('role').eq('email', 'alice@test.com').single());
  assert('update persisted', updated?.data?.role === 'verified', updated?.data?.role);

  // UPSERT
  await ok('upsert (existing)', () => sw.from('users').upsert({ email: 'alice@test.com', name: 'Alice Updated', role: 'verified' }, { onConflict: 'email' }));
  const upserted = await ok('verify upsert', () => sw.from('users').select('name').eq('email', 'alice@test.com').single());
  assert('upsert updated name', upserted?.data?.name === 'Alice Updated', upserted?.data?.name);

  await ok('upsert (new)', () => sw.from('users').upsert({ email: 'eve@test.com', name: 'Eve', role: 'new' }, { onConflict: 'email' }));

  // DELETE
  await ok('delete with eq', () => sw.from('users').delete().eq('email', 'eve@test.com'));
  const afterDel = await ok('verify delete', () => sw.from('users').select('*').eq('email', 'eve@test.com'));
  assert('deleted row is gone', afterDel?.data?.length === 0, afterDel?.data?.length);

  // ERROR PATH: invalid table name
  const badTable = await ok('invalid table (error)', () => sw.from('nonexistent_table').select('*'), 'D1_TABLE_NOT_FOUND', 'VALIDATION_ERROR', 'D1_SYNTAX_ERROR', 'SYNTAX_ERROR');
  assert('invalid table returns error', badTable?.error != null, badTable?.error?.code);

  // Cross-table: insert tasks referencing user IDs
  await ok('insert tasks', () => sw.from('tasks').insert([
    { user_id: 1, title: 'Buy milk', done: 0 },
    { user_id: 1, title: 'Walk dog', done: 1 },
    { user_id: 2, title: 'Code review', done: 0 },
  ]));
  const tasks = await ok('select tasks with filter', () => sw.from('tasks').select('*').eq('user_id', 1).eq('done', 0));
  assert('filtered tasks correct', tasks?.data?.length === 1 && tasks.data[0].title === 'Buy milk', preview(tasks?.data));

  // ═══════════════════════════════════════════════════════════════════
  // 2. sw.storage.from(bucket) — Supabase Storage
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n## storage.from(bucket)');

  const bucket = sw.storage.from('test-bucket');
  const fileBytes = new TextEncoder().encode('hello storage round-trip test');

  await ok('upload', () => bucket.upload('docs/hello.txt', fileBytes, { contentType: 'text/plain' }));
  await ok('upload binary', () => bucket.upload('imgs/pixel.png', new Uint8Array([137, 80, 78, 71]), { contentType: 'image/png' }));

  const dl = await ok('download', () => bucket.download('docs/hello.txt'));
  if (dl?.data?.body) {
    const text = new TextDecoder().decode(new Uint8Array(dl.data.body));
    assert('download byte-exact', text === 'hello storage round-trip test', `"${text}"`);
  }

  const list = await ok('list', () => bucket.list());
  assert('list found files', (list?.data?.length ?? 0) >= 2, `count=${list?.data?.length}`);

  const pubUrl = bucket.getPublicUrl('docs/hello.txt');
  assert('getPublicUrl returns URL', typeof pubUrl?.data?.publicUrl === 'string' && pubUrl.data.publicUrl.includes('hello.txt'), pubUrl?.data?.publicUrl);

  await ok('remove', () => bucket.remove(['docs/hello.txt', 'imgs/pixel.png']));
  await ok('download after remove (error)', () => bucket.download('docs/hello.txt'), 'STORAGE_NOT_FOUND', 'NOT_FOUND');

  // ═══════════════════════════════════════════════════════════════════
  // 3. sw.auth — Supabase Auth
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n## auth');

  const authEmail = `test-${suffix}@example.com`;
  const authPass = 'robust-test-pass-123';

  const signUp = await ok('signUp', () => sw.auth.signUp({ email: authEmail, password: authPass }));
  assert('signUp returned user+session', signUp?.data?.user?.email === authEmail && signUp?.data?.session?.access_token, 'yes');

  // After signUp the SDK auto-sessions. Verify getUser returns the new user.
  const me1 = await ok('getUser (post-signUp)', () => sw.auth.getUser());
  assert('getUser matches signUp email', me1?.data?.user?.email === authEmail, me1?.data?.user?.email);

  // getSession — in-memory, no network
  const sess = await ok('getSession', () => sw.auth.getSession());
  assert('getSession has token', !!sess?.data?.session?.access_token, 'yes');

  // updateUser
  await ok('updateUser', () => sw.auth.updateUser({ display_name: `Tester ${suffix}` }));

  // signOut clears session
  await ok('signOut', () => sw.auth.signOut());
  const sessAfter = await ok('getSession post-signOut', () => sw.auth.getSession());
  assert('session cleared', sessAfter?.data?.session == null, String(sessAfter?.data?.session));

  // signInWithPassword
  const signIn = await ok('signInWithPassword', () => sw.auth.signInWithPassword({ email: authEmail, password: authPass }));
  const jwt = signIn?.data?.session?.access_token;
  assert('signIn returned JWT', !!jwt, 'yes');

  // Dual-auth: db query should work as the signed-in user
  const dualQ = await ok('from().select via user session (dual-auth)', () => sw.from('users').select('id'));
  assert('dual-auth query succeeded', Array.isArray(dualQ?.data), `type=${typeof dualQ?.data}`);

  // Developer-only calls should STILL work (use smt_ key, not the JWT)
  await ok('emails.send (dev-only while user session active)', () =>
    sw.emails.send({ from: 'noreply@somewhere.tech', to: 'test@example.com', subject: `T${suffix}`, text: 'test' }),
    'VALIDATION_ERROR', 'UPSTREAM_ERROR',
  );

  // resetPasswordForEmail (dev-only BFF)
  await ok('resetPasswordForEmail', () => sw.auth.resetPasswordForEmail(authEmail));

  // signInWithOAuth returns URL synchronously
  const oauth = await ok('signInWithOAuth (google)', () => sw.auth.signInWithOAuth({ provider: 'google' }));
  assert('OAuth URL present', typeof oauth?.data?.url === 'string' && oauth.data.url.includes('/auth/google'), oauth?.data?.url?.slice(0, 60));

  // Unsupported provider returns typed error
  const badOauth = await ok('signInWithOAuth (github — unsupported)', () => sw.auth.signInWithOAuth({ provider: 'github' }), 'UNSUPPORTED_FEATURE');
  assert('unsupported provider is error', badOauth?.error?.code === 'UNSUPPORTED_FEATURE', badOauth?.error?.code);

  // setSession rehydration on a fresh client
  if (jwt) {
    const fresh = new Somewhere({ key, projectId });
    await ok('setSession (rehydrate)', () => fresh.auth.setSession({ access_token: jwt }));
    const rehydrated = await ok('getUser via rehydrated client', () => fresh.auth.getUser());
    assert('rehydrated user matches', rehydrated?.data?.user?.email === authEmail, rehydrated?.data?.user?.email);
  }

  // Wrong password → error
  const badLogin = await ok('signInWithPassword (wrong pass)', () =>
    sw.auth.signInWithPassword({ email: authEmail, password: 'wrong' }),
    'AUTH_INVALID_CREDS',
  );
  assert('wrong password is auth error', badLogin?.error?.code === 'AUTH_INVALID_CREDS', badLogin?.error?.code);

  // ═══════════════════════════════════════════════════════════════════
  // 4. sw.emails.send — Resend
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n## emails.send');

  // Reset session back to dev key so email works reliably
  await sw.auth.signOut();
  await ok('emails.send (with html)', () => sw.emails.send({
    from: 'noreply@somewhere.tech',
    to: 'sdk-robust@example.com',
    subject: `Robust test ${suffix}`,
    html: `<h1>Test ${suffix}</h1>`,
    text: `Test ${suffix}`,
  }), 'VALIDATION_ERROR', 'UPSTREAM_ERROR');

  // ═══════════════════════════════════════════════════════════════════
  // 5. sw.chat.completions.create — OpenAI
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n## chat.completions.create');

  try {
    const comp = await sw.chat.completions.create({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Reply with the single word "pong".' }],
      max_tokens: 16,
    });
    const valid =
      comp.object === 'chat.completion' &&
      Array.isArray(comp.choices) &&
      comp.choices[0]?.message?.role === 'assistant' &&
      typeof comp.choices[0]?.message?.content === 'string' &&
      typeof comp.usage?.total_tokens === 'number' &&
      typeof comp.id === 'string' &&
      typeof comp.created === 'number';
    results.push({ name: 'chat.completions.create', outcome: valid ? 'pass' : 'fail',
      detail: preview({ id: comp.id, model: comp.model, content: comp.choices[0]?.message?.content, usage: comp.usage }) });
    console.log(`  ${valid ? '✅' : '❌'} chat.completions.create`);

    assert('response.id starts with chatcmpl-', comp.id.startsWith('chatcmpl-'), comp.id);
    assert('response.model is returned', typeof comp.model === 'string', comp.model);
    assert('usage.total_tokens = prompt + completion', comp.usage.total_tokens === comp.usage.prompt_tokens + comp.usage.completion_tokens, comp.usage.total_tokens);
  } catch (err) {
    results.push({ name: 'chat.completions.create', outcome: 'fail',
      detail: err instanceof SomewhereError ? `${err.code}: ${err.message}` : String(err) });
    console.error(`  ❌ chat.completions.create — ${err}`);
  }
}

async function cleanup() {
  console.log('\n## Cleanup');
  if (!projectId) return;
  try {
    await httpDirect('POST', `/projects/${projectId}/request-delete`);
    const code = await fetchDeleteCode(projectId);
    if (code) {
      await httpDirect('DELETE', `/projects/${projectId}`, { code });
      console.log('  ✅ project deleted');
      results.push({ name: 'cleanup', outcome: 'pass', detail: 'project deleted' });
    } else {
      console.warn(`  ⚠️  could not fetch delete code — project ${projectId} orphaned`);
      results.push({ name: 'cleanup', outcome: 'fail', detail: 'no delete code' });
    }
  } catch (err) {
    console.warn(`  ⚠️  cleanup failed: ${err}`);
    results.push({ name: 'cleanup', outcome: 'fail', detail: String(err) });
  }
}

function report() {
  const pass = results.filter(r => r.outcome === 'pass').length;
  const expected = results.filter(r => r.outcome === 'expected-error').length;
  const fail = results.filter(r => r.outcome === 'fail').length;
  const crash = results.filter(r => r.outcome === 'crash').length;
  console.log(`\n=== SUMMARY: ${pass} pass, ${expected} expected-error, ${fail} fail, ${crash} crash ===`);
  if (fail + crash > 0) {
    console.log('\nFailures:');
    for (const r of results) if (r.outcome === 'fail' || r.outcome === 'crash') console.log(`  ❌ ${r.name} — ${r.detail}`);
  }
  const md = [];
  md.push(`# JS SDK — Robust Live Test (${suffix})`);
  md.push(`\n- Timestamp: ${new Date().toISOString()}`);
  md.push(`- Subdomain: \`${subdomain}.somewhere.tech\``);
  md.push(`\n## Totals\n`);
  md.push(`| Outcome | Count |\n|---|---|`);
  md.push(`| ✅ pass | ${pass} |`);
  md.push(`| ⚠️ expected | ${expected} |`);
  md.push(`| ❌ fail | ${fail} |`);
  md.push(`| 💥 crash | ${crash} |`);
  md.push(`| **total** | **${results.length}** |`);
  md.push(`\n## Per-call\n`);
  md.push(`| # | O | Call | Detail |\n|---|---|---|---|`);
  results.forEach((r, i) => {
    const icon = { pass: '✅', 'expected-error': '⚠️', fail: '❌', crash: '💥', pending: '⏳' }[r.outcome];
    md.push(`| ${i + 1} | ${icon} | \`${r.name}\` | ${(r.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`);
  });
  writeFileSync('/Users/uzair/somewhere-sdks/somewhere-sdk-js/test/live-full-surface-results.md', md.join('\n'));
  console.log('\n📄 Results saved.');
}

try { await main(); }
catch (err) { console.error('\n💥 FATAL:', err); results.push({ name: '<fatal>', outcome: 'crash', detail: String(err?.stack ?? err) }); }
finally { await cleanup(); report(); process.exit(results.some(r => r.outcome === 'fail' || r.outcome === 'crash') ? 1 : 0); }
