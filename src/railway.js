import { mapLimit } from './api.js';

const endpoint = 'https://backboard.railway.com/graphql/v2';
// Public API fields verified against Railway's manage-services docs and CLI:
// https://github.com/railwayapp/cli/blob/master/src/gql/queries/strings/EnvironmentInstances.graphql
// Keep this document static: configuration supplies variables, never GraphQL text.
const operationName = 'AgentMapRailwayDeployments';
const query = `query AgentMapRailwayDeployments($projectId: String!, $environmentId: String!, $serviceId: String!) {
  service(id: $serviceId) { id name projectId }
  environment(id: $environmentId, projectId: $projectId) { id name projectId }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    serviceId
    environmentId
    serviceName
    latestDeployment { id status createdAt deploymentStopped meta }
    activeDeployments { id status createdAt deploymentStopped meta }
  }
}`;
const statuses = new Set(['BUILDING', 'CRASHED', 'DEPLOYING', 'FAILED', 'INITIALIZING',
  'NEEDS_APPROVAL', 'QUEUED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING', 'SUCCESS', 'WAITING']);
const identifier = value => typeof value === 'string' && /^[a-z\d][a-z\d_-]{0,127}$/i.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const timestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

class RailwayError extends Error {
  constructor(reason) { super(reason); }
}

function consoleUrl(target) {
  const url = new URL(`https://railway.com/project/${encodeURIComponent(target.projectId)}/service/${encodeURIComponent(target.serviceId)}`);
  url.searchParams.set('environmentId', target.environmentId);
  return url.href;
}

function deployment(node) {
  if (!record(node) || !identifier(node.id) || typeof node.status !== 'string'
    || !timestamp(node.createdAt)
    || typeof node.deploymentStopped !== 'boolean') throw new RailwayError('invalid API response');
  // Manual/image deploys may have no Git SHA. Never retain other deployment metadata.
  const hash = record(node.meta) ? node.meta.commitHash : null;
  return { id: node.id, status: statuses.has(node.status) ? node.status : 'UNKNOWN',
    createdAt: new Date(node.createdAt).toISOString(),
    sha: typeof hash === 'string' && /^[a-f\d]{40}$/i.test(hash) ? hash.toLowerCase() : null,
    // The public Deployment.url is an application URL. Keep only the service
    // console link until a documented deployment/log deep link is available.
    url: null };
}

function resultData(body, target) {
  if (!record(body) || (body.errors !== undefined && !Array.isArray(body.errors))) {
    throw new RailwayError('invalid API response');
  }
  if (body.errors?.length) throw new RailwayError('API query failed');
  const { service, environment, serviceInstance: instance } = body.data ?? {};
  if (!record(service) || service.id !== target.serviceId || service.projectId !== target.projectId
    || !label(service.name) || !record(environment) || environment.id !== target.environmentId
    || environment.projectId !== target.projectId
    || !label(environment.name) || !record(instance) || instance.serviceId !== target.serviceId
    || instance.environmentId !== target.environmentId || !label(instance.serviceName)
    || !Array.isArray(instance.activeDeployments)
    || !Object.hasOwn(instance, 'latestDeployment')) throw new RailwayError('invalid API response');
  const latest = instance.latestDeployment === null ? null : deployment(instance.latestDeployment);
  const active = [];
  let skippedActive = false;
  for (const node of instance.activeDeployments) {
    // Each active record is independent evidence. A malformed sibling cannot
    // invalidate a healthy active deployment or make the latest attempt live.
    try { active.push({ value: deployment(node), stopped: node.deploymentStopped }); }
    catch (error) {
      if (!(error instanceof RailwayError)) throw error;
      skippedActive = true;
    }
  }
  // A successful deployment in history can be stopped or replaced. Only Railway's
  // current active list can establish which commit is live during a failed rollout.
  const live = active.filter(item => item.value.status === 'SUCCESS' && !item.stopped)
    .sort((a, b) => Date.parse(b.value.createdAt) - Date.parse(a.value.createdAt))[0]?.value ?? null;
  return { serviceName: instance.serviceName, environmentName: environment.name,
    warning: skippedActive ? 'Railway could not verify all active deployments.' : '',
    deployment: { status: latest?.status ?? 'UNKNOWN', latest, live } };
}

export function createRailway(token, fetchImpl = fetch, { authMode = 'project', now = Date.now } = {}) {
  if (typeof token !== 'string' || !token.trim()) return undefined;
  if (!['project', 'account'].includes(authMode)) throw new Error('Invalid Railway authentication mode.');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json',
    ...(authMode === 'project' ? { 'Project-Access-Token': token } : { Authorization: `Bearer ${token}` }) };
  let retryAt = 0;

  async function read(target) {
    if (retryAt > now()) throw new RailwayError('rate limit reached');
    const response = await fetchImpl(new URL(endpoint), { method: 'POST', headers: { ...headers },
      redirect: 'error', signal: AbortSignal.timeout(15_000), body: JSON.stringify({ operationName, query,
        variables: { projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId } }) });
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const until = retry && /^\d+(?:\.\d+)?$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry);
      retryAt = Math.max(retryAt, Number.isFinite(until) && until >= now() ? until : now() + 60_000);
      throw new RailwayError('rate limit reached');
    }
    if (!response.ok) throw new RailwayError(`request failed (${response.status})`);
    // The transport never follows redirects, and response URLs are never persisted.
    if (response.redirected || (response.url && response.url !== endpoint)) throw new RailwayError('request failed');
    let body;
    try { body = await response.json(); } catch { throw new RailwayError('invalid API response'); }
    return resultData(body, target);
  }

  async function collectTarget(repo, target) {
    const item = { kind: 'deployment', id: `railway:${target.projectId}:${target.environmentId}:${target.serviceId}`,
      repo: repo.repo, title: target.name ?? target.serviceId, serviceName: target.name ?? target.serviceId,
      environmentName: target.environmentName ?? target.environmentId,
      projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId,
      branch: target.branch ?? 'main', url: consoleUrl(target),
      deployment: { status: 'UNKNOWN', latest: null, live: null },
      collectedAt: new Date(now()).toISOString(), warning: '', dataComplete: true };
    try {
      if (![target.projectId, target.environmentId, target.serviceId].every(identifier)) throw new RailwayError('invalid target configuration');
      const data = await read(target);
      return { ...item, ...data, title: target.name ?? data.serviceName,
        environmentName: target.environmentName ?? data.environmentName };
    } catch (error) {
      // Only our fixed classifications may cross the collector boundary. Fetch,
      // GraphQL and parser errors may contain response bodies or credentials.
      return { ...item, dataComplete: false,
        warning: `Railway deployment unavailable: ${error instanceof RailwayError ? error.message : 'request failed'}.` };
    }
  }

  return {
    async collectRepo(repo) {
      if (!Array.isArray(repo.railway) || repo.railway.length === 0) return [];
      return mapLimit(repo.railway, 2, target => collectTarget(repo, target));
    },
  };
}
