import { hasFinding, rules } from '../config/rules.js';

function reviewerFor(activity, owner) {
  const login = activity.user?.login?.toLowerCase();
  const app = activity.performed_via_github_app?.slug?.toLowerCase();
  const body = activity.body ?? '';
  // cursor[bot] reviews are also performed via the Cursor app. Keep those logins;
  // the slug only excludes agent fix lists posted as someone else.
  const bugbotLogin = rules.reviewers.find(reviewer => reviewer.id === 'bugbot')?.logins.includes(login);
  if ((app === 'cursor' && !bugbotLogin) || (body.length <= rules.triggerMaxLength && rules.triggerPatterns.some(pattern => pattern.test(body)))) return;
  if (app === 'claude') return rules.reviewers.find(reviewer => reviewer.id === 'claude');
  return rules.reviewers.find(reviewer => reviewer.logins.includes(login)
    || (reviewer.id === 'claude' && login === owner.toLowerCase()
      && rules.claudeReviewOutput.test(body)));
}

function reviewedSha(activity) {
  // GitHub can move commit_id forward as an inline comment's diff is updated.
  // original_commit_id records the commit that the reviewer actually saw.
  return (activity.kind === 'inline' ? activity.original_commit_id ?? activity.commit_id : activity.commit_id)
    ?? activity.body?.match(rules.reviewedSha)?.[1]?.toLowerCase() ?? null;
}

function checkReview(reviewer, checkRuns, headSha) {
  const config = reviewer.checkRun;
  if (!config) return;
  const latest = checkRuns.filter(run => run.head_sha === headSha
    && config.names.includes(run.name) && config.appSlugs.includes(run.app?.slug))
    .sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== 'completed' || !config.conclusions.includes(latest.conclusion)
    || !Number.isFinite(Date.parse(latest.completed_at))) return;
  const output = [latest.output?.summary, latest.output?.text].filter(Boolean).join('\n');
  const counts = output.split('\n').flatMap(line => {
    const count = line.match(config.issueCount)?.[1];
    return count === undefined ? [] : [Number(count)];
  });
  const reportedIssues = Math.max(0, ...counts);
  // Conflicting result lines must not let a clean result hide reported issues.
  const clean = config.clean.test(output) && reportedIssues === 0;
  if (!clean && !counts.length) return;
  return { kind: 'check', body: '', at: latest.completed_at, startedAt: latest.started_at, commit_id: headSha,
    clearOutdated: clean && config.supersedesOutdatedFindings, reportedIssues };
}

function duringCheck(at, check) {
  const timestamp = Date.parse(at);
  return Date.parse(check?.startedAt) <= timestamp && timestamp <= Date.parse(check?.at);
}

function supersededByCheck(item, check) {
  if (!check?.clearOutdated) return false;
  const originalSha = reviewedSha(item);
  // Modern REST responses retain a numeric position even after line becomes
  // null. Require an original inline location; file-level comments don't count.
  const outdated = item.line === null && item.original_line != null
    || item.line === undefined && item.position === null && item.original_position != null;
  const changedAt = Date.parse(item.updated_at ?? item.at);
  return outdated && originalSha && originalSha !== check.commit_id && changedAt <= Date.parse(check.at);
}

export function summarizeReviews({ reviews, comments, issueComments, headSha, owner, checkRuns = [] }) {
  const activeReviews = reviews.filter(review => review.state !== 'DISMISSED' && review.state !== 'PENDING');
  const dismissed = new Set(reviews.filter(review => review.state === 'DISMISSED').map(review => review.id));
  const activities = [
    ...activeReviews.map(item => ({ ...item, at: item.submitted_at, kind: 'review' })),
    ...comments.filter(item => !dismissed.has(item.pull_request_review_id))
      .map(item => ({ ...item, at: item.created_at, kind: 'inline' })),
    ...issueComments.map(item => ({ ...item, at: item.created_at, kind: 'issue' })),
  ];
  return rules.reviewers.map(reviewer => {
    const own = activities.filter(item => reviewerFor(item, owner)?.id === reviewer.id);
    const check = checkReview(reviewer, checkRuns, headSha);
    if (check) own.push(check);
    const roots = own.filter(item => item.kind === 'inline' && !item.in_reply_to_id);
    const findings = roots.filter(item => hasFinding(item.body) && !supersededByCheck(item, check) && !comments.some(reply =>
      reply.in_reply_to_id === item.id && rules.resolved.test(reply.body ?? '')
      && [owner.toLowerCase(), item.user.login.toLowerCase()].includes(reply.user?.login?.toLowerCase())));
    const summaries = own.filter(item => item.kind !== 'inline' && hasFinding(item.body)
      && !reviewer.ignoreFindingSummary?.test(item.body ?? '')
      && (item.kind !== 'review' || !roots.some(root => root.pull_request_review_id === item.id && hasFinding(root.body))));
    // Original creation plus the trusted parent review ties details to this run.
    // Edits to an earlier run's comments cannot account for newly reported issues.
    const currentReviewIds = new Set(own.filter(item => item.kind === 'review'
      && reviewedSha(item) === headSha && duringCheck(item.at, check)).map(item => item.id));
    const coveredIssues = roots.filter(item => reviewedSha(item) === headSha
      && item.pull_request_review_id != null && currentReviewIds.has(item.pull_request_review_id)
      && duringCheck(item.created_at, check)
      && (hasFinding(item.body) || rules.nonBlockingSeverity.test(item.body ?? ''))).length;
    const incomplete = check && check.reportedIssues > coveredIssues;
    const sorted = own.filter(item => item.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const latest = sorted[0];
    const reviewed = sorted.find(item => reviewedSha(item));
    const sha = reviewed ? reviewedSha(reviewed) : null;
    return {
      id: reviewer.id, name: reviewer.name, lastAt: latest?.at ?? null,
      lastReviewedSha: sha, currentHead: Boolean(sha && sha === headSha),
      openFindings: findings.length + summaries.length || (incomplete ? null : 0),
      complete: !incomplete,
      ...(incomplete ? { incompleteReason: `${reviewer.name} reported issues whose review details are not fully available yet.` } : {}),
    };
  });
}
