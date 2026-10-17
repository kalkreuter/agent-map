import { createReader } from './api.js';
import { rules } from '../config/rules.js';

export function createCursor(key, fetchImpl) {
  if (!key) return null;
  const api = createReader({ origin: 'https://api.cursor.com', service: 'Cursor', fetchImpl,
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` } });
  return {
    async collect() {
      const agents = [];
      let cursor;
      const seen = new Set();
      do {
        const { data } = await api.get(`/v0/agents?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!Array.isArray(data.agents)) throw new Error('Invalid Cursor response');
        agents.push(...data.agents);
        cursor = data.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeated Cursor pagination cursor');
        seen.add(cursor);
      } while (cursor);
      const byPr = new Map();
      const byPrInstances = new Map();
      const unlinked = new Map();
      for (const agent of agents) {
        let prUrl, agentUrl = null;
        try { prUrl = new URL(agent.target?.prUrl); } catch { /* No linked PR. */ }
        if (prUrl && (prUrl.origin !== 'https://github.com' || prUrl.username || prUrl.password || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(prUrl.pathname))) continue;
        try { const url = new URL(agent.target?.url); if (url.origin === 'https://cursor.com' && !url.username && !url.password) agentUrl = url.href; } catch { /* Agent may have no conversation URL yet. */ }
        const entry = { id: agent.id, url: agentUrl, status: agent.status ?? 'UNKNOWN',
          name: typeof agent.name === 'string' ? agent.name : 'Cursor cloud agent', createdAt: agent.createdAt,
          running: rules.runningAgentStatuses.includes(agent.status) };
        if (prUrl) {
          const normalized = (prUrl.origin + prUrl.pathname.replace(/\/$/, '')).toLowerCase();
          if (!byPr.has(normalized) || entry.running) byPr.set(normalized, entry);
          if (agent.id) {
            const runs = byPrInstances.get(normalized) ?? new Map();
            runs.set(agent.id, entry); byPrInstances.set(normalized, runs);
          }
          continue;
        }
        let repository;
        try { repository = new URL(agent.source?.repository); } catch { continue; }
        if (repository.origin !== 'https://github.com' || repository.username || repository.password || !/^\/[^/]+\/[^/]+\/?$/.test(repository.pathname) || !agent.id) continue;
        const repo = repository.pathname.slice(1).replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
        unlinked.set(agent.id, { kind: 'agent', id: `cursor:${agent.id}`, repo, title: agent.name || 'Cursor cloud agent',
          createdAt: agent.createdAt, agent: entry });
      }
      return { byPr, byPrInstances: new Map([...byPrInstances].map(([url, runs]) => [url, [...runs.values()]])), unlinked: [...unlinked.values()] };
    },
  };
}
