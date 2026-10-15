# Agent Map

A password-protected, read-only dashboard of the PRs and agents that need Andre. Projects form colored clusters on a 2D hex map; each open PR and each unlinked Cursor cloud agent is a tile. Today's merges fade in green until the next day in `America/Los_Angeles`.

Phase 1 of [issue #1](https://github.com/kalkreuter/agent-map/issues/1), with the [issue #3 follow-ups](https://github.com/kalkreuter/agent-map/issues/3). Built with Node ≥20 and vanilla JavaScript/SVG, with no npm dependencies, build step, database, or disk cache. The running app only makes GET requests to GitHub REST and, optionally, Cursor. It cannot approve, comment, launch agents, merge, or deploy anything.

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
| `TRUST_PROXY_HOPS` | Optional integer `0`–`10`, default `0` (ignore forwarded IPs). Set only for a known, trusted proxy chain; see login protection below. |

Create the fine-grained GitHub PAT for the appropriate resource owner, select the repositories, and grant **read-only** repository permissions for **Metadata** (automatic), **Contents**, **Pull requests**, **Issues**, **Actions**, and **Commit statuses**. Checks permission is not required: if the token cannot access check runs, the app uses Actions plus commit statuses. Follow any organization approval/SSO requirements. The app never sends tokens to the browser or logs API error bodies. Use HTTPS when hosting: Basic Auth relies on transport encryption. No secrets belong in repo config.

## Projects and classification

Edit `config/repos.json`; adding another object is enough:

```json
{ "repo": "kalkreuter/storagestack-manage", "name": "Manage", "color": "#8b9dff" }
```

Manage and Vivi are configured by default. Restart after config changes. Each repo has a cluster label, PR/agent counts, and a color stripe on every tile. Tile color shows its state. The top count covers all projects; the visible/total count reflects filters. Drag to pan, scroll/pinch or use +/− to zoom, and use ⌖ to fit. Tiles also support Tab and Enter/Space. Select a PR tile to open CI, head commit/age, and reviewer activity with PR and optional agent links. Agent cards show the agent name, status, creation age, and conversation link when known.

All state precedence, time windows, timezone, reviewer identities, label names, and finding heuristics live in **`config/rules.js`**, separate from the renderer. First matching rule wins:

| State | Rule |
| --- | --- |
| `MERGED_TODAY` | Merged on today's date in the configured timezone. |
| `NEEDS_ANDRE` (explicit) | Case-insensitive exact `awaiting OK` label; intentionally overrides draft, CI, findings, and work. |
| `FIXES_NEEDED` | Failing CI, an open heuristic reviewer finding, or an exact P1/P2/High/Medium/blocking label. |
| `WORKING` | Head commit less than 20 minutes old, running Cursor agent, or queued/running agent/autofix check. Drafts can be working or need fixes. |
| `NEEDS_ANDRE` (ready) | Complete fresh PR details, green CI, and no blocking signal above. Drafts additionally require the quiet period and all required current-head reviews with zero open blocking findings. |
| `DRAFT_IDLE` | Everything else, including no CI data. |

`quietPeriodMs` defaults to 20 minutes and controls recent-commit WORKING status and draft readiness. `draftRequiredReviewers` defaults to `['bugbot', 'codex', 'claude']`; edit that list to require a different set. A draft with unknown head age, missing/stale required review, or incomplete data stays out of automatic readiness. Non-draft readiness retains Phase 1 behavior and does not independently require reviewer freshness. The explicit label override still wins, including on drafts.

CI first tries current-head check runs. A permission **403** is remembered per repo until restart, and collection falls back to `GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}` plus `GET /repos/{owner}/{repo}/commits/{sha}/status`. A rate-limit **403** (`x-ratelimit-remaining: 0` or `Retry-After`) is not remembered and is retried on a later poll. Concurrent PRs share the first permission probe. All lists are paginated. The latest run/attempt per workflow, check/app, or status context wins. Pending CI is not green; failed/cancelled/timed-out runs block. Skipped/neutral checks are nonblocking. A successful fallback is complete data and produces no warning. If Actions, commit statuses, or another source fails, the warning names the missing data/permission and preserves available head/review information; partial passing results cannot make a PR ready. Restart after updating token permissions to retry Checks.

**Review limitations:** GitHub REST does not expose review-thread resolution. Severity text (P1, P2, High, Medium, blocking) is a heuristic. Clearly negative summaries such as “No P1/P2 findings” are excluded. Inline findings remain open even when outdated until the reviewer or repository owner replies in that thread starting with “fixed”, “resolved”, or “addressed”. Dismissed reviews and their comments are ignored; summary bodies are excluded when that review has inline findings to avoid double counting. Standalone severity-marked review/issue summaries remain conservative blockers; verify them on GitHub and tune heuristics when needed. General prose can cause false positives, and findings without recognizable severity can be missed.

Bugbot uses `cursor[bot]` / `cursor-bugbot[bot]`; Codex uses `chatgpt-codex-connector[bot]`. Claude activity is attributed by GitHub app slug `claude`, `claude[bot]` / `claude-code[bot]`, or a repository-owner comment matching review-output markers such as `## Claude Code Review`, `## Code Review`, or “Reviewed by Claude Code”. An incidental mention of Claude is insufficient. Bugbot reviews still count when GitHub sets the app slug to `cursor`. Other activity performed via the `cursor` GitHub app is excluded, as are short trigger comments such as `@claude go` / `@codex go`. Tune `claudeReviewOutput`, `triggerMaxLength`, and `triggerPatterns` in the rules module.

Last reviewed SHA comes from a review's `commit_id`, an inline comment's `original_commit_id` (falling back to `commit_id`), or a full 40-character SHA explicitly tagged “Reviewed”, “Reviewed commit”, “Review SHA”, or “Head SHA” in its body. Incidental commit links are ignored. SHA-less activity preserves the last known reviewed SHA; with none, the card shows “SHA unknown”. The current head is never guessed. Each card lists the last activity, known SHA, current-head status, and estimated open findings for all three reviewers. Missing review sources show an unknown count.

## Collection and failure behavior

- A server poll runs immediately at startup. Each completed poll schedules the next using an adaptive interval (minimum 60 seconds); overlapping refreshes coalesce. Browsers read the shared in-memory cache every 60 seconds and display the server's advertised interval. This keeps new snapshots and quiet-period transitions visible without making additional GitHub calls. The startup loading view refreshes every two seconds until the first snapshot is available.
- GitHub collection paginates open PRs, recently updated closed PRs (today's merges), PR commits, check runs/Actions runs, commit statuses, reviews, inline comments, and issue comments. The latest five PR commits and the head commit are retained; GitHub's PR-commits endpoint itself limits very large PRs to 250 commits. Requests time out after 15 seconds and enrichment is limited to three PRs per repo. A bounded in-memory ETag cache uses conditional GETs to reduce GitHub rate-limit usage on unchanged data. No GraphQL is used.
- A failed repo poll preserves the last successful data with a **stale** notice and collection time. Incomplete/stale data cannot qualify through automatic readiness. An explicit `awaiting OK` label still follows its configured override; verify stale entries in GitHub. Failed PR sources produce specific warnings while retaining the successful sources. Authentication, permissions, and rate-limit failures retry on the next poll. Restart clears the cache.
- With `CURSOR_API_KEY`, GET `https://api.cursor.com/v0/agents` uses Basic Auth (`key:`) and pagination. Exact `target.prUrl` matches attach `target.url` and status to a PR without an extra tile. Agents **without a linked PR** get their own tile in the configured repo matching `source.repository`; duplicate IDs are collapsed and other repos are ignored. RUNNING/CREATING agents are WORKING; finished/idle agents are DRAFT_IDLE. A missing conversation URL does not hide status. Only HTTPS GitHub repo/PR and `cursor.com` agent links are accepted. API errors show a notice without breaking GitHub data; no stale agent status is carried forward. Without a key there are only PR tiles.
- `/healthz` is the sole unauthenticated route and returns only `ok`. Private responses use `Cache-Control: no-store`, a restrictive CSP, and no-referrer headers. The API accepts only GET/HEAD. Upstream content renders as text; no HTML from comments/titles is injected.

### Adaptive polling budget

`src/polling.js` estimates each cycle as `2 × repo count + 7 × PR count` requests and takes the larger of that estimate or the last cycle's actual request count (including pagination/fallback). The minimum delay is `cost × 3,600,000 / (5,000 × 0.5)` milliseconds, bounded below by `pollMs` (60 seconds). For example, two repos and 20 PRs cost about 144 requests: the interval grows to about 3.5 minutes. Counting conditional 304s as full requests makes the estimate conservative. Settings live under `rules.polling`; a lower advertised token limit is respected too.

Below 10% remaining quota, `x-ratelimit-remaining` and `x-ratelimit-reset` stretch the interval further. If the next cycle cannot fit, it waits until reset; a zero remaining budget stops further outbound requests during the current cycle. Secondary-limit `Retry-After` responses also defer polling and further calls. Other clients sharing the token and the first unexpectedly large cycle can still consume quota, so notices remain visible and the next cycle adjusts. This is an in-memory, single-process estimate, not an account-wide rate limiter.

### Login protection and proxy configuration

`rules.auth` defaults to five failed password attempts within 15 minutes, followed by a 60-second lockout. Repeated failures after lockout expiry double the delay up to 15 minutes. Locked clients receive **429** with **Retry-After** seconds, even for a correct password, until the lockout expires. A successful login outside lockout resets the counter. An initial request without credentials only challenges for Basic Auth and does not count as a failed password. `/healthz` remains available. The tracker holds at most 10,000 IP entries, expires old records, and evicts the oldest entry at capacity; it has no disk persistence or dependencies.

By default, identity comes from the socket IP and **X-Forwarded-For is ignored**. Set `TRUST_PROXY_HOPS=1` only when the app is reachable exclusively through one trusted proxy that sanitizes/appends the client IP (for example, a verified single-proxy Railway ingress). The address is selected from the right of the forwarded chain, so an attacker-supplied prefix does not choose the key. Use the correct hop count for your actual topology; if the app is also directly reachable, leave it at `0`. Malformed/insufficient forwarded addresses fall back to the socket. Each replica has its own limiter; restart clears counters.

## Validate

```sh
npm run check
npm test
```

Tests use Node's built-in runner, fixtures, mocked transports, fake clocks/timers, and local HTTP requests; no secrets or external network calls. Coverage includes draft readiness/configuration, Claude attribution/exclusions, standalone agents, login lockout/reset/expiry/proxy handling, adaptive intervals/quota headers, Checks 403 fallback/capability caching, latest Actions runs and CI gaps, plus the original state/cache/UI-route checks. CI runs on Node 20 and 24.

## Railway deployment later

No service or production deployment is created by this PR. When ready to deploy separately:

1. Create a **new service** sourced from this repository in the intended Railway project; use the repo root `/`. Do not attach it to an existing StorageStack service.
2. Use Railway's Railpack Node builder (Node 20 or newer). Install with `npm ci`; no build step is required. Set the start command to `npm start`.
3. Set `GITHUB_READ_TOKEN` and `DASHBOARD_PASSWORD` as service variables; optionally set `CURSOR_API_KEY`. Railway supplies `PORT`. Configure `TRUST_PROXY_HOPS` only after verifying the ingress topology as described above.
4. Configure health checks at `/healthz`, enable an HTTPS Railway domain, and deploy the reviewed branch when authorized. Verify a successful deployment and the password prompt before viewing private data.

No volume or database is needed. Each replica has its own poller/cache; use a single replica initially. See [Railway deployment docs](https://docs.railway.com/guides/deploy) and [Railpack](https://docs.railway.com/builds/railpack).

## Later

Phase 2 can replace `public/hex-map.js` behind its `setItems`/`select`/`fit`/`zoom` interface with a 3D renderer. Robots, Railway state tiles, and write/approval controls are outside Phase 1.
