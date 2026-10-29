// functions.invoke/rpc host contract: only a caller-supplied app URL is ever
// called; a projectId (UUID, subdomain or per-owner slug) never becomes a host.
// Synthetic transport only, no network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/esm/index.js';
const cjs = createRequire(import.meta.url)('../dist/cjs/index.cjs');

function transport() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers ?? {}) }, method: init.method });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetch };
}

for (const [format, sdk] of [['ESM', esm], ['CommonJS', cjs]]) {
  // Two owners each have a project whose per-owner slug is "shared"; the
  // globally unique subdomains differ, and "shared" is a third customer's subdomain.
  for (const owner of ['smt_owner_a_synthetic', 'smt_owner_b_synthetic']) {
    const t = transport();
    const sw = new sdk.Somewhere({ key: owner, projectId: 'shared', fetch: t.fetch, cache: false });
    const invoked = await sw.functions.invoke('checkout', { body: { plan: 'pro' } });
    assert.equal(invoked.error?.code, 'NO_FUNCTION_HOST', `${format}: slug projectId is refused`);
    assert.match(invoked.error.message, /createClient\(appUrl, key\)/);
    assert.match(invoked.error.message, /app_url/);
    const rpc = await sw.rpc('compute', { n: 1 });
    assert.equal(rpc.error?.code, 'NO_FUNCTION_HOST', `${format}: rpc follows the same rule`);
    assert.equal(t.calls.length, 0, `${format}: no request and no credential left the process`);
  }
  {
    const t = transport();
    const sw = new sdk.Somewhere({ key: 'smt_synthetic', projectId: '11111111-2222-3333-4444-555555555555', fetch: t.fetch });
    assert.equal((await sw.functions.invoke('hello')).error?.code, 'NO_FUNCTION_HOST');
    assert.equal(t.calls.length, 0);
  }
  {
    // The platform-reported app URL (what the CLI writes as app_url) is used verbatim.
    const t = transport();
    const sw = sdk.createClient('https://shared-x7q2.somewhere.site', 'smt_owner_a_synthetic', { projectId: 'shared', fetch: t.fetch, cache: false });
    await sw.functions.invoke('checkout', { body: { plan: 'pro' } });
    assert.equal(t.calls.at(-1).url, 'https://shared-x7q2.somewhere.site/api/checkout');
    assert.equal(t.calls.at(-1).headers.Authorization, 'Bearer smt_owner_a_synthetic');
    await sw.emails.send({ from: 'fixture@example.invalid', to: 'fixture@example.invalid', subject: 'fixture', text: 'fixture' });
    assert.equal(t.calls.at(-1).url, 'https://api.somewhere.cloud/v1/email/send', `${format}: platform REST stays on the API base`);
  }
  {
    // Customer-chosen hosts stay exactly as given.
    const t = transport();
    const custom = sdk.createClient('https://app.customer.example', 'smt_synthetic', { projectId: 'shared', fetch: t.fetch });
    await custom.functions.invoke('hello');
    assert.equal(t.calls.at(-1).url, 'https://app.customer.example/api/hello');
    const override = new sdk.Somewhere({ key: 'smt_synthetic', projectId: 'shared', functionsUrl: 'https://legacy.somewhere.tech/', fetch: t.fetch });
    await override.functions.invoke('hello');
    assert.equal(t.calls.at(-1).url, 'https://legacy.somewhere.tech/api/hello', `${format}: explicit legacy override still honoured`);
  }
  console.log(`PASS ${format}: invoke/rpc call only caller-supplied app URLs; slug/UUID/subdomain-shaped project ids send nothing`);
}
