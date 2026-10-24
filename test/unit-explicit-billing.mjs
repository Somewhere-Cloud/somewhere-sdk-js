import assert from 'node:assert/strict';
import { createSomewhereAuth, AuthError } from '../dist/esm/auth/client.js';
let calls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  calls++;
  return Response.json({ user: { id: 'paid-user', email: 'paid@example.test', plan: 'pro', entitlements: ['exports'] } });
};
const auth = createSomewhereAuth({ mode: 'cookie' });
try {
  for (const read of [() => auth.billing.has('exports'), () => auth.billing.entitlements()]) {
    assert.throws(read, err => err instanceof AuthError && err.code === 'BILLING_EXPLICIT_CHECK_REQUIRED');
  }
  assert.equal(calls, 0, 'retired helpers do not fetch or return a truthy Promise');
  assert.equal((await auth.getUser()).id, 'paid-user');
  assert.equal(calls, 1);
  assert.throws(() => auth.billing.has('exports'), err => err.code === 'BILLING_EXPLICIT_CHECK_REQUIRED');
  assert.equal(calls, 1, 'legacy paid fields cannot authorize a helper');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS explicit paid checks required: synchronous typed refusal; no automatic billing requests; legacy identity paid fields grant nothing');
