# Fleet

MCP server + dashboard for coordinating multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Agents register at startup, a manager delegates tasks, and everyone communicates through a shared state file. [Kitty](https://sw.kovidgoyal.net/kitty/) terminal notifications ring the doorbell — the state file carries the actual messages.

**[Watch the demo](https://davidahirshberg.github.io/fleet-mcp/)** — an interactive playback of the dashboard in action.

## Quickstart

### 1. Install & configure

```bash
npx github:davidahirshberg/fleet-mcp
```

This clones the repo, adds the MCP server to your Claude Code settings, and symlinks the agent reference guide. Then add this to your `CLAUDE.md` (global or per-project):

```markdown
Call `register()` with the `fleet` MCP server at session start. If you see **📬** as input,
call `my_task()` — it means you have a new task or message.
```

### 2. Try it

Open two kitty tabs, each running `claude`.

**Tab 1 (manager):**
```
> register(manager=true)
> delegate(agent=<tab2-uuid>, description="say hello", message="Send me a greeting via chat()")
```

**Tab 2 (worker):**
```
> register()
> my_task()          # sees the delegation
> chat("Hello!")     # sends greeting to manager
> task_done()
```

The manager sees the message. That's it — two agents talking through fleet.

### 3. Dashboard (optional)

```bash
node dashboard/server.mjs          # default port 5200
```

Open `http://localhost:5200` to see live agent status, chat, activity cards, and more.

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

## Tools

### All agents

| Tool | Description |
|------|-------------|
| `register(manager?, session_id?, name?)` | Register at session start. Auto-detects session UUID. |
| `my_task()` | Show current task + read unread messages. |
| `chat(message, to?)` | Send a message. Omit `to` to message the manager. |
| `task_done(agent?)` | Mark own task done (or another's, manager only). |
| `task_list()` | List active tasks and registered agents. |
| `timer(seconds, message)` | Non-blocking timer. Returns immediately, delivers 📬 when it fires. |

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

## Guides

- **[Agent Guide](agent-guide.md)** — reference for agents: tool usage, notification handling, chat conventions. Symlink to `~/.claude/reference/fleet.md`.
- **[Manager Guide](managing-agents.md)** — delegation strategy, intervention, behavioral guidelines. Symlink to `~/.claude/reference/managing-agents.md`.
- **[Ops Guide](ops.md)** — how it works under the hood, what breaks, how to fix it.

## Docs

- **[Architecture](docs/architecture.md)** — state schema, identity system, task dependencies, dashboard
- **[Notifications](docs/notifications.md)** — three-tier notification model
- **[Playback](docs/playback.md)** — recording and replaying multi-agent sessions
- **[Design docs](docs/design/)** — design documents and plans
- **[Retrospectives](docs/retrospectives/)** — experience reports from multi-agent sessions

## Provenance

Written almost entirely by Claude (Opus/Sonnet), with human direction on design and behavior. The code, docs, and commit messages are AI-generated.

## License

MIT
