import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitPublishSource } from './publish-master-admission.mjs';

const master = 'a'.repeat(40);
const base = { masterSha: master, eventSha: master, version: '0.12.0' };
assert.equal(admitPublishSource({ ...base, event: 'push', ref: 'refs/tags/v0.12.0' }), master);
assert.equal(admitPublishSource({ ...base, event: 'workflow_dispatch', ref: 'refs/heads/master' }), master);
for (const source of [
  { event: 'push', ref: 'refs/tags/v0.12.1' },
  { event: 'push', ref: 'refs/heads/master' },
  { event: 'push', ref: 'refs/tags/v0.12.0', eventSha: 'b'.repeat(40) },
  { event: 'workflow_dispatch', ref: 'refs/heads/unreviewed' },
  { event: 'workflow_dispatch', ref: 'refs/tags/v0.12.0' },
  { event: 'workflow_dispatch', ref: 'refs/heads/master', eventSha: 'b'.repeat(40) },
  { event: 'workflow_dispatch', ref: 'refs/heads/master', eventSha: 'master' },
  { event: 'workflow_dispatch', ref: 'refs/heads/master', masterSha: '' },
  { event: 'workflow_dispatch', ref: 'refs/heads/master', version: '' },
  { event: 'pull_request', ref: 'refs/heads/master' },
]) assert.throws(() => admitPublishSource({ ...base, ...source }));

// Cover the credential boundary and actual checkout binding, not just the
// pure selector: the single publisher must depend on read-only admission.
const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const admission = workflow.slice(workflow.indexOf('  admission:'), workflow.indexOf('  publish:'));
const publish = workflow.slice(workflow.indexOf('  publish:'));
assert.match(admission, /permissions:\n      contents: read/);
assert.doesNotMatch(admission, /id-token|secrets\.|npm publish/);
assert.match(admission, /ref: refs\/heads\/master/);
assert.match(admission, /persist-credentials: false/);
assert.match(admission, /source_sha: \$\{\{ steps\.admit\.outputs\.source_sha \}\}/);
assert.match(publish, /needs: admission/);
assert.match(publish, /ref: \$\{\{ needs\.admission\.outputs\.source_sha \}\}/);
assert.match(publish, /id-token: write/);
assert.match(publish, /git rev-parse HEAD/);
assert.ok(publish.indexOf('npm test') < publish.indexOf('npm publish') && publish.includes('npm test'));
assert.equal((publish.match(/npm publish --provenance --access public/g) ?? []).length, 1);
const fixture = mkdtempSync(join(tmpdir(), 'sdk-publish-admission-'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const script = fileURLToPath(new URL('./publish-master-admission.mjs', import.meta.url));
for (const [name, ref, allowed] of [['allowed', 'refs/heads/master', true], ['refused', 'refs/heads/unreviewed', false]]) {
  const output = join(fixture, name);
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: ref, GITHUB_SHA: head, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(run.status === 0, allowed);
  if (allowed) assert.equal(readFileSync(output, 'utf8'), `source_sha=${head}\n`);
  else {
    assert.equal(existsSync(output), false, 'refusal cannot emit a publishable SHA');
    assert.match(run.stderr, /Manual publication must run from protected master/);
  }
}
console.log('SDK publisher admission: allowed/refused sources, read-only boundary, exact checkout and test-before-publish PASS');
