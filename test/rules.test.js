import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, dayKey, hasFinding, rules } from '../config/rules.js';
import { now, pr } from './fixtures.js';
const cases = [
  ['green non-draft needs Andre', {}, 'NEEDS_ANDRE'],
  ['draft with green checks', { draft: true }, 'DRAFT_IDLE'],
  ['no checks is not green', { ci: { state: 'unknown' } }, 'DRAFT_IDLE'],
  ['ordinary pending CI', { ci: { state: 'pending' } }, 'DRAFT_IDLE'],
  ['failed CI', { ci: { state: 'failure' } }, 'FIXES_NEEDED'],
  ['open reviewer finding', { reviewers: [{ openFindings: 1 }] }, 'FIXES_NEEDED'],
  ['blocking label', { labels: ['P2'] }, 'FIXES_NEEDED'],
  ['recent commit', { headAt: '2026-10-15T17:50:00Z' }, 'WORKING'],
  ['exactly 20m is no longer recent', { headAt: '2026-10-15T17:40:00Z' }, 'NEEDS_ANDRE'],
  ['running agent', { agent: { running: true } }, 'WORKING'],
  ['running autofix', { ci: { state: 'pending', runningAgent: true } }, 'WORKING'],
  ['failures take precedence over work', { ci: { state: 'failure' }, agent: { running: true } }, 'FIXES_NEEDED'],
  ['explicit OK overrides blockers/draft', { draft: true, labels: ['Awaiting OK'], ci: { state: 'failure' } }, 'NEEDS_ANDRE'],
  ['merged today', { mergedAt: '2026-10-15T17:00:00Z' }, 'MERGED_TODAY'],
  ['merged yesterday', { mergedAt: '2026-10-14T17:00:00Z' }, 'DRAFT_IDLE'],
  ['stale or incomplete data', { dataComplete: false }, 'DRAFT_IDLE'],
  ['future clock does not imply working', { headAt: '2026-10-16T17:00:00Z' }, 'NEEDS_ANDRE'],
];
for (const [name, data, expected] of cases) test(name, () => assert.equal(classify(pr(data), now), expected));
test('merge day uses configured Los Angeles timezone at midnight', () => {
  assert.equal(dayKey('2026-10-16T06:59:00Z'), '2026-10-15');
  assert.equal(dayKey('2026-10-16T07:00:00Z'), '2026-10-16');
});
test('finding heuristics recognize severities and skip negative summaries', () => {
  for (const body of ['[P1] Wrong index', '**P2** boundary error', 'High severity: leak', 'Medium: missing retry', 'Blocking issue']) assert.ok(hasFinding(body), body);
  for (const body of ['No P1/P2 findings', 'No blocking issues', 'Fixed P1 issue', 'Low severity: typo', "I didn't find any P2 issues"]) assert.equal(hasFinding(body), false, body);
  assert.ok(hasFinding('No P1 findings\n[P2] Wrong index'));
});

const currentReviews = () => rules.draftRequiredReviewers.map(id => ({ id, currentHead: true, openFindings: 0 }));
test('quiet draft with green CI and all required current-head reviews needs Andre', () => {
  assert.equal(classify(pr({ draft: true, reviewers: currentReviews() }), now), 'NEEDS_ANDRE');
});
test('draft readiness requires quiet, known head age and all current reviews', () => {
  const draft = pr({ draft: true, reviewers: currentReviews() });
  assert.equal(classify({ ...draft, headAt: new Date(now - 5 * 60_000).toISOString() }, now), 'WORKING');
  assert.equal(classify({ ...draft, headAt: undefined }, now), 'DRAFT_IDLE');
  const stale = currentReviews(); stale[1].currentHead = false;
  assert.equal(classify({ ...draft, reviewers: stale }, now), 'DRAFT_IDLE');
  assert.equal(classify({ ...draft, reviewers: currentReviews().slice(1) }, now), 'DRAFT_IDLE');
  assert.equal(classify({ ...draft, dataComplete: false }, now), 'DRAFT_IDLE');
});
test('draft blockers and awaiting OK retain precedence', () => {
  const reviewers = currentReviews(); reviewers[0].openFindings = 1;
  const draft = pr({ draft: true, reviewers });
  assert.equal(classify(draft, now), 'FIXES_NEEDED');
  assert.equal(classify({ ...draft, labels: ['awaiting OK'] }, now), 'NEEDS_ANDRE');
  assert.equal(classify(pr({ draft: true, reviewers: currentReviews(), ci: { state: 'failure' } }), now), 'FIXES_NEEDED');
});
test('quiet period and required reviewers are configurable', t => {
  const original = { quietPeriodMs: rules.quietPeriodMs, draftRequiredReviewers: rules.draftRequiredReviewers };
  t.after(() => Object.assign(rules, original));
  rules.quietPeriodMs = 10 * 60_000; rules.draftRequiredReviewers = ['codex'];
  const draft = pr({ draft: true, headAt: new Date(now - 11 * 60_000).toISOString(), reviewers: [{ id: 'codex', currentHead: true, openFindings: 0 }] });
  assert.equal(classify(draft, now), 'NEEDS_ANDRE');
  rules.quietPeriodMs = 30 * 60_000;
  assert.equal(classify(draft, now), 'WORKING');
});
test('standalone agents are working or idle, never ready for approval', () => {
  assert.equal(classify({ kind: 'agent', agent: { running: true } }, now), 'WORKING');
  assert.equal(classify({ kind: 'agent', agent: { running: false } }, now), 'DRAFT_IDLE');
});
