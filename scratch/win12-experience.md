# Win 12 Worker Agent Experience Analysis

Session: `c566393e-949b-4b8e-9267-959c2cce164c`
Duration: ~10.5 hours (06:53 - 17:16 UTC, Mar 6 2026)
Context compactions: 3 (at 07:40, 10:54, 11:23)
Tasks assigned: 7 distinct task IDs across the session

---

## 1. How the agent receives tasks

**Initial task delivery works well.** The agent starts with `my_task()` (before even registering -- minor ordering issue) and gets its first task immediately:

```
06:53:41 my_task() -> "Monitor cluster jobs, postprocess results, diagnose KBW_cts" (pending, 7m ago)
```

The full task description comes through in the `my_task()` response, along with status and age. Subsequent task reassignments also arrive cleanly via `my_task()`.

**The agent never uses `wait_for_task()`.** All task retrieval is via `my_task()`, triggered by kicks. This is the correct pattern for a worker -- it polls on demand rather than blocking.

**Task transitions are smooth.** The agent cycled through 7 tasks over the session:
- `mmej6th4`: Monitor cluster + diagnose KBW_cts
- `mmekh21q`: Design unified integrator abstraction
- `mmel79zm`: Fix product-integrator, audit, rerun
- `mmen48it`: Full 20-cell resubmission
- `mmepxs70`: Audit survival paper sim data
- `mmeqby5q`: Test balancing package after naming refactor
- `mmesbx3l`: Monitor cluster and postprocess results

Each new task arrived via a kick + `my_task()` call.

---

## 2. Kick (mailbox emoji) response

**The agent handles kicks correctly and quickly.** On receiving a mailbox emoji, it calls `my_task()` within 2-4 seconds, reads the message, and acts on it. No wasted cycles interpreting the emoji.

**Manager messages embedded in `my_task()` responses are effective.** The `Messages:` section in `my_task()` output delivers manager instructions inline with task status. The agent reads and acts on these immediately. Examples:

```
07:00:21 my_task() -> task + message: "You stalled after the parallel SSH errors. Keep going..."
07:03:43 my_task() -> task + message: "Good diagnosis. Implement option 1..."
07:05:02 my_task() -> task + message: "HOLD on the fix..."
```

**Rapid-fire kicks work.** At 07:03-07:07 there are 4 kicks in 4 minutes (manager course-correcting the design). The agent handles each, calls `my_task()`, reads the new guidance, and adjusts. No confusion or lost messages.

**Multi-emoji kicks** (`mailbox x4` at 07:26, `mailbox x2` at 11:19, 17:05) are treated the same as single kicks -- the agent just calls `my_task()` once. This is correct behavior.

---

## 3. The blocked-task problem

**Yes, the unblock failure happened.** At 10:12, the agent receives a task blocked by `w16-mmeps2un`:

```
10:12:11 my_task() -> "Test balancing package after naming refactor"
         Status: pending | 6m ago
         Blocked by: w16-mmeps2un (Naming audit for balancing package exports -- done)
```

The agent correctly says "Task is blocked. Waiting for the dependency to complete." But then:

**38 minutes of dead time.** The agent sits idle from 10:12 to 10:50. No productive work, no checking on other tasks, no reading ahead. When kicked again at 10:50:

```
10:50:38 my_task() -> same task, still shows "Blocked by: w16-mmeps2un (... -- done)"
         BUT now includes message: "Your task is unblocked -- win 16 finished..."
```

**The blocker shows status "done" in both the 10:12 and 10:50 responses.** The task was never actually transitioned from blocked to unblocked in the system. The manager had to manually tell the agent "your task is unblocked" via a chat message. The task still shows `Blocked by` in the `my_task()` output even after the dependency completed.

**This is the core bug:** the agent-manager system doesn't automatically transition blocked tasks to pending when dependencies complete. The manager has to notice, send a message, and kick the agent manually.

**The agent also sees "Blocked by" through all subsequent calls** (10:54, 10:57, 10:59, 11:01) even while actively working on the task. The status line is stale/incorrect.

---

## 4. Agent-to-manager communication via chat()

**`chat()` works smoothly and is used extensively.** The agent sends ~25 chat messages over the session, all substantive:

- Bug diagnoses ("Found the KBW_cts failure. Root cause: `mp$train_grid` is always discrete...")
- Progress updates with structured data (cell completion counts, timing estimates)
- Design docs ("Design doc at scratch/integrator-design.md, open in Marked 2")
- Status reports during network outage (3 messages over 75+ minutes)
- Results summaries ("Preliminary results written to `scratch/prelim-results.md`")

**The manager responds quickly** -- often within seconds -- with follow-up instructions delivered as messages attached to the next `my_task()` call.

**No chat() failures observed.** Every chat call succeeds.

**Pattern:** The agent sends a report via `chat()`, then immediately calls `my_task()` to check for the manager's response. This request-response loop is tight and effective.

---

## 5. Wasted cycles

### TaskOutput polling loop (the big waste)

The agent's cluster-monitoring strategy burns enormous context. Starting around 11:30, it enters a pattern:

1. Launch `sleep N && ssh qtm '...'` as background bash
2. Call `TaskOutput(task_id, block=True, timeout=600000)` to wait
3. When TaskOutput times out (10 min), re-call it
4. When the bash task completes, launch a new one with a longer sleep

**Between 11:30 and 17:00, the agent calls TaskOutput ~45 times**, mostly just re-blocking after 10-minute timeouts. During the SSH network outage (14:25-17:00), this produces a cascade of ~30 TaskOutput timeout-and-retry cycles with zero useful information.

The agent also launches parallel sleep-then-SSH background tasks as a "pipeline" -- scheduling the next check before the current one returns. This is clever but creates orphaned tasks when the network goes down.

### Idle during blocked task

38 minutes of dead time (10:12-10:50) waiting for an unblock that never came automatically.

### my_task() with no new information

Several `my_task()` calls return the same task/messages the agent already has, especially after rapid kicks:
- 10:54:25 returns same blocked task info as 10:50
- 11:02:19 and 11:02:21 are nearly duplicate calls 2 seconds apart

### Tool loading after compaction

After each context compaction, the agent must re-discover tools via `ToolSearch`. This adds 2-5 seconds of overhead but is unavoidable given the current architecture. The agent handles this correctly, loading the tools it needs before calling them.

---

## 6. Context compaction handling

**Three compactions occurred** during this 10.5-hour session:

1. **07:40** -- mid-design-doc work. The agent gets a summary mentioning the KBW_cts diagnosis and design task. It loads tools, calls `my_task()`, and picks up where it left off. **Smooth.**

2. **10:54** -- mid-test-fixing. The agent was editing `test-solver.R` when context ran out. After compaction, it gets kicked immediately, calls `my_task()`, reads the test file, and continues fixing. **Smooth but the partially-applied edits survived** (they were written before compaction).

3. **11:23** -- mid-rsync. The agent was waiting for a background rsync when context ran out. After compaction, it calls `my_task()`, gets the monitor task, and re-orients. It has to re-read the postprocessing scripts and re-check cluster status. **Lost some context about what was already downloaded** but recovers.

**The compaction summaries are good.** They include task IDs, what was done, what's pending. The agent uses them effectively to resume.

**No hallucinated state after compaction.** The agent re-reads files and re-checks cluster status rather than assuming. This is correct behavior.

---

## Suggested Refinements

### Critical: Fix blocked-task auto-unblock

The `Blocked by` status persisted even after the dependency was marked "done." The system should:
1. Automatically transition blocked tasks to pending when all dependencies complete
2. Auto-kick the blocked agent when this happens
3. Remove the `Blocked by` line from `my_task()` output once the dependency is done

Currently the manager has to manually notice, message, and kick -- defeating the purpose of the dependency system.

### Important: Agent should work while blocked

When a task is blocked, the agent should:
- Ask the manager for interim work ("My task is blocked by w16. Anything I can do while waiting?")
- Or read ahead on the blocked task (e.g., read the files it will need to test)
- Not just sit idle for 38 minutes

This could be a CLAUDE.md instruction: "If your task is blocked, tell the manager and ask for interim work."

### Important: Better long-polling strategy

The TaskOutput retry loop (45+ calls over 5.5 hours) wastes context tokens. Options:
- Longer TaskOutput timeouts (currently 600s max; the SSH sleeps are 1800s)
- A dedicated "monitor" mode that doesn't consume context per poll
- Let the manager kick the agent when results are ready, rather than having the agent self-poll

### Minor: De-duplicate rapid my_task() calls

When kicked multiple times in quick succession (mailbox x4), the agent sometimes calls `my_task()` only once (correct) but sometimes calls it twice within 2 seconds. The second call is always redundant.

### Minor: Register before my_task()

The agent called `my_task()` before `register()` at session start (06:53:39 vs 06:53:51). It worked because the agent was already registered from a prior session, but the ordering should be register-first as a matter of hygiene.
