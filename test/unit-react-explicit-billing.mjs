import assert from 'node:assert/strict';
import { Gate, useEntitlements } from '../dist/esm/auth/react.js';
for (const invoke of [() => useEntitlements(), () => Gate({ feature: 'exports', children: 'grant' })]) {
  assert.throws(invoke, error => error.code === 'BILLING_EXPLICIT_CHECK_REQUIRED');
}
for (const status of ['loading', 'unavailable']) {
  const result = useEntitlements({ status });
  assert.deepEqual(result, { status });
  assert.equal('has' in result, false);
  assert.equal('entitlements' in result, false);
  assert.equal(Gate({ billing: { status }, feature: 'exports', children: 'grant', fallback: 'upgrade', pending: 'wait', unavailable: 'retry' }).props.children, status === 'loading' ? 'wait' : 'retry');
}
const features = ['exports'];
const ready = useEntitlements({ status: 'ready', features });
features.length = 0;
assert.equal(ready.has('exports'), true);
assert.equal(ready.has('other'), false);
assert.deepEqual(ready.entitlements, ['exports']);
for (const [features, expected] of [[['exports'], 'grant'], [[], 'upgrade']]) {
  assert.equal(Gate({ billing: { status: 'ready', features }, feature: 'exports', children: 'grant', fallback: 'upgrade' }).props.children, expected);
}
// These helpers need no identity provider and never inspect cached paid claims.
assert.equal(Gate({ billing: { status: 'ready', features: [] }, feature: 'exports', children: 'grant', fallback: 'upgrade', user: { entitlements: ['exports'] } }).props.children, 'upgrade');
console.log('explicit React billing: missing observation, ready grant/denial, loading/unavailable separation, copied features, identity independence passed');
