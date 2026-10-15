import { isIP } from 'node:net';
import { rules } from '../config/rules.js';

function normalizeIP(ip) {
  return ip?.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function clientIP(req, trustProxyHops = 0) {
  const remote = normalizeIP(req.socket.remoteAddress) || 'unknown';
  if (!trustProxyHops || typeof req.headers['x-forwarded-for'] !== 'string') return remote;
  const chain = [...req.headers['x-forwarded-for'].split(',').map(ip => normalizeIP(ip.trim())), remote];
  const selected = chain[chain.length - 1 - trustProxyHops];
  return isIP(selected ?? '') ? selected : remote;
}

export function createLoginLimiter({ config = rules.auth, now = Date.now } = {}) {
  const entries = new Map();
  function record(ip) {
    const entry = entries.get(ip);
    if (entry && now() - entry.startedAt >= config.windowMs && entry.until <= now()) {
      entries.delete(ip); return;
    }
    return entry;
  }
  function retryAfter(ip) { return Math.max(0, Math.ceil(((record(ip)?.until ?? 0) - now()) / 1000)); }
  function fail(ip) {
    const entry = record(ip) ?? { failures: 0, startedAt: now(), until: 0 };
    entry.failures++;
    if (entry.failures >= config.maxFailures) {
      entry.until = now() + Math.min(config.maxLockoutMs, config.lockoutMs * 2 ** Math.min(30, entry.failures - config.maxFailures));
    }
    entries.delete(ip);
    if (entries.size >= config.maxEntries) {
      for (const key of entries.keys()) record(key);
      if (entries.size >= config.maxEntries) entries.delete(entries.keys().next().value);
    }
    entries.set(ip, entry);
    return retryAfter(ip);
  }
  return { retryAfter, fail, reset: ip => entries.delete(ip), size: () => entries.size };
}
