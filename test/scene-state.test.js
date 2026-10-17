import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, entityById, relatedTo, needsAndre, cycleWaiting,
  safeSourceUrl, reduceEvents, recoverSnapshot } from '../public/scene-state.js';
import { demoState, DEMO_STEPS } from '../public/demo-state.js';

const NOW = '2026-10-16T15:05:00Z';
const BEFORE = '2026-10-16T15:00:00Z';
const REPO = 'kalkreuter/storagestack-manage';
const project = { repo: REPO, name: 'Manage', color: '#839ef3', updatedAt: NOW };
function pr(id = `${REPO}#1`, extra = {}) {
  return { kind: 'pr', id, repo: REPO, number: 1, title: 'Small real work item',
    url: `https://github.com/${REPO}/pull/1`, labels: [], state: 'DRAFT_IDLE',
    dataComplete: true, collectedAt: NOW, ...extra };
}
function snapshot(items = [], extra = {}) {
  return { repos: [project], items, updatedAt: NOW, errors: [], loading: false, ...extra };
}
function event(id, at = NOW, extra = {}) { return { id, entityId: 'agent:1', type: 'assignment', at, ...extra }; }

test('normalization keeps the existing 2D snapshot intact and gives both renderers stable IDs', () => {
  const raw = snapshot([pr()]);
  const state = normalizeSnapshot(raw);
  assert.equal(state.legacy, raw);
  assert.equal(state.mode, 'LIVE');
  assert.equal(state.projects[0].id, REPO);
  assert.equal(state.workItems[0].id, `${REPO}#1`);
  assert.equal(state.workItems[0].raw, raw.items[0]);
  assert.equal(state.workItems[0].sourceUrl, raw.items[0].url);
  assert.equal(state.workItems[0].observedAt, NOW);
  assert.equal(state.workItems[0].provenance, 'observed');
  assert.equal(entityById(state, 'missing'), null);
});

test('individual Cursor runs survive list reorder, multiple runs on a PR, and standalone duplicates', () => {
  const one = { id: 'run-1', name: 'Builder', status: 'RUNNING', observedAt: NOW };
  const two = { id: 'run-2', name: 'Second builder', status: 'FINISHED', observedAt: NOW };
  const items = [pr(undefined, { agent: one, agentInstances: [two, one] }),
    { kind: 'agent', id: 'cursor:run-1', repo: REPO, title: 'Duplicate', agent: one },
    pr(`${REPO}#2`, { reviewers: [{ id: 'codex', name: 'Codex', lastAt: NOW }] })];
  const first = normalizeSnapshot(snapshot(items));
  const second = normalizeSnapshot(snapshot([...items].reverse(), { updatedAt: '2026-10-16T15:06:00Z' }));
  assert.deepEqual(first.agents.map(agent => agent.id), ['cursor:run-1', 'cursor:run-2']);
  assert.deepEqual(first.agents.map(agent => [agent.id, agent.workItemId]), second.agents.map(agent => [agent.id, agent.workItemId]));
  assert.equal(first.agents[0].workItemId, `${REPO}#1`);
  assert.equal(first.agents[1].status, 'completed');
  assert.equal(first.agents.some(agent => agent.provider === 'Codex'), false, 'review summaries cannot manufacture run IDs');
});

test('heuristic legacy readiness stays in legacy and never becomes an explicit input request', () => {
  const state = normalizeSnapshot(snapshot([pr(undefined, { state: 'NEEDS_ANDRE' })]));
  assert.equal(state.legacy.items[0].state, 'NEEDS_ANDRE');
  assert.equal(state.workItems[0].status, 'idle');
  assert.equal(state.workItems[0].statusProvenance, 'inferred');
  assert.equal(needsAndre(state).length, 0);
  const explicit = normalizeSnapshot(snapshot([pr(undefined, { state: 'NEEDS_ANDRE', labels: [' awaiting OK '] })]));
  assert.equal(needsAndre(explicit).length, 1);
  assert.match(explicit.workItems[0].waitingReason, /Explicit awaiting ok/);
});

test('configured explicit input labels are shared with legacy classification without promoting heuristic readiness', () => {
  const state = normalizeSnapshot(snapshot([
    pr('custom', { state: 'NEEDS_ANDRE', labels: [' Ready for Andre '] }),
    pr('default', { state: 'NEEDS_ANDRE', labels: ['awaiting OK'] }),
    pr('inferred', { state: 'NEEDS_ANDRE', labels: [] }),
  ], { explicitInputLabels: ['ready for andre'] }));
  assert.deepEqual(needsAndre(state).map(item => item.id), ['custom']);
  assert.match(entityById(state, 'custom').waitingReason, /ready for andre/);
  assert.equal(needsAndre(normalizeSnapshot(snapshot([pr('disabled', { labels: ['awaiting OK'] })], { explicitInputLabels: [] }))).length, 0);
});

test('stale and incomplete observations are neutral; merged PRs cannot request approval', () => {
  const raw = snapshot([pr(undefined, { labels: ['awaiting OK'], state: 'NEEDS_ANDRE' })],
    { repos: [{ ...project, stale: true, updatedAt: BEFORE }] });
  const stale = normalizeSnapshot(raw);
  assert.equal(stale.workItems[0].status, 'stale');
  assert.equal(stale.workItems[0].observedAt, NOW, 'per-item successful observation takes precedence when supplied');
  assert.equal(stale.projects[0].observedAt, BEFORE);
  assert.equal(needsAndre(stale).length, 0);
  assert.equal(normalizeSnapshot(snapshot([pr(undefined, { dataComplete: false })])).workItems[0].status, 'unknown');
  assert.equal(normalizeSnapshot(snapshot([pr(undefined, { labels: ['awaiting OK'], mergedAt: NOW })])).workItems[0].status, 'merged');
  const loading = normalizeSnapshot({ repos: [{ repo: REPO }], items: [], loading: true });
  assert.equal(loading.projects[0].status, 'unknown');
  assert.equal(loading.sources[0].observedAt, null);
});

test('run completion, PR merge, and deployment success remain separate facts', () => {
  const state = normalizeSnapshot(snapshot([
    pr(undefined, { agent: { id: 'done', status: 'FINISHED' } }),
    { kind: 'deployment', id: 'railway:target', repo: REPO, title: 'Production', state: 'DEPLOY_UNVERIFIED',
      deployment: { live: { status: 'SUCCESS' } }, dataComplete: false, collectedAt: NOW },
  ]));
  assert.equal(state.agents[0].status, 'completed');
  assert.equal(state.workItems.find(item => item.type === 'pr').status, 'idle');
  assert.equal(state.workItems.find(item => item.type === 'deployment').status, 'unknown');
});

test('selection and relationship lookup link actual assigned instances bidirectionally', () => {
  const state = normalizeSnapshot(snapshot([pr(undefined, { agentInstances: [{ id: 'run-1', status: 'RUNNING' }] })]));
  const agent = entityById(state, 'cursor:run-1');
  assert.equal(agent.projectId, REPO);
  assert.equal(relatedTo(state, agent.id)[0].entity.id, `${REPO}#1`);
  assert.equal(relatedTo(state, `${REPO}#1`)[0].entity.id, agent.id);
  assert.equal(relatedTo(state, 'missing').length, 0);
  assert.equal(state.relationships[0].provenance, 'observed');
});

test('NEEDS ANDRE cycling is stable, bidirectional, and useful when empty', () => {
  const waiting = id => pr(id, { state: 'NEEDS_ANDRE', labels: ['awaiting OK'] });
  const state = normalizeSnapshot(snapshot([waiting('work:b'), waiting('work:a'), pr('work:c', { state: 'NEEDS_ANDRE' })]));
  assert.deepEqual(needsAndre(state).map(item => item.id), ['work:a', 'work:b']);
  assert.equal(cycleWaiting(state, null).id, 'work:a');
  assert.equal(cycleWaiting(state, 'work:a').id, 'work:b');
  assert.equal(cycleWaiting(state, 'work:b').id, 'work:a');
  assert.equal(cycleWaiting(state, 'work:a', -1).id, 'work:b');
  assert.equal(cycleWaiting(state, null, -1).id, 'work:b');
  assert.equal(cycleWaiting(normalizeSnapshot(snapshot()), null), null);
});

test('source links restrict HTTPS origins and reject credentials and protocol tricks', () => {
  for (const value of [null, '', 'javascript:alert(1)', 'data:text/html,x', 'http://github.com/a/b',
    'https://github.com.evil.example/a/b', 'https://github.com@evil.example', 'https://name:secret@github.com/a/b',
    'https://cursor.com:444/agents/a', '//github.com/a/b']) assert.equal(safeSourceUrl(value), null, String(value));
  assert.equal(safeSourceUrl('https://github.com/a/b/pull/1'), 'https://github.com/a/b/pull/1');
  assert.equal(safeSourceUrl('https://cursor.com/agents/run-1'), 'https://cursor.com/agents/run-1');
  assert.equal(safeSourceUrl('https://railway.com/project/a?environmentId=b'), 'https://railway.com/project/a?environmentId=b');
});

test('event replay is idempotent, chronological, bounded, and cannot inject demo events into live', () => {
  const repeated = [event('b'), event('a', BEFORE), event('b', NOW, { type: 'tampered' }), event('bad', 'invalid')];
  const reduced = reduceEvents(repeated);
  assert.deepEqual(reduced.map(entry => entry.id), ['a', 'b']);
  assert.equal(reduced[1].type, 'assignment');
  assert.deepEqual(reduceEvents([...reduced, ...repeated]), reduced);
  assert.equal(reduceEvents(Array.from({ length: 650 }, (_, i) => event(`event:${i}`, new Date(Date.parse(BEFORE) + i * 1000).toISOString()))).length, 500);
  const state = normalizeSnapshot(snapshot([], { events: [event('real'), event('fake', NOW, { provenance: 'demo' }), event('fake-2', NOW, { source: 'demo' })] }));
  assert.deepEqual(state.events.map(entry => entry.id), ['real']);
});

test('reconnect recovery replaces the authoritative snapshot, deduplicates events, and rejects older snapshots', () => {
  const current = { ...demoState(1), events: [event('one', BEFORE)] };
  const next = { ...demoState(2), agents: [], events: [event('one', BEFORE), event('two')] };
  const recovered = recoverSnapshot(current, next);
  assert.equal(recovered.agents.length, 0, 'deleted or disappeared runs must not linger');
  assert.deepEqual(recovered.events.map(entry => entry.id), ['one', 'two']);
  assert.equal(recoverSnapshot(recovered, current), recovered, 'late snapshots cannot rewind current state');
  const live = { ...normalizeSnapshot(snapshot()), events: [event('real')] };
  assert.deepEqual(recoverSnapshot(recovered, live).events.map(entry => entry.id), ['real'], 'switching modes clears demo history');
});

test('explicit source health uses last successful timestamps and distinguishes missing collectors', () => {
  const state = normalizeSnapshot(snapshot([], { updatedAt: NOW, repos: [{ ...project, stale: true, updatedAt: BEFORE }], sourceHealth: [
    { id: 'github', name: 'GitHub', status: 'stale', observedAt: BEFORE },
    { id: 'cursor', name: 'Cursor', status: 'not_configured', observedAt: null },
    { id: 'railway', name: 'Railway', status: 'unavailable', observedAt: null },
  ] }));
  assert.equal(state.sources.find(source => source.id === 'github').observedAt, BEFORE);
  assert.equal(state.sources.find(source => source.id === 'github').status, 'stale');
  assert.equal(state.sources.find(source => source.id === 'cursor').status, 'unknown');
  assert.match(state.sources.find(source => source.id === 'cursor').message, /not configured/);
  assert.equal(state.agents.length, 0);
});

test('demo has a deterministic six-step story, original timestamps, and explicit unmerged final approval', () => {
  assert.equal(DEMO_STEPS.length, 6);
  assert.deepEqual(demoState(3), demoState(3));
  const first = demoState(0), last = demoState(5);
  assert.equal(first.mode, 'DEMO');
  assert.equal(first.events[0].type, 'arrival');
  assert.equal(first.observedAt, '2026-10-16T15:00:00.000Z');
  assert.equal(last.events.length, 6);
  assert.equal(needsAndre(last).length, 1);
  assert.equal(needsAndre(last)[0].id, 'demo:manage:access-audit');
  assert.equal(last.workItems.some(item => ['merged', 'deployed'].includes(item.status)), false);
  assert.equal(last.legacy.items.some(item => item.mergedAt), false);
  for (const entity of [...last.projects, ...last.workItems, ...last.agents, ...last.relationships, ...last.events, ...last.sources]) {
    assert.equal(entity.provenance, 'demo');
    assert.equal(entity.sourceUrl, null);
  }
  assert.equal(demoState(2).agents.some(agent => agent.status === 'reviewing'), true);
  assert.equal(demoState(3).workItems.some(item => item.status === 'changes_requested'), true);
  assert.equal(demoState(4).relationships.some(edge => edge.type === 'handoff'), true);
  const stale = demoState(5, { stale: true });
  assert.equal(stale.agents.every(agent => agent.status === 'stale'), true);
  assert.equal(needsAndre(stale).length, 0);
  assert.equal(stale.observedAt, last.observedAt);
  const crowded = demoState(5, { crowded: true });
  assert.equal(crowded.workItems.length, last.workItems.length, 'crowd fixture reuses existing work sites');
  assert.equal(crowded.agents.length, last.agents.length + 15);
});

test('a mislabeled fixture snapshot cannot populate LIVE with synthetic work or runs', () => {
  const fixture = demoState(5);
  const live = normalizeSnapshot(fixture.legacy, { mode: 'LIVE' });
  assert.deepEqual(live.workItems, []);
  assert.deepEqual(live.agents, []);
  assert.deepEqual(live.events, []);
  assert.deepEqual(live.legacy.items, []);
});
