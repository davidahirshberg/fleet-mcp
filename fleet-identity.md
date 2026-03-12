# Fleet Identity System

## The Three IDs

| ID | What it is | Lifetime | Purpose |
|---|---|---|---|
| **Fleet ID** | `fleet:<8-char-prefix>` | Permanent | Canonical identity for tasks, messages, state |
| **Session ID** | Claude JSONL UUID | One context window | `--resume`, log correlation |
| **Kitty Window ID** | Integer from `$KITTY_WINDOW_ID` | One kitty tab instance | Notification kicks (ephemeral, never for identity) |

Fleet ID is the only durable identity. Session IDs accumulate in `session_ids[]`. Kitty window IDs are ephemeral — kitty recycles them when tabs close. They are used for sending kicks and setting tab titles, never for identity matching.

## The Ledger

A sqlite table (`~/.claude/fleet-identity.sqlite`) maintains the authoritative fleet_id → session mapping:

```sql
CREATE TABLE agents (
  fleet_id TEXT PRIMARY KEY,
  session TEXT,              -- most recent Claude session UUID
  cwd TEXT,                  -- working directory
  name TEXT,                 -- display name (set by manager via name_agent or spawn)
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE sessions (
  session TEXT PRIMARY KEY,  -- Claude session UUID
  fleet_id TEXT NOT NULL REFERENCES agents(fleet_id),
  cwd TEXT,                  -- cwd at the time this session was active
  created_at TEXT
);

CREATE INDEX idx_sessions_fleet ON sessions(fleet_id);
```

Two tables: `agents` is the identity ledger, `sessions` is the lookup index. The critical query — "which agent owns this session?" — is a direct primary key lookup on `sessions`, no JSON scanning.

This is the source of truth for identity. The state file (`agent-tasks.json`) remains the live coordination layer (tasks, messages, heartbeat) but identity resolution goes through the ledger. Roster breadcrumbs (`~/.claude/fleet-roster/`) are removed — the ledger replaces them.

**Concurrent access**: Multiple MCP processes write to this database. Open with `db.pragma('busy_timeout = 5000')` so concurrent writes retry instead of failing with `SQLITE_BUSY`.

**Why sqlite over roster breadcrumbs?** Breadcrumbs are one-file-per-agent, scanned linearly, with no constraints or transactions. A sqlite table is atomic, queryable, and doesn't accumulate stale files.

## Identity Resolution: Two Tiers

When the MCP server starts or `register()` is called, identity is resolved in this order:

1. **`$FLEET_ID` env var** — if set (by `spawn()`, `respawn()`, or the launching shell), this is authoritative. Look up the ledger to get the agent's full record. If the fleet_id isn't in the ledger (pruned or first-time), create a new entry with this fleet_id.

2. **`detectClaudeSession()` → ledger lookup** — JSONL scan finds the active Claude session UUID. Look it up in the ledger (`sessions` table). If found → recover that agent's fleet_id. If not found → new agent, create a new fleet_id.

3. **`detectClaudeSession()` → new agent** — no env var, no ledger match. Fallback for genuinely new manual agents.

No kitty_win matching. No roster breadcrumb scanning. No 3-way heuristic. The ledger is the recovery mechanism — not env vars, not heuristics.

## State Transitions

```
                    ┌─────────────────┐
                    │   Manual start  │ (no $FLEET_ID)
                    │   detectSessionId()
                    └────────┬────────┘
                             │
┌─────────────┐  spawn()  ┌──▼──────────┐
│  Not exist  │ ─────────→│   Running    │
└─────────────┘ $FLEET_ID └──────┬──────┘
                                 │
                     ┌───────────┼───────────┐
                     ▼           ▼           ▼
               Compaction    MCP restart   Agent dies
                     │           │           │
                     ▼           ▼           ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Running  │ │ Running  │ │   Dead   │
              │ (in-mem  │ │ ($FLEET_ │ │          │
              │ fleet ID)│ │ ID env)  │ │          │
              └──────────┘ └──────────┘ └─────┬────┘
                                              │
                                       respawn($FLEET_ID)
                                              │
                                              ▼
                                        ┌──────────┐
                                        │ Running  │
                                        │ (resumed)│
                                        └──────────┘
```

### 0. Manual Start (user types `claude`)

**What happens**: User opens a terminal, types `claude`. No fleet involvement, no `$FLEET_ID`.

**Identity mechanism**: `detectSessionId()` scans JSONLs, finds the hot one. Looked up in the ledger — if the session_id matches an existing agent, that identity is resumed. If not, new fleet_id is created.

**Known limitation**: Two manual agents in the same cwd at the same time can grab each other's session IDs. Use `register(name=...)` for manual agents in shared cwds. The "right" way to start an agent is through fleet (`spawn()` or dashboard), which sets `$FLEET_ID` and avoids this entirely.

### 1. Spawn → Running (new agent)

**What happens**: Manager calls `spawn()`. Fleet pre-creates a fleet_id, inserts it into the ledger, and launches `FLEET_ID=fleet:<id> claude` in a kitty tab.

**Identity mechanism**: MCP reads `$FLEET_ID` at startup. On `register()`, looks up the ledger — finds the pre-created entry. Identity is known immediately, no detection needed.

### 2. Running → Compaction → Running (same MCP process)

**What happens**: Claude compacts, starts writing a new JSONL. MCP process survives with `MY_FLEET_ID` in memory.

**Identity mechanism**: `MY_FLEET_ID` is still in memory. On re-registration, `register()` runs a fresh `detectSessionId()` to find the new hot JSONL and updates the ledger's session_id. The agent never needs to know or pass its own session UUID.

### 3. Running → MCP Restart → Running (new MCP process)

**What happens**: `restart_mcp` or MCP crash. New process starts, in-memory state is lost. `process.env` changes from the old MCP are gone — Claude Code spawns the new MCP from its own env, not the old MCP's.

**Identity mechanism**: If `$FLEET_ID` was in the original shell env (set by `spawn()` or `respawn()`), Claude Code inherited it and passes it through → identity is immediate. If not (manual start), the new MCP runs `detectClaudeSession()` — the Claude session hasn't changed (no compaction), so it gets the same session UUID → ledger lookup recovers the fleet_id.

### 4. Running → Death → Respawn

**What happens**: Agent dies. Manager calls `respawn(agent)`.

**Identity mechanism**: `respawn()` looks up the fleet_id in the ledger → gets the session_id and cwd. Launches `FLEET_ID=fleet:<id> claude --resume <session_id>` in a target window. The new MCP process reads `$FLEET_ID` → identity is immediate.

### 5. Adopt (identity merge)

**What happens**: An agent registered as new but is actually a continuation of a dead agent. Manager calls `adopt(old, new)`.

**Identity mechanism**: Merges session_ids, transfers tasks/messages from old → new, preserves old fleet_id. Updates the ledger. Should be rare if transitions 1–4 work correctly.

## Implementation Changes

### A. Add identity ledger (`fleet-identity.sqlite`)

New sqlite database at `~/.claude/fleet-identity.sqlite` with the `agents` table. Accessed via `better-sqlite3` (already a dependency). All identity reads/writes go through this table.

### B. `spawn()` and `respawn()` set `$FLEET_ID`

```bash
# spawn: pre-create fleet ID, insert into ledger
FLEET_ID=fleet:a1b2c3d4 claude

# respawn: existing fleet ID from ledger
FLEET_ID=fleet:a1b2c3d4 claude --resume <session-id>
```

### C. Ledger is the recovery mechanism for MCP restarts

When an MCP process starts without `$FLEET_ID` (manual start, or MCP restart where the env var wasn't in the original shell), it runs `detectClaudeSession()` and looks up the result in the `sessions` table. If found, the fleet_id is recovered from the ledger. No heuristics needed — the ledger is authoritative.

For agents launched via `spawn()` / `respawn()`, `$FLEET_ID` is in the shell env that Claude Code inherited, so it propagates to MCP child processes even across restarts. The ledger lookup is the fallback for manual agents.

### D. `register()` does server-side session detection on re-registration

When `MY_FLEET_ID` is already set (re-registration after compaction), `register()` runs a fresh `detectSessionId()` and updates the ledger with the new session_id. The agent doesn't need to pass it.

### E. Remove kitty_win identity matching from `register()`

The 3-way matching becomes 2-way: fleet_id (from env) → session_id (from JSONL scan). Kitty_win is recorded on the agent entry in the state file for notifications only, never consulted for identity.

### F. Remove roster breadcrumbs

`~/.claude/fleet-roster/` is replaced by the ledger. `sessionFromRoster()` is removed. `clearRosterWindow()` is removed. Roster files are not read or written.

### G. `detectSessionId()` scoped to new agents

JSONL scanning runs only when there's no `$FLEET_ID` env var and no `MY_FLEET_ID` in memory. It's the bootstrap for manual/unregistered agents.

### H. Variable naming overhaul

The current names are confusing — `ME` could be anything, `MY_SESSION` vs `MY_FLEET_ID` are easy to mix up, and `id` on the agent entry is actually the fleet ID.

| Old name | New name | What it is |
|---|---|---|
| `ME` | `AGENT_ID` | This MCP process's fleet ID (the one used for messages, tasks) |
| `MY_SESSION` | `CLAUDE_SESSION` | The Claude session UUID detected at startup (may go stale after compaction) |
| `MY_FLEET_ID` | *(merged into `AGENT_ID`)* | Was a duplicate of `ME`. Now just `AGENT_ID`. |
| `agent.id` | `agent.fleet_id` | Fleet ID on agent entries (currently just `id`, which is ambiguous) |
| `agent.session_id` | `agent.session` | Most recent Claude session UUID |
| `agent.session_ids` | `agent.sessions` | Array of all Claude session UUIDs |
| `agent.kitty_win` | `agent.window` | Kitty window ID (notification-only, not identity) |
| `sessionId` (in register) | `claudeSession` | The session UUID being registered |
| `detectSessionId()` | `detectClaudeSession()` | Scans JSONLs for the active Claude session |
| `sessionFromRoster()` | *(removed)* | Replaced by ledger lookup |

The naming convention: "fleet" prefix = fleet-system identity, "claude" prefix = Claude Code's own session identity, "window" = kitty UI, no prefix = obvious from context.

## Uniqueness Invariants

The identity system must prevent two live agents from sharing an identity. These are enforced in `register()` and `name_agent()`:

| Field | Scope | Enforcement |
|---|---|---|
| **fleet_id** | Global (ledger PK) | Only one agent entry per fleet_id. If a new registration resolves to a fleet_id already held by a *different live* agent, reject with an error. |
| **name** | Live agents | No two live agents can share a display name. `register()` and `name_agent()` reject duplicates. Dead agents' names are freed for reuse. |
| **session** | Live agents | One live agent per session UUID. If `detectClaudeSession()` returns a session owned by another live agent, this is an identity collision — reject, don't silently merge. Log the collision for debugging. |

**What counts as "live"?** `last_seen` within the heartbeat threshold (10 min) OR kitty window still exists. Dead/pruned agents don't participate in uniqueness checks.

**Why reject instead of merge?** Silent merging is how the identity crisis happened — two agents claiming the same identity, messages going to whichever called `my_task()` first. An explicit rejection forces the operator to resolve the conflict (via `adopt()`, `cleanup()`, or killing the stale agent).

## Migration

On first access to the ledger, if the database doesn't exist:

1. Create the sqlite database and tables
2. Scan `~/.claude/fleet-roster/*.json` — for each breadcrumb, insert into `agents` and `sessions`
3. Also scan `state.agents[]` for any entries not covered by roster (headless agents, etc.)
4. After import, the roster directory can be ignored (leave it for now, remove in a later cleanup)

Running agents will hit the new `register()` code on their next MCP tool call. Since `MY_FLEET_ID` is in memory, they'll match by fleet_id in the ledger (just imported). No identity disruption.

## Rationale

**Why `$FLEET_ID` env var?** The entity that knows the identity (manager / register) passes it directly to the entity that needs it (MCP server). No inference, no heuristics, no races. Env vars survive process forks and are scoped to the process tree.

**Why sqlite?** Roster breadcrumbs were one-file-per-agent with no atomic updates and linear scanning. The search index already uses `better-sqlite3`. A single table with fleet_id as primary key gives us atomic updates, lookup by session_id, and no stale-file accumulation.

**Why not kitty_win for identity?** Kitty recycles window IDs. Window 7 today is not window 7 tomorrow. The "identity crisis" incident was exactly this — a new agent in a recycled window inherited a dead agent's identity.

**Why not JSONL detection for existing agents?** Multiple agents can share a cwd. The "most recent JSONL" heuristic is a coin flip in that case. For new agents it's acceptable (no prior identity to collide with). For existing agents, the env var is always correct.

**Why server-side session detection on re-register?** After compaction, the MCP process has a stale `MY_SESSION` from startup. A fresh `detectSessionId()` at register-time picks up the new hot JSONL — which is guaranteed to be the calling agent's, since it's actively writing to it right now.
