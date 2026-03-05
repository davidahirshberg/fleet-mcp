# Agent Manager MCP Server

Coordinates multiple Claude Code sessions via kitty terminal read/write. The meta session uses these tools to delegate, monitor, and manage work across agent windows.

## Tools

### delegate(win, description, message, after?)

Send a task to an agent window. Records it in persistent state. **Use this for all work assignments — never use raw `agent-ask` to assign work, as it bypasses tracking.**

- `win`: Kitty window ID (number)
- `description`: Short human-readable label (5-10 words)
- `message`: Full message to send to the agent
- `after`: Optional. Task ID or array of task IDs. If any dependency is not done, the message is deferred — it's stored but not sent until all dependencies complete.

Returns the task ID. Use this ID in `after` for dependent tasks.

### chat(message, win?)

Send a message to another agent. If `win` is omitted, sends to the manager. Workers: use this to report results, ask questions, or flag issues without waiting to be checked on. Manager: use this for corrections or guidance on existing tasks (use `delegate()` for new work).

- `message`: Message to send
- `win`: Optional. Kitty window ID. Omit to send to the manager.

### wait_for_idle(win, timeout?, interval?)

Block until the agent in `win` hits an idle prompt. Default timeout 1800s, interval 60s. Returns the last 40 lines of window output.

### wait_for_any(timeout?, interval?)

Block until ANY pending agent goes idle. Skips blocked tasks. Returns which window went idle and its output. Use this when managing multiple agents instead of separate `wait_for_idle` calls.

### task_list()

Show all active (non-done) tasks. Refreshes status from actual window state. Flags stale tasks (>24h pending). Shows dependency info for blocked tasks.

### task_done(win)

Mark the active task for a window as done. Automatically unblocks any dependent tasks — sends their deferred messages and flips them to pending.

### task_check(win)

Non-blocking snapshot of a window's current state. Returns status (IDLE/WORKING) and window tail.

### my_task()

Show what task is assigned to this window (any agent can call this). Returns your task description, status, age, dependency info, and what other agents are working on. Uses `$AGENT_WIN` to identify the caller.

### register_manager()

Register the calling session as the manager. **Call this at session start.** Window ID is auto-detected from `$AGENT_WIN` (set automatically by the `claude` alias). The keepalive watcher kicks the manager (not workers) when agents need attention. Also auto-starts the keepalive watcher if it's not already running.

## delegate vs chat

- **delegate**: "Do this work." Creates a tracked task, monitors completion, supports dependencies.
- **chat**: "Quick question" / "Change of plan" / "Here's context." No tracking, no task created.

If you're tempted to use `chat` to assign work, use `delegate` instead. The rule: if you'd want to know when it's done, it's a `delegate`.

## Task Schema

```json
{
  "id": "w18-mmb2df6x",
  "win": 18,
  "description": "Build survival paper",
  "status": "pending|blocked|idle|done",
  "delegated_at": "ISO timestamp",
  "last_checked": "ISO timestamp",
  "completed_at": "ISO timestamp (only if done)",
  "blockedBy": ["w16-mmb2hblm"],
  "deferredMessage": "message text (only if blocked)"
}
```

Status flow: `blocked` → `pending` → `idle` → `done`

Tasks without dependencies skip `blocked` and start at `pending`.

## State File

`~/.claude/agent-tasks.json` — persists across sessions and context compaction.

## Keepalive Watcher

Auto-started by `register_manager`. Polls every 45s, kicks the manager when agents need attention. Only kicks the manager — workers don't have context to reassign work.

Log: `~/.claude/keepalive.log`

Guard rails:
- Only kicks the registered manager window
- 5-minute cooldown between kicks
- Signed messages ("— keepalive watcher") so the manager knows the source
- Won't kick if the manager is actively working
