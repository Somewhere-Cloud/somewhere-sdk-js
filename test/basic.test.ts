/**
 * Typed compile-check ("typed source of truth") for the public SDK surface,
 * focused on the v0.5.0 DEFAULT-ON query cache ( — productize
 * prong A). This file is TYPECHECKED by `npm test` (tsc -p tsconfig.test.json),
 * not executed — its job is to prove the documented cache API type-checks
 * exactly as the README shows it. Runtime behaviour is covered by
 * test/unit-cache.mjs; the live end-to-end smoke lives in test/run-basic.mjs.
 *
 * (Before v0.5.0 this file mirrored a `projects`/`deploy` SDK surface that the
 * Supabase migration removed — it had been left stale and was failing the
 * typecheck gate. Rewritten here against the current surface.)
 */
// Pull types from src and runtime from the built ESM so a future executed
// variant keeps the `instanceof SomewhereError` narrow working at typecheck.
import type * as SdkTypes from '../src/index.js';
// @ts-expect-error — relative path to built JS, no matching .d.ts at that location.
import * as SdkRuntime from '../dist/esm/index.js';

const createClient = SdkRuntime.createClient as unknown as typeof SdkTypes.createClient;
const SomewhereError = SdkRuntime.SomewhereError as unknown as typeof SdkTypes.SomewhereError;

// Never invoked — existence + types ARE the assertions (no network here).
async function cacheApiTypeChecks(): Promise<void> {
  // Cache is on by default. Tune it…
  const sw = createClient('https://demo.somewhere.tech', 'eyJ.jwt', {
    cache: { staleTime: 1000 },
  });
  // …or turn it off globally.
  const noCache = createClient('https://demo.somewhere.tech', 'eyJ.jwt', { cache: false });
  void noCache;

  // A normal read: request-deduped + served from cache within staleTime.
  const read = await sw.from('todos').select('*').eq('user_id', 1);
  if (read.error) {
    if (read.error instanceof SomewhereError) {
      console.error(`[${read.error.code}] ${read.error.message}`);
    }
  } else {
    console.log(read.data, read.count);
  }

  // Per-query opt-out — always hit the network for this one read.
  await sw.from('todos').select('*').eq('id', 1).fresh();

  // Warm the cache ahead of need (hover-prefetch / route preload).
  const warmed = await sw.prefetch(sw.from('todos').select('*').eq('id', 7));
  void warmed;

  // A write self-invalidates the table (read-your-own-writes). The manual /
  // event-invalidation seam is also public:
  await sw.from('todos').insert({ title: 'ship the cache' });
  sw.invalidate('todos');
}

void cacheApiTypeChecks;

console.log('basic.test.ts is typecheck-only — see test/unit-cache.mjs for runtime assertions.');
