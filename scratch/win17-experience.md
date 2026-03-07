# Win 17 Agent Experience Analysis ("docs" agent)

**Session**: `68920273-ffa6-420a-ba8c-a524721cb662`
**Project**: `-Users-skip-work-balancing`
**Session stats**: 2342 JSONL lines, 32 non-trivial user turns, 331 assistant turns, 19 agent-manager calls, 7 user interruptions

## 1. Task Reception

**Registration**: Smooth. `register()` at L50, got "Registered 17. 7 agent(s) registered." Then user sent `📬`, agent called `my_task()`, got first task immediately. No friction.

**Task delivery is title-only — detail gets lost.** This is the biggest issue in the session. Three tasks were delegated:

- **"Set up GitHub Pages docs site for balancing package"** — title was sufficient; agent figured out what to do.
- **"Fix spinoff3.tex anisotropic kernel description"** — wrong-project task. Agent correctly pushed back via `chat()`.
- **"Rename estimand constructors in balancing package"** — **the agent only received the title**. At L654 the agent said: *"Got the task but there's no detail on what to rename them to."* The manager replied: *"It's all in the task message — re-read it. The renames are listed explicitly."* But `my_task()` returned only the title string and status. The specifics (tsm_estimand -> treatment_specific_mean, etc.) had to be relayed via a follow-up `chat()` message. **This cost a full round-trip of wasted time.**

**Implication**: `delegate()` likely accepts a body/description, but `my_task()` only returns the title line. The task body needs to be included in the `my_task()` response.

## 2. Does wait_for_task() / my_task() Work Smoothly?

**`my_task()` works but is entirely poll-based.** The agent never called `wait_for_task()` — every task pickup was triggered by user typing `📬`, then agent calling `my_task()`. This is functional but requires the user/manager to manually kick the agent.

**Repeated `my_task()` calls returning stale or empty state.** At L1228 and L1239, back-to-back `my_task()` calls both returned "Nothing new" but included queued `📬 Messages` from the manager. The messages were the real payload; the "Nothing new" header was misleading. The agent had to parse embedded chat messages from within the `my_task()` response to get its actual instructions.

**Rejected tool call at L2025**: User was mid-sentence ("it looks like shit is a little more barebones even in the API ref") and the `📬` emoji was embedded in their text. The agent called `my_task()` mid-conversation, and the user rejected it. The `📬` trigger is fragile — it can fire spuriously when the user types it as part of a sentence rather than as a standalone signal.

## 3. Communication Back (chat())

**`chat()` works well.** The agent used it effectively for:
- Pushing back on wrong-project task (spinoff3.tex) — L261
- Offering to take on the task with more context — L272
- Asking for missing task details (rename specifics) — L654
- Progress updates on docs site — L1332, L1871, L1988

**Response from manager comes bundled into next `my_task()` call**, not as a separate notification. This means the agent has to call `my_task()` again to see chat replies. There's no push mechanism for chat responses.

## 4. Wasted Cycles and Friction

**Task detail round-trip (rename task)**: ~15 lines of overhead. Agent asks for details, waits for `📬`, calls `my_task()`, gets the reply. Should have been zero-cost if the task body came through initially.

**Wrong-project assignment (spinoff3.tex)**: The manager assigned a LaTeX paper task to a docs/R-package agent. The agent handled it gracefully via `chat()` pushback, but it still consumed cycles. This suggests the manager doesn't track agent specialization or project context.

**MCP restart confusion (L294-299)**: User restarted the MCP server, then said "wait, shit, I meant the manager." The agent lost registration state. Minor, but shows that MCP restart = agent identity loss.

**`📬` in mid-sentence (L2023)**: User typed a message containing `📬` as part of flowing text. The agent interpreted it as a task signal and called `my_task()`, which the user rejected. The trigger needs to be standalone-only.

**"still waiting" (L997)**: User had to prod the agent about a CI build. Not an agent-manager issue per se, but shows the agent was blocked on an external process (GitHub Actions) with no good async mechanism.

**No `name_agent()` call**: The agent never named itself, so the manager and other agents only knew it as "17." In a multi-agent session with 7+ agents, this makes coordination harder.

## 5. Suggested Refinements

1. **Include task body in `my_task()` response.** The title-only return is the single biggest source of friction. If `delegate()` accepts a description, `my_task()` must return it.

2. **Separate chat messages from task status.** Currently `my_task()` returns both task state AND queued chat messages in one blob. Split these: `my_task()` for task state, `my_messages()` or similar for chat. Or at minimum, structure the response so "Nothing new" + important messages don't contradict each other.

3. **Make `📬` trigger more robust.** Either require it as the sole content of a message (ignore when embedded in text), or use a different mechanism entirely (e.g., a system-level notification that doesn't depend on the user's typing).

4. **Prompt agents to call `name_agent()` at registration.** The register response could say "Call name_agent() to identify yourself." Or auto-name based on project context.

5. **Track agent project context in the manager.** Would have prevented the spinoff3.tex mis-assignment. If the manager knows win 17 is in `balancing/`, it shouldn't send it LaTeX paper tasks from a different project.

6. **Push-based chat replies.** When the manager or another agent replies via `chat()`, the target agent should get a notification (like `📬`) rather than having to poll via `my_task()`.

## Summary

The core loop works: register -> get task -> do work -> chat for coordination -> task_done. The main pain points are (a) task body not coming through in `my_task()`, (b) `📬` trigger fragility, and (c) chat replies being bundled into `my_task()` polls rather than pushed. The agent handled wrong-project assignment and missing details gracefully via `chat()`, which is a sign the communication channel works even if the task metadata delivery doesn't.
