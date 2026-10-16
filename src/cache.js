import { classify, dayKey, rules, states } from '../config/rules.js';
import { pollInterval } from './polling.js';

export function createCache({ repos, github, cursor, railway, now = Date.now }) {
  const previous = new Map();
  const previousDeployments = new Map();
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
      const comparisons = new Map();
      const deploymentWork = railway ? Promise.all(repos.map(async repo => {
        let items;
        try { items = await railway.collectRepo(repo); if (!Array.isArray(items)) throw new Error(); }
        catch {
          items = (repo.railway ?? []).map(target => ({ kind: 'deployment',
            id: `railway:${target.projectId}:${target.environmentId}:${target.serviceId}`, repo: repo.repo,
            title: target.name ?? 'Railway deployment', serviceName: target.name ?? 'Railway service',
            environmentName: target.environmentName ?? 'Environment', branch: target.branch ?? 'main',
            deployment: { status: 'UNKNOWN', live: null, latest: null }, dataComplete: false,
            warning: 'Railway unavailable; check service access and token configuration.' }));
        }
        return Promise.all(items.map(async item => {
          if (item.dataComplete === false) {
            const old = previousDeployments.get(item.id);
            const warning = `${item.warning || 'Railway deployment unavailable.'}${old ? ' Showing previously collected Railway data.' : ''}`;
            errors.push(`${repo.name}: ${warning}`);
            return { ...(old ?? item), sync: old?.sync ?? { status: 'unknown', branch: item.branch ?? 'main', headSha: null },
              warning, stale: true, dataComplete: false };
          }
          const branch = item.branch ?? 'main';
          let sync = { status: 'unknown', branch, headSha: null };
          let warning = item.warning ?? '';
          if (item.deployment?.live?.sha) {
            const key = `${repo.repo}:${branch}:${item.deployment.live.sha}`;
            if (!comparisons.has(key)) comparisons.set(key, Promise.resolve().then(() =>
              github.compareDeployment(repo.repo, item.deployment.live.sha, branch)));
            try { sync = await comparisons.get(key); }
            catch { warning = [warning, 'Live deployment is available, but its branch comparison is unavailable.'].filter(Boolean).join(' '); }
          }
          const result = { ...item, sync, warning, stale: false, dataComplete: item.dataComplete !== false && !warning };
          // Retain independently of GitHub so a failed source cannot erase the
          // other source, and never turn a stale deployment into a fresh one.
          previousDeployments.set(item.id, result);
          if (warning) errors.push(`${repo.name}: ${warning}`);
          return result;
        }));
      })).then(groups => groups.flat()) : Promise.resolve([]);
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
      const deployments = await deploymentWork;
      snapshot = { ...snapshot, loading: false, updatedAt: new Date(now()).toISOString(), errors,
        pollMs: pollInterval({ repoCount: repos.length, prCount, ...github.usage?.(), now: now() }),
        repos: collected.map(({ items, ...repo }) => repo),
        items: [...collected.flatMap(repo => repo.items.map(pr => ({ ...pr, agent: agents.byPr.get(pr.url.toLowerCase()) ?? null }))), ...standalone, ...deployments] };
      return view();
    })().finally(() => { pending = null; });
    return pending;
  }
  return { refresh, view };
}
