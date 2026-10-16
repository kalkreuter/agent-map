import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReviews } from '../src/reviews.js';
import { classify } from '../config/rules.js';
import { head, oldHead, now, pr } from './fixtures.js';

const completedAt = '2026-10-15T17:00:00Z';
const cleanText = '**Final Result:** Bugbot completed review - no issues found! ✅';
function check(overrides = {}) {
  return { id: 12, name: 'Cursor Bugbot', app: { slug: 'cursor' }, head_sha: head,
    status: 'completed', conclusion: 'success', completed_at: completedAt,
    output: { summary: cleanText }, ...overrides };
}
function finding(overrides = {}) {
  return { id: 1, user: { login: 'cursor[bot]' }, performed_via_github_app: { slug: 'cursor' },
    body: '**High Severity**\nMissing boundary check', commit_id: oldHead, original_commit_id: oldHead,
    line: null, original_line: 7, position: 1, original_position: 1,
    created_at: '2026-10-15T16:00:00Z', ...overrides };
}
function summarize(overrides = {}) {
  return summarizeReviews({ reviews: [], comments: [], issueComments: [], checkRuns: [], headSha: head, owner: 'kalkreuter', ...overrides });
}
test('a verified clean check counts as a current-head Bugbot review without a new comment', () => {
  const reviews = ['chatgpt-codex-connector[bot]', 'claude[bot]'].map((login, id) => ({ id,
    user: { login }, state: 'COMMENTED', commit_id: head, submitted_at: completedAt, body: 'No P1/P2 findings' }));
  const reviewers = summarize({ reviews, checkRuns: [check()] });
  assert.equal(reviewers[0].currentHead, true); assert.equal(reviewers[0].lastReviewedSha, head);
  assert.equal(reviewers[0].lastAt, completedAt); assert.equal(reviewers[0].openFindings, 0);
  assert.equal(classify(pr({ draft: true, reviewers }), now), 'NEEDS_ANDRE');
});
test('PR risk summaries are excluded while real inline findings still count', () => {
  const issueComments = [{ ...finding(), body: '## PR Summary\n<!-- CURSOR_SUMMARY -->\n**Medium Risk**\nChanges billing behavior.' }];
  assert.equal(summarize({ issueComments })[0].openFindings, 0);
  assert.equal(summarize({ issueComments, comments: [finding()] })[0].openFindings, 1);
});
test('a clean current-head check supersedes old outdated locations even when position stays numeric', () => {
  assert.equal(summarize({ comments: [finding()] })[0].openFindings, 1);
  assert.equal(summarize({ comments: [finding()], checkRuns: [check()] })[0].openFindings, 0);
});
test('a clean check preserves current-head, still-positioned, file-level, and newly edited findings', () => {
  for (const root of [
    finding({ original_commit_id: head, commit_id: head }), finding({ line: 7 }),
    finding({ original_line: null }), finding({ updated_at: '2026-10-15T17:01:00Z' }),
  ]) assert.equal(summarize({ comments: [root], checkRuns: [check()] })[0].openFindings, 1);
});
for (const [name, overrides] of [
  ['another app', { app: { slug: 'github-actions' } }], ['another check', { name: 'Unit tests' }],
  ['another head', { head_sha: oldHead }], ['pending review', { status: 'in_progress' }],
  ['cancelled review', { conclusion: 'cancelled' }], ['unknown completion time', { completed_at: null }],
  ['unrecognized output', { output: { summary: 'All done' } }],
]) test(`${name} cannot claim current-head review or clear findings`, () => {
  const result = summarize({ comments: [finding()], checkRuns: [check(overrides)] })[0];
  assert.equal(result.currentHead, false); assert.equal(result.openFindings, 1);
});
test('a newer pending or non-clean attempt prevents using an older clean check to clear findings', () => {
  for (const latest of [check({ id: 13, status: 'queued' }), check({ id: 13, conclusion: 'neutral',
    output: { summary: '**Final Result:** Bugbot completed review and found 1 potential issue.' } })]) {
    assert.equal(summarize({ comments: [finding()], checkRuns: [check(), latest] })[0].openFindings, 1);
  }
});
test('reported issues with missing inline details are incomplete rather than a clean sign-off', () => {
  const checkRuns = [check({ conclusion: 'neutral', output: { summary: '**Final Result:** Bugbot completed review and found 2 potential issues.' } })];
  const reviewer = summarize({ checkRuns })[0];
  assert.equal(reviewer.currentHead, true); assert.equal(reviewer.openFindings, null); assert.equal(reviewer.complete, false);
  assert.match(reviewer.incompleteReason, /review details/);
});
test('a quoted previous result cannot override the current check result', () => {
  const result = summarize({ checkRuns: [check({ conclusion: 'neutral', output: { summary:
    'Previous run: Bugbot completed review - no issues found.\n**Final Result:** Bugbot completed review and found 1 potential issue.' } })] })[0];
  assert.equal(result.openFindings, null); assert.equal(result.complete, false);
});
test('a clean result cannot override an explicit issue count elsewhere in check output', () => {
  const foundText = '**Final Result:** Bugbot completed review and found 2 potential issues.';
  for (const output of [
    { summary: `${cleanText}\n${foundText}` }, { summary: `${foundText}\n${cleanText}` },
    { summary: cleanText, text: foundText }, { summary: foundText, text: cleanText },
  ]) {
    const reviewer = summarize({ comments: [finding()], checkRuns: [check({ output })] })[0];
    assert.equal(reviewer.currentHead, true); assert.equal(reviewer.openFindings, 1);
    assert.equal(reviewer.complete, false);
  }
});
test('conflicting reported issue counts retain the largest count until details are available', () => {
  const output = { summary: '**Final Result:** Bugbot completed review and found 1 potential issue.',
    text: '**Final Result:** Bugbot completed review and found 2 potential issues.' };
  const comments = [finding({ original_commit_id: head, body: '[P3] Low severity: improve wording' })];
  const reviewer = summarize({ comments, checkRuns: [check({ output })] })[0];
  assert.equal(reviewer.currentHead, true); assert.equal(reviewer.openFindings, null);
  assert.equal(reviewer.complete, false);
});
test('known blocking and low-severity comments cover the reported issue count without double counting', () => {
  const checkRuns = [check({ conclusion: 'neutral', output: { summary: '**Final Result:** Bugbot completed review and found 2 potential issues.' } })];
  const comments = [finding({ original_commit_id: head }), finding({ id: 2, original_commit_id: head, body: '[P3] Low severity: improve wording' })];
  const reviewer = summarize({ checkRuns, comments })[0];
  assert.equal(reviewer.openFindings, 1); assert.equal(reviewer.complete, true);
  comments[0].body = '[P3] Low severity: improve wording';
  assert.equal(summarize({ checkRuns, comments })[0].openFindings, 0);
});
