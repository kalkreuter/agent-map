import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../src/github.js';
import { createCache } from '../src/cache.js';
import { validateRepos } from '../src/config.js';
import { classify } from '../config/rules.js';
import { repo, pr, head, oldHead, now } from './fixtures.js';

const target = { projectId: '11111111-1111-1111-1111-111111111111',
  environmentId: '22222222-2222-2222-2222-222222222222', serviceId: '33333333-3333-3333-3333-333333333333' };
const configured = { ...repo, railway: [target] };
const live = { id: 'live', status: 'SUCCESS', sha: oldHead, createdAt: new Date(now - 3600_000).toISOString() };
function deployment(overrides = {}) {
  return { kind: 'deployment', id: `railway:${target.projectId}:${target.environmentId}:${target.serviceId}`,
    repo: repo.repo, title: 'Manage production', branch: 'main', collectedAt: new Date(now).toISOString(),
    deployment: { status: 'SUCCESS', latest: live, live }, sync: { status: 'current', branch: 'main', headSha: oldHead },
    dataComplete: true, warning: '', ...overrides };
}

test('deployment states distinguish live, behind, pending, failed, and stale without becoming PR approval items', () => {
  assert.equal(classify(deployment()), 'DEPLOY_LIVE');
  assert.equal(classify(deployment({ sync: { status: 'behind' } })), 'DEPLOY_BEHIND');
  for (const status of ['WAITING', 'QUEUED', 'INITIALIZING', 'BUILDING', 'DEPLOYING']) {
    assert.equal(classify(deployment({ deployment: { status, live } })), 'DEPLOYING');
  }
  for (const status of ['FAILED', 'CRASHED']) {
    assert.equal(classify(deployment({ deployment: { status, live } })), 'DEPLOY_FAILED');
  }
  assert.equal(classify(deployment({ stale: true })), 'DEPLOY_UNKNOWN');
  assert.equal(classify(deployment({ deployment: { status: 'SUCCESS', latest: live, live: null } })), 'DEPLOY_UNKNOWN');
  assert.equal(classify(deployment({ sync: { status: 'unknown' }, dataComplete: false })), 'DEPLOY_UNVERIFIED');
});

test('active deployments are green only when their branch comparison and source data are verified', () => {
  for (const status of ['ahead', 'diverged', 'unknown']) {
    assert.equal(classify(deployment({ sync: { status } })), 'DEPLOY_UNVERIFIED');
  }
  assert.equal(classify(deployment({ sync: undefined })), 'DEPLOY_UNVERIFIED');
  assert.equal(classify(deployment({ dataComplete: false, warning: 'Some active records could not be verified.' })), 'DEPLOY_UNVERIFIED');
  assert.equal(classify(deployment({ dataComplete: false, sync: { status: 'behind' } })), 'DEPLOY_UNVERIFIED');
  assert.equal(classify(deployment({ sync: { status: 'behind' } })), 'DEPLOY_BEHIND');
  assert.equal(classify(deployment()), 'DEPLOY_LIVE');
});

test('deployment comparison proves branch ancestry instead of treating every different SHA as behind', async () => {
  for (const [status, expected] of [['ahead', 'behind'], ['behind', 'ahead'], ['diverged', 'diverged'], ['identical', 'current']]) {
    const requests = [];
    const github = createGitHub('fixture-token', async (url, options) => {
      requests.push(url.pathname); assert.equal(options.method, 'GET');
      if (url.pathname.includes('/branches/')) return Response.json({ commit: { sha: head } });
      return Response.json({ status, ahead_by: 3, behind_by: 2 });
    });
    const result = await github.compareDeployment(repo.repo, oldHead, 'release/main');
    assert.equal(result.status, expected); assert.equal(result.branch, 'release/main');
    assert.equal(result.behindBy, 3); assert.equal(result.aheadBy, 2);
    assert.equal(requests[0], `/repos/${repo.repo}/branches/release%2Fmain`);
    assert.equal(requests[1], `/repos/${repo.repo}/compare/${oldHead}...${head}`);
  }
});

test('equal live and branch commits need no comparison, while missing/invalid commits cannot look current', async () => {
  let calls = 0;
  const github = createGitHub('fixture-token', async () => { calls++; return Response.json({ commit: { sha: head } }); });
  assert.equal((await github.compareDeployment(repo.repo, head)).status, 'current'); assert.equal(calls, 1);
  await assert.rejects(github.compareDeployment(repo.repo, null)); assert.equal(calls, 1);
  const invalid = createGitHub('fixture-token', async () => Response.json({ commit: { sha: 'unknown' } }));
  await assert.rejects(invalid.compareDeployment(repo.repo, head));
  const missing = createGitHub('fixture-token', async url => url.pathname.includes('/branches/')
    ? Response.json({ commit: { sha: head } }) : Response.json({ status: 'unknown' }));
  await assert.rejects(missing.compareDeployment(repo.repo, oldHead));
});

test('optional deployment collection retains previous service data as stale and recovers without changing PR readiness', async () => {
  let fail = false, comparisons = 0;
  const github = { collectRepo: async () => [pr()], compareDeployment: async () => {
    comparisons++; return { status: 'behind', branch: 'main', headSha: head, behindBy: 2 };
  } };
  const railway = { collectRepo: async () => [fail ? deployment({ dataComplete: false, warning: 'Railway unavailable.' }) : deployment()] };
  const cache = createCache({ repos: [configured], github, railway, now: () => now });
  const first = await cache.refresh();
  assert.equal(first.items[0].state, 'NEEDS_ANDRE'); assert.equal(first.items[1].state, 'DEPLOY_BEHIND');
  assert.equal(first.items[1].deployment.live.sha, oldHead); assert.equal(comparisons, 1);
  fail = true;
  const stale = await cache.refresh();
  assert.equal(stale.items[0].dataComplete, true); assert.equal(stale.items[1].stale, true);
  assert.equal(stale.items[1].state, 'DEPLOY_UNKNOWN'); assert.equal(stale.items[1].deployment.live.sha, oldHead);
  assert.match(stale.items[1].warning, /previously collected Railway data/); assert.equal(comparisons, 1);
  fail = false;
  assert.equal((await cache.refresh()).items[1].state, 'DEPLOY_BEHIND'); assert.equal(comparisons, 2);
  const without = await createCache({ repos: [configured], github }).refresh();
  assert.equal(without.items.length, 1); assert.equal(comparisons, 2);
});

test('Railway remains independent when GitHub or branch comparison fails, and comparisons share a cycle budget', async () => {
  let compareFails = false, calls = 0;
  const github = { collectRepo: async () => { throw new Error('private'); },
    compareDeployment: async () => { calls++; if (compareFails) throw new Error('private');
      return { status: 'current', branch: 'main', headSha: oldHead }; }, usage: () => ({ requests: 1000 }) };
  const railway = { collectRepo: async () => [deployment(), deployment({ id: 'other-environment' })] };
  const cache = createCache({ repos: [configured], github, railway, now: () => now });
  const first = await cache.refresh();
  assert.equal(first.items.length, 2); assert.ok(first.items.every(item => item.state === 'DEPLOY_LIVE'));
  assert.equal(calls, 1); assert.ok(first.pollMs >= 1_440_000);
  compareFails = true;
  const unknown = await cache.refresh();
  assert.equal(calls, 2); assert.ok(unknown.items.every(item => item.sync.status === 'unknown' && !item.stale));
  assert.doesNotMatch(JSON.stringify(unknown), /private/);
  const failed = await createCache({ repos: [{ ...configured, railway: [{ ...target, branch: 'release' }] }], github: { collectRepo: async () => [pr()] },
    railway: { collectRepo: async () => { throw new Error('private'); } } }).refresh();
  assert.equal(failed.items[1].state, 'DEPLOY_UNKNOWN'); assert.equal(failed.items[0].state, 'NEEDS_ANDRE');
  assert.deepEqual(failed.items[1].sync, { status: 'unknown', branch: 'release', headSha: null });
});

test('Railway configuration accepts multiple optional targets and rejects malformed or duplicate scopes', () => {
  assert.deepEqual(validateRepos([repo]), [repo]); assert.deepEqual(validateRepos([configured]), [configured]);
  for (const railway of [null, {}, [null], [{ ...target, projectId: 'https://untrusted.test' }],
    [{ ...target, branch: '' }], [{ ...target, name: '\nprivate' }], [target, target]]) {
    assert.throws(() => validateRepos([{ ...repo, railway }]));
  }
  assert.throws(() => validateRepos([configured, { ...configured, repo: 'owner/another' }]));
});

test('an incomplete branch comparison remains clearly incomplete when later Railway reads fail', async () => {
  let railwayFails = false;
  const github = { collectRepo: async () => [pr()], compareDeployment: async () => { throw new Error('private'); } };
  const railway = { collectRepo: async () => [railwayFails
    ? deployment({ dataComplete: false, warning: 'Railway unavailable.' }) : deployment()] };
  const cache = createCache({ repos: [configured], github, railway, now: () => now });
  const first = await cache.refresh();
  assert.equal(first.items[1].state, 'DEPLOY_UNVERIFIED'); assert.equal(first.items[1].dataComplete, false);
  railwayFails = true;
  const second = await cache.refresh();
  assert.equal(second.items[1].state, 'DEPLOY_UNKNOWN'); assert.equal(second.items[1].sync.status, 'unknown');
  assert.equal(second.items[1].deployment.live.sha, oldHead);
  assert.match(second.items[1].warning, /previously collected Railway data/);
  assert.doesNotMatch(second.items[1].warning, /successful|private/);
  assert.equal(second.items[0].dataComplete, true);
});
