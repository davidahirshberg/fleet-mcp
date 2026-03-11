# Fleet

MCP server + dashboard for coordinating multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Agents register at startup, a manager delegates tasks, and everyone communicates through a shared state file. [Kitty](https://sw.kovidgoyal.net/kitty/) terminal notifications ring the doorbell — the state file carries the actual messages.

**[Watch the demo](https://davidahirshberg.github.io/fleet-mcp/)** — an interactive playback of the dashboard in action.

## What you get

- **MCP tools** for task delegation, chat, agent lifecycle (spawn, respawn, interrupt)
- **Web dashboard** with live agent status, chat, activity cards, terminal views, search, and playback recordings
- **Three-tier notifications**: PostToolUse hooks (instant), `sleep()` wakeup (interruptable), kitty terminal kicks (last resort)
- **Task dependencies**: chain tasks with `after` so they unblock automatically
- **Playback**: record and replay multi-agent sessions as interactive timelines

## Requirements

- [kitty](https://sw.kovidgoyal.net/kitty/) terminal with remote control enabled
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 18+

### kitty config

```conf
# ~/.config/kitty/kitty.conf
allow_remote_control socket-only
listen_on unix:/tmp/kitty-sock-{kitty_pid}
```

## Setup

```bash
git clone <repo-url> fleet
cd fleet
npm install
```

Add the MCP server to Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["/path/to/fleet/index.mjs"]
    }
  }
}
```

Start the dashboard:

```bash
node dashboard/server.mjs          # default port 5200
node dashboard/server.mjs --port 8080
```

## Tools

### All agents

| Tool | Description |
|------|-------------|
| `register(manager?, session_id?, name?)` | Register at session start. Auto-detects session UUID. |
| `my_task()` | Show current task + read unread messages. |
| `chat(message, to?)` | Send a message. Omit `to` to message the manager. |
| `task_done(agent?)` | Mark own task done (or another's, manager only). |
| `task_list()` | List active tasks and registered agents. |
| `sleep(seconds, reason?)` | Instrumented sleep with dashboard countdown. Interruptable. |

### Manager-only

| Tool | Description |
|------|-------------|
| `delegate(agent, description, message, after?, friendly_name?)` | Assign a tracked task. Supports dependency chaining. |
| `name_agent(agent, friendly_name)` | Set a human-readable name (e.g. "sims guy"). |
| `label_agent(agent, labels)` | Tag agents with labels for group targeting. |
| `spawn(cwd?, win?)` | Launch a fresh Claude agent in a new kitty tab. |
| `respawn(agent, win?)` | Resume a dead agent session. |
| `interrupt(agent, message?)` | Send ESC to break into a stuck agent. |
| `task_check(win)` | Read an agent's terminal directly (escape hatch). |

### Playback

| Tool | Description |
|------|-------------|
| `playback_record(title, sources, project?)` | Record a session into a playback timeline. |
| `playback_list(project?, limit?)` | List available recordings. |
| `playback_get(id)` | Get recording metadata. |
| `playback_edit(id, ...)` | Edit recording (trim, add markers, rename). |
| `playback_transcript(id, ...)` | Export recording as formatted text. |

## How it works

1. Open kitty tabs, each running `claude`.
2. Every agent calls `register()` at startup — added to the registry with session UUID and kitty window.
3. One agent calls `register(manager=true)` — becomes the manager.
4. Manager uses `delegate()` — task is written to the state file, agent gets a notification.
5. Agent sees 📬, calls `my_task()` to get the task.
6. Agent works, uses `chat()` to report progress.
7. Agent finishes, calls `task_done()`.

### Notifications

Three tiers, from lightest to heaviest:

1. **PostToolUse hook** — after every tool call, a shell hook checks for unread messages. If found, injects 📬 as context. Zero latency.
2. **`sleep()` wakeup** — incoming messages resolve sleep early. Agent calls `my_task()` to handle.
3. **Kitty interrupt** — `interrupt()` sends ESC to the terminal. For truly stuck agents. Last resort.

### Task dependencies

```
const t1 = delegate(agent="alpha", description="fetch data", message="...")
delegate(agent="beta", description="analyze results", message="...", after=t1)
```

Beta's task stays blocked until alpha calls `task_done()`.

## Dashboard

The dashboard (`node dashboard/server.mjs`) provides:

- **Chat** — send messages to agents, see their responses and tool activity in real time
- **Agents** — live status with seen-ago, context %, task assignment, labels
- **Terminal** — read agent terminal output directly from the dashboard
- **Search** — full-text search across all agent session logs
- **Playback** — watch recorded multi-agent sessions as interactive timelines
- **Tiling layout** — drag-and-drop panels via dockview, save/restore layouts

Chat panels can target specific agents or label groups. Activity cards show tool calls as they happen, with inline diffs for edits. Cards are draggable into chat as attachments.

### Keyboard shortcuts

Press `Cmd+K` to open the command palette, or use direct shortcuts:

- `Cmd+Enter` — send message
- `Cmd+1-9` — switch tabs
- `Cmd+N` — new chat panel

## Configuration

Add this to your `CLAUDE.md` (global or per-project):

```markdown
Call `register()` with the `fleet` MCP server at session start. If you see **📬** as input,
call `my_task()` — it means you have a new task or message.
```

### Agent guide

[`agent-guide.md`](agent-guide.md) has detailed reference for agents — tool usage, notification handling, chat conventions. Symlink it:

```bash
ln -s /path/to/fleet/agent-guide.md ~/.claude/reference/fleet.md
```

### Manager guide

[`managing-agents.md`](managing-agents.md) covers manager-specific patterns — delegation strategy, intervention, behavioral guidelines.

```bash
ln -s /path/to/fleet/managing-agents.md ~/.claude/reference/managing-agents.md
```

## State

All state persists in `~/.claude/agent-tasks.json` — survives context compaction and session restarts. Auto-prunes: done tasks older than 24h and read messages older than 1h are dropped. History lives in agent session JONSLs.

Playback recordings are stored in `~/.fleet/playback/` as SQLite databases.

## Provenance

Written almost entirely by Claude (Opus/Sonnet), with human direction on design and behavior. The code, docs, and commit messages are AI-generated.

## License

MIT
