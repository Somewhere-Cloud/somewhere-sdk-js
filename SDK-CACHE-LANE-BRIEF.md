# Lane: SDK client cache (productize "A") — build only

Autonomous BUILD lane in the SDK repo (`~/somewhere-sdks/somewhere-sdk-js`, branch `feat/cache`). This is the platform-intelligence flagship: make every app on somewhere fast-by-default so the developer never writes caching code. Founder GREENLIT **default-on**. Task:  (productize prong A).

## HARD GUARDRAILS
- **NEVER publish** (no `npm publish`, no version tag push). Build + test + commit to `feat/cache`. The FOUNDER reviews before any publish — changing default fetch semantics is a breaking change.
- Commit to `feat/cache` only. Do not touch master. Do not deploy anything.

## WHAT TO BUILD
A client cache layer in the query path. The cache hooks into `src/resources/postgrest.ts` — `PostgrestFilterBuilder` is a thenable (awaiting it runs the query) and knows its `action` (select vs insert/upsert/update/delete). Read `src/client.ts` (the Client + how requests execute) and `src/resources/postgrest.ts` (the builder + its `then()` executor) first.

**Behavior (DEFAULT-ON, the founder's call):**
1. **Request dedup/coalescing — always on, zero staleness risk.** Two awaits of the same query in the same tick share ONE in-flight request. (Reuse the single-flight pattern; this alone kills a lot of refetch waste.)
2. **Short staleTime cache — default ~1s.** A repeat read within staleTime returns the prior result instead of refetching. 1s (NOT 30s) is the safety knob: own-writes invalidate (below), normal polling (>1s apart) stays fresh, only sub-second back-to-back reads coalesce. Cache key = table + columns + filters + order + limit/offset + resolveType, scoped to the CLIENT INSTANCE (so it's auth-scoped for free — one client = one identity).
3. **Invalidate-on-write.** After insert/upsert/update/delete on a table, clear that table's cached entries so the next read is fresh (read-your-own-writes correctness).
4. **Opt-out, two levels:** `createClient(url, key, { cache: false })` (global off) and a per-query `.fresh()` (or `{ cache: false }` on the select) for the rare always-fresh need.
5. **`client.prefetch(query)`** — warm the cache ahead of need (hover-prefetch, route preload).
6. Leave a clear seam for **realtime-driven invalidation** (a future: a realtime event for a table auto-clears its cache) — design for it, note it in docs, don't build it now.

**Semver:** this changes default `from().select()` semantics → bump the MAJOR version in package.json (it's 0.4.0 → since pre-1.0, treat 0.4→0.5 as the breaking bump, or 1.0.0 — use the repo's convention; note your choice). Add a CHANGELOG entry stating the default-on behavior + the opt-out.

## DOCS + SALES (founder directive — "done" includes the story, not just code)
- **Dev docs**: document the cache (createClient `{ cache }`, dedup, staleTime, `.fresh()`, invalidate-on-write, prefetch, the realtime-invalidation roadmap). Update the SDK README + any docs the repo generates.
- **Sales/positioning writeup** (a markdown file, e.g. `docs/platform-intelligence.md`): the narrative — *the app is fast by default because the platform is intelligent, not because the developer wired React Query*. Frame it as "platform intelligence" / "what's next after Next.js." This is a SALES asset; write it to persuade.

## GATE + HANDOFF
- Build: `npm run build` (or the repo's build) must succeed; `npm test` (the repo's tests) must pass — and ADD tests for: dedup (two concurrent awaits → one fetch), staleTime (repeat read within window served from cache), invalidate-on-write (write then read → fresh), opt-out (`cache:false` always fetches).
- Commit to `feat/cache` referencing . STOP + write `SDK-CACHE-HANDOFF.md`: the API surface, the semver bump + why, test results, the docs/sales files written, and exactly what the founder must review before publish.
