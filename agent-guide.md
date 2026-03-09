# Fleet Agent Guide

Reference for Claude Code agents using the fleet MCP server. Symlink into your Claude reference directory:

```bash
ln -s /path/to/fleet/agent-guide.md ~/.claude/reference/fleet.md
```

## Startup

Call `register()` first thing, every session. This adds you to the agent registry with your session ID, kitty window, and working directory.

```
register()              # worker
register(manager=true)  # manager
```

If you see **📬** as input, call `my_task()`. This is the universal notification — it means a task was delegated, a message arrived, or something changed. Don't guess what it is; just call `my_task()`.

## Core tools

### my_task()
Shows your current task and reads unread messages inline. Call this:
- When you see 📬
- At session start (after register)
- When you finish a subtask and want to check for messages

### wait_for_task(timeout?)
Blocks until a task or message arrives. Uses `fs.watch` — resolves instantly when the state file changes. Call this when you have no work and are waiting for a delegation.

### chat(message, to?)
Send a message. Omit `to` to message whoever delegated your current task (falls back to any live manager). Use `to: "web"` to message the human via the dashboard.

Keep messages concise. If reporting completion, include what you did and any issues.

### task_done(agent?)
Mark your task complete. No args = your own task. Automatically unblocks any tasks that depend on yours.

Call this when you're done, not when you're "almost done." The manager sees the status change.

### task_list()
List all active tasks and registered agents. Useful at session start to understand the current state.

## Working on a task

1. `register()` → `my_task()` or `wait_for_task()`
2. Read the task, acknowledge it by starting work
3. Use `chat()` to report progress on longer tasks
4. Call `task_done()` when finished
5. Call `wait_for_task()` to get the next assignment

## Pushing back

If you're delegated a task but you're mid-work on something else, or the task doesn't make sense, push back via `chat()`. The manager can reassign. Don't silently ignore a delegation.

## Labels

Agents can have labels (set by the manager). Labels are used for team organization and chat filtering. You don't need to manage your own labels — the manager handles it.

## Git worktrees

If your task involves editing shared files (like `dashboard/index.html`), you may be asked to work in a git worktree to avoid conflicts:

```bash
git worktree add /tmp/fleet-<feature> -b <feature>
```

Work in the worktree, then tell the manager when you're done so they can merge your changes.

## Manager tools

These require `register(manager=true)`:

| Tool | Use |
|------|-----|
| `delegate(agent, description, message, after?)` | Assign a task. `after` creates dependency chains. |
| `name_agent(agent, friendly_name)` | Give an agent a human-readable name. |
| `interrupt(agent, message?)` | Break into a busy agent (sends ESC via kitty). |
| `spawn(cwd?)` | Launch a new agent in a kitty tab. |
| `respawn(agent)` | Resume a dead agent session. |
| `task_check(win)` | Read an agent's terminal (escape hatch). |

## Conventions

- **📬 = call my_task().** Always. No exceptions.
- **State file is truth.** `~/.claude/agent-tasks.json` has all tasks and messages. Everything else is derived.
- **Messages are ephemeral.** Read messages are pruned after 1h. Done tasks are pruned after 24h. The append-only log (`~/.claude/agent-messages.jsonl`) is the permanent record.
- **Agent identity = session UUID.** Auto-detected from your JSONL file. All tools accept UUIDs, agent names, or friendly names as identifiers.
