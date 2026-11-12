// Pure, no-network unit tests for the projects allowed-origins control
// (B-O11, ). Runs against the built ESM in dist/esm. No SMT_KEY /
// network required. The platform is the single normalization/authorization/
// audit authority — the SDK forwards exact origins verbatim.
//
//   npm run build && node test/unit-projects.mjs

import { Somewhere, SomewhereError } from '../dist/esm/index.js';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

/** A fetch double that records requests and replies with a canned body. */
function recorder(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let parsedBody = null;
    if (typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method: init.method, headers: init.headers, body: parsedBody });
    const r = responder ? responder(url, init) : { status: 200, json: { ok: true, data: {} } };
    return new Response(r.body ?? JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

async function main() {
  console.log('projects.getAllowedOrigins');
  {
    const rec = recorder(() => ({
      json: { ok: true, data: { project_id: 'my-app', allowed_origins: ['https://app.example.com'], cors_mode: 'safe' } },
    }));
    const sw = new Somewhere({ key: 'smt_test', projectId: 'my-app', fetch: rec.fetchImpl });
    const res = await sw.projects.getAllowedOrigins();
    const call = rec.calls.at(-1);
    check('GET hits /v1/projects/my-app/allowed-origins',
      call.method === 'GET' && call.url.endsWith('/v1/projects/my-app/allowed-origins'));
    check('sends the developer key', call.headers.Authorization === 'Bearer smt_test');
    check('unwraps {data} to allowed_origins',
      res.error === null && Array.isArray(res.data.allowed_origins)
      && res.data.allowed_origins[0] === 'https://app.example.com');
  }

  console.log('projects.setAllowedOrigins');
  {
    const rec = recorder(() => ({ json: { ok: true, data: { updated: true, allowed_origins: ['https://app.example.com', 'http://localhost:5173'] } } }));
    const sw = new Somewhere({ key: 'smt_test', projectId: 'my-app', fetch: rec.fetchImpl });
    const res = await sw.projects.setAllowedOrigins(['https://app.example.com', 'http://localhost:5173']);
    const call = rec.calls.at(-1);
    check('PUT hits /v1/projects/my-app/allowed-origins',
      call.method === 'PUT' && call.url.endsWith('/v1/projects/my-app/allowed-origins'));
    check('forwards the exact origins verbatim (no client munging)',
      JSON.stringify(call.body) === JSON.stringify({ allowed_origins: ['https://app.example.com', 'http://localhost:5173'] }));
    check('returns updated config', res.error === null && res.data.updated === true);
  }

  console.log('projects.setAllowedOrigins — explicit project override');
  {
    const rec = recorder(() => ({ json: { ok: true, data: { updated: true, allowed_origins: [] } } }));
    const sw = new Somewhere({ key: 'smt_test', projectId: 'my-app', fetch: rec.fetchImpl });
    await sw.projects.setAllowedOrigins(['https://x.example.com'], 'other-project');
    const call = rec.calls.at(-1);
    check('honors the explicit projectId argument',
      call.url.endsWith('/v1/projects/other-project/allowed-origins'));
  }

  console.log('projects.clearAllowedOrigins');
  {
    const rec = recorder(() => ({ json: { ok: true, data: { updated: true, allowed_origins: [] } } }));
    const sw = new Somewhere({ key: 'smt_test', projectId: 'my-app', fetch: rec.fetchImpl });
    await sw.projects.clearAllowedOrigins();
    const call = rec.calls.at(-1);
    check('clear PUTs an empty allowlist',
      call.method === 'PUT' && JSON.stringify(call.body) === JSON.stringify({ allowed_origins: [] }));
  }

  console.log('projects control-plane requires a developer key');
  {
    const rec = recorder(() => ({ json: { ok: true, data: {} } }));
    // Constructed with a JWT token, not an smt_ key.
    const sw = new Somewhere({ token: 'eyJ.jwt.token', projectId: 'my-app', fetch: rec.fetchImpl });
    const res = await sw.projects.setAllowedOrigins(['https://app.example.com']);
    check('fails clear (INVALID_API_KEY) without a developer key, before any request',
      res.error instanceof SomewhereError && res.error.code === 'INVALID_API_KEY' && rec.calls.length === 0);
  }

  console.log('projects.seoCheck');
  {
    const data = { label: 'Deployed SEO metadata', coverage: { public_response: 'unobserved' }, items: [{ name: 'title', value_count: 1000, values: ['Title'], values_truncated: true }] };
    const rec = recorder(() => ({ json: { ok: true, data } }));
    const sw = new Somewhere({ key: 'smt_test', projectId: 'my-app', fetch: rec.fetchImpl });
    const res = await sw.projects.seoCheck();
    check('SEO uses default project and developer GET', rec.calls[0].method === 'GET' && rec.calls[0].url.endsWith('/v1/projects/my-app/seo') && rec.calls[0].headers.Authorization === 'Bearer smt_test');
    check('SEO preserves artifact provenance and bounded counts', JSON.stringify(res.data) === JSON.stringify(data));
    await sw.projects.seoCheck('other/project');
    check('SEO encodes explicit project override', rec.calls[1].url.endsWith('/v1/projects/other%2Fproject/seo'));
  }
  {
    const rec = recorder(() => ({ status: 409, json: { ok: false, error: 'SEO_UNAVAILABLE', message: 'Release unavailable' } }));
    const sw = new Somewhere({ key: 'smt_test', projectId: 'my-app', fetch: rec.fetchImpl });
    const res = await sw.projects.seoCheck();
    check('SEO preserves unavailable error and status', res.data === null && res.error instanceof SomewhereError && res.status === 409);
  }
  {
    const rec = recorder();
    const sw = new Somewhere({ token: 'eyJ.jwt.token', projectId: 'my-app', fetch: rec.fetchImpl });
    const res = await sw.projects.seoCheck();
    check('SEO requires developer authority before network', res.error instanceof SomewhereError && rec.calls.length === 0);
  }

  if (failures > 0) {
    console.error(`\nunit-projects: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nunit-projects: all checks passed');
}

main();
