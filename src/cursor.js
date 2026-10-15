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
      for (const agent of agents) {
        let prUrl, agentUrl = null;
        try { prUrl = new URL(agent.target?.prUrl); } catch { continue; }
        if (prUrl.origin !== 'https://github.com' || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(prUrl.pathname)) continue;
        try { const url = new URL(agent.target?.url); if (url.origin === 'https://cursor.com') agentUrl = url.href; } catch { /* Agent may have no conversation URL yet. */ }
        const normalized = prUrl.origin + prUrl.pathname.replace(/\/$/, '');
        const entry = { url: agentUrl, status: agent.status ?? 'UNKNOWN',
          running: rules.runningAgentStatuses.includes(agent.status) };
        if (!byPr.has(normalized) || entry.running) byPr.set(normalized, entry);
      }
      return byPr;
    },
  };
}
