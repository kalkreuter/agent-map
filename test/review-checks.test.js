import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReviews } from '../src/reviews.js';
import { classify } from '../config/rules.js';
import { head, oldHead, now, pr } from './fixtures.js';

const completedAt = '2026-10-15T17:00:00Z';
const startedAt = '2026-10-15T16:50:00Z';
const postedAt = '2026-10-15T16:59:00Z';
const cleanText = '**Final Result:** Bugbot completed review - no issues found! ✅';
function check(overrides = {}) {
  return { id: 12, name: 'Cursor Bugbot', app: { slug: 'cursor' }, head_sha: head,
    status: 'completed', conclusion: 'success', started_at: startedAt, completed_at: completedAt,
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
function review(overrides = {}) {
  return { id: 7, user: { login: 'cursor[bot]' }, performed_via_github_app: { slug: 'cursor' },
    state: 'COMMENTED', commit_id: head, submitted_at: postedAt, body: '', ...overrides };
}
function currentFinding(overrides = {}) {
  return finding({ commit_id: head, original_commit_id: head, created_at: postedAt,
    pull_request_review_id: 7, ...overrides });
}
function issueCheck(count = 1, overrides = {}) {
  return check({ conclusion: 'neutral', output: { summary:
    `**Final Result:** Bugbot completed review and found ${count} potential issues.` }, ...overrides });
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
  const comments = [currentFinding({ body: '[P3] Low severity: improve wording' })];
  const reviewer = summarize({ reviews: [review()], comments, checkRuns: [check({ output })] })[0];
  assert.equal(reviewer.currentHead, true); assert.equal(reviewer.openFindings, null);
  assert.equal(reviewer.complete, false);
});
test('known blocking and low-severity comments cover the reported issue count without double counting', () => {
  const checkRuns = [issueCheck(2)], reviews = [review()];
  const comments = [currentFinding(), currentFinding({ id: 2, body: '[P3] Low severity: improve wording' })];
  const reviewer = summarize({ reviews, checkRuns, comments })[0];
  assert.equal(reviewer.openFindings, 1); assert.equal(reviewer.complete, true);
  comments[0].body = '[P3] Low severity: improve wording';
  const lowOnly = summarize({ reviews, checkRuns, comments })[0];
  assert.equal(lowOnly.openFindings, 0); assert.equal(lowOnly.complete, true);
});
test('earlier same-head low and resolved comments cannot cover a newer run even when edited', () => {
  const earlierAt = '2026-10-15T16:00:00Z';
  const reviews = [review({ submitted_at: earlierAt }), ...['chatgpt-codex-connector[bot]', 'claude[bot]']
    .map((login, id) => review({ id: id + 8, user: { login }, performed_via_github_app: undefined }))];
  const oldRun = issueCheck(1, { id: 11, started_at: '2026-10-15T15:50:00Z', completed_at: earlierAt });
  for (const root of [
    currentFinding({ created_at: earlierAt, body: '[P3] Low severity: improve wording' }),
    currentFinding({ created_at: earlierAt, updated_at: postedAt, body: '[P3] Low severity: improve wording' }),
    currentFinding({ created_at: earlierAt, updated_at: postedAt }),
  ]) {
    const comments = [root, { id: 2, in_reply_to_id: root.id, user: { login: 'kalkreuter' },
      body: 'Fixed in this head', created_at: '2026-10-15T16:10:00Z' }];
    const reviewers = summarize({ reviews, comments, checkRuns: [oldRun, issueCheck()] });
    assert.equal(reviewers[0].currentHead, true); assert.equal(reviewers[0].openFindings, null);
    assert.equal(reviewers[0].complete, false);
    assert.equal(classify(pr({ draft: true, reviewers }), now), 'DRAFT_IDLE');
  }
});
test('issue coverage requires original comment creation inside a valid latest check window', () => {
  for (const checkOverrides of [
    { started_at: undefined }, { started_at: null }, { started_at: 'unknown' },
    { started_at: '2026-10-15T17:01:00Z' },
  ]) {
    const result = summarize({ reviews: [review()], comments: [currentFinding({ body: '[P3] Low severity' })],
      checkRuns: [issueCheck(1, checkOverrides)] })[0];
    assert.equal(result.complete, false); assert.equal(result.openFindings, null);
  }
  for (const created_at of [undefined, 'unknown', '2026-10-15T16:49:59Z', '2026-10-15T17:00:01Z']) {
    const result = summarize({ reviews: [review()], comments: [currentFinding({ created_at, updated_at: postedAt,
      body: '[P3] Low severity' })], checkRuns: [issueCheck()] })[0];
    assert.equal(result.complete, false); assert.equal(result.openFindings, null);
  }
});
test('issue coverage requires the current run trusted parent review, not a stale or missing review', () => {
  const comments = [currentFinding({ body: '[P3] Low severity' })], checkRuns = [issueCheck()];
  for (const reviews of [
    [], [review({ id: 8 })], [review({ commit_id: oldHead })],
    [review({ user: { login: 'stranger' }, performed_via_github_app: undefined })],
    [review({ state: 'PENDING' })], [review({ state: 'DISMISSED' })],
    [review({ submitted_at: undefined })], [review({ submitted_at: 'unknown' })],
    [review({ submitted_at: '2026-10-15T16:49:59Z' })], [review({ submitted_at: '2026-10-15T17:00:01Z' })],
  ]) {
    const result = summarize({ reviews, comments, checkRuns })[0];
    assert.equal(result.complete, false); assert.equal(result.openFindings, null);
  }
  const result = summarize({ reviews: [review()], comments: [{ ...comments[0], pull_request_review_id: undefined }], checkRuns })[0];
  assert.equal(result.complete, false); assert.equal(result.openFindings, null);
});
test('a current-run finding resolved afterward still accounts for its reported issue', () => {
  const comments = [currentFinding(), { id: 2, in_reply_to_id: 1, user: { login: 'kalkreuter' },
    body: 'Fixed in the latest commit', created_at: '2026-10-15T17:01:00Z' }];
  const result = summarize({ reviews: [review()], comments, checkRuns: [issueCheck()] })[0];
  assert.equal(result.openFindings, 0); assert.equal(result.complete, true);
});
