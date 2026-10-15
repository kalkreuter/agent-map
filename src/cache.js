import { classify, dayKey, rules, states } from '../config/rules.js';
import { pollInterval } from './polling.js';

export function createCache({ repos, github, cursor, now = Date.now }) {
  const previous = new Map();
  let snapshot = { updatedAt: null, repos: repos.map(repo => ({ ...repo, stale: false, updatedAt: null })),
    items: [], errors: [], loading: true, states, pollMs: rules.pollMs };
  let pending;
  function view() {
    return { ...snapshot, items: snapshot.items
      .filter(pr => !pr.mergedAt || dayKey(pr.mergedAt) === dayKey(now()))
      .map(pr => ({ ...pr, state: classify(pr, now()) })) };
  }
  async function refresh() {
    if (pending) return pending;
    pending = (async () => {
      const errors = [];
      let agents = { byPr: new Map(), unlinked: [] };
      github.beginCycle?.();
      const collected = await Promise.all(repos.map(async repo => {
        try {
          const items = await github.collectRepo(repo, now());
          previous.set(repo.repo, items);
          const warnings = [...new Set(items.flatMap(pr => pr.warnings ?? (pr.warning ? [pr.warning] : [])))];
          if (warnings.length) errors.push(`${repo.name}: ${warnings.join(' ')}`);
          return { ...repo, stale: false, updatedAt: new Date(now()).toISOString(), items };
        } catch {
          errors.push(`${repo.name}: GitHub unavailable; showing the last successful snapshot, if any.`);
          return { ...repo, stale: true, updatedAt: snapshot.repos.find(item => item.repo === repo.repo)?.updatedAt ?? null,
            items: (previous.get(repo.repo) ?? []).map(pr => ({ ...pr, dataComplete: false })) };
        }
      }));
      if (cursor) {
        try { agents = await cursor.collect(); }
        catch { errors.push('Cursor status unavailable. GitHub data is still shown.'); }
      }
      const standalone = agents.unlinked.flatMap(agent => {
        const repo = repos.find(repo => repo.repo.toLowerCase() === agent.repo);
        return repo ? [{ ...agent, repo: repo.repo }] : [];
      });
      const prCount = collected.reduce((total, repo) => total + repo.items.length, 0);
      snapshot = { ...snapshot, loading: false, updatedAt: new Date(now()).toISOString(), errors,
        pollMs: pollInterval({ repoCount: repos.length, prCount, ...github.usage?.(), now: now() }),
        repos: collected.map(({ items, ...repo }) => repo),
        items: [...collected.flatMap(repo => repo.items.map(pr => ({ ...pr, agent: agents.byPr.get(pr.url.toLowerCase()) ?? null }))), ...standalone] };
      return view();
    })().finally(() => { pending = null; });
    return pending;
  }
  return { refresh, view };
}
