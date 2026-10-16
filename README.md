# Agent Map

A password-protected, read-only dashboard of PRs, agents, and deployments. Projects form colored clusters on a 2D hex map; each open PR, unlinked Cursor cloud agent, and configured Railway service is a tile. Today's merges fade in green until the next day in `America/Los_Angeles`.

Phase 1 of [issue #1](https://github.com/kalkreuter/agent-map/issues/1), the [issue #3 follow-ups](https://github.com/kalkreuter/agent-map/issues/3), and Phase 2 Railway deployment visibility. Built with Node ≥20 and vanilla JavaScript/SVG, with no npm dependencies, build step, database, or disk cache. The running app uses GET requests to GitHub REST and optional Cursor, plus a fixed read-only GraphQL query sent by POST to Railway when configured. It cannot approve, comment, launch agents, merge, or deploy anything.

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
| `RAILWAY_PROJECT_TOKEN` | Optional Railway project/environment-scoped token for deployment tiles, sent as `Project-Access-Token`. Preferred when targets share one project/environment. |
| `RAILWAY_API_TOKEN` | Optional account/workspace API token, sent as Bearer auth, for targets across accessible projects. Used only when `RAILWAY_PROJECT_TOKEN` is absent. |
| `PORT` | Listen port, default `3000`; binds `0.0.0.0`. |
| `TRUST_PROXY_HOPS` | Optional integer `0`–`10`, default `0` (ignore forwarded IPs). Set only for a known, trusted proxy chain; see login protection below. |

Create the fine-grained GitHub PAT for the appropriate resource owner, select the repositories, and grant **read-only** repository permissions for **Metadata** (automatic), **Contents**, **Pull requests**, **Issues**, **Actions**, and **Commit statuses**. Checks permission is not required: if the token cannot access check runs, the app uses Actions plus commit statuses. Follow any organization approval/SSO requirements. The app never sends tokens to the browser or logs API error bodies. Use HTTPS when hosting: Basic Auth relies on transport encryption. No secrets belong in repo config.

## Projects and classification

Edit `config/repos.json`; adding another object is enough:

```json
{ "repo": "kalkreuter/storagestack-manage", "name": "Manage", "color": "#8b9dff" }
```

Manage and Vivi are configured by default. Restart after config changes. Each repo has a cluster label, separate PR/agent/deployment counts, and a color stripe on every tile. Tile color shows its state. The top Needs Andre count covers PRs across all projects; the visible/total count includes every tile kind and reflects filters. Drag to pan, scroll/pinch or use +/− to zoom, and use ⌖ to fit. Tiles also support Tab and Enter/Space. Select a PR tile to open CI, head commit/age, and reviewer activity with PR and optional agent links. Agent cards show the agent name, status, creation age, and conversation link when known.

### Railway deployment tiles

Manage and Vivi include their existing production service IDs in `config/repos.json`. Deployment collection is silently skipped unless a Railway token is set. No service or deployment is created by configuring tiles. A repo may have multiple targets, for example production and staging:

```json
{
  "repo": "owner/repository", "name": "Project", "color": "#8b9dff",
  "railway": [{
    "name": "Production", "environmentName": "production", "branch": "main",
    "projectId": "11111111-1111-1111-1111-111111111111",
    "environmentId": "22222222-2222-2222-2222-222222222222",
    "serviceId": "33333333-3333-3333-3333-333333333333"
  }]
}
```

Use the IDs from the Railway dashboard URL. IDs are configuration, never credentials; tokens belong only in server environment variables. Labels and tracked `branch` are optional; the branch defaults to `main`. Each project/environment/service combination must be unique across the config. The integration uses the [Railway public API](https://docs.railway.com/integrations/api) at `https://backboard.railway.com/graphql/v2` with a static named query, variables for IDs, a 15-second timeout, and redirects disabled. No GraphQL mutations are implemented. Project tokens are scoped to one Railway project/environment; an account/workspace token can query its accessible projects. The app's read-only behavior does not change the token's upstream permissions.

Each deployment card separates the **latest attempt** from the **actual live deployment**. A failed or building attempt can coexist with an older successful active version. Historical successful or stopped deployments are never used to guess which commit is live. The tile shows deploying, deploy failed, live, live/behind, or unknown; deployment tiles never contribute to the Needs Andre PR count. The card provides service/environment, status, live commit and age, latest attempt, collection time, and Railway links.

Only a full Git SHA reported for the live deployment is compared with the configured branch using GitHub's branch and commit-comparison APIs (existing Contents read permission). Equality means current; ancestry distinguishes behind, ahead, and diverged. Different hashes alone do not prove production is behind. Manual/image deployments without a SHA, missing branch access, or failed comparisons show an unknown comparison. The configured branch is the comparison target, not a claim about the deployment's original source branch.

Railway polls share the existing server refresh. Errors are isolated per service and never erase GitHub PR details. A failed service read retains its previous snapshot with an explicit stale notice and an unknown tile state; fresh Railway data remains visible when GitHub fails. Rate limits honor `Retry-After` and defer further Railway calls. Branch-comparison requests count toward observed GitHub polling cost. Neither raw deployment metadata, API error bodies, nor tokens are sent to the browser.

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

CI first tries current-head check runs. An explicit permission **403** is remembered per repo until restart, and collection falls back to `GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}` plus `GET /repos/{owner}/{repo}/commits/{sha}/status`. Rate-limit and ambiguous **403** responses remain retryable. Secondary limits are recognized even without retry headers; secondary and ambiguous 403s back off for at least one minute. Concurrent PRs share the first permission probe. All lists are paginated. The latest run/attempt per workflow, check/app, or status context wins. Pending CI is not green; failed/cancelled/timed-out runs block. Skipped/neutral checks are nonblocking. A successful fallback is complete data and produces no warning. If Actions, commit statuses, or another source fails, the warning names the missing data/permission and preserves available head/review information; partial passing results cannot make a PR ready. Restart after updating token permissions to retry Checks.

**Review limitations:** GitHub REST does not expose review-thread resolution. Severity text (P1, P2, High, Medium, blocking) is a heuristic. Clearly negative summaries such as “No P1/P2 findings” are excluded. Inline findings remain open until the reviewer or repository owner replies in that thread starting with “fixed”, “resolved”, or “addressed”, with the Bugbot check exception below. Dismissed reviews and their comments are ignored; summary bodies are excluded when that review has inline findings to avoid double counting. Bugbot's generated PR overview (`CURSOR_SUMMARY`) is excluded from finding counts: “Medium Risk” describes the change, not an open finding. Other standalone severity-marked review/issue summaries remain conservative blockers. General prose can cause false positives, and findings without recognizable severity can be missed.

**Bugbot check results:** A clean review may finish as a check run without posting a new review comment. The latest `Cursor Bugbot` check from app slug `cursor` can provide current-head review evidence when its head SHA matches, it has completed successfully/neutral, and its output explicitly reports a completed review with no issues or a reported issue count. Conflicting result lines retain the largest reported count; clean text cannot override reported issues. Pending/cancelled checks, different apps/heads, and unrecognized output do not provide this evidence. Check name, app slug, result patterns, and supersession behavior are configured under the Bugbot reviewer in `config/rules.js`.

An explicit clean current-head Bugbot result supersedes older-head inline findings only when GitHub also marks the original inline location outdated and the comment was not edited after that result. Current-head findings, still-positioned comments, file-level comments, and other reviewers' findings retain their normal rules. This remains a documented heuristic; verify findings on GitHub before acting. When a check reports issues whose current-head comments are not fully available, the reviewer count is unknown (or retains already known blockers), a notice is shown, and automatic readiness is blocked. Only comments created during the latest check's review window, with a matching reviewer/current-head parent review submitted in that window, can cover its reported count. Older same-head comments and later edits cannot stand in for a new run; missing association data keeps the review incomplete. Reported counts are not added on top of inline counts, and low-severity comments can account for reported issues without becoming blockers.

If Checks is unavailable and Actions/status fallback is used, CI can still be complete, but this extra Bugbot review evidence is unavailable. Reviewer freshness then uses the known reviews/comments, and old findings remain conservative blockers. A green Actions result is never interpreted as a clean Bugbot review.

Bugbot uses `cursor[bot]` / `cursor-bugbot[bot]`; Codex uses `chatgpt-codex-connector[bot]`. Claude activity is attributed by GitHub app slug `claude`, `claude[bot]` / `claude-code[bot]`, or a repository-owner comment matching review-output markers such as `## Claude Code Review`, `## Code Review`, or “Reviewed by Claude Code”. An incidental mention of Claude is insufficient. Bugbot reviews still count when GitHub sets the app slug to `cursor`. Other activity performed via the `cursor` GitHub app is excluded, as are short trigger comments such as `@claude go` / `@codex go`. Tune `claudeReviewOutput`, `triggerMaxLength`, and `triggerPatterns` in the rules module.

Last reviewed SHA comes from a review's `commit_id`, an inline comment's `original_commit_id` (falling back to `commit_id`), a verified Bugbot check result as above, or a full 40-character SHA explicitly tagged “Reviewed”, “Reviewed commit”, “Review SHA”, or “Head SHA” in its body. Incidental commit links are ignored. SHA-less activity preserves the last known reviewed SHA; with none, the card shows “SHA unknown”. The current head is never guessed. Each card lists the last activity, known SHA, current-head status, and estimated open findings for all three reviewers. Missing review sources show an unknown count.

## Collection and failure behavior

- A server poll runs immediately at startup. Each completed poll schedules the next using an adaptive interval (minimum 60 seconds); overlapping refreshes coalesce. Browsers read the shared in-memory cache every 60 seconds and display the server's advertised interval. This keeps new snapshots and quiet-period transitions visible without making additional GitHub calls. The startup loading view refreshes every two seconds until the first snapshot is available.
- GitHub collection paginates open PRs, recently updated closed PRs (today's merges), PR commits, check runs/Actions runs, commit statuses, reviews, inline comments, and issue comments. The latest five PR commits and the head commit are retained; GitHub's PR-commits endpoint itself limits very large PRs to 250 commits. Requests time out after 15 seconds and enrichment is limited to three PRs per repo. A bounded in-memory ETag cache uses conditional GETs to reduce GitHub rate-limit usage on unchanged data. GitHub uses REST only; the optional Railway collector uses a static GraphQL query.
- A failed repo poll preserves the last successful data with a **stale** notice and collection time. Incomplete/stale data cannot qualify through automatic readiness. An explicit `awaiting OK` label still follows its configured override; verify stale entries in GitHub. Failed PR sources produce specific warnings while retaining the successful sources. Authentication, permissions, and rate-limit failures retry on the next poll. Restart clears the cache.
- With `CURSOR_API_KEY`, GET `https://api.cursor.com/v0/agents` uses Basic Auth (`key:`) and pagination. Exact `target.prUrl` matches attach `target.url` and status to a PR without an extra tile. Agents **without a linked PR** get their own tile in the configured repo matching `source.repository`; duplicate IDs are collapsed and other repos are ignored. RUNNING/CREATING agents are WORKING; finished/idle agents are DRAFT_IDLE. A missing conversation URL does not hide status. Only HTTPS GitHub repo/PR and `cursor.com` agent links are accepted. API errors show a notice without breaking GitHub data; no stale agent status is carried forward. Without a key there are no Cursor agent tiles.
- `/healthz` is the sole unauthenticated route and returns only `ok`. Private responses use `Cache-Control: no-store`, a restrictive CSP, and no-referrer headers. The API accepts only GET/HEAD. Upstream content renders as text; no HTML from comments/titles is injected.

### Adaptive polling budget

`src/polling.js` estimates each cycle as `2 × repo count + 7 × PR count` requests and takes the larger of that estimate or the last cycle's actual request count (including pagination/fallback). The minimum delay is `cost × 3,600,000 / (5,000 × 0.5)` milliseconds, bounded below by `pollMs` (60 seconds). For example, two repos and 20 PRs cost about 144 requests: the interval grows to about 3.5 minutes. Counting conditional 304s as full requests makes the estimate conservative. Settings live under `rules.polling`; a lower advertised token limit is respected too.

Below 10% remaining quota, `x-ratelimit-remaining` and `x-ratelimit-reset` stretch the interval further. If the next cycle cannot fit, it waits until reset regardless of the percentage remaining; a zero remaining budget stops further outbound requests during the current cycle. Secondary-limit responses also defer polling and further calls, honoring `Retry-After` when supplied. Other clients sharing the token and the first unexpectedly large cycle can still consume quota, so notices remain visible and the next cycle adjusts. This is an in-memory, single-process estimate, not an account-wide rate limiter.

### Login protection and proxy configuration

`rules.auth` defaults to five failed password attempts within 15 minutes, followed by a 60-second lockout. Repeated failures after lockout expiry double the delay up to 15 minutes. Locked clients receive **429** with **Retry-After** seconds, even for a correct password, until the lockout expires. A successful login outside lockout resets the counter. An initial request without credentials only challenges for Basic Auth and does not count as a failed password. `/healthz` remains available. The tracker holds at most 10,000 IP entries, expires old records, and evicts the oldest entry at capacity; it has no disk persistence or dependencies.

By default, identity comes from the socket IP and **X-Forwarded-For is ignored**. Set `TRUST_PROXY_HOPS=1` only when the app is reachable exclusively through one trusted proxy that sanitizes/appends the client IP (for example, a verified single-proxy Railway ingress). The address is selected from the right of the forwarded chain, so an attacker-supplied prefix does not choose the key. Use the correct hop count for your actual topology; if the app is also directly reachable, leave it at `0`. Malformed/insufficient forwarded addresses fall back to the socket. Each replica has its own limiter; restart clears counters.

## Validate

```sh
npm run check
npm test
```

Tests use Node's built-in runner, fixtures, mocked transports, fake clocks/timers, and local HTTP requests; no secrets or external network calls. Coverage includes Railway query/auth/scopes, live versus latest deployment, partial failures and stale snapshots, branch ancestry/unknown comparisons, deployment classification/configuration, draft readiness, review attribution, standalone agents, login protection, adaptive polling, Checks fallback, and the original cache/UI-route checks. CI runs on Node 20 and 24.

## Hosting on Railway

No service or production deployment is created by this PR. When ready to deploy separately:

1. Create a **new service** sourced from this repository in the intended Railway project; use the repo root `/`. Do not attach it to an existing StorageStack service.
2. Use Railway's Railpack Node builder (Node 20 or newer). Install with `npm ci`; no build step is required. Set the start command to `npm start`.
3. Set `GITHUB_READ_TOKEN` and `DASHBOARD_PASSWORD` as service variables; optionally set `CURSOR_API_KEY` and `RAILWAY_PROJECT_TOKEN` (or `RAILWAY_API_TOKEN`) for the corresponding integrations. Railway supplies `PORT`. Configure `TRUST_PROXY_HOPS` only after verifying the ingress topology as described above.
4. Configure health checks at `/healthz`, enable an HTTPS Railway domain, and deploy the reviewed branch when authorized. Verify a successful deployment and the password prompt before viewing private data.

No volume or database is needed. Each replica has its own poller/cache; use a single replica initially. See [Railway deployment docs](https://docs.railway.com/guides/deploy) and [Railpack](https://docs.railway.com/builds/railpack).

## Later

The next Phase 2 increment can replace `public/hex-map.js` behind its `setItems`/`select`/`fit`/`zoom` interface with a 3D renderer and robots. Write/approval controls remain a separate feature requiring explicit authorization and credentials with write permissions.
