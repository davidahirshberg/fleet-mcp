# Agent Kick System — Audit & Hardening

## Failure Modes Found

### 1. Stale socket selection (FIXED)
**Old**: `ls -t /tmp/kitty-sock-* | head -1` picks the most-recently-touched socket. A stale socket from a dead kitty instance can have a newer timestamp (e.g. if something touches it), causing ALL kicks to silently fail.

**Fix**: Try all sockets, find the one that actually has the target window. `find_socket()` iterates `/tmp/kitty-sock-*`, attempts `get-text` on each, returns the first that works.

### 2. No retry (FIXED)
**Old**: Single attempt. If the kitty command times out or the socket is momentarily unavailable, the kick fails permanently.

**Fix**: Retry once after 300ms on both socket-finding and kick delivery.

### 3. No logging (FIXED)
**Old**: No record of kick attempts. Impossible to diagnose "why didn't the agent respond?"

**Fix**: Every attempt logged to `~/.claude/kick.log` with timestamp, target, result (OK/FAIL), and socket used.

### 4. `\r` in send-text vs send-key enter (FIXED)
**Old**: `send-text '📬\r'` — relies on kitty interpreting `\r` as carriage return in single-quoted bash strings. Kitty's send-text does interpret Python-style escapes, so this works in kitty 0.42.1, but behavior has changed across versions and is fragile.

**Fix**: Split into `send-text '📬'` + `send-key enter`. `send-key` is unambiguous.

### 5. No structured return (FIXED)
**Old**: `kickAgent()` returns boolean. Callers can't distinguish "window gone" from "socket stale" from "command timeout."

**Fix**: Returns `{ ok, result }` or `{ ok: false, error }`. Dashboard API endpoints now return kick status to the frontend.

### 6. Race between ESC and 📬 text (ACCEPTABLE)
100ms sleep between ESC and 📬 send. Could theoretically be too short if the terminal is very slow to process the ESC. In practice, kitty processes ESC synchronously via its remote control protocol, so 100ms is plenty. No change needed.

## Terminal Survey

### kitty remote control (CURRENT)
- **Mechanism**: Unix socket at `/tmp/kitty-sock-*`, commands via `kitty @`
- **send-key**: Sends key events (escape, enter, etc.) — reliable
- **send-text**: Sends text as if typed — reliable but escape sequence interpretation varies by version
- **get-text**: Reads terminal screen content — used for idle detection
- **Pros**: Rich API (send-key, send-text, get-text, ls, signal-child), direct window targeting by ID
- **Cons**: Socket discovery is fragile (multiple instances, stale sockets). Window IDs are kitty-specific. Must have `allow_remote_control` and `listen_on` configured.
- **Verdict**: Good enough with the socket-finding fix. The API is the richest of any terminal.

### tmux send-keys
- **Mechanism**: `tmux send-keys -t <session>:<window>.<pane> <keys>`
- **Pros**: Very reliable. Pane targeting is stable (named sessions). No socket discovery issues. Works headless (detached sessions).
- **Cons**: Requires running claude sessions inside tmux panes. No screen reading API (would need `tmux capture-pane` which is limited). Agents currently run in kitty tabs, not tmux.
- **Verdict**: Most reliable option for key delivery. Would require architectural change (kitty tabs → tmux panes inside kitty, or tmux-only). Good fallback if kitty kicks prove fundamentally broken.

### osascript (Terminal.app / iTerm2)
- **Mechanism**: `osascript -e 'tell application "Terminal" to do script "..." in window 1'`
- **Pros**: Works with any macOS terminal app
- **Cons**: Very coarse targeting (window index, not reliable ID). `do script` runs a new command, doesn't send keystrokes. For keystrokes need System Events UI scripting which requires Accessibility permissions and is fragile. No screen reading.
- **Verdict**: Not suitable for reliable agent kicks.

### iTerm2 Python API
- **Mechanism**: Python scripts via `iterm2` module, communicates over websocket
- **Pros**: Rich API similar to kitty (send text, read screen, target by session/tab/pane ID)
- **Cons**: Requires iTerm2 running with Python API enabled. websocket connection setup is heavier than kitty's unix socket. Not currently used in the fleet.
- **Verdict**: Viable alternative to kitty if switching terminals. Similar reliability profile.

### Signal-based (SIGUSR1/SIGUSR2)
- **Mechanism**: Send Unix signal to the claude process, have a handler respond
- **Pros**: Terminal-agnostic. PID-based targeting is reliable.
- **Cons**: Claude Code doesn't support custom signal handlers. Would need a wrapper process.
- **Verdict**: Not feasible without claude-side changes.

## Recommendation

**Stay with kitty** but with the hardened `agent-kick` script. The fixes address all identified failure modes:
- Socket discovery is now robust (tries all sockets)
- Retries cover transient failures
- Logging enables diagnosis
- Structured returns let the dashboard show kick status

If kitty kicks prove unreliable in practice (check `~/.claude/kick.log`), the migration path is: run claude sessions in tmux panes inside kitty windows, switch to `tmux send-keys` for kicks. This is a contained change — only `agent-kick`, `agent-idle`, and `agent-read` need updating.

## Files Changed

- `bin/agent-kick` — Rewritten: socket discovery, retry, logging, send-key for Enter
- `index.mjs` — `kickAgent()` and `interruptAgent()` return structured `{ok, result/error}`, `interrupt` tool surfaces kick result
- `dashboard/server.mjs` — `kickAgentById()` returns structured result, `/api/kick` and `/api/interrupt` endpoints return kick status
