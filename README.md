# Agent Map

A password-protected, read-only dashboard of the PRs that need Andre. Projects form colored clusters on a 2D hex map; each open PR is a tile. Today's merges stay visible in green until the next day in `America/Los_Angeles`.

Phase 1 of [issue #1](https://github.com/kalkreuter/agent-map/issues/1). Built with Node ≥20 and vanilla JavaScript/SVG, with no runtime dependencies, build step, database, or disk cache. The running app only makes GET requests to GitHub REST and, optionally, Cursor. It cannot approve, comment, launch agents, merge, or deploy anything.

## Run locally

```sh
npm ci
export GITHUB_READ_TOKEN='your-read-only-fine-grained-token'
export DASHBOARD_PASSWORD='a-long-shared-password'
npm start
```

Open [localhost:3000](http://localhost:3000). The browser asks for Basic Auth: enter any username (e.g. `andre`) and `DASHBOARD_PASSWORD` as the password. Missing either required variable stops startup. For a private local env file, copy `.env.example` to `.env` and use `node --env-file=.env src/server.js` (Node ≥20.6); `npm start` reads the process environment only. `.env` files are ignored by Git.

| Environment variable | Purpose |
| --- | --- |
| `GITHUB_READ_TOKEN` | Required. Fine-grained PAT with read-only access to the configured repositories. |
| `DASHBOARD_PASSWORD` | Required shared password protecting the UI, assets, and API. |
| `CURSOR_API_KEY` | Optional Cursor cloud-agent API key. If absent, integration is silently skipped. |
| `PORT` | Listen port, default `3000`; binds `0.0.0.0`. |

Create the GitHub PAT for the appropriate resource owner, select the repositories, and grant **read-only** repository permissions for **Contents**, **Pull requests**, **Issues**, **Checks**, and **Commit statuses** (Metadata read is automatic). Follow any organization approval/SSO requirements. The app never sends tokens to the browser or logs API error bodies. Use HTTPS when hosting: Basic Auth relies on transport encryption. No secrets belong in repo config.

## Projects and classification

Edit `config/repos.json`; adding another object is enough:

```json
{ "repo": "kalkreuter/storagestack-manage", "name": "Manage", "color": "#8b9dff" }
```

Manage and Vivi are configured by default. Restart after config changes. Each repo has a cluster label and a color stripe on every tile. Tile color shows its state. The top count covers all projects; the visible/total count reflects filters. Drag to pan, scroll/pinch or use +/− to zoom, and use ⌖ to fit. Tiles also support Tab and Enter/Space. Select a tile to open CI, head commit/age, and Bugbot/Codex/Claude activity with PR and optional agent links.

All state precedence, time windows, timezone, reviewer identities, label names, and finding heuristics live in **`config/rules.js`**, separate from the renderer. First matching rule wins:

| State | Rule |
| --- | --- |
| `MERGED_TODAY` | Merged on today's date in the configured timezone. |
| `NEEDS_ANDRE` (explicit) | Case-insensitive exact `awaiting OK` label; intentionally overrides draft, CI, findings, and work. |
| `FIXES_NEEDED` | Failing CI, an open heuristic reviewer finding, or an exact P1/P2/High/Medium/blocking label. |
| `WORKING` | Head commit less than 20 minutes old, running Cursor agent, or queued/running agent/autofix check. Drafts can be working or need fixes. |
| `NEEDS_ANDRE` (ready) | Not draft, complete fresh PR details, green CI, and no blocking signal above. |
| `DRAFT_IDLE` | Everything else, including no CI data. |

CI uses check runs and commit statuses for the current head; the newest attempt per check/app or status context wins. Pending CI is not green; failed/cancelled/timed-out checks block. Skipped/neutral checks are nonblocking. Review freshness is displayed but does **not** independently prevent readiness, as specified by the issue.

**Review limitations:** GitHub REST does not expose review-thread resolution. Severity text (P1, P2, High, Medium, blocking) is a heuristic. Clearly negative summaries such as “No P1/P2 findings” are excluded. Inline findings remain open even when outdated until the reviewer or repository owner replies in that thread starting with “fixed”, “resolved”, or “addressed”. Dismissed reviews and their comments are ignored; summary bodies are excluded when that review has inline findings to avoid double counting. Standalone severity-marked review/issue summaries remain conservative blockers; verify them on GitHub and tune heuristics when needed. General prose can cause false positives, and findings without recognizable severity can be missed.

Bugbot uses `cursor[bot]` / `cursor-bugbot[bot]`; Codex uses `chatgpt-codex-connector[bot]`; Claude uses `claude[bot]` / `claude-code[bot]`, plus repository-owner comments explicitly mentioning Claude/Claude Code. Owner comments without a Claude marker are excluded. Last reviewed SHA comes from a review's `commit_id`, an inline comment's `original_commit_id` (falling back to `commit_id`), or a full 40-character SHA explicitly tagged “Reviewed”, “Reviewed commit”, “Review SHA”, or “Head SHA” in its body. Incidental commit links are ignored. SHA-less activity preserves the last known reviewed SHA; with none, the card shows “SHA unknown”. The current head is never guessed. Each card lists the last activity, known SHA, current-head status, and estimated open findings for all three reviewers.

## Collection and failure behavior

- A server poll runs immediately at startup, then every 60 seconds. Overlapping polls coalesce. Browsers read only the shared in-memory cache, so another tab does not trigger GitHub calls. The startup loading view refreshes every two seconds until the first snapshot is available.
- GitHub collection paginates open PRs, recently updated closed PRs (today's merges), PR commits, check runs, commit statuses, reviews, inline comments, and issue comments. The latest five PR commits and the head commit are retained; GitHub's PR-commits endpoint itself limits very large PRs to 250 commits. Requests time out after 15 seconds and enrichment is limited to three PRs per repo. A bounded in-memory ETag cache uses conditional GETs to reduce GitHub rate-limit usage on unchanged data. No GraphQL is used.
- A failed repo poll preserves the last successful data with a **stale** notice and collection time. Incomplete/stale data cannot qualify through the automatic CI-ready rule. An explicit `awaiting OK` label still follows its configured override; verify stale entries in GitHub. A failed PR detail fetch yields an unknown-CI tile and warning. Authentication, permissions, and rate-limit failures show unavailable data and retry on the next poll. Restart clears the cache. For many PRs, increase the polling interval in the rules module to respect GitHub's rate limits.
- With `CURSOR_API_KEY`, GET `https://api.cursor.com/v0/agents` uses Basic Auth (`key:`) and pagination. Exact `target.prUrl` matches attach `target.url` and status to a PR. RUNNING/CREATING statuses count as working. Only HTTPS GitHub PR and `cursor.com` agent links are accepted. Unmatched agents do not create extra tiles; API errors show a notice without breaking GitHub data.
- `/healthz` is the sole unauthenticated route and returns only `ok`. Private responses use `Cache-Control: no-store`, a restrictive CSP, and no-referrer headers. The API accepts only GET/HEAD. Upstream content renders as text; no HTML from comments/titles is injected.

## Validate

```sh
npm run check
npm test
```

Tests use Node's built-in runner, fixtures, and mocked transports; no secrets or live network calls. Coverage includes every state and precedence, timezone boundaries, review findings/freshness, CI reruns, REST pagination, GET-only collection, optional Cursor, stale caches, and authentication/routes. CI runs on Node 20 and 24.

## Railway deployment later

No service or production deployment is created by this PR. When ready to deploy separately:

1. Create a **new service** sourced from this repository in the intended Railway project; use the repo root `/`. Do not attach it to an existing StorageStack service.
2. Use Railway's Railpack Node builder (Node 20 or newer). Install with `npm ci`; no build step is required. Set the start command to `npm start`.
3. Set `GITHUB_READ_TOKEN` and `DASHBOARD_PASSWORD` as service variables; optionally set `CURSOR_API_KEY`. Railway supplies `PORT`.
4. Configure health checks at `/healthz`, enable an HTTPS Railway domain, and deploy the reviewed branch when authorized. Verify a successful deployment and the password prompt before viewing private data.

No volume or database is needed. Each replica has its own poller/cache; use a single replica initially. See [Railway deployment docs](https://docs.railway.com/guides/deploy) and [Railpack](https://docs.railway.com/builds/railpack).

## Later

Phase 2 can replace `public/hex-map.js` behind its `setItems`/`select`/`fit`/`zoom` interface with a 3D renderer. Robots, Railway state tiles, and write/approval controls are outside Phase 1.
