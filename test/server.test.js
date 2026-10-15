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
  for (const path of ['/', '/api/map', '/app.js', '/styles.css']) {
    const response = await fetch(base + path); assert.equal(response.status, 401, path);
    assert.match(response.headers.get('www-authenticate'), /Basic/);
  }
  const options = { headers: { Authorization: authorization } };
  const page = await fetch(base, options); assert.equal(page.status, 200); assert.match(await page.text(), /AGENT MAP/);
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const api = await fetch(base + '/api/map', options); assert.deepEqual(await api.json(), { items: [], loading: false });
  assert.equal((await fetch(base + '/healthz')).status, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(base + '/api/map', { ...options, method })).status, 405);
  for (const path of ['/.env', '/config/repos.json', '/src/server.js', '/../../etc/passwd']) assert.equal((await fetch(base + path, options)).status, 404);
  const headResponse = await fetch(base, { ...options, method: 'HEAD' }); assert.equal(await headResponse.text(), '');
});
test('startup fails closed without required env vars', async () => {
  await assert.rejects(start({}), /GITHUB_READ_TOKEN and DASHBOARD_PASSWORD/);
});
