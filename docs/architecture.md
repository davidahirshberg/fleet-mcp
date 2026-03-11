# Architecture

Fleet is a single-file MCP server (`index.mjs`) that runs as a subprocess of each Claude Code session. Every agent gets its own fleet MCP process, all reading/writing the same shared state file. There is no central server.

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

## State file

`~/.claude/agent-tasks.json` is the source of truth. It persists across context compaction and session restarts. Auto-prunes on save: done tasks older than 24h and read messages older than 1h are dropped.

### Agent registry

```json
{
  "id": "a0ff6112-3b4c-4e5d-8f6a-7b8c9d0e1f2a",
  "kitty_win": 7,
  "session_id": "a0ff6112-3b4c-4e5d-8f6a-7b8c9d0e1f2a",
  "friendly_name": "sims guy",
  "cwd": "/Users/skip/work/project",
  "registered_at": "ISO timestamp",
  "last_seen": "ISO timestamp",
  "is_manager": false
}
```

- `id` / `session_id`: Session UUID — the canonical agent identifier. Auto-detected from the most recent JSONL in the project directory.
- `kitty_win`: Kitty window ID — used only for sending notification kicks. Not identity.
- `friendly_name`: Set by manager via `name_agent()` or `delegate(friendly_name=...)`. Persists across re-registrations.
- `cwd`: Captured from `$PWD` at registration. Used by `respawn()`.
- `last_seen`: Updated on every MCP tool call. Used for liveness detection (10-minute threshold).

### Task schema

```json
{
  "id": "a0ff6112-mmb2df6x",
  "agent": "a0ff6112-3b4c-4e5d-8f6a-7b8c9d0e1f2a",
  "description": "Build survival paper",
  "message": "Full task text...",
  "delegated_by": "c719a67f-9798-44b5-82fa-d07c0d5c4b1a",
  "status": "pending|blocked|working|idle|done",
  "acknowledged": true,
  "delegated_at": "ISO timestamp",
  "last_checked": "ISO timestamp",
  "completed_at": "ISO timestamp (only if done)",
  "blockedBy": ["b3c4d5e6-mmb2hblm"]
}
```

Status flow: `blocked` → `pending` → `working` (acknowledged) → `idle` / `done`

### Messages

```json
{
  "to": "a0ff6112-3b4c-4e5d-8f6a-7b8c9d0e1f2a",
  "from": "c719a67f-9798-44b5-82fa-d07c0d5c4b1a",
  "text": "Found the bug, it's in dispersion.R",
  "timestamp": "ISO timestamp",
  "read": false
}
```

## Identity & registration

On startup, each fleet MCP process auto-detects the agent's session ID:

1. Takes `$PWD`, converts to project hash (slashes → dashes)
2. Looks in `~/.claude/projects/<hash>/` for `.jsonl` files
3. Prefers the one actively being written (mtime within 30s of server start)
4. Falls back to the most recently modified

**Worktree support:** If `$PWD` is a git worktree, detection also checks the main worktree's project directory.

**Headless agents:** Agents without a kitty window (e.g. background processes) register with a `name` instead of a session ID.

`register()` deregisters any other agent on the same kitty window to prevent stale registrations after session restart.

## Key files

| File | Purpose |
|------|---------|
| `~/.claude/agent-tasks.json` | Shared state: agents, tasks, messages |
| `~/.claude/agent-messages.jsonl` | Append-only event log (permanent record) |
| `~/.claude/kick.log` | Kitty kick attempts with timestamps |
| `~/.claude/keepalive.log` | Keepalive watcher activity |
| `~/.claude/search-index.sqlite` | FTS5 search index across sessions |
| `index.mjs` | The MCP server |

## Task dependencies

Use `after` when delegating to chain tasks:

```
const t1 = delegate(agent="alpha", description="fetch data", message="...")
delegate(agent="beta", description="analyze", message="...", after=t1)
```

Beta's task stays blocked until alpha calls `task_done()`. Multiple deps: `after: ["t1", "t2"]`.

## Dashboard

The dashboard (`node dashboard/server.mjs`, default port 5200) watches the state file and serves a web UI with:

- Live agent status with seen-ago, context %, task assignment, labels
- Chat panels targeting specific agents or label groups
- Activity cards showing tool calls with inline diffs
- Terminal views reading agent output directly
- Full-text search across all session logs
- Playback recordings of multi-agent sessions
- Drag-and-drop tiling layout via dockview

Playback recordings are stored in `~/.claude/playbacks/` as JSON files.
