import { createReader, mapLimit } from './api.js';
import { summarizeCI, workflowChecks } from './ci.js';
import { summarizeReviews } from './reviews.js';
import { dayKey, rules } from '../config/rules.js';

function missing(label, permission, error) {
  if (error?.status === 429 || error?.rateLimited) return `${label} unavailable: GitHub rate limit reached.`;
  if (error?.status === 403) return `${label} unavailable: token needs ${permission} read or repository access was denied.`;
  return `${label} unavailable: GitHub request failed${error?.status ? ` (${error.status})` : ''}.`;
}

export function createGitHub(token, fetchImpl, { now = Date.now } = {}) {
  const api = createReader({ origin: 'https://api.github.com', service: 'GitHub', fetchImpl, now,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agent-map' } });
  // One permission probe per repo, shared by concurrent PRs. A permission 403
  // disables Checks for that repo until process restart (e.g. after changing the token).
  // Rate-limit 403s are not remembered, so Checks is tried again on a later poll.
  const checkAccess = new Map();
  async function readChecks(repo, sha) {
    const read = async () => {
      try { return await api.list(`/repos/${repo}/commits/${sha}/check-runs?filter=latest`, 'check_runs'); }
      catch (error) { if (error.status !== 403 || error.rateLimited) throw error; checkAccess.set(repo, false); return null; }
    };
    const access = checkAccess.get(repo);
    if (access === false) return null;
    if (access === true) return read();
    const probe = access ?? read().then(runs => ({ sha, runs }));
    if (!access) checkAccess.set(repo, probe);
    try {
      const result = await probe;
      checkAccess.set(repo, result.runs !== null);
      return result.runs === null ? null : result.sha === sha ? result.runs : read();
    } catch (error) { checkAccess.delete(repo); throw error; }
  }

  async function readCI(repo, sha) {
    const path = `/repos/${repo}`;
    const [checksResult, statusesResult] = await Promise.allSettled([
      readChecks(repo, sha), api.list(`${path}/commits/${sha}/status`, 'statuses'),
    ]);
    const warnings = [];
    let runs = [], source = 'checks';
    if (checksResult.status === 'fulfilled' && checksResult.value === null) {
      source = 'actions';
      try { runs = workflowChecks(await api.list(`${path}/actions/runs?head_sha=${encodeURIComponent(sha)}`, 'workflow_runs')); }
      catch (error) { warnings.push(missing('CI status (Actions)', 'Actions', error)); }
    } else if (checksResult.status === 'fulfilled') runs = checksResult.value;
    else warnings.push(missing('CI check runs', 'Checks', checksResult.reason));
    if (statusesResult.status === 'rejected') warnings.push(missing('Commit statuses', 'Commit statuses', statusesResult.reason));
    const ci = summarizeCI(runs, statusesResult.status === 'fulfilled' ? statusesResult.value : []);
    if (warnings.length && ci.state === 'success') ci.state = 'unknown';
    ci.runningAgent = ci.runs.some(run => run.status !== 'completed' && rules.autofixCheck.test(run.name));
    delete ci.runs;
    return { ...ci, source, warnings, complete: warnings.length === 0, reviewChecks: source === 'checks' ? runs : [] };
  }

  async function enrich(repo, pr) {
    const path = `/repos/${repo.repo}`;
    const pullPath = `${path}/pulls/${pr.number}`;
    const results = await Promise.allSettled([
      api.get(`${path}/commits/${pr.head.sha}`).then(result => result.data),
      api.list(`${pullPath}/commits`), api.list(`${pullPath}/reviews`),
      api.list(`${pullPath}/comments`), api.list(`${path}/issues/${pr.number}/comments`),
      readCI(repo.repo, pr.head.sha),
    ]);
    const warnings = [];
    function value(index, label, permission, fallback) {
      const result = results[index];
      if (result.status === 'fulfilled') return result.value;
      warnings.push(missing(label, permission, result.reason)); return fallback;
    }
    const commit = value(0, 'Head commit', 'Contents', {});
    const commits = value(1, 'PR commits', 'Pull requests', []);
    const reviews = value(2, 'Reviews', 'Pull requests', []);
    const comments = value(3, 'Review comments', 'Pull requests', []);
    const issueComments = value(4, 'Issue comments', 'Issues', []);
    const ci = value(5, 'CI status', 'Actions and Commit statuses', { ...summarizeCI([], []), complete: false, warnings: [] });
    delete ci.runs;
    const checkRuns = ci.reviewChecks ?? [];
    delete ci.reviewChecks;
    warnings.push(...ci.warnings);
    const reviewers = summarizeReviews({ reviews, comments, issueComments, checkRuns, headSha: pr.head.sha, owner: repo.repo.split('/')[0] });
    warnings.push(...reviewers.flatMap(reviewer => reviewer.incompleteReason ? [reviewer.incompleteReason] : []));
    if (results.slice(2, 5).some(result => result.status === 'rejected')) {
      for (const reviewer of reviewers) reviewer.complete = false;
    }
    return { kind: 'pr', id: `${repo.repo}#${pr.number}`, repo: repo.repo, number: pr.number, title: pr.title,
      url: `https://github.com/${repo.repo}/pull/${pr.number}`, draft: pr.draft,
      headSha: pr.head.sha, mergedAt: pr.merged_at, updatedAt: pr.updated_at,
      labels: (pr.labels ?? []).map(label => label.name),
      headAt: commit.commit?.committer?.date ?? commit.commit?.author?.date,
      headMessage: commit.commit?.message?.split('\n')[0] ?? '',
      latestCommits: commits.slice(-5).reverse().map(item => ({ sha: item.sha,
        message: item.commit?.message?.split('\n')[0] ?? '', at: item.commit?.committer?.date ?? item.commit?.author?.date })),
      ci, reviewers, dataComplete: warnings.length === 0, warnings, warning: warnings.join(' ') };
  }

  return {
    beginCycle: api.beginCycle, usage: api.usage,
    async collectRepo(repo, now = Date.now()) {
      const path = `/repos/${repo.repo}/pulls`;
      const [open, closed] = await Promise.all([
        api.list(`${path}?state=open&sort=updated&direction=desc`),
        api.list(`${path}?state=closed&sort=updated&direction=desc`, undefined,
          batch => batch.some(pr => Date.parse(pr.updated_at) < now - 48 * 60 * 60_000)),
      ]);
      const merged = closed.filter(pr => pr.merged_at && dayKey(pr.merged_at) === dayKey(now));
      return mapLimit([...open, ...merged], 3, pr => enrich(repo, pr));
    },
  };
}
