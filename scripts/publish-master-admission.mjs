import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Admit only the exact master checkout, never an arbitrary caller ref. */
export function admitPublishSource({ event, ref, eventSha, masterSha, version }) {
  if (!/^[0-9a-f]{40}$/.test(masterSha ?? '') || !/^[0-9a-f]{40}$/.test(eventSha ?? '')) {
    throw new Error('Publication requires exact commit SHAs.');
  }
  if (eventSha !== masterSha) throw new Error('Publication source is not the current protected master commit.');
  if (typeof version !== 'string' || !version) throw new Error('The admitted package has no version.');
  if (event === 'workflow_dispatch') {
    if (ref !== 'refs/heads/master') throw new Error('Manual publication must run from protected master.');
  } else if (event === 'push') {
    if (ref !== `refs/tags/v${version}`) throw new Error('Release tag must match the admitted package version.');
  } else {
    throw new Error('This event cannot publish the SDK.');
  }
  return masterSha;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const masterSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = admitPublishSource({
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    eventSha: process.env.GITHUB_SHA,
    masterSha,
    version,
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub Actions output path is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${source}\n`);
  console.log(`Admitted protected master source ${source} (${version}).`);
}
