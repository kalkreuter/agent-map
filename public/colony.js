import { normalizeSnapshot, entityById, relatedTo, needsAndre, cycleWaiting, safeSourceUrl, recoverSnapshot } from './scene-state.js';
import { demoState, DEMO_STEPS } from './demo-state.js';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const explicitMode = String(query.get('mode') || '').toUpperCase();
const modes = new Set(['DEMO', 'RECORDED', 'LIVE']);
const demoOptions = { crowded: query.get('crowded') === '1', stale: query.get('stale') === '1' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const listeners = [];
let state = null, rawSnapshot = null, renderer = null, selectedId = null, followingId = null;
let mode = modes.has(explicitMode) ? explicitMode : null;
let demoStep = Math.max(0, Math.min(DEMO_STEPS.length - 1, Number.parseInt(query.get('step'), 10) || 0));
let playing = false, replayTimer = null, pollTimer = null, fallbackTimer = null, request = null;
let disposed = false, generation = 0, lastSelectionTrigger = null, disconnected = false;
let rendererKind = '3d', rendererGeneration = 0;

function listen(target, event, callback, options) {
  target.addEventListener(event, callback, options);
  listeners.push(() => target.removeEventListener(event, callback, options));
}
function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = String(value);
  return element;
}
function age(value) {
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return 'time unknown';
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
function dateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Observation time unknown';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' }).format(new Date(value));
}
function kind(entity) {
  if (state?.projects.some(entry => entry.id === entity.id)) return 'project';
  if (state?.agents.some(entry => entry.id === entity.id)) return 'agent';
  return entity.type === 'deployment' ? 'deployment' : 'pr';
}
function icon(entity) { return ({ project: '⬡', agent: '◉', deployment: '⌁', pr: '▣' })[kind(entity)]; }
function typeName(entity) { return ({ project: 'Project district', agent: `${entity.provider || 'Agent'} run`, deployment: 'Deployment observation', pr: 'PR work site' })[kind(entity)]; }
const statusNames = { working: 'Working', reviewing: 'Reviewing', waiting: 'Waiting for Andre', idle: 'Idle', completed: 'Run completed', failed: 'Failed', blocked: 'Blocked', unknown: 'Unknown', stale: 'Stale observation', merged: 'PR merged', deployed: 'Deployment succeeded', changes_requested: 'Changes requested' };
const statusIcons = { working: '↗', reviewing: '◎', waiting: '?', idle: '·', completed: '✓', failed: '!', blocked: '!', unknown: '—', stale: '◷', merged: '✓', deployed: '✓', changes_requested: '!' };
function statusLabel(entity) {
  if (entity.status === 'completed' && kind(entity) !== 'agent') return 'Completed work';
  return statusNames[entity.status] || 'Unknown';
}
function sourceName(value) {
  const name = typeof value === 'object' ? value?.name || value?.id : value;
  return ({ demo: 'Synthetic demo', github: 'GitHub', cursor: 'Cursor', railway: 'Railway' })[name] || String(name || 'Unknown source');
}
function flatUrl() {
  const params = new URLSearchParams();
  if (mode) params.set('mode', mode.toLowerCase());
  if (mode === 'DEMO') {
    params.set('step', String(demoStep));
    if (demoOptions.crowded) params.set('crowded', '1');
    if (demoOptions.stale) params.set('stale', '1');
  }
  return `/2d${params.size ? `?${params}` : ''}`;
}
function updateAddress() {
  const params = new URLSearchParams(location.search);
  params.set('mode', mode.toLowerCase());
  if (mode === 'DEMO') params.set('step', String(demoStep)); else {
    params.delete('step'); params.delete('crowded'); params.delete('stale');
  }
  history.replaceState(null, '', `${location.pathname}?${params}`);
  $('flat-link').href = flatUrl();
  $('fallback-link').href = flatUrl();
}
function announce(message) { $('announcer').textContent = message; }
function showNotice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function updateMode() {
  $('data-mode').value = mode || 'LIVE';
  $('mode-dot').dataset.mode = mode || 'LIVE';
  $('mode-caption').textContent = mode === 'RECORDED' && rendererKind === 'flat' ? 'Captured history · 2D' : ({ DEMO: 'Synthetic replay', RECORDED: 'Captured history', LIVE: 'Observed sources' })[mode] || 'Connecting';
  $('flat-link').firstChild.textContent = rendererKind === 'flat' ? '3D view ' : '2D view ';
  $('demo-panel').hidden = mode !== 'DEMO';
  $('recorded-empty').hidden = mode !== 'RECORDED' || Boolean(rawSnapshot);
  $('flat-link').href = flatUrl();
  $('fallback-link').href = flatUrl();
}
function fact(label, value, navigateId) {
  if (value === undefined || value === null || value === '') return;
  const row = node('div'), description = node('dd');
  row.append(node('dt', '', label));
  if (navigateId) {
    const button = node('button', '', value);
    button.type = 'button'; button.className = 'fact-navigation';
    button.addEventListener('click', () => selectEntity(navigateId, { fly: true }));
    description.append(button);
  } else description.textContent = String(value);
  row.append(description); $('card-facts').append(row);
}
function activity(entity) {
  if (entity.waitingReason) return entity.waitingReason;
  if (entity.activity) return entity.activity;
  if (kind(entity) === 'project') {
    const items = state.workItems.filter(item => item.projectId === entity.id).length;
    const agents = state.agents.filter(agent => agent.projectId === entity.id).length;
    return `${items} work site${items === 1 ? '' : 's'} and ${agents} observable agent run${agents === 1 ? '' : 's'} in this district.`;
  }
  if (entity.status === 'stale') return 'The last observation is retained. Current activity is unverified.';
  if (entity.status === 'unknown') return 'This source has not provided enough evidence to describe current activity.';
  if (entity.status === 'completed' && kind(entity) === 'agent') return 'This run finished. PR review, merge, deployment, and feature enablement are separate observations.';
  if (entity.status === 'merged') return 'The source reports this PR as merged. Deployment and feature enablement are tracked separately.';
  if (entity.status === 'deployed') return 'An existing deployment source reports success. This does not establish feature enablement or service health.';
  return `${statusLabel(entity)} · ${typeName(entity).toLowerCase()}.`;
}
function renderReviews(entity) {
  const reviews = entity.raw?.reviewers;
  $('card-reviews').replaceChildren();
  $('card-reviews').hidden = !Array.isArray(reviews) || !reviews.length;
  if ($('card-reviews').hidden) return;
  $('card-reviews').append(node('h3', '', 'REVIEW EVIDENCE'));
  for (const review of reviews.slice(0, 6)) {
    const row = node('div', 'review-line');
    row.append(node('strong', '', review.name || 'Reviewer'), node('span', '', `${review.currentHead ? 'Current head' : review.lastReviewedSha ? 'Older head' : 'SHA unknown'} · ${review.complete === false ? '?' : review.openFindings ?? '?'} findings`));
    $('card-reviews').append(row);
  }
  $('card-reviews').append(node('p', 'review-note', 'Findings use the existing source heuristics. Verify resolution in the PR.'));
}
function relationshipLabel(relationship) {
  const labels = { works_on: 'Works on', reviews: 'Reviews', depends_on: 'Depends on', handoff: 'Handoff', creates: 'Creates worker', orchestrates: 'Coordinates', member_of: 'In district' };
  const proof = relationship.provenance === 'demo' ? 'demo' : relationship.provenance === 'inferred' ? 'inferred' : 'observed';
  return `${labels[relationship.type] || String(relationship.type || 'Related').replaceAll('_', ' ')} · ${proof}`;
}
function renderCard() {
  const entity = entityById(state, selectedId);
  if (!entity) { closeDetails(); return; }
  const entityKind = kind(entity), project = entityById(state, entity.projectId);
  $('card-eyebrow').textContent = `${project ? `${project.name} / ` : ''}${typeName(entity)}`;
  $('card-title').textContent = entity.name;
  $('card-icon').textContent = icon(entity);
  $('card-status').textContent = `${statusIcons[entity.status] || '—'} ${statusLabel(entity)}`;
  $('card-status').dataset.status = entity.status;
  $('card-activity').textContent = activity(entity);
  const warnings = [];
  if (entity.status === 'stale') warnings.push('Stale source. Verify the current state at the source before making a decision.');
  if (entity.raw?.warning) warnings.push(String(entity.raw.warning));
  if (entity.raw?.dataComplete === false) warnings.push('Some source data is incomplete.');
  if (entityKind === 'agent' && entity.status === 'completed') warnings.push('Run complete does not mean the PR was approved, merged, or deployed.');
  $('card-warning').textContent = warnings.join(' '); $('card-warning').hidden = !warnings.length;
  $('card-facts').replaceChildren();
  if (project) fact('PROJECT', project.name, project.id);
  if (entityKind === 'project') {
    fact('REPOSITORY', entity.repo || entity.id);
    fact('OBSERVATION', entity.status === 'stale' ? 'Retained snapshot; current work unverified' : 'Read-only source data');
  }
  if (entityKind === 'agent') {
    const work = entityById(state, entity.workItemId);
    fact('WORK SITE', work ? work.name : 'No verified work-item assignment', work?.id);
    fact('RUN IDENTITY', entity.runId || entity.id);
    if (entity.createdAt) fact('RUN CREATED', dateTime(entity.createdAt));
  }
  if (entityKind === 'pr') {
    fact('MERGE', entity.raw?.mergedAt ? `Merged ${dateTime(entity.raw.mergedAt)}` : 'No merge observed in this snapshot');
    if (entity.raw?.number) fact('PULL REQUEST', `#${entity.raw.number}${entity.raw.draft ? ' · Draft' : ''}`);
    if (entity.raw?.headSha) fact('HEAD COMMIT', `${String(entity.raw.headSha).slice(0, 7)}${entity.raw.headAt ? ` · ${dateTime(entity.raw.headAt)}` : ''}`);
    const ci = entity.raw?.ci;
    if (ci) fact('CONTINUOUS INTEGRATION', `${({ success: 'Passing', failure: 'Failing', pending: 'In progress' })[ci.state] || 'Unknown'}${ci.total ? ` · ${ci.passed ?? 0} passed / ${ci.pending ?? 0} pending / ${ci.failed ?? 0} failed` : ''}`);
  }
  if (entityKind === 'deployment') {
    const raw = entity.raw || {}, deployment = raw.deployment || {}, sync = raw.sync || {};
    fact('SERVICE / ENVIRONMENT', `${raw.serviceName || 'Unknown service'} / ${raw.environmentName || 'Unknown environment'}`);
    fact('DEPLOYMENT STATUS', deployment.status || 'Unknown');
    fact('LIVE COMMIT', deployment.live?.sha ? String(deployment.live.sha).slice(0, 7) : 'No active commit reported');
    fact('BRANCH COMPARISON', entity.status === 'stale' ? 'Stale; comparison unverified' : sync.status || 'Unknown');
  }
  const relationships = relatedTo(state, entity.id);
  $('card-related').replaceChildren();
  const linked = new Set();
  for (const { relationship, entity: related } of relationships) {
    linked.add(related.id);
    appendRelated(related, relationshipLabel(relationship));
  }
  if (entityKind === 'project') {
    for (const child of [...state.workItems, ...state.agents].filter(item => item.projectId === entity.id).slice(0, 12)) {
      if (!linked.has(child.id)) appendRelated(child, `${typeName(child)} · ${statusLabel(child)}`);
    }
  }
  $('card-related-section').hidden = !$('card-related').childElementCount;
  $('card-observed').textContent = `${sourceName(entity.source)} · observed ${entity.observedAt ? dateTime(entity.observedAt) : 'at an unknown time'}`;
  $('card-provenance').textContent = `${entity.statusProvenance === 'demo' ? 'Synthetic demo evidence' : entity.statusProvenance === 'inferred' ? 'Status inferred by existing source rules' : 'Observed source evidence'}${mode === 'RECORDED' ? ' · imported recording' : ''}`;
  const sourceUrl = safeSourceUrl(entity.sourceUrl);
  $('source-link').hidden = !sourceUrl;
  if (sourceUrl) $('source-link').href = sourceUrl; else $('source-link').removeAttribute('href');
  $('source-link').textContent = entityKind === 'pr' && entity.status === 'waiting' ? 'Open approval location ↗' : 'Open at source ↗';
  $('follow-agent').hidden = entityKind !== 'agent' || typeof renderer?.follow !== 'function';
  $('follow-agent').textContent = followingId === entity.id ? 'Stop following' : 'Follow robot';
  $('follow-agent').setAttribute('aria-pressed', String(followingId === entity.id));
  renderReviews(entity);
  $('details-card').hidden = false;
  document.body.classList.add('has-selection');
}
function appendRelated(entity, description) {
  const button = node('button', 'related-button'); button.type = 'button'; button.dataset.relatedId = entity.id;
  const content = node('span'); content.append(node('strong', '', entity.name), node('small', '', description));
  button.append(content, node('span', '', '↗'));
  button.addEventListener('click', () => selectEntity(entity.id, { fly: true }));
  $('card-related').append(button);
}
function selectEntity(id, { fly = false, focus = true } = {}) {
  if (!entityById(state, id)) return;
  if (followingId && followingId !== id) { followingId = null; renderer?.follow?.(null); }
  selectedId = id; renderer?.select(id);
  if (fly) renderer?.focus(id);
  renderCard(); renderList();
  if (focus) $('details-card').focus({ preventScroll: true });
}
function closeDetails(restoreFocus = false) {
  selectedId = null; followingId = null;
  renderer?.select(null); renderer?.follow?.(null);
  $('details-card').hidden = true;
  document.body.classList.remove('has-selection');
  if (restoreFocus) lastSelectionTrigger?.focus({ preventScroll: true });
  renderList();
}
function navigateWaiting(direction = 1) {
  const next = cycleWaiting(state, selectedId, direction);
  if (!next) {
    announce('Nothing explicitly needs Andre right now. Open pull requests alone do not count as an input request.');
    showNotice('Nothing explicitly needs Andre right now. Open PRs alone do not count as input requests.');
    return;
  }
  selectEntity(next.id, { fly: true });
  announce(`${next.name}. ${next.waitingReason}`);
}
function renderList() {
  $('entity-list').replaceChildren();
  if (!state) return;
  const search = $('entity-search').value.trim().toLowerCase();
  const groups = [['DISTRICTS', state.projects], ['WORK SITES', state.workItems], ['ROBOT RUNS', state.agents]];
  let count = 0;
  for (const [label, entries] of groups) {
    const matches = entries.filter(entity => `${entity.name} ${entity.provider || ''} ${entity.status}`.toLowerCase().includes(search));
    if (!matches.length) continue;
    $('entity-list').append(node('p', 'list-group', `${label} · ${matches.length}`));
    for (const entity of matches) {
      const button = node('button', 'entity-list-button'); button.type = 'button'; button.dataset.entityId = entity.id;
      button.setAttribute('aria-pressed', String(selectedId === entity.id));
      const content = node('span'); content.append(node('strong', 'entity-list-name', entity.name), node('span', 'entity-list-status', `${typeName(entity)} · ${statusLabel(entity)}`));
      button.append(node('span', '', icon(entity)), content);
      button.addEventListener('click', () => { lastSelectionTrigger = $('explore-toggle'); $('object-list').hidden = true; $('explore-toggle').setAttribute('aria-expanded', 'false'); selectEntity(entity.id, { fly: true }); });
      $('entity-list').append(button); count++;
    }
  }
  if (!count) $('entity-list').append(node('p', 'list-empty', search ? 'No matching projects, work sites, or robots.' : 'No observed work or runs in this snapshot.'));
}
function renderSummary() {
  const working = state.agents.filter(agent => ['working', 'reviewing'].includes(agent.status)).length;
  $('colony-summary').textContent = `${state.projects.length} district${state.projects.length === 1 ? '' : 's'} · ${state.agents.length} robot run${state.agents.length === 1 ? '' : 's'} · ${working} active`;
  const waiting = needsAndre(state);
  $('needs-count').textContent = String(waiting.length);
  $('attention-description').textContent = waiting.length ? `${waiting.length} explicit decision${waiting.length === 1 ? '' : 's'} waiting` : 'No explicit input requests';
  $('previous-waiting').disabled = !waiting.length; $('next-waiting').disabled = !waiting.length;
  const unhealthy = state.sources.filter(source => ['stale', 'unknown'].includes(source.status));
  $('source-indicator').classList.toggle('stale', Boolean(unhealthy.length));
  if (mode === 'DEMO') $('source-status').textContent = demoOptions.stale ? 'Demo · stale source / simulated disconnect' : 'Demo colony · no real work is running';
  else if (mode === 'RECORDED') $('source-status').textContent = rawSnapshot ? `Recorded · ${dateTime(state.observedAt)}` : 'No recording loaded';
  else $('source-status').textContent = disconnected ? 'Disconnected · retained observations' : unhealthy.length ? 'Live · source coverage incomplete' : `Live · observed ${age(state.observedAt)}`;
  $('source-count').textContent = mode === 'DEMO' ? 'SYNTHETIC' : 'READ ONLY';
  $('source-status').title = state.sources.map(source => `${source.name}: ${source.message || source.status}${source.observedAt ? ` Last observed ${dateTime(source.observedAt)}.` : ''}`).join('\n');
}
function applyState(next) {
  if (disposed) return;
  state = next;
  renderer?.update(state);
  $('loading').hidden = true;
  updateMode(); renderSummary(); renderList();
  if (selectedId) renderCard();
}
function renderDemoControls() {
  const current = DEMO_STEPS[demoStep];
  $('demo-title').textContent = current.title;
  $('demo-detail').textContent = current.detail;
  $('demo-step-count').textContent = `${String(demoStep + 1).padStart(2, '0')} / ${String(DEMO_STEPS.length).padStart(2, '0')}`;
  $('demo-play').textContent = playing ? 'Ⅱ' : '▶';
  $('demo-play').setAttribute('aria-label', playing ? 'Pause demo replay' : 'Play demo replay');
  $('demo-next').disabled = demoStep >= DEMO_STEPS.length - 1;
  for (const [index, button] of [...$('demo-timeline').children].entries()) {
    button.setAttribute('aria-current', index === demoStep ? 'step' : 'false');
    button.classList.toggle('past', index < demoStep);
  }
}
function setDemoStep(nextStep) {
  if (mode !== 'DEMO') return;
  demoStep = Math.max(0, Math.min(DEMO_STEPS.length - 1, Math.trunc(nextStep)));
  applyState(demoState(demoStep, demoOptions));
  renderDemoControls(); updateAddress();
  announce(`Synthetic replay. ${DEMO_STEPS[demoStep].title}. ${DEMO_STEPS[demoStep].detail}`);
}
function scheduleReplay() {
  clearTimeout(replayTimer);
  if (!playing || document.hidden || mode !== 'DEMO' || disposed) return;
  replayTimer = setTimeout(() => {
    if (demoStep >= DEMO_STEPS.length - 1) { playing = false; renderDemoControls(); return; }
    setDemoStep(demoStep + 1);
    if (demoStep >= DEMO_STEPS.length - 1) playing = false;
    renderDemoControls(); scheduleReplay();
  }, 5200);
}
function togglePlay() {
  if (!playing && demoStep >= DEMO_STEPS.length - 1) setDemoStep(0);
  playing = !playing; renderDemoControls(); scheduleReplay();
}
function stopAsync() {
  clearTimeout(pollTimer); clearTimeout(replayTimer);
  request?.abort(); request = null; playing = false; generation++;
}
async function poll() {
  if (disposed || mode === 'DEMO' || mode === 'RECORDED' || document.hidden) return;
  clearTimeout(pollTimer);
  const currentGeneration = generation;
  request?.abort(); const controller = new AbortController(); request = controller;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const url = mode === 'LIVE' ? '/api/map?mode=live' : '/api/map';
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (currentGeneration !== generation || request !== controller || disposed) return;
    if (response.status === 401) { showNotice('Authentication is required. Reload to sign in with your existing map credentials.'); $('loading').hidden = true; return; }
    if (!response.ok) throw new Error('Snapshot unavailable');
    const data = await response.json();
    if (currentGeneration !== generation || request !== controller || disposed) return;
    if (mode === null && data.mode === 'DEMO') { mode = 'DEMO'; showNotice(''); setDemoStep(demoStep); updateAddress(); return; }
    if (data.mode === 'DEMO' || (Array.isArray(data.items) && data.items.some(item => (typeof item?.id === 'string' && item.id.startsWith('demo:')) || item?.demoStatus))) throw new Error('Synthetic snapshot refused');
    mode = 'LIVE'; rawSnapshot = data; disconnected = false;
    const next = normalizeSnapshot(data, { mode: 'LIVE' });
    applyState(recoverSnapshot(state, next)); updateAddress();
    const errors = Array.isArray(data.errors) ? data.errors.map(String) : [];
    showNotice(errors.length ? errors.join(' ').slice(0, 600) : data.loading ? 'Waiting for the first source collection. Current activity is unknown.' : '');
  } catch (error) {
    if (currentGeneration !== generation || request !== controller || disposed || (error.name === 'AbortError' && document.hidden)) return;
    disconnected = true; mode = 'LIVE';
    applyState(normalizeSnapshot(rawSnapshot || {}, { mode: 'LIVE', disconnected: true }));
    showNotice(error.message === 'Synthetic snapshot refused' ? 'The source returned synthetic data. LIVE remains empty until observed sources are available.' : 'Connection interrupted. The last observations are retained as stale; current activity is unverified. Retrying automatically.');
  } finally {
    clearTimeout(timeout);
    if (currentGeneration === generation && request === controller && !disposed && mode === 'LIVE' && !document.hidden) pollTimer = setTimeout(poll, rawSnapshot?.loading ? 2000 : 60_000);
  }
}
function switchMode(nextMode) {
  if (!modes.has(nextMode)) return;
  stopAsync(); closeDetails(); state = null; rawSnapshot = null; disconnected = false; mode = nextMode;
  clearTimeout(fallbackTimer); $('fallback').hidden = true;
  showNotice(''); updateMode(); updateAddress();
  if ((!renderer || renderer.contextLost || rendererKind === 'flat' && mode !== 'RECORDED')) void initialize3D();
  if (mode === 'DEMO') { setDemoStep(demoStep); renderDemoControls(); }
  else if (mode === 'RECORDED') { applyState(normalizeSnapshot({}, { mode: 'RECORDED' })); $('recorded-empty').hidden = false; }
  else { applyState(normalizeSnapshot({}, { mode: 'LIVE' })); $('loading').hidden = false; void poll(); }
  if (rendererKind === 'flat' && mode !== 'RECORDED') void initialize3D();
}
async function importRecording(file) {
  if (!file) return;
  try {
    if (file.size > 10_000_000) throw new Error('Choose a recording smaller than 10 MB.');
    const captured = JSON.parse(await file.text());
    if (!captured || !Array.isArray(captured.repos) || !Array.isArray(captured.items) || !Number.isFinite(Date.parse(captured.updatedAt))) throw new Error('Use a captured /api/map JSON snapshot with repos, items, and an original updatedAt timestamp.');
    if (String(captured.mode).toUpperCase() === 'DEMO' || captured.items.some(item => (typeof item?.id === 'string' && item.id.startsWith('demo:')) || item?.demoStatus || item?.source === 'demo' || item?.provenance === 'demo' || item?.agent?.demoStatus || (Array.isArray(item?.agentInstances) && item.agentInstances.some(agent => agent?.demoStatus || agent?.provenance === 'demo')))
      || (captured.events || []).some(event => event?.source === 'demo' || event?.provenance === 'demo')) throw new Error('Synthetic demo data belongs in DEMO mode. Import an observed source snapshot.');
    if (mode !== 'RECORDED') return;
    rawSnapshot = captured;
    applyState(normalizeSnapshot(captured, { mode: 'RECORDED' }));
    showNotice('Imported recording. Observation times are preserved; this view does not fetch live updates.');
    renderer?.fit();
  } catch (error) { showNotice(error instanceof SyntaxError ? 'That file is not valid JSON. Choose a captured Agent Map snapshot.' : error.message); }
  finally { $('recording-file').value = ''; }
}
async function initialize3D() {
  const token = ++rendererGeneration;
  try {
    const { ColonyMap } = await import('./colony-map.js');
    if (disposed || token !== rendererGeneration) return;
    renderer?.dispose(); renderer = null;
    $('colony-world').replaceChildren(); document.body.classList.remove('flat-scene');
    rendererKind = '3d'; updateMode();
    renderer = new ColonyMap($('colony-world'), id => { lastSelectionTrigger = $('explore-toggle'); selectEntity(id); }, rendererFailure);
    if (state) renderer.update(state);
    if (selectedId) renderer.select(selectedId);
    if (selectedId) renderCard();
  } catch { if (token === rendererGeneration) rendererFailure(); }
}
async function showRecordedFlat(fromFailure = false) {
  if (disposed || mode !== 'RECORDED') return;
  const token = ++rendererGeneration;
  try {
    const { HexMap } = await import('./hex-map.js');
    if (disposed || mode !== 'RECORDED' || token !== rendererGeneration) return;
    renderer?.dispose(); renderer = null; followingId = null;
    clearTimeout(fallbackTimer); $('fallback').hidden = true; $('loading').hidden = true;
    const host = $('colony-world'); host.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'), viewport = document.createElementNS(ns, 'g');
    svg.id = 'recorded-flat-map'; svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'Recorded 2D map. Drag to pan, scroll or pinch to zoom. Select a tile or use Explore colony for keyboard navigation.');
    svg.append(viewport); host.append(svg);
    const rawToEntity = id => {
      if (entityById(state, id)) return id;
      const item = state?.legacy?.items?.find(entry => entry.id === id);
      return state?.agents.find(agent => agent.runId === item?.agent?.id && agent.projectId === item?.repo)?.id;
    };
    const entityToRaw = id => {
      const entity = entityById(state, id);
      if (entity && kind(entity) === 'agent') return state?.legacy?.items?.find(item => item.kind === 'agent' && item.agent?.id === entity.runId)?.id || entity.workItemId;
      return id;
    };
    const map = new HexMap(svg, viewport, id => { const normalizedId = rawToEntity(id); if (normalizedId) selectEntity(normalizedId); });
    let initial = true;
    renderer = {
      update(next) { const legacy = next.legacy || {}; map.setItems(legacy.items || [], legacy.repos || [], legacy.states || {}, initial); initial = false; },
      select(id) { map.select(entityToRaw(id)); },
      focus(id) { map.select(entityToRaw(id)); },
      fit() { map.fit(); }, zoom(factor) { map.zoom(factor); },
      stats() { return { type: '2d', recorded: true }; },
      dispose() { map.dispose(); svg.remove(); },
    };
    rendererKind = 'flat'; document.body.classList.add('flat-scene'); updateMode();
    if (state) renderer.update(state);
    if (selectedId) { renderer.select(selectedId); renderCard(); }
    if (fromFailure) showNotice('3D rendering is unavailable. Your imported recording remains in this read-only 2D view with its original timestamps.');
    else showNotice('Recorded 2D view. The same imported observations and original timestamps are retained in memory.');
  } catch { showNotice('The 2D renderer could not load. Your recording remains available in the keyboard explorer.'); }
}
function rendererFailure() {
  if (mode === 'RECORDED') { void showRecordedFlat(true); return; }
  if (disposed || !$('fallback').hidden) return;
  $('loading').hidden = true;
  $('fallback').hidden = false;
  $('fallback-message').textContent = '3D rendering could not initialize or recover. Opening the existing 2D map with the same data mode.';
  const target = new URL(flatUrl(), location.origin); target.searchParams.set('fallback', 'webgl');
  $('fallback-link').href = `${target.pathname}${target.search}`;
  const fallbackGeneration = generation;
  fallbackTimer = setTimeout(() => { if (!disposed && generation === fallbackGeneration) location.replace(`${target.pathname}${target.search}`); }, 1600);
}
function dispose() {
  if (disposed) return;
  disposed = true; stopAsync(); clearTimeout(fallbackTimer);
  for (const remove of listeners) remove();
  renderer?.dispose(); renderer = null;
}

for (const [index, step] of DEMO_STEPS.entries()) {
  const button = node('button'); button.type = 'button'; button.setAttribute('aria-label', `Replay ${step.title}`); button.title = step.title;
  listen(button, 'click', () => { playing = false; clearTimeout(replayTimer); setDemoStep(index); });
  $('demo-timeline').append(button);
}
listen($('flat-link'), 'click', event => { if (mode !== 'RECORDED') return; event.preventDefault(); if (rendererKind === 'flat') void initialize3D(); else void showRecordedFlat(); });
listen($('data-mode'), 'change', event => switchMode(event.target.value));
listen($('recording-file'), 'change', event => { void importRecording(event.target.files[0]); });
listen($('demo-play'), 'click', togglePlay);
listen($('demo-next'), 'click', () => { playing = false; clearTimeout(replayTimer); setDemoStep(demoStep + 1); });
listen($('demo-restart'), 'click', () => { playing = false; clearTimeout(replayTimer); setDemoStep(0); });
listen($('needs-andre'), 'click', () => { lastSelectionTrigger = $('needs-andre'); navigateWaiting(); });
listen($('next-waiting'), 'click', () => { lastSelectionTrigger = $('next-waiting'); navigateWaiting(1); });
listen($('previous-waiting'), 'click', () => { lastSelectionTrigger = $('previous-waiting'); navigateWaiting(-1); });
listen($('close-details'), 'click', () => closeDetails(true));
listen($('follow-agent'), 'click', () => { followingId = followingId === selectedId ? null : selectedId; renderer?.follow?.(followingId); renderCard(); });
listen($('colony-world'), 'colony-follow-stopped', () => { followingId = null; if (selectedId) renderCard(); });
listen($('entity-search'), 'input', renderList);
listen($('explore-toggle'), 'click', () => { const open = $('object-list').hidden; $('object-list').hidden = !open; $('explore-toggle').setAttribute('aria-expanded', String(open)); if (open) $('entity-search').focus(); });
listen($('close-list'), 'click', () => { $('object-list').hidden = true; $('explore-toggle').setAttribute('aria-expanded', 'false'); $('explore-toggle').focus(); });
listen($('help-toggle'), 'click', () => { $('camera-help').hidden = !$('camera-help').hidden; $('help-toggle').setAttribute('aria-expanded', String(!$('camera-help').hidden)); });
listen($('zoom-in'), 'click', () => renderer?.zoom(1.2));
listen($('zoom-out'), 'click', () => renderer?.zoom(1 / 1.2));
listen($('reset-view'), 'click', () => { followingId = null; renderer?.follow?.(null); renderer?.fit(); if (selectedId) renderCard(); });
listen(document, 'keydown', event => { if (event.key !== 'Escape') return; if (!$('object-list').hidden) { $('object-list').hidden = true; $('explore-toggle').setAttribute('aria-expanded', 'false'); $('explore-toggle').focus(); } else if (!$('camera-help').hidden) { $('camera-help').hidden = true; $('help-toggle').setAttribute('aria-expanded', 'false'); } else closeDetails(true); });
listen(document, 'visibilitychange', () => {
  if (document.hidden) { clearTimeout(replayTimer); clearTimeout(pollTimer); request?.abort(); }
  else if (mode === 'DEMO') scheduleReplay(); else if (mode === 'LIVE' || mode === null) void poll();
});
listen(window, 'pagehide', dispose);
listen(reducedMotion, 'change', () => { if (reducedMotion.matches) { followingId = null; renderer?.follow?.(null); if (selectedId) renderCard(); } });

window.agentMap = { get state() { return state; }, get renderer() { return renderer; }, select: (id, options) => selectEntity(id, options), setDemoStep, dispose };
updateMode(); renderDemoControls();
if (mode === 'DEMO') setDemoStep(demoStep);
else if (mode === 'RECORDED') applyState(normalizeSnapshot({}, { mode: 'RECORDED' }));
else void poll();
void initialize3D();
