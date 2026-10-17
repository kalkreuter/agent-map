import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGitHub } from './github.js';
import { createCursor } from './cursor.js';
import { createRailway } from './railway.js';
import { createCache } from './cache.js';
import { validateRepos } from './config.js';
import { clientIP, createLoginLimiter } from './auth.js';
import { startPolling } from './polling.js';
import { rules } from '../config/rules.js';

const assets = new Map([
  ['/', ['colony.html', 'text/html; charset=utf-8']],
  ['/2d', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/hex-map.js', ['hex-map.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['colony.js', 'colony-map.js', 'colony-assets.js', 'robot-model.js', 'scene-state.js', 'demo-state.js']
    .map(name => [`/${name}`, [name, 'text/javascript; charset=utf-8']]),
  ['/colony.css', ['colony.css', 'text/css; charset=utf-8']],
]);
// Serve only these pinned local dependencies. No CDN, package-directory listing,
// arbitrary file access, import map, or relaxed script policy is needed.
const vendorAssets = new Map([
  ['/vendor/three.module.js', 'three/build/three.module.js'],
  ['/vendor/three.core.js', 'three/build/three.core.js'],
  ['/vendor/OrbitControls.js', 'three/examples/jsm/controls/OrbitControls.js'],
]);
const hash = value => createHash('sha256').update(value).digest();

export function authorized(header, password) {
  if (!password || !header?.startsWith('Basic ')) return false;
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = credentials.indexOf(':');
  return separator >= 0 && timingSafeEqual(hash(credentials.slice(separator + 1)), hash(password));
}

export function createServer({ password, cache, trustProxyHops = 0, authSettings = rules.auth, now = Date.now }) {
  if (!password) throw new Error('DASHBOARD_PASSWORD is required');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10');
  const limiter = createLoginLimiter({ config: authSettings, now });
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
    const ip = clientIP(req, trustProxyHops);
    const locked = limiter.retryAfter(ip);
    if (locked) return send(429, 'Too many failed logins. Try again later.', { 'Retry-After': String(locked) });
    if (!authorized(req.headers.authorization, password)) {
      const retryAfter = req.headers.authorization ? limiter.fail(ip) : 0;
      if (retryAfter) return send(429, 'Too many failed logins. Try again later.', { 'Retry-After': String(retryAfter) });
      return send(401, 'Password required', { 'WWW-Authenticate': 'Basic realm="Agent Map", charset="UTF-8"' });
    }
    limiter.reset(ip);
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Read-only', { Allow: 'GET, HEAD' });
    try {
      if (path === '/api/map') return send(200, JSON.stringify(cache.view(new URL(req.url, 'http://localhost'))), { 'Content-Type': 'application/json; charset=utf-8' });
      const vendor = vendorAssets.get(path);
      if (vendor) {
        let body = await readFile(new URL(`../node_modules/${vendor}`, import.meta.url), 'utf8');
        if (path === '/vendor/OrbitControls.js') body = body.replace("from 'three'", "from '/vendor/three.module.js'");
        return send(200, body, { 'Content-Type': 'text/javascript; charset=utf-8' });
      }
      const asset = assets.get(path);
      if (!asset) return send(404, 'Not found');
      const body = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      return send(200, body, { 'Content-Type': asset[1] });
    } catch { return send(500, 'Unable to serve dashboard'); }
  });
}

export async function start(env = process.env) {
  if (!env.GITHUB_READ_TOKEN || !env.DASHBOARD_PASSWORD) throw new Error('Set GITHUB_READ_TOKEN and DASHBOARD_PASSWORD before starting.');
  const repos = validateRepos(JSON.parse(await readFile(new URL('../config/repos.json', import.meta.url), 'utf8')));
  const railway = createRailway(env.RAILWAY_PROJECT_TOKEN || env.RAILWAY_API_TOKEN, undefined,
    { authMode: env.RAILWAY_PROJECT_TOKEN ? 'project' : 'account' });
  const cache = createCache({ repos, github: createGitHub(env.GITHUB_READ_TOKEN), cursor: createCursor(env.CURSOR_API_KEY), railway });
  const server = createServer({ password: env.DASHBOARD_PASSWORD, cache, trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0) });
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  server.listen(port, '0.0.0.0', () => console.log(`Agent Map listening on port ${server.address().port}`));
  const stopPolling = startPolling(cache, { onError: () => console.error('Refresh failed; retrying on next poll.') });
  server.on('close', stopPolling);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}
