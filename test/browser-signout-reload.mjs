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
let events = [];
let browser;
const results = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const reply = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Sw-Access-Expires': String(Date.now() + 60_000) });
    res.end(JSON.stringify(body));
  };
  if (path === '/api/auth/me') {
    return reply({ user: req.headers.cookie?.includes('fixture_session=yes') ? { id: 'fixture-user', email: 'fixture@example.invalid' } : null });
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
    }, 400);
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

  // keepalive protects an already-started request even if the user manually
  // reloads before awaiting it. The first new-page /me can precede logout;
  // only the response and subsequent check are asserted here.
  events = [];
  const manual = await open();
  await manual.page.getByTestId('logout').click();
  const deadline = Date.now() + 5_000;
  while (!events.length && Date.now() < deadline) await manual.page.waitForTimeout(5);
  assert.equal(events.length, 1);
  await manual.page.reload();
  await manual.page.waitForTimeout(650);
  assert.equal((await manual.context.cookies()).some(cookie => cookie.name === 'fixture_session'), false);
  await manual.page.reload();
  await manual.page.getByTestId('form').waitFor();
  assert.equal(await manual.page.getByTestId('logout').count(), 0);
  results.push({ case: 'manual navigation after request started', cookieCleared: true, subsequentCheckSignedOut: true, events });
  await manual.context.close();
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
