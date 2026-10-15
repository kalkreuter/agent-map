import { createReader, mapLimit } from './api.js';
import { summarizeCI } from './ci.js';
import { summarizeReviews } from './reviews.js';
import { dayKey, rules } from '../config/rules.js';

export function createGitHub(token, fetchImpl) {
  const api = createReader({ origin: 'https://api.github.com', service: 'GitHub', fetchImpl,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agent-map' } });

  async function enrich(repo, pr) {
    const path = `/repos/${repo.repo}`;
    const pullPath = `${path}/pulls/${pr.number}`;
    const [commit, commits, checks, statuses, reviews, comments, issueComments] = await Promise.all([
      api.get(`${path}/commits/${pr.head.sha}`).then(result => result.data),
      api.list(`${pullPath}/commits`),
      api.list(`${path}/commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs'),
      api.list(`${path}/commits/${pr.head.sha}/statuses`),
      api.list(`${pullPath}/reviews`),
      api.list(`${pullPath}/comments`),
      api.list(`${path}/issues/${pr.number}/comments`),
    ]);
    const ci = summarizeCI(checks, statuses);
    ci.runningAgent = ci.runs.some(run => run.status !== 'completed' && rules.autofixCheck.test(run.name));
    delete ci.runs;
    return { ...basic(repo, pr), headAt: commit.commit?.committer?.date ?? commit.commit?.author?.date,
      headMessage: commit.commit?.message?.split('\n')[0] ?? '',
      latestCommits: commits.slice(-5).reverse().map(item => ({ sha: item.sha,
        message: item.commit?.message?.split('\n')[0] ?? '', at: item.commit?.committer?.date ?? item.commit?.author?.date })),
      ci, dataComplete: true,
      reviewers: summarizeReviews({ reviews, comments, issueComments, headSha: pr.head.sha, owner: repo.repo.split('/')[0] }) };
  }

  return {
    async collectRepo(repo, now = Date.now()) {
      const path = `/repos/${repo.repo}/pulls`;
      // Closed PRs are newest-updated first. A 48-hour cutoff safely covers
      // today's merges in every IANA timezone, including DST transitions.
      const [open, closed] = await Promise.all([
        api.list(`${path}?state=open&sort=updated&direction=desc`),
        api.list(`${path}?state=closed&sort=updated&direction=desc`, undefined,
          batch => batch.some(pr => Date.parse(pr.updated_at) < now - 48 * 60 * 60_000)),
      ]);
      const merged = closed.filter(pr => pr.merged_at && dayKey(pr.merged_at) === dayKey(now));
      return mapLimit([...open, ...merged], 3, async pr => {
        try { return await enrich(repo, pr); }
        catch { return { ...basic(repo, pr), dataComplete: false,
          warning: 'PR details unavailable. Check GitHub access or rate limits.', ci: { state: 'unknown', total: 0 },
          reviewers: rules.reviewers.map(reviewer => ({ id: reviewer.id, name: reviewer.name,
            openFindings: null, lastReviewedSha: null, currentHead: false })) }; }
      });
    },
  };
}

function basic(repo, pr) {
  return { id: `${repo.repo}#${pr.number}`, repo: repo.repo, number: pr.number, title: pr.title,
    url: `https://github.com/${repo.repo}/pull/${pr.number}`, draft: pr.draft,
    headSha: pr.head.sha, mergedAt: pr.merged_at, updatedAt: pr.updated_at,
    labels: (pr.labels ?? []).map(label => label.name) };
}
