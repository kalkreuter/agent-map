import test from 'node:test';
import assert from 'node:assert/strict';
import { createRailway } from '../src/railway.js';

const now = Date.parse('2026-10-16T12:00:00Z');
const sha = 'a'.repeat(40), newerSha = 'b'.repeat(40);
const target = { projectId: 'project-1', environmentId: 'environment-1', serviceId: 'service-1' };
const repo = { repo: 'owner/application', railway: [target] };
const consoleUrl = 'https://railway.com/project/project-1/service/service-1?environmentId=environment-1';
function node(overrides = {}) {
  return { id: 'deployment-1', status: 'SUCCESS', createdAt: '2026-10-16T10:00:00Z',
    deploymentStopped: false, meta: { commitHash: sha }, ...overrides };
}
function body({ latest = node(), active = [node()], scope = target } = {}) {
  return { data: {
    service: { id: scope.serviceId, name: 'application', projectId: scope.projectId },
    environment: { id: scope.environmentId, name: 'production', projectId: scope.projectId },
    serviceInstance: { serviceId: scope.serviceId, environmentId: scope.environmentId, serviceName: 'application',
      latestDeployment: latest, activeDeployments: active },
  } };
}
function fixture(response = body(), options = {}) {
  const requests = [];
  const client = createRailway('fixture-token', async (url, request) => {
    requests.push({ url, request, payload: JSON.parse(request.body) });
    return typeof response === 'function' ? response(url, request) : Response.json(response);
  }, { now: () => now, ...options });
  return { client, requests };
}

test('Railway is disabled without a token, and absent targets make no requests', async () => {
  for (const token of [undefined, null, '', '  ']) assert.equal(createRailway(token), undefined);
  const { client, requests } = fixture();
  assert.deepEqual(await client.collectRepo({ repo: repo.repo }), []);
  assert.deepEqual(await client.collectRepo({ repo: repo.repo, railway: [] }), []);
  assert.equal(requests.length, 0);
});

test('static named read query uses explicit scope variables and project-token auth at the fixed endpoint', async () => {
  const { client, requests } = fixture();
  const [item] = await client.collectRepo(repo);
  const [{ url, request, payload }] = requests;
  assert.equal(url.href, 'https://backboard.railway.com/graphql/v2');
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json', Accept: 'application/json', 'Project-Access-Token': 'fixture-token' });
  assert.equal(payload.operationName, 'AgentMapRailwayDeployments');
  assert.match(payload.query, /^query AgentMapRailwayDeployments\(/);
  assert.doesNotMatch(payload.query, /mutation|fixture-token|project-1|service-1|environment-1/);
  assert.match(payload.query, /latestDeployment/); assert.match(payload.query, /activeDeployments/);
  assert.deepEqual(payload.variables, target);
  assert.deepEqual(item, { kind: 'deployment', id: 'railway:project-1:environment-1:service-1', repo: repo.repo,
    title: 'application', serviceName: 'application', environmentName: 'production', ...target,
    branch: 'main', url: consoleUrl, deployment: { status: 'SUCCESS',
      latest: { id: 'deployment-1', status: 'SUCCESS', createdAt: '2026-10-16T10:00:00.000Z', sha, url: null },
      live: { id: 'deployment-1', status: 'SUCCESS', createdAt: '2026-10-16T10:00:00.000Z', sha, url: null } },
    collectedAt: '2026-10-16T12:00:00.000Z', warning: '', dataComplete: true });
});

test('account tokens use Bearer auth and unsupported modes fail without exposing credentials', async () => {
  const { client, requests } = fixture(body(), { authMode: 'account' });
  await client.collectRepo(repo);
  assert.equal(requests[0].request.headers.Authorization, 'Bearer fixture-token');
  assert.equal(requests[0].request.headers['Project-Access-Token'], undefined);
  assert.throws(() => createRailway('private-secret', undefined, { authMode: 'private-secret' }), /^Error: Invalid Railway authentication mode\.$/);
});

test('configured title, environment label, and branch override API display labels', async () => {
  const { client } = fixture();
  const [item] = await client.collectRepo({ ...repo, railway: [{ ...target, name: 'Application production', environmentName: 'Live', branch: 'release' }] });
  assert.equal(item.title, 'Application production'); assert.equal(item.serviceName, 'application');
  assert.equal(item.environmentName, 'Live'); assert.equal(item.branch, 'release');
});

for (const status of ['FAILED', 'BUILDING', 'DEPLOYING', 'QUEUED', 'NEEDS_APPROVAL']) {
  test(`latest ${status} attempt retains the older active successful deployment`, async () => {
    const latest = node({ id: 'new-attempt', status, createdAt: '2026-10-16T11:00:00Z', meta: { commitHash: newerSha } });
    const { client } = fixture(body({ latest, active: [latest, node()] }));
    const [item] = await client.collectRepo(repo);
    assert.equal(item.deployment.status, status); assert.equal(item.deployment.latest.id, 'new-attempt');
    assert.equal(item.deployment.latest.sha, newerSha); assert.equal(item.deployment.live.id, 'deployment-1');
    assert.equal(item.deployment.live.sha, sha); assert.equal(item.dataComplete, true);
  });
}

test('live deployment comes only from active SUCCESS records that have not stopped', async () => {
  for (const active of [[], [node({ deploymentStopped: true })], [node({ status: 'CRASHED' })],
    [node({ status: 'SLEEPING' })], [node({ status: 'DEPLOYING' })]]) {
    const { client } = fixture(body({ active }));
    const [item] = await client.collectRepo(repo);
    assert.equal(item.deployment.latest.status, 'SUCCESS');
    assert.equal(item.deployment.live, null); assert.equal(item.dataComplete, true);
  }
});

test('overlapping active successes select the newest running deployment independently of list order', async () => {
  const newer = node({ id: 'new-live', createdAt: '2026-10-16T11:00:00Z', meta: { commitHash: newerSha } });
  for (const active of [[node(), newer], [newer, node()]]) {
    const { client } = fixture(body({ latest: newer, active }));
    assert.equal((await client.collectRepo(repo))[0].deployment.live.sha, newerSha);
  }
});

test('no deployments remains explicitly UNKNOWN with no inferred live SHA', async () => {
  const { client } = fixture(body({ latest: null, active: [] }));
  const [item] = await client.collectRepo(repo);
  assert.deepEqual(item.deployment, { status: 'UNKNOWN', latest: null, live: null });
  assert.equal(item.dataComplete, true);
});

test('unknown provider statuses normalize to UNKNOWN without returning arbitrary response strings', async () => {
  const { client } = fixture(body({ latest: node({ status: 'Private status payload' }), active: [] }));
  const [item] = await client.collectRepo(repo);
  assert.equal(item.deployment.status, 'UNKNOWN'); assert.equal(item.deployment.latest.status, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(item), /Private status payload/);
});

test('only full hexadecimal meta.commitHash values are retained as normalized SHAs', async () => {
  for (const meta of [null, undefined, 'private metadata', { commitHash: sha.slice(0, 7) },
    { commitHash: 'g'.repeat(40) }, { commitHash: ` ${sha}` }, { commitHash: 123 },
    { sha, source: { commitHash: sha } }, { commitHash: [sha] }]) {
    const { client } = fixture(body({ latest: node({ meta }), active: [node({ meta })] }));
    const [item] = await client.collectRepo(repo);
    assert.equal(item.deployment.latest.sha, null); assert.equal(item.deployment.live.sha, null);
    assert.equal(item.dataComplete, true);
  }
  const { client } = fixture(body({ latest: node({ meta: { commitHash: sha.toUpperCase() } }) }));
  assert.equal((await client.collectRepo(repo))[0].deployment.latest.sha, sha);
});

test('raw metadata, application URLs, logs, extra fields, and configuration query text never escape', async () => {
  const payload = body();
  for (const deployment of [payload.data.serviceInstance.latestDeployment, ...payload.data.serviceInstance.activeDeployments]) {
    deployment.url = 'javascript:alert(private-secret)'; deployment.staticUrl = 'https://private-secret.invalid';
    deployment.meta.private = 'private-secret'; deployment.meta.url = 'https://private-secret.invalid';
    deployment.logs = 'private-secret';
  }
  payload.data.private = 'private-secret';
  const { client, requests } = fixture(payload);
  const [item] = await client.collectRepo({ ...repo, railway: [{ ...target, query: 'mutation { private-secret }', url: 'https://private-secret.invalid' }] });
  assert.doesNotMatch(JSON.stringify(item), /private-secret|javascript:|staticUrl|"meta"|"logs"/);
  assert.doesNotMatch(requests[0].request.body, /private-secret|mutation/);
  assert.equal(item.url, consoleUrl); assert.equal(item.deployment.latest.url, null);
  assert.equal(item.deployment.live.url, null);
});

test('HTTP and GraphQL failures return safe unknown records without response bodies or tokens', async () => {
  for (const response of [() => new Response('private-secret fixture-token', { status: 403 }),
    () => new Response('private-secret fixture-token', { status: 500 }),
    () => Response.json({ errors: [{ message: 'private-secret fixture-token', extensions: { traceId: 'private-secret' } }], data: body().data }),
    () => new Response('private-secret fixture-token'),
    () => { throw new Error('private-secret fixture-token'); }]) {
    const { client } = fixture(response);
    const [item] = await client.collectRepo(repo);
    assert.equal(item.dataComplete, false); assert.equal(item.deployment.status, 'UNKNOWN');
    assert.equal(item.deployment.live, null); assert.equal(item.deployment.latest, null);
    assert.match(item.warning, /^Railway deployment unavailable:/);
    assert.doesNotMatch(JSON.stringify(item), /private-secret|fixture-token|traceId/);
  }
});

test('redirects are refused even if an injected transport returns a successful cross-origin response', async () => {
  for (const response of [{ redirected: true, url: 'https://attacker.invalid' }, { redirected: false, url: 'https://attacker.invalid' }]) {
    let parsed = false;
    const { client } = fixture(() => ({ ...response, ok: true, status: 200,
      json: () => { parsed = true; return body(); } }));
    const [item] = await client.collectRepo(repo);
    assert.equal(item.dataComplete, false); assert.equal(parsed, false);
    assert.doesNotMatch(item.warning, /attacker/);
  }
});

test('malformed response fields or scope mismatches never establish a live deployment', async () => {
  const changes = [
    data => { data.service.projectId = 'different-project'; },
    data => { data.service.id = 'different-service'; },
    data => { data.environment.id = 'different-environment'; },
    data => { data.environment.projectId = 'different-project'; },
    data => { data.serviceInstance.serviceId = 'different-service'; },
    data => { data.serviceInstance.environmentId = 'different-environment'; },
    data => { data.serviceInstance.activeDeployments = null; },
    data => { delete data.serviceInstance.latestDeployment; },
    data => { data.serviceInstance.latestDeployment.createdAt = 'private-secret'; },
    data => { data.serviceInstance.latestDeployment.id = { private: 'secret' }; },
    data => { data.serviceInstance.latestDeployment.deploymentStopped = null; },
    data => { data.serviceInstance.activeDeployments = [null]; },
  ];
  for (const change of changes) {
    const payload = body(); change(payload.data);
    const { client } = fixture(payload);
    const [item] = await client.collectRepo(repo);
    assert.equal(item.dataComplete, false); assert.equal(item.deployment.live, null);
    assert.match(item.warning, /invalid API response/); assert.doesNotMatch(item.warning, /private-secret/);
  }
  for (const payload of [null, [], {}, { data: null }, { errors: 'private-secret' }]) {
    const { client } = fixture(payload);
    assert.equal((await client.collectRepo(repo))[0].dataComplete, false);
  }
});

test('one target failure preserves another target and stable result order', async () => {
  const other = { ...target, serviceId: 'service-2' };
  const { client } = fixture((url, request) => {
    const scope = JSON.parse(request.body).variables;
    return scope.serviceId === target.serviceId ? Response.json({ errors: [{ message: 'private-secret' }] })
      : Response.json(body({ scope }));
  });
  const items = await client.collectRepo({ ...repo, railway: [target, other] });
  assert.deepEqual(items.map(item => item.serviceId), ['service-1', 'service-2']);
  assert.equal(items[0].dataComplete, false); assert.equal(items[1].dataComplete, true);
  assert.equal(items[1].deployment.live.sha, sha);
});

test('429 Retry-After blocks subsequent polls until retry time and never exposes its body', async () => {
  for (const retryAfter of ['60', 'Fri, 16 Oct 2026 12:01:00 GMT', 'invalid-private-secret']) {
    let clock = now, calls = 0;
    const { client } = fixture(() => ++calls === 1
      ? new Response('private-secret fixture-token', { status: 429, headers: { 'Retry-After': retryAfter } })
      : Response.json(body()), { now: () => clock });
    const [limited] = await client.collectRepo(repo);
    assert.equal(limited.dataComplete, false); assert.match(limited.warning, /rate limit reached/);
    assert.doesNotMatch(limited.warning, /private-secret|fixture-token/);
    clock += 59_999;
    assert.equal((await client.collectRepo(repo))[0].dataComplete, false); assert.equal(calls, 1);
    clock += 1;
    assert.equal((await client.collectRepo(repo))[0].dataComplete, true); assert.equal(calls, 2);
  }
});

test('request aborts use a 15 second deadline and produce sanitized warnings', async t => {
  const original = AbortSignal.timeout;
  let deadline;
  AbortSignal.timeout = milliseconds => { deadline = milliseconds; return AbortSignal.abort(); };
  t.after(() => { AbortSignal.timeout = original; });
  const { client } = fixture((url, request) => {
    request.signal.throwIfAborted(); throw new Error('unreachable');
  });
  const [item] = await client.collectRepo(repo);
  assert.equal(deadline, 15_000); assert.equal(item.dataComplete, false);
  assert.equal(item.warning, 'Railway deployment unavailable: request failed.');
});
