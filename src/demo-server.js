// A separate, local-only rehearsal. Never starts collectors or reads credentials.
import { createServer } from './server.js';
import { demoState } from '../public/demo-state.js';
import { fileURLToPath } from 'node:url';

export function startDemo({ port = 3000 } = {}) {
  const fixture = demoState(0).legacy;
  const quiet = { ...fixture, mode: 'LIVE', items: [], loading: false, updatedAt: null,
    repos: fixture.repos.map(repo => ({ ...repo, updatedAt: null, stale: true })),
    sourceHealth: [{ id: 'github', name: 'GitHub', status: 'disconnected', observedAt: null,
      message: 'Local demo server. No live credentials or upstream connections.' }],
    errors: ['LIVE unavailable in the local demo server. Start npm start with scoped read-only credentials.'] };
  const cache = { view: url => url?.searchParams.get('mode') === 'live' ? quiet : ({ ...fixture, mode: 'DEMO' }) };
  const server = createServer({ password: 'demo', cache });
  server.listen(port, '127.0.0.1', () => console.log(`Agent Map DEMO: http://127.0.0.1:${server.address().port} (username andre, password demo)`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startDemo({ port: Number(process.env.PORT ?? 3000) });
