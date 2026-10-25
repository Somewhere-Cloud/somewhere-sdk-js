// Public package paths must not turn a malformed response into a confirmed write.
// All fetches and input are synthetic; no network or writes are performed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/esm/index.js';
const cjs = createRequire(import.meta.url)('../dist/cjs/index.cjs');

const raw = '<html>synthetic upstream text\n' + 'x'.repeat(220) + '</html>';
const email = { from: 'fixture@example.invalid', to: 'fixture@example.invalid', subject: 'fixture', text: 'synthetic' };
const unknownWrite = {
  ok: false, error: 'DB_WRITE_OUTCOME_UNKNOWN', message: 'The write outcome is unknown.',
  retry: false, retryable: false, outcome: 'unknown', retry_after_ms: 15000,
  hint: 'Inspect the saved operation before repeating it.',
  request_id: '12345678-1234-4234-8234-123456789abc', trace_id: '0123456789abcdef0123456789abcdef',
};

for (const [format, sdk] of [['ESM', esm], ['CommonJS', cjs]]) {
  let cases = 0;
  function fixture(body, status = 200, contentType = 'application/json', networkError) {
    const calls = [];
    const sw = new sdk.Somewhere({
      key: 'smt_synthetic_fixture', projectId: 'fixture', cache: false,
      baseUrl: 'https://fixture.invalid/v1', functionsUrl: 'https://fixture.invalid',
      headers: { 'Idempotency-Key': 'synthetic-idempotency-key' },
      fetch: async (url, init) => {
        calls.push({ url, ...init });
        if (networkError) throw networkError;
        return new Response(body, { status, headers: { 'Content-Type': contentType } });
      },
    });
    return { sw, calls };
  }
  function singleCall(calls, expectedBody) {
    assert.equal(calls.length, 1, 'an unconfirmed operation is never automatically replayed');
    assert.equal(calls[0].headers['Idempotency-Key'], 'synthetic-idempotency-key');
    if (expectedBody !== undefined) assert.deepEqual(JSON.parse(calls[0].body), expectedBody);
    cases++;
  }
  const operations = [
    ['emails.send safeCall', 201, sw => sw.emails.send(email), { project_id: 'fixture', ...email }],
    ['db.query throw', 200, async sw => {
      try { return { data: await sw.db.query('INSERT INTO fixture VALUES ($1)', ['synthetic']), error: null }; }
      catch (error) { return { data: null, error }; }
    }, { project_id: 'fixture', sql: 'INSERT INTO fixture VALUES ($1)', params: ['synthetic'] }],
    ['fluent insert result', 202, sw => sw.from('fixture').insert({ value: 'synthetic' })],
    ['fs.write putBytes', 200, sw => sw.fs.write('fixture.txt', 'synthetic')],
  ];

  for (const [name, status, run, requestBody] of operations) {
    const { sw, calls } = fixture(raw, status, 'text/html');
    const result = await run(sw);
    assert.ok(result.error instanceof sdk.SomewhereError, `${format}: ${name} rejects nonempty non-JSON ${status}`);
    assert.equal(result.data, null);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
    assert.equal(result.error.statusCode, status);
    assert.equal(result.error.retry, false);
    assert.equal(result.error.retryAfterMs, null);
    assert.equal(result.error.body, undefined);
    assert.equal(result.error.message,
      `The platform returned a non-JSON response (HTTP ${status}), so the operation's result could not be confirmed. ` +
      'Inspect the resulting state before repeating a write.');
    if (name !== 'db.query throw') assert.equal(result.status, status);
    singleCall(calls, requestBody);
    if (name === 'fs.write putBytes') assert.equal(calls[0].body, 'synthetic');
    assert.equal(calls[0].method, name === 'fs.write putBytes' ? 'PUT' : 'POST');

    const controlled = fixture(JSON.stringify(unknownWrite), 500);
    const refused = await run(controlled.sw);
    assert.ok(refused.error instanceof sdk.SomewhereError);
    assert.equal(refused.error.code, unknownWrite.error);
    assert.equal(refused.error.statusCode, 500);
    assert.equal(refused.error.retry, false);
    assert.equal(refused.error.retryAfterMs, 15000);
    assert.equal(refused.error.message, unknownWrite.message);
    assert.deepEqual(refused.error.body, unknownWrite, 'hints, correlation and outcome stay available');
    singleCall(controlled.calls, requestBody);
  }

  for (const status of [403, 503]) {
    const { sw, calls } = fixture(raw, status, 'text/html');
    const { error } = await sw.emails.send(email);
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.statusCode, status);
    assert.equal(error.retry, status >= 500);
    assert.equal(error.retryAfterMs, null);
    assert.equal(error.body, undefined);
    assert.equal(error.message, `Non-JSON response (status ${status}): ${raw.slice(0, 200)}`);
    singleCall(calls, { project_id: 'fixture', ...email });
  }
  for (const status of [200, 204]) {
    const { sw, calls } = fixture(null, status);
    assert.deepEqual(await sw.emails.send(email), { data: null, error: null, status: 200 });
    singleCall(calls, { project_id: 'fixture', ...email });
  }
  const valid = fixture(JSON.stringify({ ok: true, data: { id: 'synthetic' } }));
  assert.deepEqual(await valid.sw.emails.send(email), { data: { id: 'synthetic' }, error: null, status: 200 });
  singleCall(valid.calls, { project_id: 'fixture', ...email });

  const invoke = fixture(JSON.stringify(unknownWrite), 500);
  const invoked = await invoke.sw.functions.invoke('fixture', { body: { value: 'synthetic' } });
  assert.equal(invoked.error.retry, false);
  assert.equal(invoked.error.retryAfterMs, 15000);
  assert.deepEqual(invoked.error.body, unknownWrite);
  assert.equal(invoke.calls.length, 1);
  cases++;

  const appText = fixture(raw, 200, 'text/html');
  assert.deepEqual(await appText.sw.functions.invoke('fixture'), { data: raw, error: null, status: 200 });
  assert.equal(appText.calls.length, 1, 'application functions retain their text response contract');
  cases++;

  const network = fixture(null, 200, 'application/json', new Error('synthetic connection lost'));
  const lost = await network.sw.emails.send(email);
  assert.equal(lost.error.code, 'NETWORK_ERROR');
  assert.equal(lost.error.statusCode, 0);
  assert.equal(lost.error.retry, true, 'existing transport metadata is unchanged');
  singleCall(network.calls, { project_id: 'fixture', ...email });
  console.log(`PASS ${format}: ${cases} malformed-response and compatibility cases`);
}
