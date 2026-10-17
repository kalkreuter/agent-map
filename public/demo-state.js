import { normalizeSnapshot, reduceEvents } from './scene-state.js';

// Synthetic runs and work; these are fixtures, never a claim about production.
// Configured project names are reused to make the metaphor easy to recognize.
const MANAGE = 'kalkreuter/storagestack-manage';
const VIVI = 'kalkreuter/storagestack-vivi';
const STORY = 'demo:manage:access-audit';
const START = Date.parse('2026-10-16T15:00:00Z');
const at = step => new Date(START + step * 60_000).toISOString();
const states = {
  NEEDS_ANDRE: { label: 'Needs Andre', color: '#ff747d', symbol: '?' },
  WORKING: { label: 'Working', color: '#8b9dff', symbol: '⚒' },
  FIXES_NEEDED: { label: 'Changes requested', color: '#f4bb65', symbol: '!' },
  DRAFT_IDLE: { label: 'Idle', color: '#8a95a9', symbol: '·' },
  MERGED_TODAY: { label: 'Merged', color: '#52d4bc', symbol: '✓' },
};
export const DEMO_STEPS = Object.freeze([
  { title: '01 · Arrival', detail: 'A synthetic Cursor run arrives at Manage’s launch pad. The replay uses fixed historical fixture timestamps.' },
  { title: '02 · Build', detail: 'Builder 01 begins the small access-audit PR. Its verified demo assignment lights the route to the work site.' },
  { title: '03 · Review', detail: 'A separate Codex review run inspects the same work. Builder completion does not mean review approval or merge.' },
  { title: '04 · Changes requested', detail: 'The reviewer requests clearer permission copy. The work site shows a warning and remains unmerged.' },
  { title: '05 · Revision', detail: 'A separate Claude revision run updates the brief. The handoff is explicit demo evidence, not timestamp inference.' },
  { title: '06 · Needs Andre', detail: 'The revised work explicitly waits for Andre’s merge approval. This replay never merges, deploys, or enables anything.' },
]);
function run(id, provider, name, status, step, activity, overrides = {}) {
  return { id, provider, name, demoStatus: status, status: status.toUpperCase(),
    running: ['working', 'reviewing'].includes(status), observedAt: at(step), createdAt: at(0),
    activity, url: null, ...overrides };
}
function work(id, repo, number, title, state, step, extras = {}) {
  return { kind: 'pr', id, repo, number, title, state, url: null, draft: true,
    labels: [], headSha: 'd'.repeat(40), headAt: at(step), updatedAt: at(step),
    headMessage: 'Synthetic replay fixture', mergedAt: null, reviewers: [], dataComplete: true,
    ci: { state: state === 'FIXES_NEEDED' ? 'failure' : 'success', total: 1, passed: state === 'FIXES_NEEDED' ? 0 : 1,
      failed: state === 'FIXES_NEEDED' ? 1 : 0, pending: 0 }, ...extras };
}
function standalone(agent, repo) {
  return { kind: 'agent', id: `demo:${agent.provider.toLowerCase()}:${agent.id}`, repo,
    title: agent.name, createdAt: agent.createdAt, agent, state: agent.running ? 'WORKING' : 'DRAFT_IDLE' };
}

export function demoState(step = 0, { crowded = false, stale = false } = {}) {
  step = Math.max(0, Math.min(DEMO_STEPS.length - 1, Math.trunc(Number(step) || 0)));
  const storyState = ['DRAFT_IDLE', 'WORKING', 'DRAFT_IDLE', 'FIXES_NEEDED', 'WORKING', 'NEEDS_ANDRE'][step];
  const builder = run('builder-01', 'Cursor', 'Builder 01', step === 1 ? 'working' : step >= 2 ? 'completed' : 'idle', step,
    step === 0 ? 'Arriving at the launch pad · demo event' : step === 1 ? 'Building the access-audit work site' : 'Build run completed; work remains unmerged');
  const reviewer = run('review-01', 'Codex', 'Inspector 01', step === 2 ? 'reviewing' : step >= 3 ? 'completed' : 'idle', step,
    step === 2 ? 'Inspecting the current revision' : step >= 3 ? 'Review run completed; revision requested' : 'Standing by for a review assignment');
  const revision = run('revision-01', 'Claude', 'Revision 01', step === 4 ? 'working' : step === 5 ? 'waiting' : 'idle', step,
    step === 4 ? 'Clarifying permission copy after the review handoff' : step === 5 ? 'Waiting for Andre’s explicit merge decision' : 'No revision assignment yet');
  const storyAgents = step === 0 ? [] : [builder, ...(step >= 2 ? [reviewer] : []), ...(step >= 4 ? [revision] : [])];
  const story = work(STORY, MANAGE, 'D01', 'Access audit · compact permissions brief', storyState, step, {
    demoStatus: step === 2 ? 'reviewing' : undefined,
    activity: ['Awaiting a builder arrival', 'Building a focused PR', 'Inspecting the current revision',
      'Permission copy needs a revision', 'Revision in progress', 'Waiting for Andre’s merge approval'][step],
    labels: step === 5 ? ['awaiting OK'] : [],
    waitingReason: step === 5 ? 'Demo: the revised brief explicitly requests Andre’s merge approval. Nothing has been merged.' : null,
    agentInstances: storyAgents, agent: storyAgents.at(-1) ?? null,
    reviewers: step >= 2 ? [{ id: 'codex', name: 'Codex · synthetic review', currentHead: step >= 4,
      lastReviewedSha: 'd'.repeat(40), openFindings: step === 3 ? 1 : 0, complete: true, lastAt: at(Math.min(step, 3)) }] : [],
  });
  const viviBuilder = run('vivi-builder-02', 'Cursor', 'Builder 02', 'working', step, 'Working on a synthetic reservation summary');
  const viviIdle = run('vivi-idle-03', 'Cursor', 'Scout 03', 'idle', step, 'Idle at Vivi’s launch pad; no active assignment');
  const manageInspector = run('manage-review-02', 'Codex', 'Inspector 02', 'reviewing', step, 'Reviewing the synthetic approval brief');
  const items = [story,
    work('demo:manage:approval-brief', MANAGE, 'D02', 'Approval brief · review station', 'DRAFT_IDLE', step,
      { demoStatus: 'reviewing', activity: 'Synthetic inspection in progress', agentInstances: [manageInspector], agent: manageInspector }),
    work('demo:manage:queue', MANAGE, 'D03', 'Work queue · ready for the next run', 'DRAFT_IDLE', step,
      { activity: 'Idle work site; no live work implied' }),
    work('demo:vivi:reservations', VIVI, 'D04', 'Reservation summary · build station', 'WORKING', step,
      { activity: 'Synthetic build in progress', agentInstances: [viviBuilder], agent: viviBuilder }),
    work('demo:vivi:handoff', VIVI, 'D05', 'Arrival notes · quiet work site', 'DRAFT_IDLE', step,
      { activity: 'No agent assigned; awaiting a future task' }),
    standalone(viviIdle, VIVI),
  ];
  if (step === 0) items.push(standalone(builder, MANAGE));
  if (crowded) {
    // A bounded stress fixture tests distribution around existing work sites.
    // Additional robots do not create additional buildings or pretend PRs.
    const assignments = [items[0], items[1], items[3]];
    for (let i = 0; i < 15; i++) {
      const target = assignments[i % assignments.length];
      const agent = run(`crowd-${String(i + 1).padStart(2, '0')}`, i % 3 ? 'Cursor' : 'Codex', `Demo crew ${i + 1}`,
        ['working', 'reviewing', 'idle'][i % 3], step, 'Synthetic crowd fixture · shared work site');
      target.agentInstances = [...(target.agentInstances ?? []), agent];
    }
  }
  const snapshot = { updatedAt: at(step), repos: [
    { repo: MANAGE, name: 'Manage', color: '#839ef3', updatedAt: at(step), stale },
    { repo: VIVI, name: 'Vivi', color: '#4ebfa6', updatedAt: at(step), stale },
  ], items, errors: stale ? ['Demo source disconnected: retained fixture is stale.'] : [], loading: false, states, pollMs: 60_000 };
  const state = normalizeSnapshot(snapshot, { mode: 'DEMO', disconnected: stale });
  const events = [
    { id: 'demo:event:arrival', type: 'arrival', entityId: 'demo:cursor:builder-01', at: at(0) },
    { id: 'demo:event:build', type: 'assignment', entityId: 'demo:cursor:builder-01', at: at(1), toId: STORY },
    { id: 'demo:event:review', type: 'review_started', entityId: 'demo:codex:review-01', at: at(2), toId: STORY },
    { id: 'demo:event:changes', type: 'changes_requested', entityId: STORY, at: at(3) },
    { id: 'demo:event:revision', type: 'handoff', entityId: 'demo:claude:revision-01', fromId: 'demo:codex:review-01', toId: STORY, at: at(4) },
    { id: 'demo:event:waiting', type: 'waiting_for_input', entityId: STORY, at: at(5) },
  ];
  state.events = reduceEvents(events.slice(0, step + 1).map(event => ({ ...event, name: event.type.replaceAll('_', ' '),
    observedAt: event.at, provenance: 'demo', source: 'demo', sourceUrl: null, status: stale ? 'stale' : 'completed' })));
  const edge = (id, fromId, toId, type) => ({ id, name: type.replaceAll('_', ' '), fromId, toId, type,
    provenance: 'demo', statusProvenance: 'demo', source: 'demo', sourceUrl: null, observedAt: at(step), status: stale ? 'stale' : 'idle' });
  state.relationships.push(edge('demo:dependency:brief-audit', STORY, 'demo:manage:approval-brief', 'depends_on'));
  if (step >= 4) state.relationships.push(edge('demo:handoff:review-revision', 'demo:codex:review-01', 'demo:claude:revision-01', 'handoff'));
  for (const entity of [...state.projects, ...state.workItems, ...state.agents, ...state.relationships]) entity.source = 'demo';
  state.sources = [{ id: 'demo', name: 'Deterministic demo replay', source: 'demo', sourceUrl: null,
    observedAt: at(step), provenance: 'demo', statusProvenance: 'demo', status: stale ? 'stale' : 'idle',
    message: stale ? 'Simulated disconnect. Original fixture timestamps retained; all entities are stale.'
      : 'Entirely synthetic work and runs. No real merges, deployments, approvals, or operational agents.' }];
  state.demoStep = step;
  return state;
}
