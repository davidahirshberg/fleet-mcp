# Managing Agents — Meta Session Patterns

Guidance for the manager session only. Loaded via `register_manager()`.

**Read the reference files for what your workers are doing.** The manager reviews worker output and catches mistakes — you can't do that without domain knowledge. If workers are implementing math, read `math-implementation.md`. If they're submitting cluster jobs, read `cluster.md`. If they're writing LaTeX, read `tex-patterns.md` and `notation.md`. The manager needs at least the same reference context as the workers, plus this file.

## Meta Sessions

A meta session is one where the work is about agent infrastructure: editing CLAUDE.md or reference files, configuring hooks, diagnosing problems in other sessions, building tools. Two modes:

### Conducting a meta session

**Guidance changes are high-stakes** — they affect every future session. Ground them in actual log evidence. The flow is: read logs → synthesize findings → discuss → write guidance. Don't skip to writing rules before the discussion establishes whether the pattern is real and whether it's already covered.

**In research reports and discussion, speculation is fine — label it.** "This might also apply to X" is useful. It just needs to be marked as such and separated (at minimum a separate sentence or bullet) from less speculative findings, so it can be pushed back on without first arguing about whether it's established fact.

**Read the full existing section before editing.** Don't patch in isolation — the surrounding context matters, and you might duplicate or contradict something nearby.

**Don't improve surrounding text** while you're editing a reference file. Same rule as everywhere else: if you didn't write it and weren't asked to change it, leave it.

### Identifying meta sessions at startup

When orienting at session start, check whether the most recent session was a meta session. If it was, scan back for the most recent non-meta session and surface both: "Most recent session was a meta session (hooks/CLAUDE.md edits). Most recent work session was [X]. Which do you want to pick up?" Don't assume.

### Active intervention in another session (kitty tools)

With `agent-read` and `agent-kick` available, a meta session can actively intervene in a running session rather than just talk about it.

**Describing a problem is not a request to fix it.** If the user describes what's going wrong in another session, that's context for discussion — not a trigger to send corrections. Wait for an explicit "help" or "fix it" before touching the other window.

**When the user points at a problem in an identifiable session, read that session before asking questions.** Don't ask the user to show you something you can look up yourself. "Identifiable" includes the current session, other open windows, and any session the user has described precisely enough to find. Pay attention to number cues — "agents" (plural, no number given) means read all windows.

**When asked to advise an agent, advise — don't do the task yourself.** If the user asks you to tell agent B how to do X, send agent B instructions on how to do X. Do not do X yourself. The distinction matters: agent B has context you don't, and doing it yourself bypasses that context and creates confusion about what's been done.

**When asked to relay instructions, read the instructing agent first.** Find out what the instructions actually are before sending anything. Don't compose your own version — the instructing agent may have specific content, context, or framing that you'll get wrong if you improvise.

**Identifying the right window — this is the hardest part.** `agent-list` shows OS window, tab, and window ID. Do not guess by ID. The procedure:

1. Run `agent-list` to see the full structure.
2. For each plausible window, `agent-read <id> | grep <distinctive-string>` using text from what the user pasted or described.
3. Confirm with a full tail read of the matching window before sending anything.
4. If a window has been sent a wrong message and pivoted to a different task, read further back (earlier in the scrollback) to find its original context.
5. If the scrollback is too shallow, go to the JSONL for that session.
6. Don't conclude it's the wrong window from the last line alone — agents change topics. Read enough context to see what the session is actually about.

**Don't ask the user to recall session history.** "Do you remember what prompted X?" is a question the agent should answer by reading the log — not by asking. If the context for a decision is missing, go find it in the JSONL for that session. This applies whether it's your own session or another agent's session you've been asked to read. The user shouldn't have to reconstruct their own session history for you.

**Sign inter-agent messages and say how to respond.** When sending instructions to another session via `agent-kick`, identify the source and tell the recipient how to communicate back. End messages with something like: "— meta session (win N). Just reply here; I'll check back." Otherwise the receiving agent doesn't know whether this is from the user or another agent, and can't route a response.

**Receiving a signed inter-agent message: just do it.** If a message is signed (identifies a source window), in scope, and asks for work consistent with the session's ongoing task — treat it as a legitimate instruction and act. Do not escalate to the user for confirmation. The signature is the authorization. Treating a correctly-signed inter-agent instruction as a security risk to verify defeats the whole point of the coordination system.

**Window vs. log:** `agent-read` only goes as far as kitty's scrollback buffer. If the window content feels shallow or starts mid-thought, go to the JSONL as well. The window gives you the live current state; the log gives you the full arc. (Kitty's scrollback limit is also worth extending via config — `scrollback_lines` in `~/.config/kitty/kitty.conf`.)

## Managing Multiple Agents

**Use the agent-manager MCP server.** All agents have the `agent-manager` MCP server (`~/work/ama-mcp/`), configured in `~/.claude/settings.json`. Communication is MCP-native: agents receive work via `wait_for_task()` and send messages via `chat()`. No kitty terminal scraping for normal communication. State persists in `~/.claude/agent-tasks.json` across compaction and session restarts.

### Tools

- `register(manager?, session_id?, name?)` — register this agent. **All agents call this at session start.** Adds to the agent registry so kicks work. Captures `$PWD` as working directory. Pass `manager=true` for the manager session.
- `delegate(agent, description, message, after?, friendly_name?)` — assign a task. Writes to state and kicks the agent via kitty. `agent` is a session UUID, agent name, or friendly name. Agent must be registered. Optional `after` for dependencies. Optional `friendly_name` to name the agent on first delegation.
- `chat(message, to?)` — send a message. Writes to state and kicks the recipient via kitty. Omit `to` to send to the manager.
- `wait_for_task(timeout?)` — block until a task or message arrives. Agents call this when idle. Polls every 5s.
- `task_list()` — show all active tasks + registered agents. **Call at session start.** Shows friendly names when set.
- `task_done(agent?)` — mark a task done. No args = mark own task. Marking another agent's task requires manager. Automatically unblocks dependent tasks and kicks them.
- `task_check(win)` — **escape hatch.** Read an agent's kitty terminal directly. For stuck/unresponsive agents only.
- `my_task()` — show own task and read unread messages.
- `name_agent(agent, friendly_name)` — set/change a friendly name. Manager only. Names persist across re-registrations.
- `spawn(cwd?, win?)` — launch a fresh claude agent in a new kitty tab. Creates the tab, runs `claude`. Manager only.
- `respawn(agent, win?)` — resume a dead agent by name. Finds an idle kitty tab, cd's to the agent's cwd, runs `claude --resume`. Manager only.
- `register_manager()` — alias for `register(manager=true)`.
- `unregister_manager(to?)` — step down as manager. Pass `to` to hand off to a specific agent.

See `~/work/ama-mcp/CLAUDE.md` for full tool reference, task schema, and status flow.

### Notification model

The state file is the source of truth. Kitty is the doorbell:
- `delegate()` writes task → kicks agent via kitty
- `chat()` writes message → kicks recipient via kitty
- `task_done()` with unblocked deps → kicks each unblocked agent

Agents must be registered for kicks to work. Headless agents (no kitty) must poll via `wait_for_task()`.

### Agent lifecycle

1. Agent starts, calls `register()` — added to agent registry
2. Manager calls `delegate(agent, ...)` — task written to state, agent kicked via kitty
3. Agent sees the kick, calls `wait_for_task()` or `my_task()` — gets the task
4. Agent works, uses `chat()` to report progress
5. Agent finishes, calls `task_done()`
6. Agent waits for next kick or calls `wait_for_task()` to poll

### Agent types

- **Terminal agents**: identified by session UUID (auto-detected at startup). Kitty window ID is just metadata for notifications.
- **Headless agents**: identified by name (string, e.g. "todd"). These are processes like Todd (the tlda triage agent) that run outside of kitty.

### Agent naming

Agents have friendly names — human-readable labels like "sims guy" or "survival paper" that the manager uses instead of raw UUIDs. Names are a manager-side concept; agents don't need to know their own names.

- Set a name: `name_agent(agent, "sims guy")` or `delegate(agent, ..., friendly_name="sims guy")`
- Names persist across re-registrations (agent restarts don't lose the name)
- All tools that accept an agent identifier also accept friendly names
- `task_list()` shows friendly names when set

Pick up names naturally from context — if the user calls someone "sims guy," name them that.

### Respawning agents

When an agent session dies (window closed, crash, etc.), the manager can bring it back:

```
respawn("sims guy")
```

This looks up the agent's session ID and working directory from the registry, finds an idle kitty tab (or the agent's old window if still alive), and runs `cd <cwd> && claude --resume <session_id>`. The agent's registry entry is updated with the new window.

If no idle tab is available, open a new terminal tab and try again, or pass `win` explicitly.

### delegate vs chat

If you'd want to know when it's done, use `delegate()`. Work assigned via `chat()` is invisible to `task_list()` and keepalive — idle agents with completed chat-assigned work never trigger a review.

- **delegate**: "Do this work." Creates a tracked task.
- **chat**: "Quick question" / "Here's context." Goes to inbox, no task created.

### Task dependencies

Use `after` to chain tasks: `delegate(agent=18, description="build paper", message="...", after="w16-xxx")`. The task stays blocked until all deps complete, then activates — agent's `wait_for_task()` picks it up. Chain multiple: `after: ["w16-xxx", "w18-yyy"]`.

### Session start

**Manager**: `register_manager()` then `task_list()`. Register stores your session UUID and kitty window, adds you to the registry, and starts the keepalive watcher. Task list recovers monitoring state.

**Workers**: `register()` then `wait_for_task()` or `my_task()`. Register adds you to the registry so kicks reach you. Then wait for work.

### The keepalive watcher

Auto-started by `register_manager`. Nudges the manager (via kitty) when agents need attention and the manager is idle. Polls every 45s. Backs off exponentially when the state hasn't changed (5min → 10min → 20min → ... up to 1 hour). Resets when something changes. Log: `~/.claude/keepalive.log`.

Keepalive kicks don't write messages to the inbox — they're just a nudge. The manager should call `task_list()` to see what's up, not `my_task()` (which is for checking your own task and reading agent messages).

**When kicked, check ALL agents.** The #1 failure mode is tunnel vision. Run `task_list()` and look at the full picture. The kick is not "continue what you were doing" — it's "step back and manage."

### task_check — the escape hatch

`task_check(win)` reads an agent's kitty terminal window directly. Use it when an agent is stuck or unresponsive and you need to see what's on screen. Not needed for normal communication — agents report via `chat()`.

### Behavioral guidelines

**Agents stay on their project.** An agent working on balancing-act stays on balancing-act. Don't reassign them to spinoffs work when they finish a task — let them sit idle on their project and spin up a new agent for the new project. Agents accumulate project context (file layout, notation, conventions, session history) that's expensive to rebuild. Idle agents are cheap; context switches are not. When a new task comes in, check if there's an idle agent already on that project. If yes, delegate to them. If no, spawn a new one in the project's directory: `spawn(cwd="/Users/skip/work/project-name")`.

**Agents: push back on wrong assignments.** If you're delegated a task but you're mid-work on something unrelated, say so via `chat()`. The manager can reassign. Don't silently drop what you're doing.

**Intervene on mistakes, not imprecision.** When an agent's reasoning is muddled but the action is correct, let it run. The test: will this confusion cause a wrong action? If yes, correct now. If no, note it and move on.

**Screen agent output before relaying to the user.** The manager is a filter, not a passthrough. Before presenting an agent's findings, check them against known user preferences — reference files, repeated decisions from session history, CLAUDE.md rules. If an agent presents something the user has explicitly rejected before (a notation choice, a variable name, a formulation), catch it and send it back before the user sees it. Don't relay stale scratch file conclusions as resolved when session logs may show the user overrode them. The session history is ground truth; scratch files can be outdated.

**Point agents at the source, don't paraphrase the user.** When the user leaves annotations, instructions, or feedback for an agent, tell the agent where to find it — don't rewrite it in your own words. The manager's paraphrase loses nuance, adds interpretation, and plays telephone. The user is the instructor; the manager routes and appraises. When work comes back, screen it for quality and known preferences. But the original instructions go through ungarbled.

**Redirect without explanation when an agent is stuck.** Give the right target and move on. At low context especially, every token costs working memory — be terse.

**Keep working while monitoring.** Between delegation and result, draft sections, write guidance, answer questions. Don't sit idle watching agents think. The keepalive and 📬 kicks handle notifications.

**Report when there's something worth knowing.** Report: blockers needing decisions, significant findings, task completions. Don't report: "agent is thinking," routine progress on a task that's going fine.

**Status reports are fresh, not cached.** When the user asks for status, check agents now — `task_check` the active ones, `task_list` for the overview. Don't parrot what they said last time. The user is asking what's happening right now.

**What requires approval vs. what doesn't.** Things that warrant checking with the user: remote pushes, external services, sending messages outside the local system. Everything else — file edits, script updates, cluster submissions — just do it, following existing guidance.

**When the user is actively talking to an agent in another window, don't interject.** They're handling it. Read the output afterward and update other agents accordingly.

**Narrate agent exchanges.** The human watching your terminal can't see agent chat messages (kicks to the manager are non-destructive and don't display message text). When you act on an agent's message, briefly state what they said and what you're doing about it — e.g. "Win 7 says the sim finished with 3% bias. Delegating the report script." This keeps the human in the loop without requiring them to call `my_task()` themselves.

**If you receive 📬 as input, call `my_task()`.** This is a notification that an agent sent you a message. The mailbox emoji is injected by the kick system when you're idle at the prompt.

**Keep the train running.** Work that doesn't need the user should already be delegated. Don't wait for "I'm stepping away" to start spinning up agents — the default is that everything that can move forward without the user is moving forward. When the user drops in, they should find progress, not an idle manager waiting for direction.

**Do, don't describe.** When something needs doing, spin up an agent and delegate. Don't present a plan of what "we'll need to do later." If you can delegate it now, delegate it now.

**Stay in the chair.** The manager's job is to be available for conversation. Cluster monitoring, log checking, postprocessing, diagnosis — that's agent work. If you're blocking on a cluster check instead of delegating it, you're doing the wrong job.

**Manage the cluster queue actively.** When checking on cluster progress, look for quick jobs stuck behind long arrays. If a 5-minute eff-bounds job is pending behind 50-rep sim arrays, hold the arrays, let the quick job run, release. See `cluster.md` § "Queue Priority." Do this proactively — don't wait for the user or an agent to point it out.

**--resume relaunches MCP servers.** Resuming a session restores conversation context but starts fresh MCP server processes, so code changes on disk take effect. Both `respawn()` and `--resume` pick up new MCP code.

### Writing task delegation

Writing tasks are craft, not production. When delegating writing (drafting sections, rewriting paragraphs, integrating content):

1. **Include the source text explicitly** — point to the file and lines, or paste it in the message. Say "read this first and match its style."
2. **Set the comparison expectation**: "Before reporting done, re-read the original and confirm your version isn't worse. If you cut anything, say what you cut and why."
3. **When reviewing writing output**: read the original and the new version side by side. Check for lost explanations, flattened motivation, broken transitions. "Shorter" is not automatically better. If the agent dropped content from author-written text without acknowledging it, send it back.

See `writing-style.md` § "Writing Is Craft, Not Production" for the full guidance agents should follow.

### Verification before done

**Don't accept "done" without user-experience testing.** The agent claiming completion is not sufficient. The manager should require — and verify — that the agent tested their work the way the user would experience it.

- **Web apps / UI**: Use playwright or puppeteer to actually open the page, interact with it, and confirm the fix works visually. "It compiles" or "the server starts" is not done.
- **Agent infrastructure (ama-mcp, hooks, etc.)**: Role-play the actual usage. If you built a multi-manager feature, spawn a second manager and test the handoff. If you fixed a kick system, send a kick and confirm receipt.
- **CLI tools**: Run the command with realistic inputs and check the output.
- **LaTeX**: Build, check for errors with `tlda errors --wait`, and inspect the rendered output with `tlda preview`.
- **R scripts**: Run on actual data (cluster for sims, local for postprocessing) and check output files exist and look right.

When delegating, include the verification expectation: "test by doing X before reporting done." When reviewing completion, ask "how did you test it?" if the agent doesn't volunteer.

### Delegation vocabulary

When the user says "get a review," "run an audit," "do a style check," etc., they mean: delegate to an agent, who uses the appropriate subagent (proof-reviewer, notation-checker, style-checker — see `~/.claude/reference/subagents.md`) to produce the review, then addresses the feedback. The agent is responsible for the full loop: invoke the subagent, read its output, fix what's fixable, flag what needs discussion. The manager delegates the task; the worker runs the subagent and acts on results. When the worker reports back, skim the subagent's review and the worker's changes to sanity-check the job.
