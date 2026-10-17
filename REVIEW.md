# Agent Map colony review

Review date: October 16, 2026 (America/Los_Angeles). Branch: `codex/agent-colony`.

## Review card — one coherent change set

**Purpose:** make the existing read-only ecosystem view explorable as a miniature robot colony while preserving the working SVG map and source collectors.

**Visible result:** connected Manage/Vivi hex districts, white modular buildings, expressive working/reviewing/waiting/idle robots, pan/zoom/bounded orbit, smooth selection, related-work highlights, explicit Needs Andre navigation, and a seekable six-frame synthetic replay. Portrait framing and cards keep selected work visible on a 390px viewport.

**Scope:** a renderer-neutral scene adapter and fixtures; original Three.js assets/robots; a vanilla JavaScript interface; distinct linked Cursor run retention; source-health timestamps; authenticated allowlisted local modules; a loopback demo entry point; in-memory recorded snapshots; SVG fallback; unit/browser checks and documentation. Existing live collectors, adaptive server polling, Basic Auth, review heuristics, and deployment classifications remain in place. Three.js is the sole new runtime package; there is no framework rewrite or build pipeline.

**Checks:** see the final result table below and the generated inspection report. Browser smoke verifies actual geometry and screenshot pixel variation, then selects a work site through the canvas and checks its card/relationships. WebGL initialization failure is a failure for that test, not a silent skip. Separate tests deliberately remove WebGL to verify fallback.

**Risks/limits:** source coverage is limited to what current adapters expose; live credentials were unavailable in this environment. GitHub review summaries lack worker-run IDs, so they are evidence on work sites rather than invented robots. Large districts render four work sites and a bounded crew; all omitted entities remain in Explore and overflow is disclosed. Real-device desktop/mobile FPS is unmeasured; see the honest software-rendered sample below. Existing readiness inference is preserved as a tile/card signal, while the attention queue counts explicit, fresh requests only.

**Approval needed:** review and explicitly authorize any merge. Production deployment and feature activation require separate approval. No merges, deployments, write-enabled integrations, approvals, permissions, or scheduled jobs were performed or changed.

## Run

```sh
cd /path/to/agent-map
npm ci
npm run demo
```

Open http://127.0.0.1:3000/?mode=demo with Basic Auth `andre` / `demo`. No upstream credentials are used by this separate loopback-only command.

- Waiting state: `http://127.0.0.1:3000/?mode=demo&step=5`
- Crowded: `http://127.0.0.1:3000/?mode=demo&step=5&crowded=1`
- Stale: `http://127.0.0.1:3000/?mode=demo&step=5&stale=1`
- Quiet/unavailable LIVE demonstration: `http://127.0.0.1:3000/?mode=live`
- Original SVG map: `http://127.0.0.1:3000/2d?mode=demo&step=5`

For actual LIVE, stop the demo and use existing scoped, read-only credentials:

```sh
export GITHUB_READ_TOKEN='your-scoped-read-only-token'
export DASHBOARD_PASSWORD='your-local-dashboard-password'
npm start
```

Open http://localhost:3000/?mode=live; use any Basic Auth username and `DASHBOARD_PASSWORD`. `CURSOR_API_KEY` and existing deployment credentials remain optional, server-side environment variables. No credentials are placed in browser code or source URLs. The existing README documents permissions and optional scopes.

RECORDED mode imports a captured `/api/map` JSON file with its original `updatedAt`; no historical capture is bundled. Imports stay in memory. Manual/automatic recorded SVG fallback keeps that same snapshot and never substitutes live data.

## Validation commands

```sh
npm run check
npm test
# If system Chromium is absent:
npx playwright install chromium
npm run test:browser
# With npm run demo already running in another terminal:
npm run inspect
```

The inspection command generates ignored `artifacts/` screenshots, `inspection-report.json`, and a WebM recording when system ffmpeg is available. CI runs Node 20/24 regression checks plus a separate Chromium WebGL job and uploads its browser report. Hosted CI results are reported separately from local results; local headless rendering does not establish mobile performance.

## Results and performance

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm test` | 186 passed, 0 failed |
| `npm run test:browser` | 12 passed, 0 failed (1.6 minutes) |
| Security review and hostile-content/mode probes | Passed; no remaining blockers |
| `npm audit --omit=dev` | 0 reported runtime vulnerabilities |
| Desktop/390px visual inspection | 11 screenshots opened and inspected |
| Uncaught application errors during inspection | 0 |
| Hardware desktop/mobile FPS | Unavailable/unmeasured |
| Authenticated real upstream smoke | Unavailable: no configured credentials |

Final isolated software sample: **3.1 renderer FPS** at 1440×1000 CSS pixels, 25 measured frames over 8,005ms after 11 warmup renders. P50 frame interval: 316.7ms; P95: 566.6ms. The reduced-quality path used DPR 0.75, 154 draw calls, 22,568 triangles and four robots. This is CPU-rendered SwiftShader; the 60/30 FPS targets are **not verified or achieved in this software test**. Normal GPU rendering retains higher resolution/PBR/soft shadows but has not been measured here. The app offers manual SVG fallback for weaker devices.

The environment uses Node 24.19.0, headless Chromium 154.0.8037.57, ANGLE SwiftShader (Vulkan CPU rendering), Intel Xeon Platinum 8573C, and a four-core container CPU quota. Desktop layout was inspected at 1440×1000; responsive mobile layout at 390×844. No physical mobile or hardware-GPU test was available.

An initial isolated software baseline was 2.3 renderer FPS over 8.4 seconds at 1440×1000, four robots, 343 draw calls and 21,336 triangles. That led to per-pivot robot batching, scene batching, cached static shadows, reduced software resolution/effects, and faster adaptive quality. This baseline is retained for context; it is not a claim that the desktop/mobile performance targets were achieved.

## Evidence

Final synthetic-only [desktop](docs/images/colony-desktop.png) and [mobile waiting selection](docs/images/colony-mobile-waiting.png) captures are retained under `docs/images/`; full state captures, JSON environment data, and interaction recording are in the local ignored `artifacts/` directory.

- `colony-desktop.png`
- `colony-selected-robot.png`
- `colony-changes-requested.png`
- `colony-waiting.png`
- `colony-crowded.png`
- `colony-live-quiet.png`
- `colony-stale.png`
- `colony-reduced-motion.png`
- `colony-mobile.png`
- `colony-mobile-waiting.png`
- `colony-2d-fallback.png`
- `colony-interaction.webm`

Screenshots were actually opened and inspected, including empty LIVE, stale source, crowded crews, reduced motion, and fallback. The interaction capture contains 16 actual CDP frames encoded at 12 FPS with approximate frame durations, useful for review rather than FPS measurement. The TikTok URL was inaccessible through the web tool; the supplied screenshot guided art direction. No claim is made to have watched the video.

## Live coverage and deferred work

GitHub PRs, CI/review evidence, merge observations, distinct observable Cursor runs, and the existing optional deployment adapter are reused. Current verified live relationships are exact Cursor run→PR assignments. Source health preserves last successful timestamps; missing credentials/incomplete reads/disconnects remain explicit. Existing heuristic reviewer findings and resolution limitations remain documented in README.

The local environment had no upstream credentials, so actual current PRs/runs/deployments could not be verified. Mocked adapter coverage and browser fixtures passed; that is not a live integration smoke test. The exact remaining live step is to start the app with the existing scoped read-only credentials and allowed upstream network access, then inspect the first successful collections. No synthetic evidence is used to fill gaps.

SSE, new provider adapters, observed orchestrator/worker relationships, production activation, themes, Notion terrain, weather, planet mode, and one-click approval are deferred. The builder, review/fix pipeline, Andre’s approvals, digest/alert schedules, and production monitoring remain separate systems.
