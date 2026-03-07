# Win 16 Agent Experience Analysis

Session `f519b6f8-3374-4660-b305-2489bd20d9b9`, project `what-panels-arent`.
16 unique tasks across one long session, 4487 JSONL lines.

---

## 1. Task Receipt: The Delegate Message Bug

**The core problem is confirmed and systematic.** Every single task arrives the same way:

1. Agent gets `📬`, calls `my_task()`
2. `my_task()` returns **only the short description**: `"Your task [w16-mmXXXXXX]: Rename estimand constructors in balancing package\nStatus: pending | 0m ago"`
3. The full delegate message — with file paths, specific instructions, renames listed explicitly — is **not included**.
4. Agent asks manager for details.
5. Manager scolds: "It's in the task message. Read it again."
6. Agent calls `my_task()` again. This time the instructions appear as a `📬 Messages` block — but only because the manager's scolding reply was delivered as a chat message.

**The delegate body is never delivered on first call.** The agent sees the short description but not the detailed instructions the manager wrote when calling `delegate()`. Those instructions only arrive later, re-sent manually by the manager as chat messages after the agent asks.

This happened on **every task**. The pattern:
- 16 tasks assigned
- 14 times the agent asked for details it should have already had
- 8 times the manager responded with variations of "re-read the task message" / "everything is there"

The manager genuinely believes the full message was delivered. The agent genuinely cannot see it. Both are right from their own perspective — the delegate call probably stores the message, but `my_task()` only returns the short description field.

## 2. What my_task() Actually Returns

First call after delegation (no messages yet):
```
Your task [w16-mmepe8bd]: Rename estimand constructors in balancing package
Status: pending | 0m ago
```

Second call (after manager sends a chat message):
```
Your task [w16-mmepe8bd]: Rename estimand constructors in balancing package
Status: pending | 0m ago

📬 Messages:

[from 2] It's in the task message. Read it again — the renames are listed explicitly.
```

The `📬 Messages` section only appears when there are chat messages. The original delegate body is never surfaced through `my_task()`.

## 3. task_done() Behavior

`task_done()` works cleanly and gives useful feedback:

```
Marked 16 task done: Naming audit for balancing package exports.
Unblocked: [w12-mmeqby5q] 12: Test balancing package after naming refactor 2 task(s) remaining.
```

Key observations:
- The agent **does** learn about unblocked dependent tasks (win 12 was waiting on the naming refactor)
- The response confirms what was marked done
- Shows remaining task count
- No confirmation from the manager is needed — it's a clean state transition

However, the agent has **no agency over task_done timing**. For some tasks, the manager marked it done externally ("Nice work, all three look good. Task marked done."), and `my_task()` returned "No active task for win 16." The agent didn't call `task_done()` itself in those cases.

Of the 16 tasks, the agent called `task_done()` itself on 7. The other 9 were either marked done by the manager, superseded by new tasks, or the session shows the agent finishing work and reporting via `chat()` without formally closing.

## 4. Communication Flow (chat)

`chat()` works well as a back-channel. The agent uses it for:
- Asking clarifying questions (most common)
- Reporting completion: "Report done, open in Marked 2"
- Presenting diagnostic findings before asking what to do
- Asking judgment calls: "Should I export rmst_tsm?"

The flow is:
1. Agent calls `chat({message: "..."})`
2. Returns: `"Message queued for 2 (kicked)."` — the "(kicked)" means the manager was nudged
3. Agent waits (says "Waiting for details from the manager")
4. Eventually gets `📬` input, calls `my_task()` to read the response

**Friction point:** The agent can't distinguish "manager hasn't replied yet" from "manager replied but I haven't been kicked." It just waits passively. There's no polling or timeout mechanism.

**Another friction point:** Chat messages accumulate in `my_task()` output, creating an ever-growing thread. By the naming refactor task (which had ~8 back-and-forth exchanges), the agent was getting very long `my_task()` responses with the full chat history.

## 5. Registration

Smooth. First action in the session:
1. Loads tools: `select:mcp__agent-manager__my_task,mcp__agent-manager__register`
2. Calls `register()` — returns `"Registered 16. 5 agent(s) registered."`
3. Immediately calls `my_task()` — already has a task waiting

One interesting detail: after a context compression mid-session, the agent re-registered (same window ID 16) with no issues. The server handled the re-registration gracefully.

## 6. Wasted Cycles and UX Friction

### The delegate message bug dominates
Every task starts with 1-3 wasted round-trips:
1. `my_task()` → sees only short description
2. `chat()` → "what do I do?"
3. Wait for 📬
4. `my_task()` → manager says "re-read the task message"
5. Sometimes another `chat()` → "I still don't see details"
6. Wait for 📬
7. `my_task()` → manager re-sends the full instructions as a chat message

This is 2-6 minutes of wall-clock time per task, 16 tasks = potentially 30-90 minutes wasted across the session.

### Tool loading overhead
The agent has to `ToolSearch(select:...)` for every tool before first use. This is 1-2 calls per tool, and the agent needs Read, Write, Edit, Bash, Glob, Grep, plus agent-manager tools. Each task often requires re-loading tools after context compression. Not a huge cost per call, but adds up.

### Wrong working directory
The agent's cwd is `what-panels-arent` but many tasks involve files in `~/work/spinoffs/` or `~/work/balancing/`. The agent frequently has to search multiple directories with Glob before finding the right files. The delegate message (when it eventually arrives) usually has paths, but the first-call miss means the agent guesses wrong.

### Edit tool type error
One instance of `Edit` failing because `replace_all` was passed as string `"false"` instead of boolean `false`. The agent had to re-load the Edit tool and retry. Minor but real.

### Redundant my_task() calls
The agent sometimes calls `my_task()` twice in quick succession (lines 19 and 26) hoping for more detail. The second call returns identical content. This is a rational response to the delegate message bug — maybe the message will appear on retry? — but it never does.

## 7. Suggested Refinements

### Critical: Fix the delegate message bug
`my_task()` must return the full delegate body on first call, not just the short description. The delegate message is the spec. Without it, every task starts with the agent flying blind and the manager re-explaining.

**Concrete fix:** When `delegate()` is called with a message body, store it. When `my_task()` is called, include it:
```
Your task [w16-mmepe8bd]: Rename estimand constructors in balancing package
Status: pending | 0m ago

📋 Task details:

[from 2] Rename these constructors in ~/work/balancing/R/estimands.R:
- tsm → treatment_specific_mean
- ...
```

### Important: Let task_done() accept a summary
Currently `task_done()` takes no arguments. The agent's work product (what it did, what files it changed) gets reported via `chat()` as a side-channel. If `task_done({summary: "..."})` stored a completion message, the manager and dependent tasks could read it without trawling chat history.

### Nice-to-have: chat() should show delivery status
Currently returns "Message queued for 2 (kicked)." It would help to know: did the manager read it? Is there a reply? A `check_messages()` or `has_reply()` would reduce passive waiting.

### Nice-to-have: Include cwd hint in delegation
The short description could include the working directory or primary file path so the agent doesn't have to search four directories before finding `prelim-results.md`.

### Minor: Accumulating chat history in my_task()
After 8+ exchanges, `my_task()` returns a wall of text. Consider showing only the latest 2-3 messages, with a `chat_history()` call for the rest.
