# Dashboard as Hub: Design Sketch

A design document for making the agent dashboard the primary communication interface, rather than a passive viewer of terminal-based agent coordination.

---

## 1. The Vision

Right now the dashboard is a window into a system that lives elsewhere. The state file is the brain, kitty terminals are the nervous system, and the dashboard watches from outside. "Dashboard as hub" means inverting this: the dashboard becomes the nervous system too.

Concretely:

- **Skip's primary interface is the dashboard**, not a grid of terminal tabs. Chat, task delegation, status monitoring, agent output — all flow through the web UI.
- **Agents don't need kitty windows to be reachable.** Notifications go through the MCP server directly (no terminal injection), so agents work headless or in terminals interchangeably.
- **The dashboard is bidirectional.** Skip can message agents, agents can message Skip, and messages arrive with browser notifications — no need to scan terminal tabs.
- **Terminals become optional.** They still exist for agents that need them (debugging, interactive tool use), but they're not the communication channel. A terminal is a workspace, not an inbox.

The state file remains the source of truth. What changes is the notification plumbing and the human's attention surface.

---

## 2. Current Architecture

### How it works

```
                    ┌──────────────────┐
                    │  State File      │
                    │  agent-tasks.json│
                    └──────┬───────────┘
                           │ read/write
           ┌───────────────┼───────────────┐
           │               │               │
    ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
    │ Agent MCP   │ │ Agent MCP   │ │ Agent MCP   │
    │ (manager)   │ │ (worker)    │ │ (worker)    │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
    ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
    │ Kitty Tab 1 │ │ Kitty Tab 2 │ │ Kitty Tab 3 │
    └─────────────┘ └─────────────┘ └─────────────┘
           │
    ┌──────▼──────────────────────────────────────┐
    │ Dashboard (passive viewer, SSE from state)  │
    └─────────────────────────────────────────────┘
```

**Notification flow** (e.g., manager delegates to worker):
1. Manager calls `delegate()` MCP tool
2. Tool writes task to `agent-tasks.json`
3. Tool runs `agent-kick <worker-kitty-win>`
4. `agent-kick` checks `agent-idle` (reads kitty screen buffer)
5. If idle: sends ESC + "📬\r" (with Enter) to terminal
6. If typing: sends ESC + "📬" (no Enter — waits for agent to finish)
7. Agent sees 📬, calls `my_task()`, gets the task

**Human notification flow** (agent messages Skip):
1. Agent calls `chat(to: 'web', message: '...')`
2. Tool writes message to state file
3. Dashboard picks up change via SSE
4. Browser notification fires (if Skip has the dashboard tab open)

### What's good

- **The state file as source of truth is clean.** No distributed state, no consensus, no sync bugs. One JSON file. Everything reads from it, everything writes to it.
- **The JSONL log is a permanent record.** Every delegation, chat, completion gets appended. The state file is ephemeral (auto-prunes); the log is forever. This separation is good.
- **Kitty kicks are fast and reliable when they work.** Sub-second notification. The ESC interrupt wakes up `wait_for_task` polls. The idle detection is clever — it reads the screen buffer to decide whether to send Enter.
- **The dashboard already has most of the UI.** Chat, task list, agent cards, command palette, search, export. It's not starting from zero.

### What's fragile

- **Kitty is the single point of coupling.** Every notification path goes through `kitty @ send-key` and `kitty @ send-text`. No kitty socket → no communication. Agent on a remote machine → no communication. Agent in tmux → no communication.
- **Idle detection is screen-scraping.** `agent-idle` reads the terminal buffer, looks for the prompt character above a separator line, checks for "esc to interrupt." This works, but it's fragile — prompt theme changes, window resizing, or Claude UI updates can break it.
- **Terminal tabs are the human's status display.** Skip has to scan 5-8 terminal tabs to know what's happening. Tab titles help, but it's cognitively expensive. The dashboard duplicates this information but Skip still has to look at terminals because that's where kicks go and where agents show their work.
- **Keepalive is a Rube Goldberg.** The keepalive watcher polls the state file, checks if agents need attention, checks if the manager is idle (via screen-scraping), applies exponential backoff, then kicks the manager terminal. All to solve one problem: "the manager might not notice something happened." With a real notification channel, this entire subsystem is unnecessary.
- **Headless agents are second-class citizens.** An agent without a kitty window can only be reached by `wait_for_task` polling (5-second intervals). No kick, no ESC interrupt. This means headless agents have worse latency and waste cycles polling.

---

## 3. Proposed Architecture

### 3.1 Notification Channel: In-Process Events

The key change: **agents get notified through their MCP server process, not through terminal injection.**

Currently, `wait_for_task` polls the state file every 5 seconds. The kitty kick exists to interrupt this poll early (ESC breaks the sleep). In the new model, the MCP server itself watches the state file and resolves the `wait_for_task` promise immediately when something relevant arrives.

```javascript
// Current: poll loop with 5s sleep
while (Date.now() < deadline) {
  const state = loadState();
  const task = findMyTask(state);
  if (task) return task;
  await new Promise(r => setTimeout(r, 5000)); // ESC from kitty breaks this... sometimes
}

// Proposed: fs.watch resolves the wait immediately
while (Date.now() < deadline) {
  const state = loadState();
  const task = findMyTask(state);
  if (task) return task;
  await waitForStateChange(deadline - Date.now()); // resolves on fs.watch event
}
```

This is a small change in `index.mjs` but it eliminates the need for kitty kicks entirely for the notification-to-agent path. `fs.watch` on the state file triggers immediately when any other process writes to it. No terminal injection, no screen-scraping, no socket.

**But wait — what about the ESC interrupt?** Currently, if an agent is mid-tool-call (running a bash command, reading a file), it's not in `wait_for_task` and can't be interrupted. The kitty ESC was the escape hatch for this. In the new model, this becomes:

- If the agent is in `wait_for_task`: `fs.watch` resolves instantly. No issue.
- If the agent is mid-work: the message sits in the state file. The agent sees it next time it calls `my_task()` or finishes its current tool chain. This is the same as what happens now when an agent is actively working — the kick just makes 📬 appear in the terminal, but the agent doesn't process it until it finishes its current thought.

The ESC interrupt was always a soft signal anyway. The agent doesn't abort mid-tool-call when it receives ESC — Claude Code queues the 📬 as pending input and processes it when the current tool chain completes. So the latency difference is: current (ESC interrupts sleep in `wait_for_task`, ~instant) vs. proposed (`fs.watch` resolves sleep in `wait_for_task`, ~instant). For the mid-work case, latency is the same in both: "whenever the agent finishes what it's doing."

### 3.2 Notification Channel: Dashboard to Human

The dashboard already handles this. SSE pushes state changes to the browser. Browser notifications fire when agents message Skip. The existing `chat(to: 'web')` flow works.

What's new: **the dashboard becomes the authoritative place where Skip reads and responds to agents.** Not a nice-to-have secondary view — the primary one. This means:

- Notification sounds/vibration (not just silent browser notifications)
- Unread count in the tab title: `(3) Agent Dashboard`
- Per-agent unread badges
- A "needs attention" visual state that's impossible to miss (flashing border, color change, something)
- Mobile-friendly layout (iPad in particular — Tailscale already makes the dashboard accessible on the local network)

### 3.3 Human-to-Agent Interaction

**Skip sends a message from the dashboard.** The flow:

1. Skip types in the chat input, hits Enter
2. Dashboard POSTs to `/api/chat` with `{message, to: agentId}`
3. Server writes message to state file
4. Agent's MCP server detects state change via `fs.watch`
5. If agent is in `wait_for_task`, the promise resolves and the agent sees the message
6. If agent is mid-work, message sits in state file until agent checks

Latency: milliseconds (step 4 is fs.watch, not polling). Same as current kitty kick latency, without the terminal dependency.

**Skip wants to see what an agent is doing.** Two options:

- **With terminal (current):** `/peek <agent>` reads the kitty screen buffer. Still works if terminals exist.
- **Without terminal:** The agent's recent tool calls and outputs are in its JSONL log. The dashboard could show a live tail of the agent's JSONL — last N tool calls, their results, what the agent is "thinking." This is actually richer than a terminal peek, because it's structured data (tool name, arguments, result) rather than raw terminal output.

The JSONL tail viewer already exists in the search infrastructure (`/api/logs/context`). Making it live (SSE on the JSONL file) is a natural extension.

### 3.4 What Happens to the Terminal

**Terminals become optional workspaces, not communication channels.** An agent might still run in a terminal for:

- Interactive debugging sessions
- Manual intervention (Skip types into the terminal directly)
- Visual reassurance ("I can see it's doing something")

But the terminal is no longer required for an agent to receive notifications, report status, or communicate with Skip or other agents.

**The terminal escape hatch:**
- `task_check(win)` still works for reading kitty windows when they exist
- The dashboard shows which agents have terminals attached and which are headless
- Skip can `/spawn` an agent in a terminal or headless, depending on the task
- An agent can start headless and "attach" to a terminal later if needed

### 3.5 Impact on the Manager Agent

The manager agent benefits the most:

- **No keepalive watcher needed.** The manager's `wait_for_task` resolves via `fs.watch`. When an agent reports completion, the state file changes, and the manager wakes up immediately. The entire keepalive subsystem (exponential backoff, idle detection, screen-scraping) goes away.
- **No kitty window required.** The manager can run headless. Its coordination work is all MCP tool calls — no terminal output matters.
- **Skip reaches the manager through the dashboard.** Currently, Skip types into the manager's terminal tab. In the new model, Skip sends a chat message from the dashboard, and the manager's `wait_for_task` resolves with it.

The manager still uses the same MCP tools: `delegate`, `chat`, `task_done`, `task_list`. The tools just don't call `agent-kick` anymore — they write to the state file and trust that `fs.watch` will notify the recipient.

### 3.6 Headless Agents

A headless agent is an MCP server process without a kitty window. In the current system, headless agents are second-class: they can only poll via `wait_for_task` (5s interval), and they can't be kicked. In the new model, headless agents are first-class:

- `wait_for_task` resolves via `fs.watch` — same latency as kitty-backed agents
- Chat messages arrive instantly
- No `agent-idle` screen-scraping needed — the MCP server knows its own state

**How do headless agents run tools?** Claude Code agents use bash, file reads, web fetches, etc. None of these require a terminal — they're MCP tool calls that execute in the agent's process. The terminal is just where you *see* the output. A headless agent produces the same tool calls and results; they just go to the JSONL log instead of a screen buffer.

**What can't headless agents do?** Anything that requires interactive terminal input. `vim`, `less`, interactive `git rebase`, etc. These are rare in agent workflows. If an agent needs an interactive terminal, it can be spawned with one.

---

## 4. The HCI Angle

### 4.1 One Log vs. Scattered JONSLs

Today, agent work lives in per-session JSONL files scattered across `~/.claude/projects/`. The state file is ephemeral. The `agent-messages.jsonl` log captures inter-agent communication but not agent *work*. To understand what happened, you need to cross-reference:

- `agent-messages.jsonl` for who talked to whom
- Individual JONSLs for what each agent actually did
- The state file (if it hasn't been pruned) for current task assignments

The dashboard's search index already unifies the JONSLs into a searchable corpus. The timeline view already shows inter-agent events chronologically. Making the dashboard the hub strengthens this: all communication flows through a system that logs and indexes it.

What changes: **the dashboard becomes the natural place to reconstruct what happened.** Not "let me grep through JSONL files" but "let me scroll back in the timeline." The timeline already exists. It just needs to be the canonical record, not a secondary view.

### 4.2 Single Pane of Glass

Skip currently monitors agents by:
1. Glancing at kitty tab titles (which agent, rough status)
2. Switching to a tab to read the terminal buffer
3. Checking the dashboard for chat messages and task status
4. Getting browser notifications when agents message him

This is three attention surfaces (tab bar, terminal content, dashboard). The "single pane of glass" collapses it to one: the dashboard.

What the dashboard needs to replace the terminal tab bar:
- **Agent cards with live status.** Not just "registered" — show "working (running bash: pytest)" or "idle (waiting for task)" or "thinking (processing tool result)." This requires the MCP server to report its current state, which it can do via the state file or a separate heartbeat.
- **Recent output preview.** A compact view of the agent's last few tool calls and results. Like a terminal, but structured. Expandable to full JSONL tail.
- **At-a-glance health.** Color coding: green (working), yellow (idle/blocked), red (stuck/error), gray (dead). Skip should be able to glance at the dashboard and know the fleet status in under a second.

### 4.3 How the Human's Attention Model Changes

**Terminal tabs: interrupt-driven, spatially stable.** Each agent has a fixed position in the tab bar. Skip builds a spatial map: "sims guy is tab 3, survival paper is tab 5." Attention is pulled by seeing activity (scrolling text) in peripheral vision.

**Dashboard: notification-driven, temporally ordered.** The chat panel is a timeline. New messages appear at the bottom. Skip's attention is pulled by browser notifications and the unread badge. There's no spatial mapping to individual agents — agents appear in a list or a chat thread.

The risk: **losing ambient awareness.** With terminal tabs, Skip can glance sideways and see that an agent is actively running commands (text scrolling) without consciously deciding to check. The dashboard requires a conscious decision to look at it. Browser notifications help but they're binary (something happened / nothing happened) — they don't convey "agent is busy vs. idle vs. stuck."

Mitigation ideas:
- **A persistent "fleet status" strip** at the top of the dashboard showing all agents with activity indicators (pulsing dots for active, static dots for idle). This replaces the tab bar's ambient awareness function.
- **Sound cues.** Different sounds for "agent completed task" vs. "agent needs attention" vs. "agent error." Audio is the attention channel that works when you're not looking at the screen.
- **Desktop widget / menu bar indicator.** A macOS menu bar icon showing agent count and status. Click to open the dashboard. This is the tab-bar replacement for ambient awareness.

### 4.4 What You Learn About Human-AI Coordination

This project is building an empirical record of how a human coordinates with multiple AI agents in real time. The dashboard-as-hub design generates better data for this:

- **All communication is structured and logged.** No more "Skip typed something into a terminal and we didn't capture it." Every human-to-agent message goes through the dashboard and gets logged.
- **Attention patterns are observable.** The dashboard can log when Skip views an agent's output, how long he spends on each agent, what triggers him to intervene. These are the traces you need to study human-AI teaming.
- **The interface itself is an experiment.** Different dashboard layouts, notification strategies, and status displays are easy to A/B test. Harder to experiment with terminal tab arrangements.

The research question underneath all this: **what is the optimal attention allocation strategy for a human supervising N AI agents?** The terminal model is "scan all N tabs periodically." The dashboard model is "respond to notifications and check the fleet status bar." Neither is obviously better — it depends on the task structure, the agents' reliability, and the cost of delayed attention. Having both options (terminal escape hatch + dashboard primary) lets you compare.

---

## 5. Pro/Con Analysis

### Gains

**No kitty dependency.** The system works on any machine with Node.js. No kitty socket, no screen-scraping, no terminal injection. Agents can run on remote machines, in Docker, on a server — anywhere the state file is accessible (or synced, or replaced with a lightweight API).

**Works on iPad.** Skip already accesses the dashboard via Tailscale. Making it the primary interface means full agent coordination from a tablet. No terminal emulator needed.

**Agents can reach the human.** The `chat(to: 'web')` path already exists, but making the dashboard primary means Skip actually *sees* these messages reliably. The browser notification becomes the primary alert channel, not a supplement to terminal scanning.

**Cleaner architecture.** Removing kitty kick eliminates: `agent-kick`, `agent-idle`, `agent-read`, `agent-keepalive`, `agent-exists`, `agent-windows` — six shell scripts and all the screen-scraping logic. The notification path becomes: write to state file → `fs.watch` resolves promise. Two moving parts instead of twelve.

**Headless agents are first-class.** Same latency, same notification path, same status reporting. No penalty for not having a terminal.

**Unified logging.** All human-agent communication flows through the dashboard and gets logged. No "lost" messages typed into terminals.

### Losses

**Terminal interactivity.** Skip can currently type directly into an agent's terminal to course-correct in real time. This is gone for headless agents. The replacement (chat message via dashboard) has higher latency and is less fluid — you can't interrupt mid-sentence, you can't see the agent's reaction in real time.

**Ambient awareness.** Terminal tabs provide passive visibility into agent activity (scrolling text, cursor position). The dashboard must recreate this somehow (activity indicators, live JSONL tails), and it's not clear that a web UI can match the glanceability of a tab bar.

**Single point of failure.** If the dashboard server goes down, Skip loses visibility into the fleet. Terminal tabs are independent — each agent is its own process. Mitigation: agents are still independent processes; the dashboard is just a viewer. The state file still works. You just lose the notification UI until the server restarts.

**Complexity of live JSONL streaming.** Showing an agent's real-time activity (tool calls, outputs) requires watching individual JSONL files and streaming them to the browser. These files can be large and write-heavy. This is solvable but it's new infrastructure.

**Loss of spatial memory.** Skip knows "sims guy is tab 3." In the dashboard, agent ordering is... what? Alphabetical? By status? By last activity? The spatial stability of terminal tabs is an underrated UX advantage.

### The Terminal Escape Hatch

Terminals don't disappear — they become optional. The design should support:

- **Spawning an agent with a terminal** when you want to watch it work or intervene manually
- **Attaching a terminal to a headless agent** by resuming its session in a kitty tab (this is what `respawn` already does)
- **Using `/peek`** from the dashboard to read a terminal-backed agent's screen, exactly as now
- **Typing into a terminal** when the chat interface is too slow or too structured for the interaction you need

The key invariant: **the presence or absence of a terminal doesn't affect an agent's ability to receive tasks, send messages, or be monitored.** Terminals are an optional view, not the communication backbone.

---

## 6. Migration Path

This can be done incrementally. Each step is independently valuable and the system works at every intermediate state.

### Step 1: `fs.watch` in `wait_for_task`

Replace the 5-second poll in `wait_for_task` with `fs.watch` on the state file. The sleep/poll loop becomes a watch/resolve loop. This gives instant notification to all agents without kitty kicks.

Kitty kicks still work in parallel — they're just redundant now. No code needs to be removed. Agents that receive a kick and an `fs.watch` event both call `my_task()` and get the same result. Idempotent.

**Effort:** ~20 lines changed in `index.mjs`. Low risk.

### Step 2: Dashboard notification improvements

Make the dashboard a reliable human notification surface:
- Unread count in tab title
- Notification sounds (configurable)
- Per-agent unread badges
- "Needs attention" visual state

**Effort:** Frontend only, medium. No backend changes.

### Step 3: Live agent activity view

Add a JSONL tail viewer to the dashboard. For each agent, show the last N tool calls and their results, updated live via SSE on the JSONL file.

This replaces `/peek` for understanding what an agent is doing — and it's richer, because it's structured data rather than raw terminal output.

**Effort:** New SSE endpoint + frontend component. Medium.

### Step 4: Fleet status bar

A persistent top-of-page strip showing all agents with live status indicators. Replaces the tab bar's ambient awareness function.

Requires agents to report their current activity to the state file (or a separate lightweight heartbeat). The MCP server already updates `last_seen` on every tool call — extending this to include "current tool" or "idle" is small.

**Effort:** Small backend change (report current activity), medium frontend.

### Step 5: Deprecate kitty kick (optional)

Once Steps 1-4 are stable, kitty kicks become redundant. The `agent-kick` codepath can be removed from MCP tools. The shell scripts (`agent-kick`, `agent-idle`, `agent-exists`, `agent-windows`) become unused. `agent-keepalive` is unnecessary.

Don't remove the scripts yet — keep them as manual escape hatches. Just stop calling them from the MCP tools.

**Effort:** Small. Remove `kick()` calls from `index.mjs`. Leave scripts in `bin/`.

### Step 6: Headless-first agent spawning

Change `spawn` to launch headless agents by default (no kitty tab). Add a `--terminal` flag for when you want one. This is a policy change, not an infrastructure change — all the plumbing is in place by this step.

**Effort:** Small. Policy decision more than code.

---

## 7. Open Questions

**How does `fs.watch` behave under high write contention?** If multiple agents are writing to the state file simultaneously, `fs.watch` might fire rapidly. The current code already has a `saveState` function that does a synchronous write — no locking. This works because tool calls are serialized within each MCP server process, and file writes are atomic at the OS level (rename-over pattern would be safer). Need to verify that `fs.watch` coalescing doesn't drop events.

**What does "headless spawn" actually look like?** Currently, `spawn` runs `kitty @ launch --type=tab -- zsh -c 'claude'`. A headless spawn would be... `claude --mcp-server-only`? Does Claude Code have a headless mode? If not, can we run it in a detached process without a pty? This needs investigation. The MCP server runs fine without a terminal (it's stdio-based), but Claude Code itself expects a terminal for its UI.

**Should the state file be replaced with a database?** The JSON file works at current scale (5-10 agents, dozens of messages). At larger scale, the read-modify-write cycle becomes a bottleneck. SQLite would give atomic transactions, but it's also more complexity. The JSON file's simplicity is a feature — it's `cat`-able, greppable, human-readable. Don't change this unless you hit actual contention issues.

**How does Skip intervene in real-time without a terminal?** The chat interface is good for asynchronous communication ("do this differently"), but bad for real-time steering ("wait, stop, go back"). A terminal lets Skip type Ctrl-C or ESC to interrupt. The dashboard has no equivalent. Options:
- A "stop" button that sends SIGINT to the agent process (if we know its PID)
- A "pause" message type that the MCP server interprets as "stop current tool chain"
- Accept that real-time steering is a terminal-only capability and keep the escape hatch

**What about remote agents?** The state file is local. For agents on remote machines, you'd need to either sync the file (bad) or replace it with an HTTP API (essentially making the dashboard server the state backend, not just a viewer). This is a bigger architectural change and probably not worth doing until there's a concrete need for remote agents.

**How do you handle agent output that's visual?** Some agents produce plots, rendered PDFs, screenshots. In a terminal, these are file paths that Skip opens separately. In the dashboard, they could be inline previews. The `/api/file` endpoint already serves images. Extending this to cover common output types (plots, screenshots, diffs) would make the dashboard strictly superior to the terminal for reviewing agent output.

**What's the right notification granularity?** Currently, Skip gets notified on every `chat(to: 'web')`. In the dashboard-as-hub model, he'd also want to know about task completions, agent errors, agents going idle, agents being stuck. Too many notifications → noise. Too few → missed signals. Configurable notification rules ("only notify me when an agent completes a task or reports an error") would help, but that's UI complexity.

**What about multiple humans?** The current system is single-user (Skip). The dashboard could serve multiple users, each with their own unread state and notification preferences. Not on the roadmap, but the architecture should not preclude it. Using `from: 'web'` for all dashboard messages already conflates all human users — this would need to change.
