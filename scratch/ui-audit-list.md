# Fleet Dashboard UI Audit List

<!-- session: fleet:868edc45 files: dashboard/index.html, dashboard/server.mjs -->

## Bug Fixes

1. **Compaction not surfaced in UI** — PreCompact hook sets `compacting: true` on old agent ID; after compaction, new agent re-registers with a different fleet ID. Dashboard shows compacting on a dead entry, not linked to the new one. Fix: on re-register with same session_id, transfer compacting state from old entry.

2. **Reference chip → plaintext morph** — Chat messages with tool-ref chips briefly degrade to plaintext on SSE re-render (~2s), then restore. Full innerHTML rebuild loses chip markup when some state is momentarily missing.

3. **"manager" label on ambient messages** — Intermittent; style-auditor→manager messages sometimes display "manager" instead of the agent's actual name. Root cause unclear — may be transient state issue. Related to `name` field cleanup (item 5).

4. **MCP restart doesn't restart all servers** — `restart_mcp()` sends `/mcp` + Enter to kitty, which only reconnects the first MCP server (fleet). Need proper restart that handles all servers, reads kitty screen to verify, error checks.

5. **Style-auditor interrupt loop** — 📬 → `my_task()` → "nothing new, interrupted" → 📬 → repeat. PostToolUse hook fires on `my_task()` response, injects new 📬, triggers another `my_task()`. Needs debounce or "nothing new = don't re-fire" logic.

## Refactors

6. **Single chat render path** — Currently 4+ places render message nick→target arrows (chat panel, agents tooltip, task panel, DB history). Unify into one `renderChatLine(state, msg)` function used by all sources (SSE, DB history, optimistic).

7. **Drop `name` field** — Keep only `fleet_id` + `friendly_name`. `agentLabel` falls back to `id.slice(0,8)` if no friendly_name. Remove `name` from register(), state file, all rendering paths.

## Features

8. **Scratch cards** — Agent writes markdown (with math) to a scratch file, posts as chat attachment. Renders inline (collapsed, click to expand), with MathJax. Draggable to tlda. Supports LaTeX preamble via frontmatter (`preamble: ~/work/project/macros.tex`). File on disk is source of truth; agents can update.

9. **Diagonal arrows for hierarchy** — ↗ agent→manager, ↘ manager→agent, → peer. (Partially done — applied to 3 chat render paths. Needs unification per item 6.)

## Monitor

10. **tlda black screen on iPhone Safari** — Single occurrence, likely iOS GPU compositing bug with large SVG. Monitor for recurrence.

11. **Thumb label placement** — Reading-ui moved highlight color label from `bottom: -16px` to `top: -18px`, still under thumb. Needs to be screen top-center or bottom-center — away from touch point.
