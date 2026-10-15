import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGitHub } from './github.js';
import { createCursor } from './cursor.js';
import { createCache } from './cache.js';
import { rules } from '../config/rules.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/hex-map.js', ['hex-map.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const hash = value => createHash('sha256').update(value).digest();

export function authorized(header, password) {
  if (!password || !header?.startsWith('Basic ')) return false;
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = credentials.indexOf(':');
  return separator >= 0 && timingSafeEqual(hash(credentials.slice(separator + 1)), hash(password));
}

export function createServer({ password, cache }) {
  if (!password) throw new Error('DASHBOARD_PASSWORD is required');
  return http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
    const send = (status, body, extra = {}) => { res.writeHead(status, { ...headers, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; }
    catch { return send(400, 'Invalid request URL'); }
    // Health reveals no private data and supports Railway's health checks.
    if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) return send(200, 'ok');
    if (!authorized(req.headers.authorization, password)) {
      return send(401, 'Password required', { 'WWW-Authenticate': 'Basic realm="Agent Map", charset="UTF-8"' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Read-only', { Allow: 'GET, HEAD' });
    try {
      if (path === '/api/map') return send(200, JSON.stringify(cache.view()), { 'Content-Type': 'application/json; charset=utf-8' });
      const asset = assets.get(path);
      if (!asset) return send(404, 'Not found');
      const body = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      return send(200, body, { 'Content-Type': asset[1] });
    } catch { return send(500, 'Unable to serve dashboard'); }
  });
}

export async function start(env = process.env) {
  if (!env.GITHUB_READ_TOKEN || !env.DASHBOARD_PASSWORD) throw new Error('Set GITHUB_READ_TOKEN and DASHBOARD_PASSWORD before starting.');
  const repos = JSON.parse(await readFile(new URL('../config/repos.json', import.meta.url), 'utf8'));
  if (!Array.isArray(repos) || repos.length === 0 || repos.some(repo =>
    !/^[\w.-]+\/[\w.-]+$/.test(repo.repo) || typeof repo.name !== 'string' || !/^#[\da-f]{6}$/i.test(repo.color))) {
    throw new Error('config/repos.json must contain repo, name, and a six-digit hex color for each project.');
  }
  const cache = createCache({ repos, github: createGitHub(env.GITHUB_READ_TOKEN), cursor: createCursor(env.CURSOR_API_KEY) });
  const server = createServer({ password: env.DASHBOARD_PASSWORD, cache });
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  server.listen(port, '0.0.0.0', () => console.log(`Agent Map listening on port ${server.address().port}`));
  void cache.refresh().catch(() => console.error('Initial refresh failed; retrying on next poll.'));
  const timer = setInterval(() => { void cache.refresh().catch(() => console.error('Refresh failed; retrying on next poll.')); }, rules.pollMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}
