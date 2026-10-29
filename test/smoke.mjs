// Live smoke test for @somewhere-cloud/sdk.
// Exercises the v0.1 surfaces against the real api.somewhere.tech.
//
// Required env:
//   SMT_KEY        — developer smt_ key (or read from ~/.somewhere/config.json)
//   SMT_PROJECT_ID — project UUID to test against
//
// Skipped if either is missing so CI on a clean checkout stays green.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let key = process.env.SMT_KEY;
if (!key) {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.somewhere/config.json'), 'utf8'));
    key = cfg.token || cfg.api_key || cfg.key;
  } catch {}
}
const projectId = process.env.SMT_PROJECT_ID;
if (!key || !projectId) {
  console.log('SMT_KEY + SMT_PROJECT_ID not set — skipping live smoke.');
  process.exit(0);
}

const { Somewhere, SomewhereError } = await import('../dist/esm/index.js');

const sw = new Somewhere({ key, projectId });
const suffix = Math.random().toString(36).slice(2, 8);
let failed = 0;
let passed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label} — ${err?.message || err}`);
    if (err instanceof SomewhereError) console.error(`    code: ${err.code} status: ${err.statusCode}`);
  }
}

console.log('→ sw.db');
const table = `sdk_smoke_${suffix}`;
await check('db.migrate (CREATE TABLE)', async () => {
  await sw.db.migrate(
    `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`,
  );
});
await check('db.query (INSERT with $N)', async () => {
  await sw.db.query(`INSERT INTO ${table} (body) VALUES ($1)`, ['hello from sdk']);
});
await check('db.query (SELECT) returns rows', async () => {
  const rows = await sw.db.query(`SELECT id, body FROM ${table} ORDER BY id DESC LIMIT 5`);
  if (!Array.isArray(rows)) throw new Error(`expected array, got ${typeof rows}`);
  if (rows.length === 0) throw new Error('expected at least one row');
});
await check('db.from (Supabase alias)', async () => {
  const { data, error } = await sw.db.from(table).select('*').limit(5);
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('expected array');
});
await check('sw.from (top-level alias)', async () => {
  const { data, error } = await sw.from(table).select('id').limit(1);
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('expected array');
});

console.log('→ sw.fs');
const fsPath = `sdk-smoke/${suffix}.txt`;
await check('fs.write (text)', async () => {
  const { error } = await sw.fs.write(fsPath, 'hello fs', { contentType: 'text/plain' });
  if (error) throw error;
});
await check('fs.read round-trips bytes', async () => {
  const { data, error } = await sw.fs.read(fsPath);
  if (error) throw error;
  const text = new TextDecoder().decode(data.body);
  if (text !== 'hello fs') throw new Error(`got "${text}"`);
});
await check('fs.list returns the new file', async () => {
  const { data, error } = await sw.fs.list('sdk-smoke');
  if (error) throw error;
  if (!data.find((e) => e.name === `${suffix}.txt`)) {
    throw new Error('new file missing from list');
  }
});
await check('fs.delete', async () => {
  const { error } = await sw.fs.delete(fsPath);
  if (error) throw error;
});

console.log('→ sw.tasks');
let createdTaskId;
await check('tasks.create', async () => {
  const { data, error } = await sw.tasks.create({
    title: `SDK smoke ${suffix}`,
    priority: 'low',
  });
  if (error) throw error;
  createdTaskId = data.id;
});
await check('tasks.list includes the new task', async () => {
  const { data, error } = await sw.tasks.list({ status: 'open', limit: 50 });
  if (error) throw error;
  if (!data.find((t) => t.id === createdTaskId)) throw new Error('new task missing');
});
await check('tasks.update (status=done)', async () => {
  const { error } = await sw.tasks.update(createdTaskId, { status: 'done' });
  if (error) throw error;
});
await check('tasks.delete', async () => {
  const { error } = await sw.tasks.delete(createdTaskId);
  if (error) throw error;
});

console.log('→ cleanup');
await check('db.migrate (DROP TABLE)', async () => {
  await sw.db.migrate(`DROP TABLE IF EXISTS ${table}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
