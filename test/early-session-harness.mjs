// Shared fixtures for unit-early-session*.mjs: one simulated page (shared localStorage,
// window events, a fetch whose answers the test releases) per test.
import { earlySessionScript, earlySessionNames } from '../dist/esm/auth/early-session.js';

export const N = earlySessionNames();
export const user = { id: 'alice', email: 'alice@example.test' };
export const bob = { id: 'bob', email: 'bob@example.test' };

// A page: shared localStorage, window events, and a fetch whose answers the test releases.
// Pass the previous page's storage to model the next page load in the same browser.
export function page(storage = null) {
  if (!storage) {
    const map = new Map();
    storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
  }
  const events = new EventTarget();
  const calls = [];
  const fetch = (input, init = {}) => new Promise((resolve, reject) => {
    const call = { path: String(input), init, headers: new Headers(init.headers), resolve, reject, aborted: false };
    init.signal?.addEventListener('abort', () => { call.aborted = true; reject(new DOMException('The operation was aborted.', 'AbortError')); });
    calls.push(call);
  });
  Object.assign(globalThis, {
    window: globalThis, localStorage: storage, fetch,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  delete globalThis.__swEarlySession;
  return { storage, calls, lifecycle(type) { events.dispatchEvent(new Event(type)); }, otherTab(key, value) { storage.setItem(key, value); events.dispatchEvent(Object.assign(new Event('storage'), { key })); } };
}
export const me = (u) => Response.json({ user: u });
export const runEarlyScript = () => new Function(earlySessionScript())();
export const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
export const meCalls = (calls) => calls.filter((c) => c.path === N.me);

// A test that never settles is a failure with its name, not a silent exit.
export function suite() {
  let passed = 0;
  const test = async (name, fn) => {
    let timer;
    const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HUNG (5 s): ' + name)), 5000); });
    try { await Promise.race([fn(), hung]); } finally { clearTimeout(timer); }
    passed++; console.log('  ok   ' + name);
  };
  return { test, done: () => console.log(`\n${passed} passed, 0 failed`) };
}
export const stalledBody = (status = 200) => new Response(new ReadableStream({ start() {} }), { status, headers: { 'Content-Type': 'application/json' } });
