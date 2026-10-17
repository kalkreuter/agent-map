import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startDemo } from '../src/demo-server.js';

// The local rehearsal must not require or accidentally reveal real credentials.
test('demo command binds loopback, preserves auth, and never substitutes synthetic work into LIVE', async t => {
  const server = startDemo({ port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/map`)).status, 401);
  const options = { headers: { Authorization: `Basic ${Buffer.from('andre:demo').toString('base64')}` } };
  const demo = await (await fetch(`${base}/api/map`, options)).json();
  assert.equal(demo.mode, 'DEMO');
  assert.ok(demo.items.some(item => item.id.startsWith('demo:')));
  const live = await (await fetch(`${base}/api/map?mode=live`, options)).json();
  assert.equal(live.mode, 'LIVE'); assert.deepEqual(live.items, []);
  assert.equal(live.updatedAt, null);
  assert.match(live.errors.join(' '), /LIVE unavailable/);
  assert.equal(live.sourceHealth[0].status, 'disconnected');
});
