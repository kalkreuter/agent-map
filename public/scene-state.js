// Renderer-neutral state. Collection remains in the server; this adapter never
// starts work, infers run identities, or manufactures live activity events.
const SOURCES = new Set(['github.com', 'cursor.com', 'railway.com']);
const MODES = new Set(['DEMO', 'RECORDED', 'LIVE']);
const MAX_EVENTS = 500;
const WAITING_LABELS = new Set(['awaiting ok']);

export function safeSourceUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !SOURCES.has(url.hostname) || url.username || url.password || url.port) return null;
    return url.href;
  } catch { return null; }
}

function timestamp(value, fallback = null) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}
function ordered(entries) { return entries.sort((a, b) => a.id.localeCompare(b.id)); }
function provenance(mode) { return mode === 'DEMO' ? 'demo' : 'observed'; }
function common(id, name, source, sourceUrl, observedAt, mode) {
  return { id, name: String(name || id), source, sourceUrl: mode === 'DEMO' ? null : safeSourceUrl(sourceUrl),
    observedAt, provenance: provenance(mode), statusProvenance: provenance(mode) };
}
function labelsOf(item) {
  return (Array.isArray(item.labels) ? item.labels : []).map(label => String(typeof label === 'object' ? label?.name ?? '' : label).trim().toLowerCase());
}
function itemStatus(item, stale, mode, explicitInputLabels) {
  if (stale) return 'stale';
  if (item.kind === 'deployment') {
    if (item.state === 'DEPLOY_FAILED') return 'failed';
    if (item.state === 'DEPLOYING') return 'working';
    // A running service and a successful current deployment are separate facts.
    if (item.state === 'DEPLOY_LIVE' && item.dataComplete !== false) return 'deployed';
    return 'unknown';
  }
  if (item.mergedAt) return 'merged';
  if (labelsOf(item).some(label => explicitInputLabels.has(label))
    || (mode === 'DEMO' && item.waitingReason)) return 'waiting';
  if (item.state === 'FIXES_NEEDED') return 'changes_requested';
  if (item.dataComplete === false) return 'unknown';
  if (item.state === 'WORKING') return 'working';
  if (mode === 'DEMO' && ['reviewing', 'completed', 'failed'].includes(item.demoStatus)) return item.demoStatus;
  // Legacy NEEDS_ANDRE also includes heuristic readiness. It is intentionally
  // preserved in legacy, but cannot become an explicit approval beacon.
  if (item.state === 'DRAFT_IDLE' || item.state === 'NEEDS_ANDRE') return 'idle';
  return 'unknown';
}
function agentStatus(agent, stale, mode) {
  if (stale) return 'stale';
  if (mode === 'DEMO' && ['working', 'reviewing', 'waiting', 'idle', 'completed', 'failed', 'unknown'].includes(agent.demoStatus)) return agent.demoStatus;
  const status = String(agent.status || '').toUpperCase();
  if (['RUNNING', 'CREATING'].includes(status)) return 'working';
  if (['FINISHED', 'COMPLETED'].includes(status)) return 'completed';
  if (['FAILED', 'ERROR'].includes(status)) return 'failed';
  if (['STOPPED', 'CANCELLED', 'CANCELED', 'IDLE'].includes(status)) return 'idle';
  return 'unknown';
}
function health(id, name, status, observedAt, message, mode) {
  return { ...common(id, name, id, null, observedAt, mode), status, message };
}

/** Adapt the existing /api/map response without changing its legacy semantics. */
export function normalizeSnapshot(snapshot = {}, { mode = 'LIVE', disconnected = false } = {}) {
  mode = MODES.has(mode) ? mode : 'LIVE';
  const observedAt = timestamp(snapshot.updatedAt ?? snapshot.observedAt);
  const repos = Array.isArray(snapshot.repos) ? snapshot.repos : [];
  // Fail closed if an accidentally replayed demo payload reaches a source path.
  // Real collectors never produce these fixture-only fields or identities.
  const items = (Array.isArray(snapshot.items) ? snapshot.items : []).filter(item => mode === 'DEMO'
    || !((typeof item?.id === 'string' && item.id.startsWith('demo:')) || item?.demoStatus || item?.agent?.demoStatus));
  const errors = Array.isArray(snapshot.errors) ? snapshot.errors.map(String) : [];
  const explicitInputLabels = new Set(Array.isArray(snapshot.explicitInputLabels)
    ? snapshot.explicitInputLabels.filter(label => typeof label === 'string').map(label => label.trim().toLowerCase())
    : WAITING_LABELS);
  const projects = ordered(repos.filter(repo => typeof repo.repo === 'string').map(repo => ({
    ...common(repo.repo, repo.name, 'github', repo.url || (/^[\w.-]+\/[\w.-]+$/.test(repo.repo) ? `https://github.com/${repo.repo}` : null), timestamp(repo.updatedAt, observedAt), mode),
    repo: repo.repo, color: /^#[\da-f]{6}$/i.test(repo.color ?? '') ? repo.color : '#8999ad',
    status: disconnected || repo.stale ? 'stale' : snapshot.loading || !timestamp(repo.updatedAt, observedAt) ? 'unknown' : 'idle',
  })));
  const byProject = new Map(projects.map(project => [project.id, project]));
  const workItems = [], agentMap = new Map(), relationships = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !byProject.has(item.repo)) continue;
    const project = byProject.get(item.repo);
    const stale = disconnected || item.stale || (item.kind !== 'deployment' && project.status === 'stale');
    const source = item.kind === 'deployment' ? 'railway' : 'github';
    const at = timestamp(item.collectedAt, item.kind === 'deployment' ? observedAt : project.observedAt);
    const isAgent = item.kind === 'agent';
    if (!isAgent) {
      const status = itemStatus(item, stale, mode, explicitInputLabels);
      const waitingReason = status === 'waiting'
        ? mode === 'DEMO' && item.waitingReason ? String(item.waitingReason)
          : `Explicit ${labelsOf(item).find(label => explicitInputLabels.has(label)) || 'input'} label requests Andre’s input.` : null;
      workItems.push({ ...common(item.id, item.title, source, item.url, at, mode),
        projectId: item.repo, type: item.kind === 'deployment' ? 'deployment' : 'pr', status,
        statusProvenance: mode === 'DEMO' ? 'demo' : ['working', 'changes_requested', 'idle'].includes(status) ? 'inferred' : 'observed',
        waitingReason, raw: item,
        activity: status === 'idle' && item.state === 'NEEDS_ANDRE'
          ? 'CI and review signals suggest readiness; no explicit approval request was observed.' : item.activity || null });
    }
    // Cursor collection can expose several actual runs for one PR. The old
    // item.agent remains supported for existing snapshots and the 2D card.
    const instances = Array.isArray(item.agentInstances) ? item.agentInstances : item.agent ? [item.agent] : [];
    for (const agent of instances) {
      if (!agent || typeof agent.id !== 'string' || !agent.id.trim()) continue;
      if (mode !== 'DEMO' && (agent.demoStatus || agent.id.startsWith('demo:'))) continue;
      const provider = mode === 'DEMO' ? String(agent.provider || 'Cursor') : 'Cursor';
      const id = `${mode === 'DEMO' ? 'demo:' : ''}${provider.toLowerCase()}:${agent.id}`;
      const linked = !isAgent;
      const entity = { ...common(id, agent.name || (isAgent ? item.title : `${provider} · ${agent.id}`), 'cursor', agent.url,
        timestamp(agent.observedAt, timestamp(item.collectedAt, observedAt)), mode),
        provider, projectId: item.repo, workItemId: linked ? item.id : null,
        status: agentStatus(agent, disconnected || Boolean(agent.stale), mode),
        statusProvenance: provenance(mode), runId: agent.id, activity: agent.activity || null,
        createdAt: timestamp(agent.createdAt ?? item.createdAt), raw: agent };
      // A linked record is richer than a duplicate standalone record. Stable
      // run identity is independent of list order and snapshot timestamps.
      const previous = agentMap.get(id);
      if (!previous || (!previous.workItemId && linked)) agentMap.set(id, entity);
    }
  }
  const agents = ordered([...agentMap.values()]);
  for (const agent of agents) {
    if (!agent.workItemId) continue;
    const type = agent.status === 'reviewing' ? 'reviews' : 'works_on';
    relationships.push({ ...common(`${agent.id}:${type}:${agent.workItemId}`, type.replaceAll('_', ' '), agent.source,
      agent.sourceUrl, agent.observedAt, mode), fromId: agent.id, toId: agent.workItemId, type,
      status: agent.status === 'stale' ? 'stale' : 'observed' });
  }
  const successfulGithubAt = projects.reduce((latest, project) => !latest || Date.parse(project.observedAt) > Date.parse(latest)
    ? project.observedAt : latest, null);
  const sources = [health('github', 'GitHub', disconnected || projects.some(project => project.status === 'stale') ? 'stale'
    : snapshot.loading || !successfulGithubAt || errors.some(error => /github|check|review|commit|actions/i.test(error)) ? 'unknown' : 'idle', successfulGithubAt,
  disconnected ? 'Connection interrupted; retained snapshot is stale.' : snapshot.loading ? 'Waiting for first collection.'
    : projects.some(project => project.status === 'stale') ? 'One or more repositories could not be refreshed.'
      : errors.some(error => /github|check|review|commit|actions/i.test(error)) ? 'Some GitHub observations are unavailable; inspect work-item freshness.'
        : 'Read-only PR and review snapshot. Review providers do not expose individual run identities here.', mode)];
  const cursorError = errors.some(error => /cursor/i.test(error));
  if (agents.length || cursorError) {
    sources.push(health('cursor', 'Cursor cloud agents', disconnected || cursorError ? 'stale'
      : observedAt ? 'idle' : 'unknown', cursorError ? null : observedAt,
    cursorError ? 'Cursor collection unavailable. No current run activity is asserted.' : 'Only runs with observable distinct IDs are shown.', mode));
  }
  const deployments = workItems.filter(item => item.type === 'deployment');
  if (deployments.length) {
    sources.push(health('railway', 'Railway deployments', disconnected || deployments.some(item => item.status === 'stale') ? 'stale' : 'idle',
      deployments.reduce((latest, item) => !latest || Date.parse(item.observedAt) > Date.parse(latest) ? item.observedAt : latest, null),
      'Existing read-only deployment observations. A building does not imply healthy infrastructure.', mode));
  }
  // The server knows which collectors are configured and when each last
  // succeeded. A refresh attempt is never promoted to a successful observation.
  for (const source of Array.isArray(snapshot.sourceHealth) ? snapshot.sourceHealth : []) {
    if (!source || !['github', 'cursor', 'railway'].includes(source.id)) continue;
    const existing = sources.find(entry => entry.id === source.id);
    const collectionStatus = String(source.status || 'unknown');
    const status = disconnected ? 'stale' : collectionStatus === 'current'
      ? source.id === 'github' && existing?.status === 'unknown' ? 'unknown' : 'idle'
      : ['stale', 'disconnected'].includes(collectionStatus) ? 'stale' : 'unknown';
    const messages = { not_configured: 'Source is not configured; no activity is asserted.',
      unavailable: 'Source is unavailable; no current activity is asserted.', unknown: 'No successful observation yet.',
      stale: 'Source could not refresh. Last successful observation is retained.',
      disconnected: 'Source is disconnected; no current activity is asserted.' };
    const replacement = { ...health(source.id, source.name || existing?.name || source.id, status,
      timestamp(source.observedAt), disconnected ? 'Connection interrupted; retained snapshot is stale.'
        : messages[collectionStatus] || existing?.message || 'Read-only source snapshot.', mode), collectionStatus };
    if (existing) sources.splice(sources.indexOf(existing), 1, replacement); else sources.push(replacement);
  }
  return { mode, observedAt, projects, workItems: ordered(workItems), agents, relationships: ordered(relationships),
    events: reduceEvents(snapshot.events ?? []).filter(event => mode === 'DEMO' || (event.provenance !== 'demo' && event.source !== 'demo')).map(event => ({
      ...event, name: String(event.name || event.type || 'Activity'), source: String(event.source || 'unknown'),
      sourceUrl: mode === 'DEMO' ? null : safeSourceUrl(event.sourceUrl), observedAt: timestamp(event.observedAt, event.at),
      status: disconnected ? 'stale' : String(event.status || 'unknown'), statusProvenance: provenance(mode), provenance: mode === 'DEMO' ? 'demo' : event.provenance === 'inferred' ? 'inferred' : 'observed' })),
    sources: ordered(sources), legacy: items.length === (snapshot.items?.length ?? 0) ? snapshot : { ...snapshot, items } };
}

export function entityById(state, id) {
  if (!state || typeof id !== 'string') return null;
  for (const key of ['projects', 'workItems', 'agents']) {
    const entity = state[key]?.find(entry => entry.id === id);
    if (entity) return entity;
  }
  return null;
}
export function relatedTo(state, id) {
  if (!entityById(state, id)) return [];
  return (state.relationships ?? []).filter(edge => edge.fromId === id || edge.toId === id)
    .map(relationship => ({ relationship, entity: entityById(state, relationship.fromId === id ? relationship.toId : relationship.fromId) }))
    .filter(entry => entry.entity);
}
export function needsAndre(state) {
  return ordered((state?.workItems ?? []).filter(item => item.status === 'waiting' && Boolean(item.waitingReason)));
}
export function cycleWaiting(state, currentId, direction = 1) {
  const waiting = needsAndre(state);
  if (!waiting.length) return null;
  const index = waiting.findIndex(item => item.id === currentId);
  const step = direction < 0 ? -1 : 1;
  return waiting[index < 0 ? step < 0 ? waiting.length - 1 : 0 : (index + step + waiting.length) % waiting.length];
}

/** Idempotent bounded event history; event IDs are source identities, not time. */
export function reduceEvents(events = []) {
  const byId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.id !== 'string' || !event.id || !timestamp(event.at) || typeof event.entityId !== 'string') continue;
    // The first occurrence is immutable; replaying the same ID cannot rewrite history.
    if (!byId.has(event.id)) byId.set(event.id, { ...event });
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id)).slice(-MAX_EVENTS);
}

/** Replace state from a full snapshot on reconnect; do not retain deleted runs. */
export function recoverSnapshot(current, incoming) {
  if (!incoming) return current;
  if (!current || current.mode !== incoming.mode) return { ...incoming, events: reduceEvents(incoming.events) };
  const previousAt = Date.parse(current.observedAt), incomingAt = Date.parse(incoming.observedAt);
  if (Number.isFinite(previousAt) && Number.isFinite(incomingAt) && incomingAt < previousAt) return current;
  return { ...incoming, events: reduceEvents([...(current.events ?? []), ...(incoming.events ?? [])]) };
}
