import { hasFinding, rules } from '../config/rules.js';

function reviewerFor(activity, owner) {
  const login = activity.user?.login?.toLowerCase();
  const app = activity.performed_via_github_app?.slug?.toLowerCase();
  const body = activity.body ?? '';
  if (app === 'cursor' || (body.length <= rules.triggerMaxLength && rules.triggerPatterns.some(pattern => pattern.test(body)))) return;
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

export function summarizeReviews({ reviews, comments, issueComments, headSha, owner }) {
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
    const roots = own.filter(item => item.kind === 'inline' && !item.in_reply_to_id);
    const findings = roots.filter(item => hasFinding(item.body) && !comments.some(reply =>
      reply.in_reply_to_id === item.id && rules.resolved.test(reply.body ?? '')
      && [owner.toLowerCase(), item.user.login.toLowerCase()].includes(reply.user?.login?.toLowerCase())));
    const summaries = own.filter(item => item.kind !== 'inline' && hasFinding(item.body)
      && (item.kind !== 'review' || !roots.some(root => root.pull_request_review_id === item.id && hasFinding(root.body))));
    const sorted = own.filter(item => item.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const latest = sorted[0];
    const reviewed = sorted.find(item => reviewedSha(item));
    const sha = reviewed ? reviewedSha(reviewed) : null;
    return {
      id: reviewer.id, name: reviewer.name, lastAt: latest?.at ?? null,
      lastReviewedSha: sha, currentHead: Boolean(sha && sha === headSha),
      openFindings: findings.length + summaries.length,
    };
  });
}
