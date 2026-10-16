import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReviews } from '../src/reviews.js';
import { classify } from '../config/rules.js';
import { head, oldHead, now, pr } from './fixtures.js';
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
  const issueComments = [comment({ user: { login: 'kalkreuter' }, commit_id: undefined, body: '## Claude Code review\nP2 issue' })];
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

const attributionCases = [
  ['Claude GitHub app under owner', { user: { login: 'kalkreuter' }, performed_via_github_app: { slug: 'claude' }, body: '[P2] Wrong index' }, 1],
  ['Claude GitHub app under another login', { user: { login: 'integration' }, performed_via_github_app: { slug: 'claude' }, body: '[P2] Wrong index' }, 1],
  ['Claude bot', { user: { login: 'claude[bot]' }, body: '[P2] Wrong index' }, 1],
  ['owner review heading', { user: { login: 'kalkreuter' }, body: '## Code Review\n[P2] Wrong index' }, 1],
  ['owner explicit review signature', { user: { login: 'kalkreuter' }, body: 'Reviewed by Claude Code\n[P2] Wrong index' }, 1],
  ['incidental Claude mention in owner fix list', { user: { login: 'kalkreuter' }, body: 'Claude should fix these P2 issues' }, 0],
  ['Cursor app fix list with Claude heading', { user: { login: 'kalkreuter' }, performed_via_github_app: { slug: 'cursor' }, body: '## Claude Code review\n[P2] Fix this' }, 0],
  ['Cursor app authored as Claude bot', { user: { login: 'claude[bot]' }, performed_via_github_app: { slug: 'cursor' }, body: '[P1] Fix this' }, 0],
  ['Claude trigger', { user: { login: 'kalkreuter' }, body: '@claude go' }, 0],
  ['Codex trigger with severity text', { user: { login: 'kalkreuter' }, body: '@codex go fix P2 from Claude' }, 0],
  ['Claude app trigger', { user: { login: 'claude[bot]' }, performed_via_github_app: { slug: 'claude' }, body: '@claude review P2' }, 0],
  ['non-owner heading', { user: { login: 'stranger' }, body: '## Claude Code review\n[P2] Wrong index' }, 0],
];
for (const [name, data, expected] of attributionCases) test(`Claude attribution: ${name}`, () => {
  const result = summarize({ issueComments: [comment({ ...data, commit_id: undefined })] });
  assert.equal(result[2].openFindings, expected);
  if (!expected) assert.equal(result[2].lastAt, null);
});
test('Bugbot reviews performed via the Cursor GitHub app still count', () => {
  for (const login of ['cursor[bot]', 'cursor-bugbot[bot]']) {
    const result = summarize({ comments: [comment({ user: { login }, performed_via_github_app: { slug: 'cursor' } })],
      issueComments: [comment({ user: { login }, performed_via_github_app: { slug: 'cursor' }, commit_id: undefined,
        body: `Reviewed ${head}: no P1/P2 findings` })] });
    assert.equal(result[0].openFindings, 1); assert.equal(result[0].currentHead, true);
    assert.equal(result[2].openFindings, 0); assert.equal(result[2].lastAt, null);
  }
});
test('Cursor-app Bugbot sign-off readies a quiet draft and its findings still block', () => {
  const reviews = ['cursor[bot]', bot, 'claude[bot]'].map((login, index) => ({ id: index + 1,
    user: { login }, performed_via_github_app: index === 0 ? { slug: 'cursor' } : undefined,
    body: 'No P1/P2 findings', state: 'COMMENTED', commit_id: head, submitted_at: date }));
  const clear = summarize({ reviews });
  assert.equal(clear[0].currentHead, true); assert.equal(clear[0].openFindings, 0);
  assert.equal(classify(pr({ draft: true, reviewers: clear }), now), 'NEEDS_ANDRE');
  const blocked = summarize({ reviews, comments: [comment({ user: { login: 'cursor[bot]' },
    performed_via_github_app: { slug: 'cursor' }, pull_request_review_id: 1 })] });
  assert.equal(blocked[0].openFindings, 1);
  assert.equal(classify(pr({ draft: true, reviewers: blocked }), now), 'FIXES_NEEDED');
});
test('review attribution honors app metadata on reviews and inline comments too', () => {
  const result = summarize({ reviews: [{ ...comment(), user: { login: 'integration' }, performed_via_github_app: { slug: 'claude' }, state: 'COMMENTED', submitted_at: date }],
    comments: [comment({ user: { login: 'kalkreuter' }, performed_via_github_app: { slug: 'cursor' }, body: '## Code review\nP2' })] });
  assert.equal(result[2].openFindings, 1);
});
