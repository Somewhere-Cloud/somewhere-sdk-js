// Directed implementation regression: real React SDK and Chromium, isolated
// delayed cookie endpoint. This is not hosted auth/security acceptance.
// npm run test:browser-signout (install Chromium with Playwright first).
// Optional SDK_TEST_CHROMIUM selects an existing browser executable.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'sdk-signout-'));
let failLogout = false;
let meRequests = 0;
let meGate;
let failLogin = false;
let loginDelay = 0;
let logoutDelays = [];
let accessLife = 60_000;
let refreshEvents = [];
let events = [];
let browser;
const results = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const reply = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Sw-Access-Expires': String(Date.now() + accessLife) });
    res.end(JSON.stringify(body));
  };
  if (path === '/api/auth/me') {
    meRequests++;
    if (meGate) await meGate;
    return reply({ user: req.headers.cookie?.includes('fixture_session=yes') ? { id: 'fixture-user', email: 'fixture@example.invalid' } : null });
  }
  if (path === '/api/auth/login') {
    if (failLogin) return reply({ error: 'invalid credentials' }, 401);
    if (loginDelay) await new Promise(resolve => setTimeout(resolve, loginDelay));
    if (res.destroyed) return;
    res.setHeader('Set-Cookie', 'fixture_session=yes; HttpOnly; Path=/');
    return reply({ cookie_session: true, user: { id: 'fixture-user', email: 'fixture@example.invalid' } });
  }
  if (path === '/api/auth/refresh') {
    const event = { arrived: Date.now(), finished: null, closed: null };
    refreshEvents.push(event);
    res.on('close', () => { event.closed = Date.now(); });
    setTimeout(() => {
      event.finished = Date.now();
      res.setHeader('Set-Cookie', 'fixture_session=old; HttpOnly; Path=/');
      reply({ user: { id: 'fixture-user', email: 'fixture@example.invalid' }, expires_at: Date.now() + 60_000 });
    }, 1000);
    return;
  }
  if (path === '/api/auth/logout') {
    const event = { arrived: Date.now(), finished: null, closed: null, failure: failLogout };
    events.push(event);
    res.on('close', () => { event.closed = Date.now(); });
    setTimeout(() => {
      event.finished = Date.now();
      if (event.failure) return reply({ error: 'fixture failure' }, 503);
      res.setHeader('Set-Cookie', 'fixture_session=; HttpOnly; Path=/; Max-Age=0');
      reply({ ok: true });
    }, logoutDelays.shift() ?? 400);
    return;
  }
  if (path === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(await readFile(join(dir, 'app.js')));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<div id="root"></div><script type="module" src="/app.js"></script>');
});
try {
  await build({ entryPoints: [join(root, 'test/fixtures/signout-reload.tsx')], outfile: join(dir, 'app.js'), bundle: true, platform: 'browser', format: 'esm' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.SDK_TEST_CHROMIUM ? { executablePath: process.env.SDK_TEST_CHROMIUM } : {}) });
  const open = async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'fixture_session', value: 'yes', url: origin, httpOnly: true }]);
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    page.on('pageerror', error => console.error('browser page error:', error.message));
    await page.goto(origin);
    await page.getByTestId('logout').waitFor();
    return { context, page };
  };
  const failures = [];
  async function regression(name, run) {
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: 'fixture_session', value: 'yes', url: origin, httpOnly: true }]);
      await run(context);
      console.log('PASS', name);
    } catch (error) {
      failures.push(name);
      console.error('FAIL', name, error.message);
    } finally {
      await context.close();
    }
  }
  await regression('shared provider remount verifies the session again', async context => {
    const page = await context.newPage();
    await page.goto(origin + '?variant=shared');
    await page.getByTestId('private').waitFor();
    await context.clearCookies();
    const before = meRequests;
    const firstPaint = await page.evaluate(() => {
      window.fixtureRemount();
      return document.querySelector('[data-testid="status"]').textContent;
    });
    assert.equal(firstPaint, 'checking', 'the remount must not expose the previous authenticated state');
    await page.getByTestId('natural-form').waitFor({ timeout: 3000 });
    assert.equal(meRequests - before, 1);
  });
  await regression('other tab settles confirmed sign-out with an empty cache', async context => {
    const first = await context.newPage();
    await first.goto(origin);
    await first.getByTestId('private').waitFor();
    const second = await context.newPage();
    await second.goto(origin);
    await second.getByTestId('private').waitFor();
    await first.getByTestId('logout').click();
    await second.locator('html[data-sw-auth="indeterminate"]').waitFor({ state: 'attached' });
    await first.getByTestId('natural-form').waitFor();
    await second.locator('html[data-sw-auth="signed-out"]').waitFor({ state: 'attached', timeout: 3000 });
    assert.equal(await second.getByTestId('unconfirmed').innerText(), 'false');
    assert.equal(await second.getByTestId('signedout-form').count(), 1);
  });
  await regression('Strict Mode makes one session request and emits ready once', async context => {
    await context.addInitScript(() => {
      window.fixtureReady = 0;
      document.addEventListener('sw-auth-ready', () => { window.fixtureReady++; });
    });
    const before = meRequests;
    const page = await context.newPage();
    await page.goto(origin + '?variant=strict');
    await page.getByTestId('private').waitFor();
    await page.waitForLoadState('networkidle');
    assert.deepEqual({ requests: meRequests - before, ready: await page.evaluate(() => window.fixtureReady) },
      { requests: 1, ready: 1 });
  });
  await regression('SignedIn and Protect stay hidden during cached-user verification', async context => {
    await context.addInitScript(() => {
      localStorage.setItem('sw_auth_user', JSON.stringify({ id: 'cached-user', email: 'cached@example.invalid' }));
    });
    let releaseMe;
    meGate = new Promise(resolve => { releaseMe = resolve; });
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.getByTestId('natural-loading').waitFor();
      assert.equal(await page.getByTestId('cached-user').innerText(), 'cached-user');
      assert.deepEqual({
        signedIn: await page.getByTestId('private').count(),
        protected: await page.getByTestId('protected-private').count(),
      }, { signedIn: 0, protected: 0 });
    } finally {
      releaseMe();
      meGate = undefined;
    }
    await page.getByTestId('private').waitFor();
    assert.equal(await page.getByTestId('protected-private').count(), 1);
  });
  assert.deepEqual(failures, [], 'browser auth regressions');
  // The reported handwritten consumer uses only user truthiness and does not
  // await signOut. Reload immediately when that consumer exposes the auth form.
  for (let n = 0; n < 3; n++) {
    events = [];
    const { context, page } = await open();
    await page.getByTestId('logout').click();
    await page.getByTestId('form').waitFor();
    assert.equal(events.length, 1, 'logout must have reached the server before signed-out UI');
    assert.ok(events[0].finished !== null, 'logout response must precede signed-out UI');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid="pending"]')?.textContent === 'false');
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId('logout').count(), 0, 'reload must not restore the user');
    assert.equal((await context.cookies()).some(cookie => cookie.name === 'fixture_session'), false);
    results.push({ case: 'form-triggered reload', n, signedOut: true, events });
    await context.close();
  }
  failLogout = true; events = [];
  const { context, page } = await open();
  await page.getByTestId('logout').click();
  await page.getByTestId('signedout-pending').waitFor();
  assert.equal(await page.getByTestId('private').count(), 0);
  assert.equal(await page.getByTestId('protected-private').count(), 0);
  assert.equal(await page.getByTestId('form').count(), 0);
  assert.equal(await page.getByTestId('protect-pending').count(), 1);
  await page.getByTestId('form').waitFor();
  assert.equal(await page.getByTestId('unconfirmed').innerText(), 'true');
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'fixture_session'), true);
  results.push({ case: 'failed logout', privateHelpersHidden: true, unconfirmed: true, cookieRemains: true, events });
  failLogout = false; events = [];
  await page.getByTestId('retry').click();
  await page.waitForFunction(() => window.fixtureAuth.getState().signingOut === false);
  assert.equal(await page.getByTestId('unconfirmed').innerText(), 'false');
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'fixture_session'), false);
  results.push({ case: 'retry', confirmed: true, events });
  await context.close();

  // Durable intent survives navigation while the original logout is cancelled.
  // The new document retries logout without restoring authenticated UI; assert
  // both the first-reload gate and eventual removal of the session cookie.
  events = [];
  const manual = await open();
  await manual.page.getByTestId('logout').click();
  const deadline = Date.now() + 5_000;
  while (!events.length && Date.now() < deadline) await manual.page.waitForTimeout(5);
  assert.equal(events.length, 1);
  await manual.page.reload();
  await manual.page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent !== 'checking');
  assert.equal(await manual.page.getByTestId('natural-private').count(), 0, 'first reload during logout must not restore authenticated UI');
  await manual.page.waitForTimeout(650);
  assert.equal((await manual.context.cookies()).some(cookie => cookie.name === 'fixture_session'), false);
  await manual.page.reload();
  await manual.page.getByTestId('form').waitFor();
  assert.equal(await manual.page.getByTestId('logout').count(), 0);
  results.push({ case: 'manual navigation after request started', cookieCleared: true, subsequentCheckSignedOut: true, events });
  await manual.context.close();

  // Navigation before the queued logout starts (it waits behind a slow sign-in
  // in this document's queue). The replacement document must finish the real
  // logout before ever restoring UI.
  events = [];
  const queued = await open();
  loginDelay = 3000;
  await queued.page.evaluate(() => { void window.fixtureAuth.signIn({ email: 'fixture@example.invalid', password: 'fixture' }).catch(() => {}); });
  await queued.page.getByTestId('logout').click();
  assert.equal(events.length, 0, 'logout has not reached the server');
  await queued.page.reload();
  loginDelay = 0;
  await queued.page.getByTestId('natural-form').waitFor();
  await queued.page.waitForTimeout(650);
  assert.equal(await queued.page.getByTestId('natural-private').count(), 0);
  assert.equal((await queued.context.cookies()).some(c => c.name === 'fixture_session'), false);
  results.push({ case: 'reload before request begins', signedOut: true, events });
  await queued.context.close();

  // Failure persists across reload. Bootstrap cannot convert an old surviving
  // cookie into a new sign-in, but an explicit successful sign-in can recover.
  failLogout = true;
  const failed = await open();
  await failed.page.getByTestId('logout').click();
  await failed.page.getByTestId('natural-form').waitFor();
  await failed.page.reload();
  await failed.page.getByTestId('natural-form').waitFor();
  assert.equal(await failed.page.getByTestId('unconfirmed').innerText(), 'true');
  assert.equal((await failed.context.cookies()).some(c => c.name === 'fixture_session'), true);
  failLogin = true;
  await failed.page.evaluate(() => window.fixtureAuth.signIn({ email: 'fixture@example.invalid', password: 'fixture' }).catch(() => {}));
  assert.equal(await failed.page.getByTestId('natural-private').count(), 0);
  failLogin = false;
  await failed.page.evaluate(() => window.fixtureAuth.signIn({ email: 'fixture@example.invalid', password: 'fixture' }));
  await failed.page.getByTestId('natural-private').waitFor();
  await failed.page.reload();
  await failed.page.getByTestId('natural-private').waitFor();
  failLogout = false;
  await failed.page.getByTestId('logout').click();
  await failed.page.getByTestId('natural-form').waitFor();
  results.push({ case: 'failed logout reload and explicit sign-in recovery', passed: true });
  await failed.context.close();

  // A previous document's delayed logout response must not erase cookies from
  // an explicit new sign-in after the replacement document finishes its retry.
  events = []; logoutDelays = [1000, 50];
  const late = await open();
  await late.page.getByTestId('logout').click();
  const lateDeadline = Date.now() + 5000;
  while (!events.length && Date.now() < lateDeadline) await late.page.waitForTimeout(5);
  assert.equal(events.length, 1, 'prior-document logout reached server');
  await late.page.reload();
  await late.page.getByTestId('natural-form').waitFor();
  await late.page.evaluate(() => window.fixtureAuth.signIn({ email: 'fixture@example.invalid', password: 'fixture' }));
  await late.page.getByTestId('natural-private').waitFor();
  await late.page.waitForTimeout(1200);
  await late.page.reload();
  await late.page.getByTestId('natural-private').waitFor();
  results.push({ case: 'new explicit sign-in survives prior-document late logout', passed: true, events });
  await late.context.close();

  // Sign-out supersedes an in-flight cookie refresh, including its browser
  // cookie side effect after navigation and a subsequent explicit sign-in.
  accessLife = 1000; refreshEvents = [];
  const refreshing = await open();
  const refreshDeadline = Date.now() + 5000;
  while (!refreshEvents.length && Date.now() < refreshDeadline) await refreshing.page.waitForTimeout(5);
  assert.equal(refreshEvents.length, 1, 'background refresh reached server');
  accessLife = 60_000;
  await refreshing.page.getByTestId('logout').click();
  await refreshing.page.reload();
  await refreshing.page.getByTestId('natural-form').waitFor();
  await refreshing.page.evaluate(() => window.fixtureAuth.signIn({ email: 'fixture@example.invalid', password: 'fixture' }));
  await refreshing.page.getByTestId('natural-private').waitFor();
  await refreshing.page.waitForTimeout(1200);
  assert.equal((await refreshing.context.cookies()).find(c => c.name === 'fixture_session')?.value, 'yes', 'late refresh cannot replace explicit login cookies');
  await refreshing.page.reload();
  await refreshing.page.getByTestId('natural-private').waitFor();
  results.push({ case: 'sign-out supersedes in-flight refresh across navigation and sign-in', passed: true, refreshEvents });
  await refreshing.context.close();
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
