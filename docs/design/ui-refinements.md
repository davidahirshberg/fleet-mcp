<!-- session: c88bafbf-47e8-4055-b31b-b7d1d80f1474 files: dashboard/index.html, dashboard/server.mjs, index.mjs -->

# UI Refinements — Backlog

Ops priorities that remain after the agent panel health indicators (done).

## Ready to Build

1. **Dim messages from stale agents in chat** — If the sending agent's `last_seen` is >10min, dim their chat messages (lower opacity or muted color). Signals "this agent may not be responsive."

2. **Message delivery confirmation / read receipts** — When you send a chat from the dashboard, you get `{ok: true}` but no proof the agent saw it. Add read receipts: agent marks messages read on `my_task()`, dashboard shows a subtle checkmark or "read" indicator.

3. **MCP health check indicator** — Agents can silently lose their MCP connection. Show last successful MCP tool call timestamp per agent. Could be a small icon or tooltip on the agent entry.

4. **Stale banner in terminal/task_check view** — When viewing an agent's terminal output (Terminal tab or task_check), show a warning banner if the agent hasn't heartbeated recently. "Agent last seen 45m ago — may be unresponsive."

## Auto-Prune Dead Agents

Periodic sweep to remove agents whose kitty windows are gone. The `agentAlive()` function in `index.mjs:244` already checks window liveness via kitty. Could run on a timer in the server, or on each `task_list()` / `saveState()` call.

## Future / Nice-to-Have

- Notification badges on agent panel tabs (delegated to badges agent)
- Sound/visual notification on new messages when dashboard tab is background
- Agent grouping by label in the panel
- Collapsible agent details (task history, message log)
- Agent panel search/filter
