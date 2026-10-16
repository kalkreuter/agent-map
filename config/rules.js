// All classification/reviewer heuristics live here. Order is intentional:
// merged > explicit OK > fixes > working > ready > draft/idle.
// REST does not expose thread resolution. Count severity-marked review comments
// conservatively, even on old commits, until a same-thread reply by the reviewer
// or repository owner explicitly says resolved/fixed. A verified clean Bugbot
// check on the current head also supersedes older, outdated inline findings.
// Dismissed review bodies do not count. PR risk summaries are not findings.
// SHA-less issue comments never imply review of the current head.
export const rules = {
  pollMs: 60_000,
  quietPeriodMs: 20 * 60_000,
  draftRequiredReviewers: ['bugbot', 'codex', 'claude'],
  polling: { hourlyLimit: 5000, budgetFraction: .5, lowRemainingFraction: .1, fallbackBackoffMs: 5 * 60_000 },
  auth: { maxFailures: 5, windowMs: 15 * 60_000, lockoutMs: 60_000, maxLockoutMs: 15 * 60_000, maxEntries: 10_000 },
  timezone: 'America/Los_Angeles',
  awaitingLabels: ['awaiting ok'],
  blockingLabels: ['p1', 'p2', 'high', 'medium', 'blocking'],
  severity: /\bP[12]\b|\b(?:high|medium)(?:[\s_-]+(?:severity|priority))?\b|\bblocking\b/i,
  nonBlockingSeverity: /\bP[34]\b|\blow(?:[\s_-]+(?:severity|priority))?\b/i,
  noFindings: /\b(?:no|zero|0)\s+(?:(?:open|new|remaining|actionable)\s+)?(?:P[12](?:\s*[/,]\s*P[12])?|high|medium|blocking)\b|\b(?:did not|didn't) find\b/i,
  resolved: /^(?:\s*(?:✅|✔|\*\*)\s*)?(?:resolved|fixed|addressed)\b/i,
  claudeReviewOutput: /(?:^|\n)\s*(?:#{1,6}\s*|\*\*)(?:claude(?:[ -]code)?\s+(?:code\s+)?review|code\s+review|review\s+(?:summary|findings))\b|\breviewed\s+(?:by|with)\s+claude(?:[ -]code)?\b/i,
  triggerMaxLength: 160,
  triggerPatterns: [/^\s*@(claude|codex)\s+(?:go|review|please\s+review|fix|continue|run)\b/i],
  reviewedSha: /\b(?:reviewed(?:\s+(?:commit|head|sha))?|review(?:ed)?[ _-]?sha|head[ _-]?sha)\s*[:=]?\s*[`*]*([0-9a-f]{40})\b/i,
  reviewers: [
    { id: 'bugbot', name: 'Bugbot', logins: ['cursor[bot]', 'cursor-bugbot[bot]'],
      ignoreFindingSummary: /<!--\s*CURSOR_SUMMARY\s*-->/i,
      checkRun: { names: ['Cursor Bugbot'], appSlugs: ['cursor'], conclusions: ['success', 'neutral'],
        clean: /(?:^|\n)\s*\*{0,2}Final Result:\*{0,2}\s*Bugbot completed review\s*[-–—:]\s*no issues found\b/i,
        issueCount: /(?:^|\n)\s*\*{0,2}Final Result:\*{0,2}\s*Bugbot completed review and found\s+(\d+)\s+(?:potential\s+)?issues?\b/i,
        supersedesOutdatedFindings: true } },
    { id: 'codex', name: 'Codex', logins: ['chatgpt-codex-connector[bot]'] },
    { id: 'claude', name: 'Claude', logins: ['claude[bot]', 'claude-code[bot]'] },
  ],
  runningAgentStatuses: ['RUNNING', 'CREATING'],
  autofixCheck: /agent|autofix|bugbot|cursor|codex|claude/i,
};

export function hasFinding(body = '') {
  return body.split('\n').some(line => rules.severity.test(line) && !rules.noFindings.test(line) && !rules.resolved.test(line));
}

export const states = {
  NEEDS_ANDRE: { label: 'Needs Andre', color: '#ff747d', symbol: '?' },
  WORKING: { label: 'Working', color: '#8b9dff', symbol: '⚒' },
  FIXES_NEEDED: { label: 'Fixes needed', color: '#f4bb65', symbol: '!' },
  DRAFT_IDLE: { label: 'Draft / idle', color: '#8a95a9', symbol: '·' },
  MERGED_TODAY: { label: 'Merged today', color: '#52d4bc', symbol: '✓', fadeMs: 6 * 60 * 60_000 },
  DEPLOY_LIVE: { label: 'Live', color: '#52d4bc', symbol: '✓' },
  DEPLOYING: { label: 'Deploying', color: '#8b9dff', symbol: '↑' },
  DEPLOY_FAILED: { label: 'Deploy failed', color: '#ff747d', symbol: '!' },
  DEPLOY_BEHIND: { label: 'Live / behind', color: '#f4bb65', symbol: '!' },
  DEPLOY_UNKNOWN: { label: 'Deploy unknown', color: '#8a95a9', symbol: '·' },
};

export function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: rules.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(date));
}

export function classify(pr, now = Date.now()) {
  if (pr.kind === 'deployment') {
    if (pr.stale) return 'DEPLOY_UNKNOWN';
    if (['WAITING', 'QUEUED', 'INITIALIZING', 'BUILDING', 'DEPLOYING'].includes(pr.deployment?.status)) return 'DEPLOYING';
    if (['FAILED', 'CRASHED'].includes(pr.deployment?.status)) return 'DEPLOY_FAILED';
    if (pr.deployment?.live?.status !== 'SUCCESS') return 'DEPLOY_UNKNOWN';
    return pr.sync?.status === 'behind' ? 'DEPLOY_BEHIND' : 'DEPLOY_LIVE';
  }
  if (pr.kind === 'agent') return pr.agent?.running ? 'WORKING' : 'DRAFT_IDLE';
  if (pr.mergedAt && dayKey(pr.mergedAt) === dayKey(now)) return 'MERGED_TODAY';
  if (pr.mergedAt) return 'DRAFT_IDLE';
  const labels = (pr.labels ?? []).map(label => label.toLowerCase().trim());
  if (labels.some(label => rules.awaitingLabels.includes(label))) return 'NEEDS_ANDRE';
  if (pr.ci?.state === 'failure' || pr.reviewers?.some(reviewer => reviewer.openFindings > 0)
    || labels.some(label => rules.blockingLabels.includes(label))) return 'FIXES_NEEDED';
  const age = now - Date.parse(pr.headAt);
  if ((age >= 0 && age < rules.quietPeriodMs) || pr.agent?.running || pr.ci?.runningAgent) return 'WORKING';
  const reviewedDraft = age >= rules.quietPeriodMs && rules.draftRequiredReviewers.every(id =>
    pr.reviewers?.some(reviewer => reviewer.id === id && reviewer.currentHead && reviewer.complete !== false && reviewer.openFindings === 0));
  if ((!pr.draft || reviewedDraft) && pr.dataComplete !== false && pr.ci?.state === 'success') return 'NEEDS_ANDRE';
  return 'DRAFT_IDLE';
}
