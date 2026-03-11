# Agent Manager MCP Server

Coordinates agents via shared state file + kitty kicks for notifications. All agents register at startup. Communication goes through the state file; kitty rings the doorbell so agents know to check.

Agent identity = session UUID (auto-detected from most recent JSONL). Kitty window IDs are metadata for notifications only.

## Tools

See **[agent-guide.md](agent-guide.md)** for the full tool reference (parameters, usage, conventions). Symlink to `~/.claude/reference/fleet.md`.

## delegate vs chat

- **delegate**: "Do this work." Creates a tracked task. Agent is notified via fs.watch.
- **chat**: "Quick question" / "Here's context." Goes to inbox. Agent is notified via fs.watch.
- **interrupt**: "Stop what you're doing." Sends kitty ESC to break into a running agent.

If you'd want to know when it's done, use `delegate`.

## Multiple Managers

All managers are peers — any manager can manage any agent. No hierarchy. `chat()` without a `to` goes to whoever delegated your current task, falling back to any live manager.

## Agent Lifecycle

1. Agent starts, calls `register()` — added to agent registry with session UUID
2. Manager calls `delegate(agent, ...)` — task written to state file
3. Agent sees 📬 (via PostToolUse hook or kitty kick) — calls `my_task()` to get the task
4. Agent works, uses `chat()` to report progress
5. Agent finishes, calls `task_done()`
6. Agent keeps working or uses `timer()` — sees 📬 when something arrives

## Notification Model

Two-tier message delivery, from lightest to heaviest:

1. **PostToolUse hook** — after every Claude Code tool call, a shell hook checks the state file for unread messages/tasks. If found, it injects 📬 as `additionalContext`. Zero latency for working agents.
2. **Kitty interrupt** — `interrupt()` sends ESC to a kitty window. For breaking into an agent that is truly stuck (mid-tool-chain, not responding to hooks). Last resort.

`timer()` notifications also deliver via the state file — the PostToolUse hook picks them up.

**When you see 📬 as input, call `my_task()`.** This is the universal response. `my_task()` returns your current task and any unread messages.

Headless agents (no kitty window) get the same instant notifications via `fs.watch` — no polling, no kitty dependency.

## Agent Registry

`state.agents` tracks all registered agents:

```json
{
  "id": "a0ff6112-3b4c-4e5d-8f6a-7b8c9d0e1f2a",
  "kitty_win": 7,
  "session_id": "a0ff6112-3b4c-4e5d-8f6a-7b8c9d0e1f2a",
  "friendly_name": "sims guy",
  "cwd": "/Users/skip/work/bregman-lower-bound",
  "registered_at": "ISO timestamp",
  "last_seen": "ISO timestamp",
  "is_manager": false
}
```

- `id`: Session UUID — the canonical agent identifier. All tasks, messages, and log events use this.
- `kitty_win`: Kitty window ID — used only for sending notification kicks. Not identity.
- `session_id`: Same as `id` for session-based agents. Kept for explicit reference.
- `friendly_name`: Set by manager via `name_agent()` or `delegate(friendly_name=...)`. Persists across re-registrations.
- `cwd`: Captured automatically from `$PWD` at registration. Used by `respawn()` to cd before resuming.
- `last_seen`: Updated on every MCP tool call. Used for liveness detection (10-minute threshold) — works for both kitty and headless agents. Falls back to kitty window check if no heartbeat.

Lazy cleanup: when any tool tries to interact with an agent's kitty window and it's gone, the agent is removed from the registry.

## Task Schema

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

Status flow: `blocked` → `pending` → `working` (acknowledged) → `idle`/`done`

## Messages

```json
{
  "to": "a0ff6112-3b4c-4e5d-8f6a-7b8c9d0e1f2a",
  "from": "c719a67f-9798-44b5-82fa-d07c0d5c4b1a",
  "text": "Found the bug, it's in dispersion.R",
  "timestamp": "ISO timestamp",
  "read": false
}
```

## State File

`~/.claude/agent-tasks.json` — persists across sessions and compaction. Auto-prunes on save: done tasks older than 24h and read messages older than 1h are dropped. History lives in agent JONSLs.

## Keepalive Watcher

Auto-started when the first manager registers. Polls every 45s, nudges all idle managers via kitty when agents need attention. Backs off exponentially when the state hasn't changed (5min → 10min → 20min → ... up to 1h). Resets when something changes. Doesn't write messages — just sends 📬. Manager should call `task_list()` when nudged.

Log: `~/.claude/keepalive.log`
