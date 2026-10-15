import test from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../src/api.js';
import { createGitHub } from '../src/github.js';
import { createCursor } from '../src/cursor.js';
import { createCache } from '../src/cache.js';
import { head, repo, now, pr } from './fixtures.js';
test('GET-only REST pagination follows next pages and rejects foreign origins', async () => {
  const requests = [];
  const reader = createReader({ origin: 'https://api.github.com', service: 'GitHub', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify([requests.length]), { headers: requests.length === 1 ? { link: '<anything>; rel="next"' } : {} });
  } });
  assert.deepEqual(await reader.list('/items'), [1, 2]);
  assert.equal(requests[1].url.searchParams.get('page'), '2');
  assert.ok(requests.every(req => req.options.method === 'GET' && req.options.redirect === 'error'));
  await assert.rejects(reader.get('//evil.example/path'), /Invalid API path/);
});
test('GitHub joins checks, commits, reviews and merged-today PRs using REST', async () => {
  const requests = [];
  const raw = { number: 1, title: 'Fix storage', head: { sha: head }, labels: [], draft: false, updated_at: '2026-10-15T12:00:00Z' };
  const github = createGitHub('fixture-token', async (url, options) => {
    requests.push({ url, options });
    let data;
    if (url.pathname.endsWith('/pulls')) data = url.searchParams.get('state') === 'open' ? [raw]
      : [{ ...raw, number: 2, merged_at: '2026-10-15T13:00:00Z' }, { ...raw, number: 3, merged_at: '2026-10-14T12:00:00Z' }];
    else if (url.pathname.endsWith(`/commits/${head}`)) data = { commit: { message: 'Fix storage', committer: { date: '2026-10-15T12:00:00Z' } } };
    else if (url.pathname.endsWith('/check-runs')) data = { check_runs: [{ id: 1, name: 'Codex autofix', status: 'in_progress' }] };
    else if (url.pathname.endsWith('/commits')) data = [{ sha: head, commit: { message: 'Fix storage' } }];
    else if (url.pathname.endsWith('/status')) data = { statuses: [] };
    else data = [];
    return Response.json(data);
  });
  const result = await github.collectRepo(repo, now);
  assert.equal(result.length, 2); assert.equal(result[0].headSha, head);
  assert.equal(result[0].latestCommits[0].sha, head);
  assert.equal(result[0].ci.runningAgent, true); assert.equal(result[0].reviewers.length, 3);
  assert.ok(requests.every(req => req.options.method === 'GET' && req.url.origin === 'https://api.github.com'));
});
test('conditional requests reuse unchanged data without losing pagination', async () => {
  let calls = 0;
  const reader = createReader({ origin: 'https://api.github.com', service: 'GitHub', fetchImpl: async (url, options) => {
    if (++calls === 1) return new Response('[1]', { headers: { etag: 'fixture-etag', link: '<next>; rel="next"' } });
    assert.equal(options.headers['If-None-Match'], 'fixture-etag');
    return new Response(null, { status: 304 });
  } });
  const first = await reader.get('/items');
  assert.deepEqual(await reader.get('/items'), first); assert.equal(first.hasNext, true);
});
test('incomplete GitHub details never produce an automatic ready state', async () => {
  const github = createGitHub('fixture-token', async url => {
    if (url.pathname.endsWith('/pulls')) return Response.json(url.searchParams.get('state') === 'open'
      ? [{ number: 1, title: 'PR', head: { sha: head }, labels: [] }] : []);
    return new Response('secret response body', { status: 403 });
  });
  const cache = createCache({ repos: [repo], github, now: () => now });
  const result = await cache.refresh();
  assert.equal(result.items[0].state, 'DRAFT_IDLE'); assert.ok(result.errors.length);
  assert.ok(!JSON.stringify(result).includes('secret response body'));
});
test('cache retains stale repo data, retries and coalesces concurrent refreshes', async () => {
  let calls = 0, fail = false;
  const cache = createCache({ repos: [repo], now: () => now, github: { async collectRepo() {
    calls++; if (fail) throw new Error('private token'); return [pr()];
  } } });
  assert.equal(cache.view().loading, true);
  assert.equal(cache.view().repos[0].repo, repo.repo);
  await Promise.all([cache.refresh(), cache.refresh()]); assert.equal(calls, 1);
  assert.equal(cache.view().items[0].state, 'NEEDS_ANDRE');
  fail = true; await cache.refresh();
  assert.equal(cache.view().items[0].state, 'DRAFT_IDLE'); assert.equal(cache.view().repos[0].stale, true);
  assert.ok(!JSON.stringify(cache.view()).includes('private token'));
  fail = false; await cache.refresh(); assert.equal(cache.view().items[0].state, 'NEEDS_ANDRE');
});
test('cached merged tiles disappear at the next day boundary without a network request', async () => {
  let clock = now;
  const cache = createCache({ repos: [repo], now: () => clock, github: { collectRepo: async () => [pr({ mergedAt: new Date(now).toISOString() })] } });
  await cache.refresh(); assert.equal(cache.view().items.length, 1);
  clock += 86400_000; assert.equal(cache.view().items.length, 0);
});
test('Cursor is optional; when configured, paginate and attach running agents by exact PR URL', async () => {
  assert.equal(createCursor(), null);
  const requests = [];
  const cursor = createCursor('fixture-key', async (url, options) => {
    requests.push({ url, options });
    return Response.json({ agents: requests.length === 1 ? [{ status: 'RUNNING', target: {
      prUrl: pr().url, url: 'https://cursor.com/agents/fixture',
    } }] : [], nextCursor: requests.length === 1 ? 'next-page' : undefined });
  });
  const entries = await cursor.collect();
  assert.equal(entries.byPr.get(pr().url).running, true); assert.equal(requests.length, 2);
  assert.equal(requests[1].url.searchParams.get('cursor'), 'next-page');
  assert.ok(requests.every(req => req.options.method === 'GET'));
});
test('Cursor status without a conversation URL still contributes to working', async () => {
  const cursor = createCursor('fixture-key', async () => Response.json({ agents: [
    { status: 'RUNNING', target: { prUrl: pr().url } },
    { status: 'RUNNING', target: { prUrl: 'https://evil.example/x/y/pull/1', url: 'https://cursor.com/agents/no' } },
  ] }));
  const agents = await cursor.collect();
  assert.equal(agents.byPr.size, 1); assert.equal(agents.byPr.get(pr().url).url, null);
  const cache = createCache({ repos: [repo], github: { collectRepo: async () => [pr()] }, cursor: { collect: async () => agents }, now: () => now });
  assert.equal((await cache.refresh()).items[0].state, 'WORKING');
});
test('optional Cursor errors leave GitHub data available', async () => {
  const cache = createCache({ repos: [repo], github: { collectRepo: async () => [pr()] },
    cursor: { collect: async () => { throw new Error('secret'); } }, now: () => now });
  const result = await cache.refresh();
  assert.equal(result.items[0].state, 'NEEDS_ANDRE'); assert.equal(result.items[0].agent, null);
  assert.match(result.errors[0], /Cursor status unavailable/);
});
test('quota headers are observed on failed requests and stop further calls until reset', async () => {
  let calls = 0, clock = 1000;
  const reader = createReader({ origin: 'https://api.github.com', service: 'GitHub', now: () => clock, fetchImpl: async () => {
    calls++;
    return new Response('private', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '61' } });
  } });
  await assert.rejects(reader.get('/one')); await assert.rejects(reader.get('/two'));
  assert.equal(calls, 1); assert.equal(reader.usage().remaining, 0); assert.equal(reader.usage().resetAt, 61_000);
  clock = 62_000; await assert.rejects(reader.get('/three')); assert.equal(calls, 2);
});
test('secondary Retry-After is respected and actual cycle request count adjusts polling', async () => {
  const reader = createReader({ origin: 'https://api.github.com', service: 'GitHub', now: () => 1000,
    fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }) });
  await assert.rejects(reader.get('/one')); await assert.rejects(reader.get('/two'));
  assert.equal(reader.usage().requests, 1); assert.equal(reader.usage().retryAt, 121_000);
  reader.beginCycle(); assert.equal(reader.usage().requests, 0);
  const cache = createCache({ repos: [repo], github: { collectRepo: async () => [pr()], usage: () => ({ requests: 1000 }) }, now: () => now });
  assert.ok((await cache.refresh()).pollMs >= 1_440_000);
});
