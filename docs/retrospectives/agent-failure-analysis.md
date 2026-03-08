# Agent Failure Patterns — Analysis & Plan

## 1. `wait_for_feedback` Loop Trap

**The #1 agent failure mode.** Agents receive tasks involving tlda documents and default to calling `wait_for_feedback` in a blocking loop, even when their task is to *write*, not *review*.

**Concrete example:** Agent 8 (session `69f6aa09`, synth-randomization) was told to rewrite Dmitry's supplement. Instead, it called `wait_for_feedback("suppl-appendix", timeout=300)` **16 times over 95 minutes**, each call blocking for 5 minutes. The manager explicitly told it at 01:08 to stop — it continued calling `wait_for_feedback` after that message.

**Root cause:** The CLAUDE.md literally instructs agents to loop:

> "Call `wait_for_feedback(doc)` **in a loop**." (line 174)
> "Call `wait_for_feedback(doc)` again automatically" (line 239)
> "**The default is to stay in the loop until the user says they're done.**" (line 243)

Three feedback mechanisms exist (`wait_for_feedback`, `tlda monitor`, `tlda listen`) but agents always reach for `wait_for_feedback` because it's the MCP tool they know. When the manager says "monitor for feedback," agents interpret this as "enter the blocking review loop" rather than using `tlda monitor` (background hook-based).

After context compression, Agent 8 lost its notation-fixing task context. All it remembered was "watching suppl-appendix for feedback." The guidance says "stay in loop until user says done" — so it stayed, for 95 minutes.

There's also no timeout escalation: ipad-review.md says "take a breath" after timeouts but never says "after N timeouts, switch to `tlda monitor` and do other work."

**Fix plan:**
- **Change the guidance:** `wait_for_feedback` is ONLY for dedicated iPad review sessions where Skip is actively drawing. If your task is to write, edit, or analyze — use `tlda monitor` for background notification and do your work.
- **Add timeout escalation:** "After 2 consecutive timeouts with no feedback, switch to `tlda monitor` and resume your primary task."
- Consider renaming `wait_for_feedback` to `wait_for_ipad_annotation` to make the use case obvious.
- Add a guard: if the agent has an active task from `delegate()`, `wait_for_feedback` should warn.

---

## 2. Idle After Task Completion — No Protocol

**Second most common failure.** Agent finishes work, reports to manager via `chat()`, then sits at prompt doing nothing for 30+ minutes.

**Concrete example:** Agent 4 (session `75b337e8`) wrote a v2 draft and sent a completion chat at 01:10. Then 32 minutes of silence until kicked at 01:43.

**Root cause:** No "done, waiting for work" protocol. CLAUDE.md says to call `my_task()` when you see `📬`, but this is purely reactive. After an agent finishes work and the kick mechanism is delayed or fails, the agent becomes permanently idle.

**Fix plan:**
- After `task_done()` or sending a completion chat, agents should call `wait_for_task()` to block until new work arrives.
- Update guidance: "After completing a task, call `task_done()` then `wait_for_task()`. Do not sit idle at the prompt."
- Consider having `task_done()` return a hint: "Call `wait_for_task()` to wait for your next assignment."

---

## 3. Kicks Restart for One Action Only

Kicks work mechanically — agent sees `📬`, calls `my_task()`, acts on it. But after that one action, the agent goes idle again unless there's another kick.

**Fix plan:**
- Same as #2 — agents should enter `wait_for_task()` after completing work.
- The keepalive watcher helps but has a 5-minute baseline delay. Agents should self-manage their idle state.

---

## 4. Manager Paraphrase Confusion

The manager paraphrases Skip's annotations to agents instead of having them read the source. Agent acts on the paraphrase, produces wrong output, manager sends corrections, burning multiple kick cycles.

**Fix plan:**
- Manager guidance: "Don't paraphrase user annotations. Tell the agent to read the annotations directly via `list_annotations()` or `read_pen_annotations()`."
- This is a manager behavior issue, not a tool issue.

---

## 5. tldraw-feedback MCP Spawns for Every Agent

Every agent session spawns a `tldraw-feedback` MCP server (node process), even agents working on pure R/LaTeX projects where it's never used. With 12 agents, that's 12 idle node processes.

**Current config:**
- `~/.claude/mcp.json` defines both `agent-manager` and `tldraw-feedback` globally
- `~/.claude/settings.json` enables both via `enabledMcpjsonServers`

**Fix plan:**
- Move `tldraw-feedback` out of global `~/.claude/mcp.json`
- Add it to project-level `.mcp.json` in `~/work/claude-tldraw/` only (already exists there)
- For review sessions, the manager can instruct agents to use tlda tools — they'll be available if the agent is working in the tlda project directory

---

## 6. Voicemode Plugin (Resolved)

Was enabled as `"voicemode@mbailey": true` in settings.json. Spawned a python MCP process per agent session + whisper (1.7GB) + kokoro TTS via launchd. 11 python processes at 4-6% CPU each.

**Status:** Fixed — plugin disabled, launch agents unloaded, processes killed.

**Root cause:** Plugin was installed during exploration (2026-02-04) and left enabled. No audit mechanism flagged the resource cost.

---

## 7. Resource Summary

| Component | Per-agent cost | Total (12 agents) | Necessary? |
|-----------|---------------|-------------------|------------|
| agent-manager (node) | ~5 MB | ~60 MB | Yes |
| tldraw-feedback (node) | ~5 MB | ~60 MB | Only for tlda work |
| voicemode (python) | ~15 MB + 4-6% CPU | ~180 MB + 55% CPU | No (disabled) |
| whisper server | 1.7 GB | 1.7 GB (shared) | No (disabled) |

---

## Priority Actions

1. **Urgent — Update agent guidance** about `wait_for_feedback` vs actual work. Add explicit "do not call wait_for_feedback unless in a dedicated review session" to CLAUDE.md.

2. **High — Add post-task protocol.** After `task_done()`, agents should call `wait_for_task()`. Update `task_done()` return message to include this instruction.

3. **Medium — Move tldraw-feedback to project-level config.** Saves 12 unnecessary node processes.

4. **Low — Consider renaming `wait_for_feedback`** to `wait_for_ipad_annotation` or similar to prevent misuse.

5. **Low — Add resource monitoring.** A periodic check (in keepalive or a separate script) that counts MCP processes and alerts if the total exceeds expectations.
