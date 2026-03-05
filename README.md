# agent-manager

MCP server that coordinates multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions through [kitty](https://sw.kovidgoyal.net/kitty/) terminal remote control.

A "manager" session delegates tasks to worker sessions running in other kitty windows, monitors their progress, and tracks dependencies between tasks. Workers can chat back to the manager without waiting to be polled.

## Requirements

- [kitty](https://sw.kovidgoyal.net/kitty/) terminal with `allow_remote_control socket-only` and `listen_on` configured
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 18+

### kitty config

```conf
# ~/.config/kitty/kitty.conf
allow_remote_control socket-only
listen_on unix:/tmp/kitty-sock-{kitty_pid}
```

### Shell alias

The `claude` alias passes the kitty window ID to the MCP server so it can identify which agent is calling:

```bash
alias claude="AGENT_WIN=$KITTY_WINDOW_ID command claude"
```

## Setup

```bash
npm install
```

Add to your Claude Code MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "agent-manager": {
      "command": "node",
      "args": ["/path/to/agent-mcp/index.mjs"]
    }
  }
}
```

## Tools

### Manager-only

| Tool | Description |
|------|-------------|
| `delegate(win, description, message, after?)` | Send a tracked task to a worker window. Optional `after` defers until dependencies complete. |
| `task_done(win)` | Mark a task complete. Auto-unblocks dependents. |

### Available to all agents

| Tool | Description |
|------|-------------|
| `register_manager()` | Register the calling session as manager. Auto-starts keepalive watcher. |
| `chat(message, win?)` | Send a message to another agent. Omit `win` to send to manager. |
| `task_list()` | List all active tasks with status. |
| `task_check(win)` | Non-blocking snapshot of a window's state. |
| `my_task()` | Show what task is assigned to the calling window. |
| `wait_for_idle(win, timeout?, interval?)` | Block until a specific agent goes idle. |
| `wait_for_any(timeout?, interval?)` | Block until any pending agent goes idle. |

## How it works

1. Open several kitty windows, each running `claude`.
2. In one window, call `register_manager()` — this becomes the manager.
3. The manager uses `delegate()` to assign tasks to worker windows.
4. Workers do their work. When done, they go idle (back to the `❯` prompt).
5. The manager calls `wait_for_any()` to monitor, then reviews output and delegates follow-ups.
6. Workers can `chat()` back to the manager at any time — to report results, ask questions, or flag issues.

### Task dependencies

Tasks can depend on other tasks via the `after` parameter:

```
delegate(win=3, description="analyze results", message="...", after="w5-m1abc")
```

The message is held until `w5-m1abc` is marked done, then sent automatically.

### Keepalive watcher

A background process (auto-started by `register_manager`) polls every 45 seconds and nudges the manager when agents need attention — idle workers awaiting review, pending tasks, or cluster jobs running. Only kicks the manager, never workers. 5-minute cooldown between kicks.

## State

Task state persists in `~/.claude/agent-tasks.json`. Survives context compaction and session restarts.

## Provenance

This was written almost entirely by Claude (Opus), with human direction on design and behavior. The code, docs, and commit messages are AI-generated.

## License

MIT
