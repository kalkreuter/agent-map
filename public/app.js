import { HexMap } from './hex-map.js';
const $ = id => document.getElementById(id);
let snapshot, selectedId, pollTimer;
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
  try { const url = new URL(value); if (url.origin !== origin) throw new Error(); element.href = url.href; element.hidden = false; }
  catch { element.removeAttribute('href'); element.hidden = true; }
}
function closeCard(restoreFocus = false) {
  const tile = [...$('viewport').querySelectorAll('.tile')].find(element => element.dataset.id === selectedId);
  $('card').hidden = true; selectedId = null; map.select(null);
  if (restoreFocus) tile?.focus({ preventScroll: true });
}
function openCard(id, focus = true) {
  const item = snapshot?.items.find(pr => pr.id === id); if (!item) return closeCard();
  selectedId = id;
  const isAgent = item.kind === 'agent';
  const repo = snapshot.repos.find(project => project.repo === item.repo);
  $('card-project').textContent = `${repo.name.toUpperCase()} / ${isAgent ? 'CURSOR AGENT' : `#${item.number}`}`;
  $('card-title').textContent = item.title;
  $('card-state').textContent = `${snapshot.states[item.state].symbol} ${snapshot.states[item.state].label}`;
  $('card-state').dataset.state = item.state;
  $('card-head-label').textContent = isAgent ? 'CREATED' : 'HEAD COMMIT';
  $('card-head').textContent = isAgent ? age(item.createdAt) : `${item.headSha.slice(0, 7)} · ${age(item.headAt)}${item.headMessage ? ` — ${item.headMessage}` : ''}`;
  $('card-ci-label').textContent = isAgent ? 'AGENT STATUS' : 'CONTINUOUS INTEGRATION';
  const ci = item.ci;
  $('card-ci').textContent = isAgent ? item.agent.status : ({ success: 'Passing', failure: 'Failing', pending: 'In progress', unknown: 'No check data' })[ci.state]
    + (ci.total ? ` · ${ci.passed} passed / ${ci.pending} pending / ${ci.failed} failed` : '')
    + (ci.source === 'actions' ? ' · Actions + commit statuses' : '');
  $('card-warning').hidden = !item.warning && (isAgent || !repo.stale);
  $('card-warning').textContent = !isAgent && repo.stale ? `GitHub is unavailable. Last successful collection: ${age(repo.updatedAt)}. Verify the PR before acting.` : item.warning;
  $('review-heading').hidden = isAgent;
  $('card-reviewers').replaceChildren();
  for (const reviewer of item.reviewers ?? []) {
    const row = text('div', 'reviewer', ''); const top = text('div', 'reviewer-top', '');
    top.append(text('strong', '', reviewer.name), text('span', `reviewer-status${reviewer.currentHead ? ' current' : ''}`,
      reviewer.currentHead ? 'CURRENT HEAD' : reviewer.lastReviewedSha ? 'OLDER HEAD' : 'SHA UNKNOWN'));
    row.append(top, text('div', 'reviewer-detail',
      `${reviewer.lastReviewedSha?.slice(0, 7) ?? 'No known review SHA'} · ${reviewer.complete === false ? '?' : reviewer.openFindings ?? '?'} open findings`),
    text('div', 'reviewer-detail', reviewer.lastAt ? `Last activity ${age(reviewer.lastAt)}` : 'No review activity recorded'));
    $('card-reviewers').append(row);
  }
  safeLink($('open-pr'), item.url, 'https://github.com');
  safeLink($('open-agent'), item.agent?.url, 'https://cursor.com');
  $('card-agent').hidden = !item.agent || isAgent;
  $('card-agent').textContent = item.agent ? `Cursor agent: ${item.agent.status.toLowerCase()}` : '';
  $('card').hidden = false; map.select(id); if (focus) $('card').focus({ preventScroll: true });
}
function render(fit = false) {
  if (!snapshot) return;
  const items = snapshot.items.filter(item => (!repoFilter.value || item.repo === repoFilter.value)
    && (!stateFilter.value || item.state === stateFilter.value));
  map.setItems(items, snapshot.repos, snapshot.states, fit);
  $('needs-count').textContent = snapshot.items.filter(item => item.state === 'NEEDS_ANDRE').length;
  $('visible-count').textContent = `${items.length} visible / ${snapshot.items.length} total`;
  $('empty').hidden = items.length > 0;
  $('empty').textContent = snapshot.loading ? 'Loading your map…' : snapshot.errors.length && !snapshot.items.length
    ? 'Project data is unavailable. Check the connection notice above.' : 'No pull requests or agents match this view.';
  const interval = snapshot.pollMs < 120_000 ? `${Math.ceil(snapshot.pollMs / 1000)}s` : `${Math.ceil(snapshot.pollMs / 60_000)}m`;
  $('sync').textContent = snapshot.loading ? 'Fetching first snapshot…' : `Polled ${age(snapshot.updatedAt)} · every ${interval}`;
  $('notice').hidden = !snapshot.errors.length; $('notice').textContent = snapshot.errors.join(' ');
  if (selectedId && items.some(item => item.id === selectedId)) openCard(selectedId, false); else closeCard();
}
function configure(data) {
  for (const repo of data.repos) repoFilter.add(new Option(repo.name, repo.repo));
  for (const [id, state] of Object.entries(data.states)) {
    stateFilter.add(new Option(state.label, id));
    const entry = text('span', 'legend-item', ''); const dot = text('i', 'legend-dot', ''); dot.dataset.state = id;
    entry.append(dot, document.createTextNode(state.label)); $('legend').append(entry);
  }
}
async function poll() {
  try {
    const response = await fetch('/api/map', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (response.status === 401) { $('notice').textContent = 'Password required. Reload to sign in.'; $('notice').hidden = false; return; }
    if (!response.ok) throw new Error('Unable to load map');
    const data = await response.json(); const first = !snapshot; const wasLoading = snapshot?.loading;
    if (first) configure(data);
    snapshot = data; render(first || wasLoading);
  } catch {
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
void poll();
