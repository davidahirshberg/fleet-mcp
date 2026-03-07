# Agent Manager MCP Server

Coordinates agents via shared state file + kitty kicks for notifications. All agents register at startup. Communication goes through the state file; kitty rings the doorbell so agents know to check.

Agent identity = session UUID (auto-detected from most recent JSONL). Kitty window IDs are metadata for notifications only.

## Tools

### register(manager?, testing?, session_id?, name?)

All agents call this at session start. Auto-detects the session UUID from the most recent JSONL in the project directory. Stores the agent in the registry with UUID as identity, kitty window ID (from `$KITTY_WINDOW_ID`) as notification address, and working directory (`$PWD`). Preserves any friendly name assigned by the manager across re-registrations.

- `manager`: set true to register as manager (starts keepalive watcher)
- `testing`: set true (with `manager=true`) to register as a secondary/test manager. Gets full manager privileges but does not replace the primary manager or start keepalive. See [Multi-Manager (Testing)](#multi-manager-testing).
- `session_id`: Claude session ID (override auto-detection)
- `name`: agent name (for headless agents without a session)

### delegate(agent, description, message, after?, friendly_name?)

Assign a task to an agent. Writes task to state and kicks the agent via kitty so they know to check. Manager only. Agent must be registered — rejects unknown identifiers.

- `agent`: Session UUID, agent name, or friendly name
- `description`: Short human-readable label (5-10 words)
- `message`: Full task message
- `after`: Optional. Task ID or array of IDs — task is blocked until all complete.
- `friendly_name`: Optional. Set a friendly name for the agent (same as `name_agent`).

Returns task ID. Use in `after` for dependent tasks.

### chat(message, to?)

Send a message to another agent's inbox. Writes to state and kicks the recipient via kitty. Recipient must be registered — rejects unknown identifiers.

- `message`: Message to send
- `to`: Optional. Session UUID, agent name, or friendly name. Omit to send to the manager.

### wait_for_task(timeout?)

Block until a task or message arrives for this agent. Uses `fs.watch` on the state file — resolves instantly when the file changes (no polling delay). Returns the task message or chat messages.

### task_list()

List all active tasks and registered agents. Call at session start.

### task_done(agent?)

Mark a task done. No args = mark own task. Marking another agent's task requires manager. Automatically unblocks dependent tasks and kicks them via kitty.

### task_check(win)

**Escape hatch.** Read an agent's kitty terminal window directly. For when an agent is stuck or unresponsive. Takes a kitty window ID (this is the one place kitty IDs are used directly). If the window is gone, removes the agent from the registry.

### my_task()

Show own task, unread messages (reads them inline).

### register_manager()

Alias for `register(manager=true)`.

### unregister_manager(to?)

Step down as manager. Manager only. Pass `to` to hand the role to a specific registered agent (they get kicked to let them know). Omit `to` to just vacate the slot.

### name_agent(agent, friendly_name)

Set or change a friendly name for an agent. Manager only. Names are for manager/human communication — agents don't need to know their names.

- `agent`: Session UUID, agent name, or friendly name
- `friendly_name`: Human-readable name (e.g. "sims guy", "survival paper")

Names persist across agent re-registrations. All tools that accept an agent identifier also accept friendly names.

### respawn(agent, win?)

Resume a dead agent session. Manager only. Looks up the agent's session ID and working directory from the registry, finds an idle kitty tab, and runs `cd <cwd> && claude --resume <session_id>`.

- `agent`: Session UUID, agent name, or friendly name
- `win`: Optional. Kitty window to use. Omit to auto-find an idle tab (prefers the agent's old window if alive, then any idle tab not assigned to another agent).

Updates the agent's registry entry with the new kitty window.

### spawn(cwd?, win?)

Launch a fresh claude agent in a new kitty tab. Manager only. The new agent will call `register()` on startup per its CLAUDE.md guidance.

- `cwd`: Working directory. Defaults to home directory.
- `win`: Optional. Kitty window to use instead of creating a new tab.

Returns the kitty window ID. Once the agent registers, find its UUID via `task_list()` and use that for `delegate()`.

### interrupt(agent, message?)

Send a kitty ESC interrupt to break into an agent that is mid-tool-chain. Manager only. NOT for routine notifications — those go through `fs.watch` automatically.

- `agent`: Session UUID, agent name, or friendly name
- `message`: Optional message delivered via chat before the interrupt

## delegate vs chat

- **delegate**: "Do this work." Creates a tracked task. Agent is notified via fs.watch.
- **chat**: "Quick question" / "Here's context." Goes to inbox. Agent is notified via fs.watch.
- **interrupt**: "Stop what you're doing." Sends kitty ESC to break into a running agent.

If you'd want to know when it's done, use `delegate`.

## Chain of Command

Multiple managers can coexist. One is **top of chain** (`state.manager`) — gets keepalive, is the default `chat()` recipient.

Manager tools that target a specific agent (`delegate`, `task_done` for others, `interrupt`) enforce chain of command:
- **Top of chain** can manage anyone.
- **Other managers** can manage agents whose active task they delegated, or unassigned agents.
- Attempting to manage someone else's report returns an error naming the responsible manager.

`name_agent`, `respawn`, `spawn` are unrestricted for any manager (cosmetic/operational).

## Agent Lifecycle

1. Agent starts, calls `register()` — added to agent registry with session UUID
2. Manager calls `delegate(agent, ...)` — task written to state file
3. Agent's `wait_for_task()` wakes via `fs.watch` — gets the task
4. Agent works, uses `chat()` to report progress
5. Agent finishes, calls `task_done()`
6. Agent calls `wait_for_task()` — wakes instantly on next state change

## Notification Model

Two separate mechanisms for two separate concerns:

**Notification** — `fs.watch` on the state file (`~/.claude/agent-tasks.json`). Every `saveState()` triggers all watching agents instantly. No kitty dependency, works for headless agents.

- `delegate()` writes task → `saveState()` → watching agents wake up
- `chat()` writes message → `saveState()` → watching agents wake up
- `task_done()` with unblocked deps → `saveState()` → unblocked agents wake up

**Interruption** — kitty ESC via `interrupt()`. For breaking into an agent that is mid-tool-chain and needs to stop. Sends `ESC` then `📬` + Enter to the agent's kitty window.

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

Auto-started for the top-of-chain manager only. Polls every 45s, nudges the manager via kitty when agents need attention and the manager is idle. Backs off exponentially when the state hasn't changed (5min → 10min → 20min → ... up to 1h). Resets when something changes. Doesn't write messages — just sends 📬. Manager should call `task_list()` when nudged.

Log: `~/.claude/keepalive.log`

## Multiple Managers

Any agent can register as a manager with `register(manager=true)`. Multiple managers coexist. The first to register (or the one handed the role via `unregister_manager(to=...)`) is **top of chain** — they get keepalive and are the default `chat()` recipient.

Chain of command is enforced: you can only `delegate`/`task_done`/`interrupt` agents you manage (agents whose active task you delegated, or unassigned agents). Top of chain can manage everyone.

`task_list()` shows `[top]` for the top-of-chain manager and `[manager]` for others. When multiple managers exist, task ownership is always visible via `delegated_by`.
