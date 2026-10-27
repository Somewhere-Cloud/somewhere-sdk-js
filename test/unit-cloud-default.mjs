// Public ESM/CommonJS URL contract; synthetic transport only, no network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/esm/index.js';
const cjs = createRequire(import.meta.url)('../dist/cjs/index.cjs');

for (const [format, sdk] of [['ESM', esm], ['CommonJS', cjs]]) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, data: { id: 'synthetic' } }), { headers: { 'Content-Type': 'application/json' } });
  };
  const send = async (sw, expected) => {
    const before = calls.length;
    const result = await sw.emails.send({ from: 'fixture@example.invalid', to: 'fixture@example.invalid', subject: 'fixture', text: 'fixture' });
    assert.equal(result.error, null);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).url, expected);
    assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer smt_synthetic_fixture');
  };
  await send(new sdk.Somewhere({ key: 'smt_synthetic_fixture', projectId: 'fixture', fetch }), 'https://api.somewhere.cloud/v1/email/send');
  await send(new sdk.Somewhere({ key: 'smt_synthetic_fixture', projectId: 'fixture', baseUrl: 'https://api.somewhere.tech/v1/', fetch }), 'https://api.somewhere.tech/v1/email/send');
  await send(new sdk.Somewhere({ key: 'smt_synthetic_fixture', projectId: 'fixture', baseUrl: 'https://api.example.invalid/v1', fetch }), 'https://api.example.invalid/v1/email/send');
  await send(sdk.createClient('https://fixture.somewhere.site', 'smt_synthetic_fixture', { projectId: 'fixture', fetch }), 'https://api.somewhere.cloud/v1/email/send');
  const custom = sdk.createClient('https://customer.example.invalid', 'smt_synthetic_fixture', { projectId: 'fixture', apiUrl: 'https://api.somewhere.tech/v1', fetch });
  await send(custom, 'https://api.somewhere.tech/v1/email/send');
  await custom.functions.invoke('checkout');
  assert.equal(calls.at(-1).url, 'https://customer.example.invalid/api/checkout');
  const legacy = new sdk.Somewhere({ key: 'smt_synthetic_fixture', projectId: 'fixture', fetch });
  await legacy.functions.invoke('checkout');
  assert.equal(calls.at(-1).url, 'https://fixture.somewhere.tech/api/checkout');
  const explicit = new sdk.Somewhere({ key: 'smt_synthetic_fixture', projectId: 'fixture', functionsUrl: 'https://fixture.somewhere.site', fetch });
  await explicit.functions.invoke('checkout');
  assert.equal(calls.at(-1).url, 'https://fixture.somewhere.site/api/checkout');
  console.log(`${format}: cloud REST default, explicit tech/custom overrides and unchanged function hosts pass`);
}
