import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReviews } from '../src/reviews.js';
import { head, oldHead } from './fixtures.js';
const bot = 'chatgpt-codex-connector[bot]';
const date = '2026-10-15T12:00:00Z';
function summarize(overrides) {
  return summarizeReviews({ reviews: [], comments: [], issueComments: [], headSha: head, owner: 'kalkreuter', ...overrides });
}
function comment(overrides = {}) {
  return { id: 1, user: { login: bot }, body: '[P1] Fix the boundary', commit_id: head, created_at: date, ...overrides };
}
test('current SHA and open inline finding per reviewer', () => {
  const result = summarize({ comments: [comment()] });
  assert.equal(result[1].currentHead, true); assert.equal(result[1].openFindings, 1);
  assert.equal(result[0].lastReviewedSha, null);
});
test('old findings stay blocking until explicitly resolved in the thread', () => {
  const root = comment({ commit_id: oldHead, position: null });
  assert.equal(summarize({ comments: [root] })[1].openFindings, 1);
  assert.equal(summarize({ comments: [root] })[1].currentHead, false);
  const reply = comment({ id: 2, in_reply_to_id: 1, body: 'Fixed in the latest commit', user: { login: 'kalkreuter' } });
  assert.equal(summarize({ comments: [root, reply] })[1].openFindings, 0);
  reply.user.login = 'stranger';
  assert.equal(summarize({ comments: [root, reply] })[1].openFindings, 1);
});
test('dismissed review and its inline findings do not block', () => {
  const reviews = [{ id: 3, state: 'DISMISSED', body: '[P1] Wrong', user: { login: bot }, commit_id: head, submitted_at: date }];
  assert.equal(summarize({ reviews, comments: [comment({ pull_request_review_id: 3 })] })[1].openFindings, 0);
});
test('review summary does not double-count inline findings', () => {
  const reviews = [{ id: 3, state: 'COMMENTED', body: 'P1 found', user: { login: bot }, commit_id: head, submitted_at: date }];
  assert.equal(summarize({ reviews, comments: [comment({ pull_request_review_id: 3 })] })[1].openFindings, 1);
});
test('Claude under owner account requires a Claude marker; SHA remains unknown', () => {
  const issueComments = [comment({ user: { login: 'kalkreuter' }, commit_id: undefined, body: 'Claude Code review: P2 issue' })];
  assert.equal(summarize({ issueComments })[2].openFindings, 1);
  assert.equal(summarize({ issueComments })[2].currentHead, false);
  issueComments[0].body = 'P2 personal note';
  assert.equal(summarize({ issueComments })[2].openFindings, 0);
});
test('SHA-tagged Claude and Bugbot activity is recognized', () => {
  const issueComments = [comment({ user: { login: 'claude[bot]' }, commit_id: undefined, body: `Reviewed ${head}: no P1/P2 findings` }),
    comment({ user: { login: 'cursor[bot]' }, commit_id: oldHead })];
  const result = summarize({ issueComments });
  assert.equal(result[2].currentHead, true); assert.equal(result[2].openFindings, 0);
  assert.equal(result[0].lastReviewedSha, oldHead); assert.equal(result[0].openFindings, 1);
});
test('new SHA-less activity preserves the last known reviewed SHA', () => {
  const result = summarize({ comments: [comment()], issueComments: [comment({ commit_id: undefined,
    body: 'Review complete', created_at: '2026-10-15T13:00:00Z' })] });
  assert.equal(result[1].lastReviewedSha, head);
  assert.equal(result[1].lastAt, '2026-10-15T13:00:00Z');
});
test('inline review freshness uses original commit, not a diff remapped to the new head', () => {
  const result = summarize({ comments: [comment({ commit_id: head, original_commit_id: oldHead })] });
  assert.equal(result[1].lastReviewedSha, oldHead); assert.equal(result[1].currentHead, false);
});
test('incidental SHAs in prose do not claim a review of the current head', () => {
  const result = summarize({ issueComments: [comment({ commit_id: undefined, body: `This issue was introduced by ${head}` })] });
  assert.equal(result[1].lastReviewedSha, null); assert.equal(result[1].currentHead, false);
});
