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

## All-agent tools

### register(manager?, session_id?, name?)

All agents call this at session start. Auto-detects the session UUID from the most recent JSONL in the project directory. Preserves any friendly name assigned by the manager across re-registrations.

- `manager`: set true to register as manager
- `session_id`: Claude session ID (override auto-detection)
- `name`: display name for headless agents (stored but not used for resolution — use `friendly_name` via `name_agent` for identity)

### my_task()

Show your current task and read unread messages inline. Call this:
- When you see 📬
- At session start (after register)
- When you finish a subtask and want to check for messages

### chat(message, to?)

Send a message to another agent's inbox. Recipient is notified via fs.watch.

- `message`: Message to send
- `to`: Optional. Fleet ID, session UUID, or friendly name. Omit to message whoever delegated your current task (falls back to any live manager). Use `"web"`, `"skip"`, or `"human"` to message the dashboard.

Keep messages concise. If reporting completion, include what you did and any issues.

### task_done(agent?)

Mark a task done. No args = mark own task. Marking another agent's task requires manager. Automatically unblocks dependent tasks and kicks them.

### task_list()

List all active tasks and registered agents. Useful at session start to understand the current state.

### timer(seconds, message)

Set a non-blocking timer. Returns immediately — you get 📬 when it fires. **Use this instead of `sleep X && ...` in bash.**

- `seconds`: Duration (1–600)
- `message`: Reminder delivered when the timer fires (e.g. "check build status")

When the timer fires, the message appears in your inbox as ⏰. Call `my_task()` to see it.

## Manager triage

Managers (especially the chief of staff) own the decision of whether to handle a request themselves or delegate it. When the user asks for something to get done, the manager decides and communicates the decision with a brief rationale if taking it on themselves. Bias toward delegating when actively collaborating with the user — the manager's attention is more valuable on coordination than execution. If the user gives an explicit instruction on whether to do it or delegate, follow that. Otherwise, use judgment:

- **Delegate** when: the task is self-contained, an agent is available, or the manager is mid-conversation with the user.
- **Take it on** when: it's faster (small fix, quick investigation), requires the manager's context, or no agents are free.

## Manager tools

These require `register(manager=true)`:

### delegate(agent, description, message, after?, friendly_name?)

Assign a tracked task to an agent. Agent must be registered — rejects unknown identifiers.

- `agent`: Fleet ID, session UUID, or friendly name
- `description`: Short human-readable label (5-10 words)
- `message`: Full task message
- `after`: Optional. Task ID or array of IDs — task is blocked until all complete.
- `friendly_name`: Optional. Set a friendly name for the agent (same as `name_agent`).

Returns task ID. Use in `after` for dependent tasks.

### name_agent(agent, friendly_name)

Set or change a friendly name. Names must be unique — rejects duplicates. Names persist across re-registrations.

- `agent`: Fleet ID, session UUID, or friendly name
- `friendly_name`: Human-readable name (e.g. "sims guy", "survival paper")

### label_agent(agent, labels)

Tag agents with labels for group targeting and chat filtering.

### spawn(cwd?, win?)

Launch a fresh Claude agent in a new kitty tab. The new agent calls `register()` on startup.

- `cwd`: Working directory. Defaults to home directory.
- `win`: Optional. Kitty window to use instead of creating a new tab.

Returns the kitty window ID. Once the agent registers, find its UUID via `task_list()`.

### respawn(agent, win?)

Resume a dead agent session. Looks up session ID and cwd from the registry.

- `agent`: Fleet ID, session UUID, or friendly name
- `win`: Optional. Kitty window to use. Omit to auto-find an idle tab.

### interrupt(agent, message?)

Send ESC to break into a stuck agent. **Not for routine notifications** — those go through fs.watch automatically.

- `agent`: Fleet ID, session UUID, or friendly name
- `message`: Optional message delivered via chat before the interrupt

### task_check(win)

**Escape hatch.** Read an agent's kitty terminal directly. For when an agent is stuck or unresponsive. Takes a kitty window ID.

## Working on a task

1. `register()` → `my_task()` to check for a task
2. Read the task, acknowledge it by starting work
3. Use `chat()` to report progress on longer tasks
4. Call `task_done()` when finished
5. Use `timer()` to set reminders — you'll see 📬 when something arrives

## Pushing back

If you're delegated a task but you're mid-work on something else, or the task doesn't make sense, push back via `chat()`. The manager can reassign. Don't silently ignore a delegation.

## delegate vs chat

- **delegate**: "Do this work." Creates a tracked task.
- **chat**: "Quick question" / "Here's context." Goes to inbox.
- **interrupt**: "Stop what you're doing." Sends ESC to break in.

If you'd want to know when it's done, use `delegate`.

## Labels

Agents can have labels (set by the manager). Labels are used for team organization and chat filtering. You don't need to manage your own labels — the manager handles it.

## Git worktrees

If your task involves editing shared files (like `dashboard/index.html`), you may be asked to work in a git worktree to avoid conflicts:

```bash
git worktree add /tmp/fleet-<feature> -b <feature>
```

Work in the worktree, then tell the manager when you're done so they can merge your changes.

## Conventions

- **📬 = call my_task().** Always. No exceptions.
- **State file is truth.** `~/.claude/agent-tasks.json` has all tasks and messages. Everything else is derived.
- **Messages are ephemeral.** Read messages are pruned after 1h. Done tasks are pruned after 24h. The append-only log (`~/.claude/agent-messages.jsonl`) is the permanent record.
- **Agent identity = session UUID.** Auto-detected from your JSONL file. All tools accept UUIDs, agent names, or friendly names as identifiers.
