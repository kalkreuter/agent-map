// All classification/reviewer heuristics live here. Order is intentional:
// merged > explicit OK > fixes > working > ready > draft/idle.
// REST does not expose thread resolution. Count severity-marked review comments
// conservatively, even on old commits, until a same-thread reply by the reviewer
// or repository owner explicitly says resolved/fixed. Dismissed review bodies do
// not count. Summary comments count only when that review has no inline findings.
// SHA-less issue comments never imply review of the current head.
export const rules = {
  pollMs: 60_000,
  recentCommitMs: 20 * 60_000,
  timezone: 'America/Los_Angeles',
  awaitingLabels: ['awaiting ok'],
  blockingLabels: ['p1', 'p2', 'high', 'medium', 'blocking'],
  severity: /\bP[12]\b|\b(?:high|medium)(?:[\s_-]+(?:severity|priority))?\b|\bblocking\b/i,
  noFindings: /\b(?:no|zero|0)\s+(?:(?:open|new|remaining|actionable)\s+)?(?:P[12](?:\s*[/,]\s*P[12])?|high|medium|blocking)\b|\b(?:did not|didn't) find\b/i,
  resolved: /^(?:\s*(?:✅|✔|\*\*)\s*)?(?:resolved|fixed|addressed)\b/i,
  claudeMarker: /\bclaude(?:[ -]code)?\b/i,
  reviewedSha: /\b(?:reviewed(?:\s+(?:commit|head|sha))?|review(?:ed)?[ _-]?sha|head[ _-]?sha)\s*[:=]?\s*[`*]*([0-9a-f]{40})\b/i,
  reviewers: [
    { id: 'bugbot', name: 'Bugbot', logins: ['cursor[bot]', 'cursor-bugbot[bot]'] },
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
};

export function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: rules.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(date));
}

export function classify(pr, now = Date.now()) {
  if (pr.mergedAt && dayKey(pr.mergedAt) === dayKey(now)) return 'MERGED_TODAY';
  if (pr.mergedAt) return 'DRAFT_IDLE';
  const labels = (pr.labels ?? []).map(label => label.toLowerCase().trim());
  if (labels.some(label => rules.awaitingLabels.includes(label))) return 'NEEDS_ANDRE';
  if (pr.ci?.state === 'failure' || pr.reviewers?.some(reviewer => reviewer.openFindings > 0)
    || labels.some(label => rules.blockingLabels.includes(label))) return 'FIXES_NEEDED';
  const age = now - Date.parse(pr.headAt);
  if ((age >= 0 && age < rules.recentCommitMs) || pr.agent?.running || pr.ci?.runningAgent) return 'WORKING';
  if (!pr.draft && pr.dataComplete !== false && pr.ci?.state === 'success') return 'NEEDS_ANDRE';
  return 'DRAFT_IDLE';
}
