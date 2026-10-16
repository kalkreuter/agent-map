import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../src/github.js';
import { createCache } from '../src/cache.js';
import { head, oldHead, repo, now } from './fixtures.js';

function fixture({ checkStatus = 403, checkHeaders, actionsStatus = 200, statusStatus = 200, statuses = [], runs, clock,
  reviewStatus = 200, comments = [],
  pulls = [{ number: 1, title: 'Storage PR', head: { sha: head }, labels: [], draft: false }], checks = [] } = {}) {
  const requests = [];
  const client = createGitHub('fixture-token', async (url, options) => {
    requests.push({ url, options });
    const path = url.pathname;
    if (path.endsWith('/pulls')) return Response.json(url.searchParams.get('state') === 'open' ? pulls : []);
    if (/\/commits\/[a-f0-9]{40}$/.test(path)) return Response.json({ commit: { message: 'Storage change', committer: { date: '2026-10-15T16:00:00Z' } } });
    if (path.endsWith('/check-runs')) {
      const status = typeof checkStatus === 'function' ? checkStatus() : checkStatus;
      return status === 200 ? Response.json({ check_runs: typeof checks === 'function' ? checks(url) : checks })
        : new Response('private', { status, headers: checkHeaders });
    }
    if (path.endsWith('/status')) return statusStatus === 200 ? Response.json({ statuses }) : new Response('private', { status: statusStatus });
    if (path.endsWith('/actions/runs')) return actionsStatus === 200 ? Response.json({ workflow_runs: runs ?? [
      { id: 1, workflow_id: 10, name: 'Test', status: 'completed', conclusion: 'failure' },
      { id: 2, workflow_id: 10, name: 'Test', status: 'completed', conclusion: 'success' },
    ] }) : new Response('private', { status: actionsStatus });
    if (path.endsWith('/reviews')) return reviewStatus === 200 ? Response.json([]) : new Response('private', { status: reviewStatus });
    if (path.endsWith('/comments')) return Response.json(path.includes('/issues/') ? [] : comments);
    if (path.endsWith('/commits')) return Response.json([]);
    throw new Error(`Unexpected request ${path}`);
  }, { now: clock });
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
test('a shared successful Checks probe collects review evidence for each distinct PR head', async () => {
  const { client, requests } = fixture({ checkStatus: 200, pulls: [
    { number: 1, title: 'One', head: { sha: head } }, { number: 2, title: 'Two', head: { sha: oldHead } },
  ], checks: url => [{ id: 1, name: 'Cursor Bugbot', app: { slug: 'cursor' }, head_sha: url.pathname.split('/').at(-2),
    status: 'completed', conclusion: 'success', completed_at: '2026-10-15T17:00:00Z',
    output: { summary: '**Final Result:** Bugbot completed review - no issues found!' } }] });
  const items = await client.collectRepo(repo, now);
  assert.deepEqual(items.map(item => item.reviewers[0].lastReviewedSha), [head, oldHead]);
  assert.ok(items.every(item => item.reviewers[0].currentHead && item.dataComplete));
  const checkRequests = requests.filter(request => request.url.pathname.endsWith('/check-runs'));
  assert.equal(checkRequests.length, 2);
});
test('Bugbot check evidence reaches reviewer summaries without leaking raw check output', async () => {
  const checks = [{ id: 1, name: 'Cursor Bugbot', app: { slug: 'cursor' }, head_sha: head,
    status: 'completed', conclusion: 'success', completed_at: '2026-10-15T17:00:00Z',
    output: { summary: '**Final Result:** Bugbot completed review - no issues found!' } }];
  const { client } = fixture({ checkStatus: 200, checks });
  const [item] = await client.collectRepo(repo, now);
  assert.equal(item.reviewers[0].currentHead, true); assert.equal(item.reviewers[0].openFindings, 0);
  assert.equal(item.dataComplete, true); assert.equal(item.ci.reviewChecks, undefined);
});
test('an issue count without corresponding review comments cannot automatically ready a PR', async () => {
  const checks = [{ id: 1, name: 'Cursor Bugbot', app: { slug: 'cursor' }, head_sha: head,
    status: 'completed', conclusion: 'neutral', completed_at: '2026-10-15T17:00:00Z',
    output: { summary: '**Final Result:** Bugbot completed review and found 2 potential issues.' } }];
  const { client } = fixture({ checkStatus: 200, checks });
  const snapshot = await createCache({ repos: [repo], github: client, now: () => now }).refresh();
  assert.equal(snapshot.items[0].dataComplete, false); assert.equal(snapshot.items[0].state, 'DRAFT_IDLE');
  assert.match(snapshot.errors[0], /Bugbot reported issues/);
});
test('a clean Bugbot check cannot make missing formal review data complete or ready', async () => {
  const { client } = fixture({ checkStatus: 200, reviewStatus: 403, checks: [{ id: 1, name: 'Cursor Bugbot',
    app: { slug: 'cursor' }, head_sha: head, status: 'completed', conclusion: 'success',
    completed_at: '2026-10-15T17:00:00Z',
    output: { summary: '**Final Result:** Bugbot completed review - no issues found!' } }] });
  const snapshot = await createCache({ repos: [repo], github: client, now: () => now }).refresh();
  const [item] = snapshot.items;
  assert.equal(item.ci.state, 'success'); assert.equal(item.reviewers[0].currentHead, true);
  assert.ok(item.reviewers.every(reviewer => reviewer.complete === false));
  assert.equal(item.dataComplete, false); assert.equal(item.state, 'DRAFT_IDLE');
  assert.match(snapshot.errors[0], /Reviews unavailable: token needs Pull requests read/);
});
test('Actions fallback output is never used as clean Bugbot review evidence', async () => {
  const { client } = fixture({ runs: [{ id: 2, workflow_id: 10, name: 'Cursor Bugbot', app: { slug: 'cursor' },
    head_sha: head, status: 'completed', conclusion: 'success', completed_at: '2026-10-15T17:00:00Z',
    output: { summary: '**Final Result:** Bugbot completed review - no issues found!' } }],
    comments: [{ id: 1, user: { login: 'cursor[bot]' }, body: 'P2: Previous finding',
      original_commit_id: oldHead, commit_id: head, original_line: 10, line: null,
      created_at: '2026-10-15T16:00:00Z' }] });
  const snapshot = await createCache({ repos: [repo], github: client, now: () => now }).refresh();
  const [item] = snapshot.items;
  assert.equal(item.ci.state, 'success'); assert.equal(item.ci.source, 'actions');
  assert.equal(item.dataComplete, true); assert.equal(item.warning, '');
  assert.equal(item.reviewers[0].currentHead, false); assert.equal(item.reviewers[0].openFindings, 1);
  assert.equal(item.state, 'FIXES_NEEDED');
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
test('rate-limit Checks 403 is retried instead of disabling Checks or falling back', async () => {
  for (const checkHeaders of [
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' },
    { 'retry-after': '0', 'x-ratelimit-remaining': '20' },
  ]) {
    let calls = 0;
    const { client, requests } = fixture({ checkHeaders, checks: [{ id: 1, name: 'Test', status: 'completed', conclusion: 'success' }],
      checkStatus: () => ++calls === 1 ? 403 : 200 });
    const [blocked] = await client.collectRepo(repo, now);
    assert.equal(blocked.dataComplete, false); assert.equal(blocked.ci.source, 'checks');
    assert.match(blocked.warning, /CI check runs unavailable: GitHub rate limit reached/);
    assert.equal(requests.some(request => request.url.pathname.endsWith('/actions/runs')), false);
    const [recovered] = await client.collectRepo(repo, now);
    assert.equal(recovered.ci.source, 'checks'); assert.equal(recovered.ci.state, 'success'); assert.equal(recovered.dataComplete, true);
    assert.equal(calls, 2);
  }
});
test('Checks 403 with remaining quota still falls back and is remembered', async () => {
  const { client, requests } = fixture({ checkHeaders: { 'x-ratelimit-remaining': '10', 'x-ratelimit-limit': '5000' } });
  const [item] = await client.collectRepo(repo, now); await client.collectRepo(repo, now);
  assert.equal(item.ci.source, 'actions'); assert.equal(item.dataComplete, true);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/check-runs')).length, 1);
});
for (const warmup of [false, true]) {
  for (const [name, checkHeaders] of [
    ['primary reset', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '61' }],
    ['secondary Retry-After', { 'retry-after': '60', 'x-ratelimit-remaining': '20' }],
  ]) test(`Checks resumes after ${name} with ${warmup ? 'known' : 'unknown'} permission`, async () => {
    let clock = 1000, checkStatus = warmup ? 200 : 403, calls = 0;
    const { client, requests } = fixture({ clock: () => clock, checkHeaders,
      checkStatus: () => { calls++; return checkStatus; },
      checks: [{ id: 1, name: 'Test', status: 'completed', conclusion: 'success' }] });
    if (warmup) {
      assert.equal((await client.collectRepo(repo, now))[0].ci.state, 'success');
      checkStatus = 403;
    }
    const [limited] = await client.collectRepo(repo, now);
    assert.match(limited.warning, /CI check runs unavailable: GitHub rate limit reached/);
    assert.equal(limited.dataComplete, false);
    const callsBeforeWait = calls;
    await assert.rejects(client.collectRepo(repo, now), error => error.status === 429);
    assert.equal(calls, callsBeforeWait);
    assert.equal(client.usage().retryAt || client.usage().resetAt, 61_000);
    clock = 61_000; checkStatus = 200;
    const [recovered] = await client.collectRepo(repo, now);
    assert.equal(recovered.ci.source, 'checks'); assert.equal(recovered.ci.state, 'success');
    assert.equal(recovered.dataComplete, true); assert.equal(calls, callsBeforeWait + 1);
    assert.equal(requests.some(request => request.url.pathname.endsWith('/actions/runs')), false);
  });
}
test('non-permission Checks errors are retried rather than permanently disabling Checks', async () => {
  const { client, requests } = fixture({ checkStatus: 500 });
  const [item] = await client.collectRepo(repo, now); await client.collectRepo(repo, now);
  assert.equal(item.dataComplete, false); assert.match(item.warning, /CI check runs unavailable/);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/check-runs')).length, 2);
  assert.equal(requests.some(request => request.url.pathname.endsWith('/actions/runs')), false);
});
