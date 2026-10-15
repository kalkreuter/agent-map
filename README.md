# Agent Map

A visual dashboard of my coding work: every open PR and AI agent across my repos, shown as tiles on a hex map so I can see at a glance what needs me.

## Phase 1 (read-only)
- 2D hex map with one cluster per repo and one tile per PR or agent
- Tile states: NEEDS ANDRE, WORKING, FIXES NEEDED, DRAFT/IDLE, MERGED
- Click a tile for a short card: what it changes, its risk, and the latest review status from Bugbot, Codex, and Claude
- Polls GitHub with a read-only token; behind a password

## Later
- 3D planet view with robots for agents
- One-click approvals

Full spec is in this repo's issues.
