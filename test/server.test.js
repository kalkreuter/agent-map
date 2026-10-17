import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { authorized, createServer, start } from '../src/server.js';
const authorization = `Basic ${Buffer.from('andre:test-password').toString('base64')}`;
test('password is required and Basic Auth checks the full password', () => {
  assert.equal(authorized(authorization, 'test-password'), true);
  for (const input of [undefined, 'Basic invalid', 'Bearer test-password', `Basic ${Buffer.from('andre:wrong').toString('base64')}`]) assert.equal(authorized(input, 'test-password'), false);
  assert.throws(() => createServer({ password: '' }), /required/);
});
test('server gates UI and API, blocks mutations and keeps secrets inaccessible', async t => {
  const server = createServer({ password: 'test-password', cache: { view: () => ({ items: [], loading: false }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/2d', '/api/map', '/app.js', '/styles.css', '/colony.js', '/scene-state.js', '/vendor/three.module.js']) {
    const response = await fetch(base + path); assert.equal(response.status, 401, path);
    assert.match(response.headers.get('www-authenticate'), /Basic/);
  }
  const options = { headers: { Authorization: authorization } };
  const page = await fetch(base, options); assert.equal(page.status, 200); assert.match(await page.text(), /AGENT MAP/);
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const api = await fetch(base + '/api/map', options); assert.deepEqual(await api.json(), { items: [], loading: false });
  assert.equal((await fetch(base + '/healthz')).status, 200);
  for (const path of ['/2d', '/scene-state.js', '/demo-state.js', '/colony.css', '/vendor/three.module.js', '/vendor/three.core.js', '/vendor/OrbitControls.js']) {
    const asset = await fetch(base + path, options); assert.equal(asset.status, 200, path);
    assert.equal(asset.headers.get('cache-control'), 'no-store');
    const body = await asset.text();
    if (path.endsWith('OrbitControls.js')) assert.match(body, /from '\/vendor\/three.module.js'/);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(base + '/api/map', { ...options, method })).status, 405);
  for (const path of ['/.env', '/config/repos.json', '/src/server.js', '/../../etc/passwd', '/node_modules/three/package.json', '/vendor/../../../etc/passwd']) assert.equal((await fetch(base + path, options)).status, 404);
  const headResponse = await fetch(base, { ...options, method: 'HEAD' }); assert.equal(await headResponse.text(), '');
});
test('startup fails closed without required env vars', async () => {
  await assert.rejects(start({}), /GITHUB_READ_TOKEN and DASHBOARD_PASSWORD/);
});
test('HTTP login lockout returns Retry-After, expires, and successful auth resets failures', async t => {
  let clock = 1000;
  const server = createServer({ password: 'test-password', cache: { view: () => ({}) }, now: () => clock,
    authSettings: { maxFailures: 3, windowMs: 60_000, lockoutMs: 1000, maxLockoutMs: 4000, maxEntries: 10 } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrong = index => fetch(base, { headers: { Authorization: 'Basic dTpiYWQ=', 'X-Forwarded-For': `203.0.113.${index}` } });
  for (let i = 0; i < 5; i++) assert.equal((await fetch(base)).status, 401); // Initial Basic Auth challenge isn't a failed password.
  assert.equal((await wrong(1)).status, 401); assert.equal((await wrong(2)).status, 401);
  assert.equal((await fetch(base, { headers: { Authorization: authorization } })).status, 200);
  assert.equal((await wrong(3)).status, 401); assert.equal((await wrong(4)).status, 401);
  const locked = await wrong(5); assert.equal(locked.status, 429); assert.equal(locked.headers.get('retry-after'), '1');
  assert.equal((await fetch(base, { headers: { Authorization: authorization } })).status, 429);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  clock += 1000;
  assert.equal((await fetch(base, { headers: { Authorization: authorization } })).status, 200);
  assert.equal((await wrong(6)).status, 401);
});
test('trusted proxy isolates clients and rejects invalid proxy configuration', async t => {
  assert.throws(() => createServer({ password: 'pw', trustProxyHops: -1 }), /TRUST_PROXY_HOPS/);
  const server = createServer({ password: 'test-password', cache: { view: () => ({}) }, trustProxyHops: 1,
    authSettings: { maxFailures: 1, windowMs: 60_000, lockoutMs: 1000, maxLockoutMs: 4000, maxEntries: 10 } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base, { headers: { Authorization: 'Basic dTpiYWQ=', 'X-Forwarded-For': '198.51.100.2, 203.0.113.1' } })).status, 429);
  assert.equal((await fetch(base, { headers: { Authorization: authorization, 'X-Forwarded-For': '203.0.113.2' } })).status, 200);
  assert.equal((await fetch(base, { headers: { Authorization: authorization, 'X-Forwarded-For': '198.51.100.99, 203.0.113.1' } })).status, 429);
});
