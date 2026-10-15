import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, dayKey, hasFinding } from '../config/rules.js';
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
