# Playback: Design Document

## What It Is

A system for recording, editing, and replaying temporal sequences of events from agent workflows, whiteboard sessions, and other sources. Playback recordings are first-class objects — viewable in the dashboard, embeddable in tlda documents, shareable as interactive artifacts.

Not video. The actual events, replayable at the application layer.

## Use Cases

### 1. Demo Recordings
Select a real agent interaction, trim to the interesting parts, publish as an interactive recording. No rehearsed demos — grab authentic sessions and edit. Viewers watch inside the apps, not as a video. Fleet plays back the agent side (chat, tool calls, file edits); tlda plays back annotations and strokes. Synced — fleet owns the clock, tlda subscribes.

### 2. HCI/STS Research
Opt-in sharing of interaction logs for researchers studying human-agent collaboration. Scholars use the playback tool itself — and agent assistance — to analyze, annotate, and write about sessions. The tool is both subject and instrument. Agents can query the logs: "find all moments where the human corrected the agent's approach."

### 3. Playback Notes (Teaching)
Capture explanations — whiteboard strokes from office hours, video segments, live coding — as playback objects in a shared tlda textbook. Students get the actual exposition, not a static summary.

### 4. Agent Handoff & Shared Context
Agent builds a playback of "here's how we got here" — curated with the human. Becomes the ground truth for continuation after compression or handoff. Shared understanding as an editable object, not a static CLAUDE.md.

### 5. Tool Design Reflection
Embed real replays in design docs as evidence. "Here's the friction point" with a trimmed recording of the actual failure. Bug reports, API redesign proposals, guidance improvements — all grounded in observable behavior.

### Future: Branch by Going Hands-On
Viewer watches a replay, pauses, takes the controls — now they're in a live session forked from that point. The playback becomes the starting state for a new interaction.

---

## Existing Data Sources

Three log streams already exist and are already unified in a single FTS5 index (`~/.claude/search-index.sqlite`). Playback extracts from these.

### Session Logs (JSONL)

**Location**: `~/.claude/projects/<project-dir>/<session-uuid>.jsonl`

Each line is a JSON object:
```json
{
  "type": "user|assistant|progress",
  "uuid": "message-uuid",
  "parentUuid": "parent-uuid",
  "sessionId": "session-uuid",
  "timestamp": "ISO 8601",
  "cwd": "/path/to/project",
  "message": {
    "role": "user|assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "...", "name": "Edit", "input": {...} },
      { "type": "tool_result", "tool_use_id": "...", "content": "..." }
    ]
  }
}
```

Content array items give us the event types: `text` (user/assistant speech), `tool_use` (tool invocations with full input), `tool_result` (tool outputs). The `parentUuid` chain reconstructs conversation order.

### Agent Event Log

**Location**: `~/.claude/agent-messages.jsonl`

```json
{
  "type": "chat|delegate|task_done",
  "from": "agent-id|web",
  "to": "agent-id|agent-name",
  "message": "text content",
  "description": "short label (delegations only)",
  "timestamp": "ISO 8601"
}
```

Inter-agent communication: who delegated what to whom, chat messages, task completions.

### tlda Changelogs

**Location**: `~/work/claude-tldraw/server/projects/<project>/changelog.jsonl`

```json
{
  "ts": 1771846652222,
  "action": "create|update|delete",
  "id": "shape:2f2u6nt11mvscihji3mp",
  "shapeType": "math-note|highlight|arrow|text|pen|geo",
  "state": {
    "props": {
      "text": "annotation text",
      "color": "orange",
      "tabs": ["reply1", "reply2"],
      "richText": { "type": "doc", "content": [...] }
    },
    "meta": {
      "createdBy": "claude",
      "sourceAnchor": {
        "file": "./paper.tex",
        "line": 171,
        "content": "source line text"
      }
    }
  },
  "diff": { "props": { "from": {...}, "to": {...} } }
}
```

Shapes with text, rich text, source anchors (file:line), threaded reply tabs. Diffs for updates.

### FTS5 Index

All three sources feed into one index (`search-index.sqlite`). Each entry has: `source` (session/events/tlda), `project`, `session_id`, `role`, `timestamp`, `text`. The search API (`/api/logs/search`) already queries across all sources. The context API (`/api/logs/context`) retrieves surrounding messages. Playback extraction can build on top of this.

---

## Core Concepts

### Event Stream

The universal container. A playback is a sequence of typed, timestamped events, extracted from the sources above and normalized into a common format:

```json
{
  "id": "playback-uuid",
  "version": 1,
  "title": "Debugging the kernel length scale",
  "created": "ISO timestamp",
  "sources": [
    { "type": "session", "id": "session-uuid-1", "project": "bregman-lower-bound" },
    { "type": "events", "agents": ["agent-uuid-1", "agent-uuid-2"] },
    { "type": "tlda", "project": "balancing-act" }
  ],
  "time_range": { "start": "ISO timestamp", "end": "ISO timestamp" },
  "duration_ms": 184000,
  "edits": [
    { "op": "trim", "start_ms": 5000, "end_ms": 120000 },
    { "op": "speed", "start_ms": 30000, "end_ms": 60000, "factor": 4 },
    { "op": "annotate", "t": 15000, "text": "Bug becomes visible here" }
  ],
  "events": [
    {
      "t": 0,
      "type": "user_text",
      "source": "session",
      "data": { "text": "Why is the kernel length scale wrong?" }
    },
    {
      "t": 800,
      "type": "tool_call",
      "source": "session",
      "data": { "tool": "Read", "input": { "file_path": "/path/to/kernel.R" } }
    },
    {
      "t": 1200,
      "type": "tool_result",
      "source": "session",
      "data": { "tool": "Read", "summary": "142 lines read", "content": "..." }
    },
    {
      "t": 3400,
      "type": "assistant_text",
      "source": "session",
      "data": { "text": "Found it — ell=8 on raw covariates..." }
    },
    {
      "t": 5000,
      "type": "chat",
      "source": "events",
      "data": { "from": "agent-uuid", "to": "manager", "text": "Found the bug..." }
    },
    {
      "t": 8000,
      "type": "annotation",
      "source": "tlda",
      "data": { "shapeType": "math-note", "text": "ell should be 2*median(dist)", "color": "orange" }
    },
    {
      "t": 12000,
      "type": "marker",
      "source": "editorial",
      "data": { "text": "Section break: fix applied", "style": "section" }
    }
  ]
}
```

### Event Types

From session logs:
- `user_text` — human input
- `assistant_text` — agent's text output
- `tool_call` — tool invocation (name + input)
- `tool_result` — tool output (summarized or full)

From agent events:
- `chat` — fleet chat message
- `delegate` — task assignment
- `task_done` — task completion

From tlda:
- `annotation` — shape create/update (math-note, highlight, arrow, text, pen, geo)
- `stroke` — pen/drawing events

Editorial (added during editing):
- `marker` — section break, caption, emphasis
- `video` — video segment reference (future)

### Extractors

Each source has an extractor that reads the raw log format and emits normalized events:

- **SessionExtractor** — reads JSONL, walks `message.content[]` arrays, emits `user_text`, `assistant_text`, `tool_call`, `tool_result` events. Timestamps from the JSONL entries.
- **EventExtractor** — reads `agent-messages.jsonl`, emits `chat`, `delegate`, `task_done` events. Filters by agent IDs and time range.
- **TldaExtractor** — reads `changelog.jsonl`, emits `annotation` and `stroke` events. Timestamps from `ts` field.

All extractors take a time range and optional filters (session IDs, agent IDs, project names).

### Editing Operations

Edits are stored as a list of operations on the playback — the raw events are preserved, edits are applied at render time:

- **Trim** — select time range, hide events outside
- **Cut** — remove a time range, shift subsequent timestamps
- **Splice** — insert events from another source at a point
- **Annotate** — add editorial markers at timestamps
- **Speed** — adjust playback speed for regions (fast-forward boring parts)
- **Redact** — mark events as redacted (content hidden but structure preserved) — tabled for v2

---

## API (MCP Tools)

### `playback_record(sources, start?, end?, title?)`
Extract events from sources into a new playback.

```
playback_record(
  sources: [
    { type: "session", id: "abc123" },
    { type: "events", agents: ["def456"] },
    { type: "tlda", project: "balancing-act" }
  ],
  start: "2026-03-07T10:00:00Z",
  end: "2026-03-07T10:30:00Z",
  title: "Debugging kernel length scale"
)
-> { id: "playback-uuid", event_count: 142, duration_ms: 1800000 }
```

### `playback_edit(id, operations)`
Apply editing operations to a playback.

```
playback_edit("playback-uuid", [
  { op: "trim", start_ms: 5000, end_ms: 120000 },
  { op: "annotate", t: 15000, text: "This is where the bug becomes visible" },
  { op: "speed", start_ms: 30000, end_ms: 60000, factor: 4 }
])
```

### `playback_list(project?, agent?, tag?)`
List available playbacks, filtered by project, agent, or tag.

### `playback_get(id, format?)`
Get playback metadata and events. Format: `full` (all events), `summary` (event counts by type, duration, title), `events_only` (just the event array).

### `playback_publish(id, visibility?)`
Make a playback available for sharing. Visibility: `private`, `team`, `public`.

### `playback_merge(ids, title?)`
Merge multiple playbacks into one, interleaving by timestamp.

---

## Storage

`~/.claude/playbacks/<uuid>.json` — each playback is a single file containing the full event stream, metadata, and edit operations.

For large playbacks, events could be chunked (separate events file referenced by the metadata), but v1 keeps it simple — single file.

---

## Playback Rendering (Demo Focus)

For the demo recording use case — synced playback across fleet and tlda:

**Fleet owns the clock.** The dashboard runs the playback timer and emits the current playback time. Events are dispatched to renderers as their timestamp arrives.

**Fleet renders:**
- Chat messages appearing in the chat widget (typed out or instant)
- Tool calls as collapsible entries (tool name + summary)
- File edits as diff views
- Agent coordination events (delegations, task completions)

**tlda renders:**
- Annotations appearing on the canvas
- Strokes drawn in real-time
- Highlights growing over source text

**Sync mechanism:** Fleet broadcasts playback time via `postMessage` (same-origin windows) or SSE (cross-origin). tlda subscribes and renders tlda-sourced events when their `t` arrives.

**Controls:** Play/pause, scrub bar, speed selector (1x/2x/4x/8x), step forward/back (jump to next event).

---

## Team Structure (Playback Dev Team)

This is a large, ongoing project. Roles:

### Team Lead (playback)
Owns the design doc, coordinates work, reviews integration. Currently: this agent.

### Extractor Developer
Builds the three extractors (Session, Event, Tlda). Needs deep knowledge of the log formats. Writes the `playback_record` tool. Test: extract a real session, verify event count and ordering.

### Dashboard Renderer
Builds the fleet-side playback UI — timeline scrubber, event rendering, sync broadcast. Works in `dashboard/index.html` and `dashboard/server.mjs`. Test: load a playback, scrub through it, verify events render correctly.

### tlda Integration
Builds the tlda-side playback subscriber — listens for sync messages, renders annotations/strokes at the right time. Works in `claude-tldraw/`. Test: fleet plays back, tlda canvas updates in sync.

### Editor / API
Builds the edit operations (trim, cut, splice, speed, annotate) and the remaining MCP tools (`playback_edit`, `playback_list`, `playback_get`). Test: extract a session, trim it, verify the trimmed playback.

Agents can hold multiple roles. The extractor is the critical path — everything else depends on having real playback data to render.

---

## v1 Scope

1. **Extractors** — SessionExtractor and EventExtractor. tlda extractor is a stretch goal.
2. **MCP tools** — `playback_record`, `playback_list`, `playback_get`
3. **Storage** — `~/.claude/playbacks/`
4. **Dashboard renderer** — basic timeline + event list, play/pause/scrub
5. **Edit operations** — trim and annotate only

## What's NOT in v1

- tlda sync playback (needs tlda-side work)
- Branch-by-going-hands-on (needs checkpoint/fork infrastructure)
- CV-based whiteboard stroke extraction
- Context snapshots
- Multi-user collaborative editing
- Video transcription / alignment
- Redaction workflow (needs scholar input)
- Publishing / sharing infrastructure

## Open Questions

1. **Event granularity**: Full tool results or summarized? A `Read` of 500 lines — include the content? Probably: store full, render summarized with expand-on-click.

2. **Playback format versioning**: `"version": 1` field in the playback file. Extractors can re-extract from raw logs if the format changes.

3. **tlda sync protocol**: `postMessage` for same-browser (iPad Split View), SSE for cross-device. Need to confirm postMessage works across Safari windows in Split View.

4. **Context snapshots** (tabled): The curated playback IS a form of context snapshot. Full conversation state at a point in time is a separate, heavier thing.

5. **Integration with tlda**: Playback notes as tldraw objects — could be a custom shape type that embeds a playback player. Or a link that opens the fleet playback view.
