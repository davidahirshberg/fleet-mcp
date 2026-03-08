# Manager Experience Analysis: Keepalive Kicks and Agent Messages

Session `44739cf1` — manager agent coordinating cluster sims across wins 12, 16, 17.

## The Numbers

| Metric | Count |
|--------|-------|
| Total kicks received | 45 |
| `my_task()` calls | 42 |
| Keepalive-only results (no real info) | 32 |
| Results with actual agent messages | 10 |
| Longest consecutive keepalive-only run | **15 kicks** |
| SSH attempts triggered by keepalive noise | 27 |
| **Useful kick ratio** | **22%** |

## Observation 1: The manager dutifully calls `my_task()` every single time

Every kick produces the same sequence: receive `📬`, call `my_task()`, get back "Nothing new. [from keepalive] 1 pending task(s)." The manager never learns to ignore these. It can't — the protocol says `📬` means "you have a new task or message," so it has to check. There is no way to distinguish "agent sent you something" from "keepalive timer fired" before calling `my_task()`.

## Observation 2: The manager invents busywork after noise kicks

When `my_task()` returns nothing useful, the manager doesn't just sit idle — it tries to justify the interruption by doing *something*. The most common response: SSH into the cluster to check job status. This happened 27 times across the session. During a 3+ hour network outage (events 0–37 in the kick sequence), the manager received ~15 consecutive keepalive kicks. Each time:

1. Call `my_task()` → "Nothing new. [from keepalive] 1 pending task(s)"
2. SSH into cluster → "Operation timed out"
3. Emit a brief status message ("Still waiting", "Network still down")

This is pure waste. The manager already knew SSH was down. The keepalive kick forced it to re-check something it had no reason to re-check. Each cycle burns ~500-1000 tokens on the my_task() call, the SSH attempt, and the status narration.

## Observation 3: The "1 pending task(s)" message is content-free

Every single keepalive result says "1 pending task(s)" (or "2 pending task(s)"). The manager already knows it has pending tasks — it delegated them. This message never changes the manager's behavior. It contains zero bits of information.

Worse, it sometimes arrives *doubled*: "[from keepalive] 1 pending task(s)\n\n[from keepalive] 1 pending task(s)" — two keepalive messages accumulated between checks, both saying the same thing.

## Observation 4: Useful kicks are genuinely useful

When an actual agent message arrives, the manager handles it well:

- **Win 12 reports SSH down** (event 9): Manager acknowledges, waits.
- **Win 12 reports results** (event 78): Manager reads the report, gives feedback, sends follow-up instructions.
- **Win 12 reports low context** (event 80): Manager respawns the agent and re-delegates. Smart proactive move.
- **Win 16 asks questions** (events 82, 84): Manager answers (though frustrated that 16 didn't read the task message).
- **Win 17 reports docs done** (event 74): Manager acknowledges and marks task complete.

The signal-to-noise problem is clear: 10 useful interactions buried under 32 noise kicks.

## Observation 5: Kicks during active work are disruptive

After the context window continuation (event 73, `📬📬`), the manager had to re-register, re-read task state, and re-orient. The keepalive kicks during the SSH outage period (events 0-37) were particularly wasteful because the manager was in a "waiting for network" state with nothing actionable.

There's also evidence of mid-flow disruption: the manager was composing instructions for win 16 when a keepalive arrived, forcing it to context-switch to `my_task()` before returning to the delegation.

## Observation 6: The delegate message delivery bug

A notable UX failure: the manager used `delegate()` with a long `message` field containing full instructions for win 16. But win 16 only saw the short `description` ("Plots + written summary from prelim sim results") and asked "where are the results?" The manager had to re-send everything via `chat()`, doubling the token cost. This isn't a keepalive problem, but it made the manager waste two more kick cycles on back-and-forth that shouldn't have existed.

## Observation 7: Token cost estimate

Conservative estimate per noise kick cycle:
- `my_task()` call + response: ~300 tokens
- SSH attempt + timeout + narration: ~400 tokens
- Total per noise cycle: ~700 tokens

32 noise kicks x 700 tokens = **~22,000 tokens wasted** on keepalive noise in this session. That's before counting the context window pressure from accumulating 32 rounds of "Nothing new" in the conversation history.

## Specific Refinements

**1. Differentiate kick types.** Instead of `📬` for everything, use `📬` for agent messages and a distinct signal (or nothing) for keepalives. If the manager knows it's just a keepalive, it can skip `my_task()` entirely.

**2. Suppress keepalive kicks when the manager has no actionable work.** If all pending tasks are in "WORKING" state and no agent has sent a message, don't kick the manager. The keepalive's job is to prevent the manager from going idle — but the manager is *already* idle-by-design when waiting for agents.

**3. Make `my_task()` return "no change" as a distinct signal.** If the response is identical to the last `my_task()` call, return a terse "No change since last check" without repeating the pending task count. Let the manager skip its busywork routine.

**4. Backoff on keepalive frequency.** If the manager has received N consecutive keepalive-only kicks with no agent messages, increase the interval. Exponential backoff (5min, 10min, 20min) would have reduced the 15-kick outage run to 3-4 kicks.

**5. Fix delegate message delivery.** The `message` field in `delegate()` should be surfaced when the agent calls `my_task()`. If it's being truncated or dropped, that's a bug worth fixing — it caused a 2-cycle back-and-forth in this session.

**6. Give the manager a "sleeping until agent message" mode.** Let the manager explicitly say "don't kick me until an agent sends a real message." This would eliminate all noise kicks during long wait periods (like the 3-hour SSH outage).
