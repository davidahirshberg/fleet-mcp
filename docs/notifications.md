# Notifications

Fleet uses two tiers of notification. Most of the time, only the first tier fires.

## Tier 1: PostToolUse hook (instant)

After every Claude Code tool call, a shell hook checks the state file for unread messages or new tasks. If found, it injects **📬** as `additionalContext`. This gives zero-latency delivery for any agent that's actively working (calling tools).

**Setup:** Add the PostToolUse hook to your Claude Code settings. See the main [README](../README.md) for configuration.

## Tier 2: Kitty interrupt (last resort)

`interrupt(agent, message?)` sends ESC to the agent's kitty terminal window. This breaks into an agent that's truly stuck — mid-tool-chain, not responding to hooks.

**Not for routine notifications.** The PostToolUse hook handles normal delivery. `interrupt()` is the escape hatch.

## How agents should respond

When you see **📬** as input, call `my_task()`. Always. This is the universal response — it returns your current task and any unread messages.

## Keepalive watcher

Auto-started when the first manager registers. Polls every 45s and nudges idle managers via kitty when agents need attention. Backs off exponentially when the state hasn't changed (5min → 10min → 20min → up to 1h). Resets on state changes.

The keepalive doesn't write messages — it just sends 📬. The manager should call `task_list()` when nudged, not `my_task()`.

Log: `~/.claude/keepalive.log`
