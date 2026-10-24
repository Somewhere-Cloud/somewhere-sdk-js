// Public package facade: invocation metadata must not invite replay of an
// unknown/committed write. All responses are synthetic; no network or writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/esm/index.js';
const cjs = createRequire(import.meta.url)('../dist/cjs/index.cjs');

for (const [format, sdk] of [['ESM', esm], ['CommonJS', cjs]]) {
  function fixture(body, status = 500, networkError) {
    const calls = [];
    const sw = new sdk.Somewhere({
      key: 'smt_synthetic_fixture', projectId: 'synthetic-project', cache: false,
      fetch: async (url, init) => {
        calls.push({ url, method: init.method });
        if (networkError) throw networkError;
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      },
    });
    return { sw, calls };
  }
  const base = { ok: false, error: 'DB_WRITE_OUTCOME_UNKNOWN', message: 'Inspect the saved write before acting.',
    hint: 'Use the existing outcome handle; do not replay.', request_id: 'synthetic-request-123',
    trace_id: '0123456789abcdef0123456789abcdef' };
  const refusals = [
    ['explicit refusal', { retry: false }],
    ['retryable false overrides retry true', { retry: true, retryable: false }],
    ['unknown outcome overrides retry true', { retry: true, outcome: 'unknown' }],
    ['committed outcome overrides retry true', { retry: true, outcome: 'committed' }],
    ['write committed overrides retry true', { retry: true, write_committed: true }],
    ['earlier write committed overrides retry true', { retry: true, prior_write_committed: true }],
    ['unknown without retry flag', { outcome: 'unknown' }],
  ];
  for (const [name, metadata] of refusals) {
    const body = { ...base, ...metadata };
    const { sw, calls } = fixture(body);
    const result = await sw.functions.invoke('synthetic-write', { body: { placeholder: true } });
    assert.ok(result.error instanceof sdk.SomewhereError, `${format}: ${name}`);
    assert.equal(result.error.retry, false, `${format}: ${name}`);
    assert.equal(result.error.code, body.error);
    assert.equal(result.status, 500);
    assert.equal(result.error.statusCode, 500);
    assert.equal(result.error.message, body.message);
    assert.deepEqual(result.error.body, body, 'body, hints, outcome and correlation remain unchanged');
    assert.equal(calls.length, 1, 'a refusal does not automatically retry');
  }
  for (const [status, metadata, expected] of [
    [429, { retry: true, retry_after_ms: 15000 }, true],
    [429, { retry: false, retry_after_ms: 15000 }, false],
    [503, { retry: true, retry_after_ms: Number.MAX_SAFE_INTEGER }, true],
    [500, { retry: false, retry_after_ms: 0 }, false],
    [400, { retry: true }, true],
    [500, {}, true], // existing app500 fallback remains intact
    [400, {}, false],
    [500, { retry: 'false', retryable: 'false', outcome: 'other', write_committed: 'true' }, true],
  ]) {
    const body = { ...base, error: 'APP_ERROR', ...metadata };
    const { sw, calls } = fixture(body, status);
    const { error } = await sw.functions.invoke('synthetic');
    assert.equal(error.retry, expected, `${format}: explicit retry or ordinary status fallback`);
    assert.equal(error.retryAfterMs, metadata.retry_after_ms ?? null);
    assert.equal(calls.length, 1);
  }
  for (const delay of [-1, 0.5, '15000', null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const { sw } = fixture({ ...base, retry_after_ms: delay }, 429);
    assert.equal((await sw.functions.invoke('synthetic')).error.retryAfterMs, null, `${format}: malformed delay ${String(delay)}`);
  }
  const successBody = { ok: true, data: { id: 'synthetic' }, retry: false, outcome: 'committed' };
  const successful = fixture(successBody, 200);
  assert.deepEqual(await successful.sw.functions.invoke('synthetic'), { data: successBody, error: null, status: 200 });
  assert.equal(successful.calls.length, 1);
  const disconnected = fixture(null, 0, new Error('synthetic connection lost'));
  const lost = await disconnected.sw.functions.invoke('synthetic');
  assert.equal(lost.error.code, 'NETWORK_ERROR');
  assert.equal(lost.status, 0, 'network uncertainty does not invent an HTTP outcome');
  assert.equal(lost.error.retry, true, 'existing network error contract is unchanged');
  assert.equal(lost.error.retryAfterMs, null);
  assert.equal(disconnected.calls.length, 1, 'uncertain operations are never automatically replayed');
  console.log(`PASS ${format}: invoke refusal/outcome precedence, delay validation, app500/success/network controls`);
}
