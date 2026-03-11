# Fleet Ops Guide

How it actually works under the hood, what breaks, and how to fix it.

## Architecture

Fleet is a single-file MCP server (`index.mjs`) that runs as a subprocess of each Claude Code session. Every agent gets its own fleet MCP process, all reading/writing the same shared state file.

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  Agent A     │   │  Agent B     │   │  Agent C     │
│  (claude)    │   │  (claude)    │   │  (claude)    │
│    ↕         │   │    ↕         │   │    ↕         │
│  fleet MCP   │   │  fleet MCP   │   │  fleet MCP   │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
              ~/.claude/agent-tasks.json
                    (shared state)
```

**No central server.** Each fleet MCP process reads/writes the same JSON file. Coordination is via filesystem: `fs.watch` on the state file wakes agents when something changes. Kitty remote control is used only for interrupts (ESC to break into a running agent).

## Key Files

| File | Purpose |
|------|---------|
| `~/.claude/agent-tasks.json` | Shared state: agents, tasks, messages. The source of truth. |
| `~/.claude/agent-messages.jsonl` | Append-only event log. Every chat/delegate/task_done gets a line. |
| `~/.claude/kick.log` | Kitty kick attempts — success/failure with timestamps. |
| `~/.claude/keepalive.log` | Keepalive watcher activity. |
| `~/.claude/search-index.sqlite` | FTS5 search index across all sessions and events. |
| `~/.claude/projects/<hash>/<uuid>.jsonl` | Per-session conversation logs (Claude Code writes these). |
| `/tmp/kitty-sock-*` | Kitty remote control Unix sockets. |
| `/Users/skip/work/fleet/index.mjs` | The MCP server itself. |
| `/Users/skip/work/fleet/bin/` | Shell scripts for kitty interaction. |

## Identity & Registration

### How agents get their identity

On startup, each fleet MCP process calls `detectSessionId()`:

1. Takes `$PWD`, converts to project hash (slashes → dashes)
2. Looks in `~/.claude/projects/<hash>/` for `.jsonl` files
3. Prefers the one actively being written (mtime within 30s of server start)
4. Falls back to the most recently modified

**Worktree support:** If `$PWD` is a git worktree, `detectSessionId()` also checks the main worktree's project directory via `git worktree list --porcelain`. This way agents working in `/tmp/fleet-kicks/` can still find their sessions under the main project hash.

**Failure mode:** If no JSONL is found (new project, weird path), `ME` is null and the agent can't register. Fix: pass `session_id` explicitly to `register()`, or pass `name` for headless agents.

### Registration

`register()` does:
1. Upserts the agent entry (preserves friendly_name and labels from prior registration)
2. **Deregisters any other agent on the same kitty window** — prevents stale registrations after session restart/compaction
3. Captures `$KITTY_WINDOW_ID` and `$PWD`
4. Applies auto-labels (manager, project name from cwd)
5. Starts keepalive watcher if this is the first live manager

## Notification: Two Mechanisms

### 1. fs.watch (primary — reliable)

Every `saveState()` triggers all agents watching the state file. This is the main notification path for delegate, chat, and task_done. Works instantly, works headless, no kitty dependency.

Every `saveState()` triggers all agents watching the state file. The PostToolUse hook checks for unread messages after every tool call, injecting 📬 as context. Agents in `sleep()` wake up early when messages arrive.

### 2. Kitty kicks (secondary — for interrupts)

For breaking into an agent that's mid-tool-chain and not responding to hooks. Sends ESC + 📬 via kitty remote control.

**The kick script** (`bin/agent-kick`) does:
1. Tries all `/tmp/kitty-sock-*` sockets to find the one that has the target window (not just the newest — stale sockets can exist)
2. Sends `escape` via `send-key` (interrupts blocking calls)
3. Checks if the agent is idle (via `agent-idle` screen scraping)
4. If idle: sends `📬` + `enter` so the agent processes it
5. If busy: sends just `📬` (agent will see it when they finish)
6. Retries once on failure
7. Logs every attempt to `~/.claude/kick.log`

**Known failure modes:**
- Stale sockets from dead kitty instances (mitigated by trying all sockets)
- Agent idle detection relies on screen scraping — can be wrong if prompt format changes
- Kick log shows what actually happened: `cat ~/.claude/kick.log | tail -20`

## Common Failure Modes

### Stale agent registrations

**Symptom:** Two agents share the same kitty window. Messages go to both.

**Cause:** Agent's session gets compacted/restarted, re-registers with a new session ID, but the old registration lingers.

**Fix (automatic):** `register()` now deregisters any other agent on the same kitty window. The dashboard also shows an orange warning banner for duplicate windows.

**Manual fix:** Restart the affected agent's MCP with `/mcp` in their terminal, or use `restart_mcp()`.

### Agent can't register (no session ID)

**Symptom:** "No session ID detected" error on register.

**Cause:** No JSONL found in the project directory. Common when working in a worktree or new project.

**Fix:** Pass `session_id` explicitly, or pass `name` for headless agents. The worktree fallback in `detectSessionId()` handles the git worktree case automatically.

### Kicks don't work

**Symptom:** Agent doesn't respond to interrupt.

**Diagnosis:** Check `~/.claude/kick.log`. Look for FAIL entries.

**Common causes:**
- Wrong kitty socket (stale socket from dead instance) — the script tries all sockets now
- Window ID changed (agent was respawned but registry not updated)
- Agent is in a state where ESC doesn't do anything useful

**Nuclear option:** Use `task_check(win)` to read the agent's terminal directly. If the window is gone, the agent gets deregistered.

### MCP server out of date

**Symptom:** Agent doesn't have new tools or fixes.

**Cause:** MCP server process starts once per session. Code changes to `index.mjs` don't take effect until restart.

**Fix:** `restart_mcp()` sends `/mcp` to agent terminals via kitty. Or use `restart_mcp(agent)` for a single agent.

### State file corruption

**Symptom:** All agents lose their tasks/messages.

**Cause:** Two processes writing simultaneously (rare — writes are fast and atomic via `writeFileSync`). Or manual editing.

**Fix:** State is reconstructable from `agent-messages.jsonl` (the append-only log). Tasks and messages from the last 24h are in the JSONL. Agent registrations need re-registration.

### Dashboard not updating

**Symptom:** Dashboard shows stale state.

**Cause:** SSE connection dropped, or dashboard server not running.

**Fix:** Refresh the browser. Dashboard server: `node dashboard/server.mjs` (usually on port 5200).

## Operational Tools

### restart_mcp(agent?)
Sends `/mcp` + Enter to agent kitty windows. Omit agent for all. Manager only.

### task_check(win)
Read an agent's terminal screen. Takes kitty window ID (not agent ID). Use when an agent is unresponsive.

### task_list()
Overview of all agents and tasks. Shows: agent name, ID, kitty window, manager status, current task.

### search_logs(query, ...)
Full-text search across all session logs and events. Use to find what happened, what was decided, what broke.

### Kick log
```bash
cat ~/.claude/kick.log | tail -20    # recent kicks
grep FAIL ~/.claude/kick.log         # failed kicks
```

### Keepalive log
```bash
cat ~/.claude/keepalive.log | tail -10
```

### State file
```bash
cat ~/.claude/agent-tasks.json | python3 -m json.tool | less
```

### Agent event log
```bash
tail -20 ~/.claude/agent-messages.jsonl | python3 -m json.tool
```

## Dashboard

The dashboard (`dashboard/server.mjs` + `dashboard/index.html`) is a separate HTTP server that watches the state file and serves a web UI.

**Port:** 5200 (default)

**Key features:**
- Live agent list with status, tasks, labels
- Chat widget with label-based filtering (DNF)
- Search across all session logs (FTS5)
- Kick/interrupt agents from the UI
- Image paste/drop in chat
- Warning banner for duplicate kitty windows

**Dashboard → Agent communication:** Dashboard sends messages as `from: "web"`. Agents can send to dashboard with `chat(to: "web")`.

## Kitty Setup Requirements

Fleet requires kitty's remote control feature:
- `allow_remote_control yes` in `~/.config/kitty/kitty.conf`
- `listen_on unix:/tmp/kitty-sock-$KITTY_PID` (or similar)

Without these, kicks and terminal reading won't work. fs.watch notifications still work.
