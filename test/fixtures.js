export const now = Date.parse('2026-10-15T18:00:00Z');
export const head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
export const repo = { repo: 'kalkreuter/storagestack-manage', name: 'Manage', color: '#8b9dff' };
export function pr(overrides = {}) {
  return { id: `${repo.repo}#1`, repo: repo.repo, number: 1, title: 'Make space for the next project',
    url: `https://github.com/${repo.repo}/pull/1`, headSha: head, headAt: '2026-10-15T16:00:00Z',
    draft: false, labels: [], ci: { state: 'success', total: 1, passed: 1, failed: 0, pending: 0 },
    dataComplete: true, reviewers: [], ...overrides };
}
