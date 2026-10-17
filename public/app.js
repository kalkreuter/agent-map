import { HexMap } from './hex-map.js';
import { normalizeSnapshot, needsAndre, cycleWaiting } from './scene-state.js';
import { demoState } from './demo-state.js';
const $ = id => document.getElementById(id);
let snapshot, scene, selectedId, pollTimer, configurationKey;
const viewParams = typeof location === 'undefined' ? null : new URLSearchParams(location.search);
const map = new HexMap($('map'), $('viewport'), openCard);
const repoFilter = $('repo-filter'), stateFilter = $('state-filter');

function age(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (!Number.isFinite(minutes)) return 'unknown age';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
function text(tag, className, value) {
  const element = document.createElement(tag); element.className = className; element.textContent = value; return element;
}
function safeLink(element, value, origin) {
  try { const url = new URL(value); if (url.origin !== origin || url.username || url.password) throw new Error(); element.href = url.href; element.hidden = false; }
  catch { element.removeAttribute('href'); element.hidden = true; }
}
function shortSha(value) { return typeof value === 'string' && value ? value.slice(0, 7) : 'SHA unknown'; }
function deploymentVersion(deployment) {
  return `${shortSha(deployment.sha)} · ${deployment.createdAt ? age(deployment.createdAt) : 'time unknown'} · ${deployment.status || 'status unknown'}`;
}
function deploymentFact(label, value, detail = '', className = '') {
  const row = text('div', className, ''); const description = text('dd', '', value);
  if (detail) description.append(text('span', 'fact-detail', detail));
  row.append(text('dt', '', label), description); $('card-deployment-facts').append(row);
}
function renderDeployment(item) {
  const deployment = item.deployment ?? {}, sync = item.sync ?? {};
  const branch = sync.branch || item.branch || 'main', live = deployment.live, latest = deployment.latest;
  const knownShas = Boolean(live?.sha && sync.headSha);
  const comparison = item.stale ? 'stale' : !knownShas || (sync.status === 'current' && live.sha !== sync.headSha)
    ? 'unknown' : sync.status;
  const production = /^(prod|production)$/i.test(item.environmentName ?? '');
  const count = Number.isInteger(sync.behindBy) && sync.behindBy > 0 ? ` by ${sync.behindBy} commit${sync.behindBy === 1 ? '' : 's'}` : '';
  const comparisons = {
    current: `Live deployment matches ${branch}.`,
    behind: `${production ? 'Production is' : 'Live deployment is'} behind ${branch}${count}.`,
    ahead: `Live deployment is ahead of ${branch}.`,
    diverged: `Live deployment has diverged from ${branch}.`,
    stale: `Stale — comparison with ${branch} is unverified.`,
    unknown: `Unknown — comparison with ${branch} is unverified.`,
  };
  $('card-deployment-facts').replaceChildren();
  deploymentFact('SERVICE / ENVIRONMENT', `${item.serviceName || 'Unknown service'} / ${item.environmentName || 'Unknown environment'}`);
  deploymentFact('RAILWAY STATUS', deployment.status || 'Unknown');
  deploymentFact('LIVE DEPLOYMENT', live ? deploymentVersion(live) : 'No active deployment reported');
  if (latest && (!live || !latest.id || !live.id || latest.id !== live.id)) {
    deploymentFact('LATEST ATTEMPT', deploymentVersion(latest), live ? 'Latest recorded attempt; active version shown above.' : 'No active deployment is reported for this service.');
  }
  deploymentFact(`LIVE VS ${branch.toUpperCase()}`, comparisons[comparison] ?? comparisons.unknown,
    `${branch} head: ${shortSha(sync.headSha)} · live: ${shortSha(live?.sha)}`, comparison === 'behind' ? 'deployment-behind' : '');
  if (item.branch) deploymentFact('TRACKED BRANCH', item.branch);
  deploymentFact('COLLECTION', item.collectedAt ? `Collected ${age(item.collectedAt)}` : 'Collection time unknown',
    item.stale ? 'Stale snapshot — verify current status in Railway.' : item.dataComplete === false ? 'Incomplete deployment data.' : '');
}
function closeCard(restoreFocus = false) {
  const tile = [...$('viewport').querySelectorAll('.tile')].find(element => element.dataset.id === selectedId);
  $('card').hidden = true; selectedId = null; map.select(null);
  if (restoreFocus) tile?.focus({ preventScroll: true });
}
function openCard(id, focus = true) {
  const item = snapshot?.items.find(entry => entry.id === id); if (!item) return closeCard();
  selectedId = id;
  const isAgent = item.kind === 'agent', isDeployment = item.kind === 'deployment';
  const repo = snapshot.repos.find(project => project.repo === item.repo) ?? { name: item.repo };
  const state = snapshot.states[item.state] ?? { symbol: '?', label: 'Unknown' };
  $('card-project').textContent = `${repo.name.toUpperCase()} / ${isDeployment ? 'RAILWAY' : isAgent ? 'CURSOR AGENT' : `#${item.number}`}`;
  $('card-title').textContent = item.title;
  $('card-state').textContent = `${state.symbol} ${state.label}`;
  $('card-state').dataset.state = item.state;
  $('card-facts').hidden = isDeployment;
  $('card-deployment-facts').hidden = !isDeployment;
  if (isDeployment) renderDeployment(item);
  else {
    $('card-head-label').textContent = isAgent ? 'CREATED' : 'HEAD COMMIT';
    $('card-head').textContent = isAgent ? age(item.createdAt) : `${shortSha(item.headSha)} · ${age(item.headAt)}${item.headMessage ? ` — ${item.headMessage}` : ''}`;
    $('card-ci-label').textContent = isAgent ? 'AGENT STATUS' : 'CONTINUOUS INTEGRATION';
    const ci = item.ci;
    $('card-ci').textContent = isAgent ? item.agent.status : ({ success: 'Passing', failure: 'Failing', pending: 'In progress', unknown: 'No check data' })[ci.state]
      + (ci.total ? ` · ${ci.passed} passed / ${ci.pending} pending / ${ci.failed} failed` : '')
      + (ci.source === 'actions' ? ' · Actions + commit statuses' : '');
  }
  const warnings = [item.warning];
  if (!isAgent && !isDeployment && item.state === 'NEEDS_ANDRE' && scene?.workItems.find(work => work.id === id)?.status === 'idle') {
    warnings.push('CI and review signals suggest readiness. No explicit approval request was observed, so this is outside the Needs Andre queue.');
  }
  if (isDeployment && item.stale) warnings.push('Railway data is stale. Verify current deployment status in Railway.');
  else if (isDeployment && item.dataComplete === false && !item.warning) warnings.push('Deployment data is incomplete. Verify live status and the commit comparison in Railway.');
  else if (!isAgent && !isDeployment && repo.stale) warnings.push(`GitHub is unavailable. Last successful collection: ${age(repo.updatedAt)}. Verify the PR before acting.`);
  $('card-warning').textContent = warnings.filter(Boolean).join(' ');
  $('card-warning').hidden = !warnings.some(Boolean);
  $('review-heading').hidden = isAgent || isDeployment;
  $('card-reviewers').hidden = isAgent || isDeployment;
  $('card-reviewers').replaceChildren();
  for (const reviewer of isDeployment ? [] : item.reviewers ?? []) {
    const row = text('div', 'reviewer', ''); const top = text('div', 'reviewer-top', '');
    top.append(text('strong', '', reviewer.name), text('span', `reviewer-status${reviewer.currentHead ? ' current' : ''}`,
      reviewer.currentHead ? 'CURRENT HEAD' : reviewer.lastReviewedSha ? 'OLDER HEAD' : 'SHA UNKNOWN'));
    row.append(top, text('div', 'reviewer-detail',
      `${reviewer.lastReviewedSha?.slice(0, 7) ?? 'No known review SHA'} · ${reviewer.complete === false ? '?' : reviewer.openFindings ?? '?'} open findings`),
    text('div', 'reviewer-detail', reviewer.lastAt ? `Last activity ${age(reviewer.lastAt)}` : 'No review activity recorded'));
    $('card-reviewers').append(row);
  }
  safeLink($('open-pr'), isAgent || isDeployment ? undefined : item.url, 'https://github.com');
  safeLink($('open-agent'), isDeployment ? undefined : item.agent?.url, 'https://cursor.com');
  safeLink($('open-railway'), isDeployment ? item.url : undefined, 'https://railway.com');
  $('card-agent').hidden = !item.agent || isAgent || isDeployment;
  $('card-agent').textContent = !isDeployment && item.agent ? `Cursor agent: ${item.agent.status.toLowerCase()}` : '';
  $('card').hidden = false; map.select(id); if (focus) $('card').focus({ preventScroll: true });
}
function render(fit = false) {
  if (!snapshot) return;
  const items = snapshot.items.filter(item => (!repoFilter.value || item.repo === repoFilter.value)
    && (!stateFilter.value || item.state === stateFilter.value));
  map.setItems(items, snapshot.repos, snapshot.states, fit);
  $('needs-count').textContent = needsAndre(scene).length;
  $('visible-count').textContent = `${items.length} visible / ${snapshot.items.length} total`;
  $('empty').hidden = items.length > 0;
  $('empty').textContent = snapshot.loading ? 'Loading your map…' : snapshot.errors.length && !snapshot.items.length
    ? 'Project data is unavailable. Check the connection notice above.' : 'No pull requests, agents, or deployments match this view.';
  const interval = snapshot.pollMs < 120_000 ? `${Math.ceil(snapshot.pollMs / 1000)}s` : `${Math.ceil(snapshot.pollMs / 60_000)}m`;
  $('sync').textContent = scene.mode === 'DEMO' ? 'DEMO · synthetic activity' : scene.mode === 'RECORDED' ? 'RECORDED · original timestamps' : snapshot.loading ? 'Fetching first snapshot…' : `LIVE · polled ${age(snapshot.updatedAt)} · every ${interval}`;
  $('notice').hidden = !snapshot.errors.length; $('notice').textContent = snapshot.errors.join(' ');
  if (selectedId && items.some(item => item.id === selectedId)) openCard(selectedId, false); else closeCard();
}
function configure(data) {
  // Polling changes timestamps and items without changing these controls.
  // Keep option nodes intact while a user is choosing a filter.
  const key = JSON.stringify({
    repos: data.repos.map(repo => [repo.repo, repo.name, repo.color]),
    states: Object.entries(data.states).map(([id, state]) => [id, state.label, state.color, state.symbol]),
  });
  if (key === configurationKey) return;
  const selectedRepo = repoFilter.value, selectedState = stateFilter.value;
  repoFilter.replaceChildren(new Option('All projects', ''));
  stateFilter.replaceChildren(new Option('All states', ''));
  $('legend').replaceChildren();
  for (const repo of data.repos) repoFilter.add(new Option(repo.name, repo.repo));
  for (const [id, state] of Object.entries(data.states)) {
    stateFilter.add(new Option(state.label, id));
    const entry = text('span', 'legend-item', ''); const dot = text('i', 'legend-dot', ''); dot.dataset.state = id; dot.style.backgroundColor = state.color;
    entry.append(dot, document.createTextNode(state.label)); $('legend').append(entry);
  }
  repoFilter.value = [...repoFilter.options].some(option => option.value === selectedRepo) ? selectedRepo : '';
  stateFilter.value = [...stateFilter.options].some(option => option.value === selectedState) ? selectedState : '';
  configurationKey = key;
}
async function poll() {
  try {
    if (viewParams?.get('mode') === 'recorded') {
      scene = normalizeSnapshot({ repos: [], items: [], states: {}, errors: [], loading: false, pollMs: 60_000 }, { mode: 'RECORDED' });
      snapshot = scene.legacy; configure(snapshot); render(true);
      $('empty').textContent = 'No recording loaded. Open the colony to import a captured snapshot; its in-memory 2D view preserves recorded data.';
      return;
    }
    const isDemo = viewParams?.get('mode') === 'demo';
    const response = isDemo ? null : await fetch(`/api/map${viewParams?.get('mode') === 'live' ? '?mode=live' : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (isDemo) {
      scene = demoState(Number(viewParams?.get('step') ?? 0), { crowded: viewParams?.get('crowded') === '1', stale: viewParams?.get('stale') === '1' }); snapshot = scene.legacy; configure(snapshot); render(true); return;
    }
    if (response.status === 401) { $('notice').textContent = 'Password required. Reload to sign in.'; $('notice').hidden = false; return; }
    if (!response.ok) throw new Error('Unable to load map');
    const data = await response.json(); const first = !snapshot; const wasLoading = snapshot?.loading;
    configure(data);
    scene = data.mode === 'DEMO' ? demoState(Number(viewParams?.get('step') ?? 0)) : normalizeSnapshot(data);
    snapshot = scene.legacy; render(first || wasLoading);
  } catch {
    if (scene && scene.mode === 'LIVE') { scene = normalizeSnapshot(snapshot, { disconnected: true }); snapshot = scene.legacy; render(); }
    $('notice').hidden = false; $('notice').textContent = 'Cannot reach the dashboard. Showing the last snapshot; it may be out of date.';
    $('sync').textContent = 'Connection interrupted';
    if (!snapshot) $('empty').textContent = 'Waiting for the dashboard connection…';
  }
  // Cache reads are cheap: keep the view responsive to new snapshots and quiet
  // period transitions even when upstream GitHub polling has slowed down.
  clearTimeout(pollTimer); pollTimer = setTimeout(poll, snapshot?.loading ? 2000 : 60_000);
}
repoFilter.addEventListener('change', () => render(true)); stateFilter.addEventListener('change', () => render(true));
$('close-card').addEventListener('click', () => closeCard(true));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCard(true); });
$('zoom-in').addEventListener('click', () => map.zoom(1.25)); $('zoom-out').addEventListener('click', () => map.zoom(.8));
$('reset-view').addEventListener('click', () => map.fit());
const needsButton = $('needs-next');
needsButton?.addEventListener('click', () => {
  const next = cycleWaiting(scene, selectedId);
  if (next) openCard(next.id); else { $('notice').hidden = false; $('notice').textContent = 'Nothing explicitly waiting for Andre. Green CI alone does not request approval.'; }
});
if (viewParams && $('colony-link')) $('colony-link').href = `/${viewParams.size ? `?${viewParams}` : ''}`;
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { clearTimeout(pollTimer); map.dispose(); }, { once: true });
void poll();
