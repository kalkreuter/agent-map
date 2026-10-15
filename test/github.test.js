import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../src/github.js';
import { createCache } from '../src/cache.js';
import { head, oldHead, repo, now } from './fixtures.js';

function fixture({ checkStatus = 403, actionsStatus = 200, statusStatus = 200, statuses = [], runs,
  pulls = [{ number: 1, title: 'Storage PR', head: { sha: head }, labels: [], draft: false }], checks = [] } = {}) {
  const requests = [];
  const client = createGitHub('fixture-token', async (url, options) => {
    requests.push({ url, options });
    const path = url.pathname;
    if (path.endsWith('/pulls')) return Response.json(url.searchParams.get('state') === 'open' ? pulls : []);
    if (/\/commits\/[a-f0-9]{40}$/.test(path)) return Response.json({ commit: { message: 'Storage change', committer: { date: '2026-10-15T16:00:00Z' } } });
    if (path.endsWith('/check-runs')) return checkStatus === 200 ? Response.json({ check_runs: checks }) : new Response('private', { status: checkStatus });
    if (path.endsWith('/status')) return statusStatus === 200 ? Response.json({ statuses }) : new Response('private', { status: statusStatus });
    if (path.endsWith('/actions/runs')) return actionsStatus === 200 ? Response.json({ workflow_runs: runs ?? [
      { id: 1, workflow_id: 10, name: 'Test', status: 'completed', conclusion: 'failure' },
      { id: 2, workflow_id: 10, name: 'Test', status: 'completed', conclusion: 'success' },
    ] }) : new Response('private', { status: actionsStatus });
    if (path.endsWith('/commits') || path.endsWith('/reviews') || path.endsWith('/comments')) return Response.json([]);
    throw new Error(`Unexpected request ${path}`);
  });
  return { client, requests };
}
test('Checks 403 falls back to latest Actions runs plus statuses with no missing-detail warning', async () => {
  const { client, requests } = fixture();
  const cache = createCache({ repos: [repo], github: client, now: () => now });
  const result = await cache.refresh();
  assert.equal(result.items[0].ci.state, 'success'); assert.equal(result.items[0].ci.source, 'actions');
  assert.equal(result.items[0].dataComplete, true); assert.equal(result.items[0].state, 'NEEDS_ANDRE');
  assert.deepEqual(result.errors, []); assert.equal(result.items[0].warning, '');
  const actions = requests.find(request => request.url.pathname.endsWith('/actions/runs'));
  assert.equal(actions.url.searchParams.get('head_sha'), head);
  assert.ok(requests.some(request => request.url.pathname.endsWith(`/commits/${head}/status`)));
  assert.ok(requests.every(request => request.options.method === 'GET'));
});
test('Checks 403 is shared by concurrent PRs and remembered per repo across polls', async () => {
  const { client, requests } = fixture({ pulls: [
    { number: 1, title: 'One', head: { sha: head } }, { number: 2, title: 'Two', head: { sha: oldHead } },
  ] });
  await client.collectRepo(repo, now); await client.collectRepo(repo, now);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/check-runs')).length, 1);
  await client.collectRepo({ ...repo, repo: 'kalkreuter/storagestack-vivi' }, now);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/check-runs')).length, 2);
});
test('accessible Checks are used without fetching Actions', async () => {
  const { client, requests } = fixture({ checkStatus: 200, checks: [{ id: 1, name: 'Test', status: 'completed', conclusion: 'success' }] });
  const [item] = await client.collectRepo(repo, now);
  assert.equal(item.ci.state, 'success'); assert.equal(item.ci.source, 'checks'); assert.equal(item.dataComplete, true);
  assert.equal(requests.some(request => request.url.pathname.endsWith('/actions/runs')), false);
});
test('Actions workflow failures, pending runs, and external failing statuses affect CI', async () => {
  for (const [runs, statuses, expected] of [
    [[{ id: 1, workflow_id: 10, status: 'completed', conclusion: 'failure' }], [], 'failure'],
    [[{ id: 1, workflow_id: 10, name: 'Codex autofix', status: 'queued' }], [], 'pending'],
    [[{ id: 1, workflow_id: 10, status: 'completed', conclusion: 'success' }], [{ id: 1, context: 'external', state: 'error' }], 'failure'],
  ]) {
    const { client } = fixture({ runs, statuses });
    const [item] = await client.collectRepo(repo, now);
    assert.equal(item.ci.state, expected); assert.equal(item.dataComplete, true);
    if (expected === 'pending') assert.equal(item.ci.runningAgent, true);
  }
});
test('Actions permission gaps keep head/review data and identify what is missing', async () => {
  const { client } = fixture({ actionsStatus: 403, statuses: [{ id: 1, context: 'external', state: 'success' }] });
  const cache = createCache({ repos: [repo], github: client, now: () => now });
  const result = await cache.refresh();
  const [item] = result.items;
  assert.equal(item.headSha, head); assert.equal(item.headMessage, 'Storage change'); assert.equal(item.reviewers.length, 3);
  assert.equal(item.ci.state, 'unknown'); assert.equal(item.dataComplete, false); assert.equal(item.state, 'DRAFT_IDLE');
  assert.match(result.errors[0], /Actions.*read/); assert.doesNotMatch(result.errors[0], /some PR details|private/);
});
test('missing commit statuses are reported even if Actions passed', async () => {
  const { client } = fixture({ statusStatus: 403 });
  const [item] = await client.collectRepo(repo, now);
  assert.equal(item.dataComplete, false); assert.equal(item.ci.state, 'unknown'); assert.match(item.warning, /Commit statuses.*read/);
});
test('non-permission Checks errors are retried rather than permanently disabling Checks', async () => {
  const { client, requests } = fixture({ checkStatus: 500 });
  const [item] = await client.collectRepo(repo, now); await client.collectRepo(repo, now);
  assert.equal(item.dataComplete, false); assert.match(item.warning, /CI check runs unavailable/);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/check-runs')).length, 2);
  assert.equal(requests.some(request => request.url.pathname.endsWith('/actions/runs')), false);
});
