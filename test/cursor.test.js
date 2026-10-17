import test from 'node:test';
import assert from 'node:assert/strict';
import { createCursor } from '../src/cursor.js';
import { createCache } from '../src/cache.js';
import { repo, pr, now } from './fixtures.js';

test('unlinked Cursor agents get configured repo tiles, with no duplicate for linked PRs', async () => {
  const agent = (id, status, extra = {}) => ({ id, status, name: `Agent ${id}`, createdAt: new Date(now).toISOString(),
    source: { repository: `https://github.com/${repo.repo}.git` }, target: { url: `https://cursor.com/agents/${id}` }, ...extra });
  let page = 0;
  const cursor = createCursor('fixture-key', async () => Response.json({ agents: page++ === 0 ? [
    agent('working', 'RUNNING'), agent('finished', 'FINISHED'),
    agent('linked', 'RUNNING', { target: { prUrl: pr().url, url: 'https://cursor.com/agents/linked' } }),
    agent('other', 'RUNNING', { source: { repository: 'https://github.com/another/project' } }),
  ] : [agent('finished', 'FINISHED')], nextCursor: page === 1 ? 'page-2' : undefined }));
  const cache = createCache({ repos: [repo], github: { collectRepo: async () => [pr()] }, cursor, now: () => now });
  const result = await cache.refresh();
  assert.equal(result.items.length, 3);
  assert.equal(result.items.find(item => item.id === pr().id).agent.id, 'linked');
  assert.equal(result.items.find(item => item.id === 'cursor:working').state, 'WORKING');
  assert.equal(result.items.find(item => item.id === 'cursor:finished').state, 'DRAFT_IDLE');
  assert.equal(result.items.find(item => item.id === 'cursor:working').agent.url, 'https://cursor.com/agents/working');
});
test('Cursor skips malformed/foreign repositories and unsafe agent links', async () => {
  const cursor = createCursor('fixture-key', async () => Response.json({ agents: [
    { id: 'unsafe', status: 'RUNNING', source: { repository: `https://github.com/${repo.repo}` }, target: { url: 'javascript:alert(1)' } },
    { id: 'foreign', status: 'RUNNING', source: { repository: 'https://evil.example/a/b' } },
  ] }));
  const result = await cursor.collect();
  assert.equal(result.unlinked.length, 1); assert.equal(result.unlinked[0].agent.url, null);
});
test('without a Cursor key only PR tiles appear', async () => {
  const cache = createCache({ repos: [repo], github: { collectRepo: async () => [pr()] }, cursor: createCursor(), now: () => now });
  assert.equal((await cache.refresh()).items.length, 1);
});

test('distinct Cursor runs sharing one PR retain identities without extra legacy tiles', async () => {
  const cursor = createCursor('fixture-key', async () => Response.json({ agents: [
    { id: 'first', name: 'Build', status: 'RUNNING', target: { prUrl: pr().url, url: 'https://cursor.com/agents/first' } },
    { id: 'second', name: 'Revision', status: 'FINISHED', target: { prUrl: pr().url, url: 'https://cursor.com/agents/second' } },
    { id: 'first', name: 'Build', status: 'RUNNING', target: { prUrl: pr().url, url: 'https://cursor.com/agents/first' } },
  ] }));
  const cache = createCache({ repos: [repo], github: { collectRepo: async () => [pr()] }, cursor, now: () => now });
  const snapshot = await cache.refresh();
  assert.equal(snapshot.items.length, 1);
  assert.deepEqual(snapshot.items[0].agentInstances.map(run => run.id), ['first', 'second']);
  assert.equal(snapshot.items[0].agent.id, 'first');
  assert.equal(snapshot.sourceHealth.find(source => source.id === 'cursor').status, 'current');
});

test('URL credentials are never reflected into Cursor conversation links', async () => {
  const cursor = createCursor('fixture-key', async () => Response.json({ agents: [
    { id: 'one', source: { repository: `https://github.com/${repo.repo}` }, target: { url: 'https://private:secret@cursor.com/agents/one' } },
  ] }));
  const result = await cursor.collect();
  assert.equal(result.unlinked[0].agent.url, null);
  assert.doesNotMatch(JSON.stringify(result.unlinked), /private|secret/);
});
