# Terminal Rendering Plan

Research for better terminal widget rendering in the fleet dashboard.

## Current State

- `fetchTerminal()` calls `/api/peek?agent=X` → server runs `bin/agent-read WIN` → `kitty @ get-text` → returns raw Unicode text
- Dashboard renders with `body.textContent = data.text` — no parsing, no formatting, no folding
- **No ANSI escape sequences** — `kitty @ get-text` returns Unicode, not raw terminal bytes. The output is plain text with Unicode symbols (no `\033[...` codes to handle)

## Patterns Found in Agent Terminal Output

### 1. Tool Call Blocks
The primary structural unit. Format:
```
⏺ ToolName(args...)
  ⎿  result line 1
     result line 2
     … +N lines (ctrl+o to expand)
```

Tool names seen: `Read`, `Edit`, `Update`, `Bash`, `Searched`, `Agent`, `Glob`, `Grep`, `Write`
MCP calls: `⏺ fleet - tool_name (MCP)(args...)`
tldraw calls: `⏺ tldraw-feedback - tool_name (MCP)(doc: ..., line: ...)`

### 2. Collapsed Sections
```
… +N lines (ctrl+o to expand)
```
These are already-collapsed in the terminal output. The full content isn't available — it's collapsed by Claude Code itself.

### 3. Agent Thinking / Status Lines
```
✻ Sautéed for 51s
✻ Conversation compacted (ctrl+o for history)
✻ Churned for 37s
✶ Hyperspacing… (2m 5s · ↓ 1.8k tokens)
✢ Infusing… (32s · ↓ 226 tokens · thought for 1s)
```
Various Unicode spinners (✻ ✶ ✢) with timing info. These are status/waiting indicators.

### 4. Edit Diffs
```
⏺ Update(dashboard/index-v2.html)
  ⎿  Added 31 lines
      103    }
      104    .chat-ts { color: var(--text-dim); ...
      105    .chat-nick { font-weight: 500; ...
      106 +  .nick-web { color: #9370db; }
```
Line numbers + `+`/`-` markers for additions/removals. Sometimes multiline with `+` at start of continuation.

### 5. Prompt Line
```
❯
❯ 📬
```
The `❯` character marks the input prompt. Sometimes followed by user input (like `📬`).

### 6. Status Bar (bottom of screen)
```
────────────────────────── ▪▪▪ ─
❯
──────────────────────────────────
  esc to interrupt                                   Context left until auto-compact: 10%
```
Horizontal rules (`─`) with `▪▪▪` dots. The context percentage line appears below the prompt. The `▪▪▪` is decorative, not a percentage indicator.

### 7. Agent Messages (narrative text)
Plain text paragraphs between tool calls — the agent's reasoning and commentary.

### 8. Subagent Blocks
```
⏺ Agent(Review revised section 5.3)
  ⎿ Read(main.tex)
    Search(pattern: "...", path: "main.tex")
    +9 more tool uses (ctrl+o to expand)
     ctrl+b to run in background
```
Nested tool calls within a subagent invocation.

### 9. Banner
```
 ▐▛███▜▌   Claude Code v2.1.71
▝▜█████▛▘  Opus 4.6 · Claude Max
  ▘▘ ▝▝    ~/work/fleet
```
Appears at top of session. Block characters forming a logo.

## Proposed Rendering

### Parsing Strategy

Line-by-line parser with state tracking. No regex-over-entire-output — process lines sequentially.

**State machine:**
1. **Scan for `⏺` at line start** → start a tool block
2. **Scan for `  ⎿` (indented hook)** → tool result, child of current tool block
3. **Scan for `❯`** → prompt marker (section boundary)
4. **Scan for `✻`/`✶`/`✢`** → thinking/status line
5. **Scan for `─` repeated** → status bar (hide or render as thin divider)
6. **Scan for `…`** → collapsed section marker
7. **Everything else** → narrative text

Each `⏺` block runs until the next `⏺`, `❯`, or `✻`/`✶`/`✢` at the same indent level.

### Section Types & Rendering

| Pattern | Rendering | Default State |
|---------|-----------|---------------|
| `⏺ Read/Searched/Glob` (info tools) | Dim, collapsed one-liner | Collapsed |
| `⏺ Update/Edit` (mutations) | Diff view with syntax coloring | Expanded |
| `⏺ Bash(...)` | Code block for command, result below | Expanded |
| `⏺ fleet - tool (MCP)` | Compact badge: "fleet→tool" | Collapsed |
| `⏺ Agent(...)` | Bordered subagent block | Collapsed |
| `✻`/`✶`/`✢` thinking lines | Dim italic, right-aligned time | Inline (dim) |
| `❯` prompt | Horizontal divider | Visible |
| `─` status bar | Thin divider or hide | Hidden |
| Narrative text | Normal text, monospace | Visible |
| Banner (▐▛) | Hide or very dim | Hidden |
| `Context left...` | Extract % for agent metadata | Hidden from terminal |

### Folding

- **Default fold**: Read, Searched, Glob, MCP calls — show one-line summary, click to expand
- **Default expand**: Edit/Update (show diff), Bash (show command + output), narrative text
- **Fold all / Expand all**: Toggle button in terminal header
- **Memory**: Don't persist fold state across refreshes (terminal content changes every 5s)

### Syntax Highlighting

- **Diffs**: Green for `+` lines, red for `-` lines, dim for context
- **Bash commands**: Monospace, slightly different background
- **File paths**: Detect `/path/to/file.ext` patterns, render as clickable (could open in editor via API)
- **Tool names**: Bold or colored badge
- **Line numbers in diffs**: Dim, fixed-width

Don't bring in a full syntax highlighter library. Use CSS classes:
```css
.term-tool-name { color: var(--blue); font-weight: 500; }
.term-tool-result { color: var(--text-dim); }
.term-diff-add { color: var(--green); }
.term-diff-del { color: #c87a7a; }
.term-diff-linenum { color: var(--text-dim); font-size: 11px; }
.term-thinking { color: var(--text-dim); font-style: italic; }
.term-narrative { color: var(--text); }
.term-collapsed { cursor: pointer; }
.term-collapsed:hover { background: rgba(255,255,255,0.03); }
```

### ANSI Color Support

**Not needed.** `kitty @ get-text` strips ANSI and returns Unicode. The output is already plain text. No need for an ANSI-to-HTML converter.

## Draggable Elements

### What's Draggable

| Element | Drag Data | Drop Target |
|---------|-----------|-------------|
| File path (in tool call or result) | `{ type: "file", path: "/full/path" }` | Chat input → inserts path |
| Code block (diff or bash output) | `{ type: "code", content: "...", source: "agent-name" }` | Chat input → wraps in ``` |
| Tool result block | `{ type: "snippet", content: "...", tool: "Bash", agent: "..." }` | Chat input → formatted quote |
| Entire tool call | `{ type: "tool-call", name: "Edit", args: "...", result: "..." }` | Chat → reference card |

### Implementation

1. **Identifying draggable regions**: The parser already segments output into tool blocks. Wrap each in a `<div draggable="true" data-drag-type="..." data-drag-content="...">`.
2. **File paths**: Regex detect paths like `/Users/...` or relative paths with extensions. Wrap in `<span class="term-filepath" draggable="true">`.
3. **Drag format**: Use `text/plain` with JSON markers (matching the existing cross-window drag pattern in the codebase — see `e47ad17`).
4. **Drop in chat**: Chat input already handles drops or could be extended. On drop, insert the content formatted appropriately (code in backticks, paths as-is).

### Composing in Chat

When a dragged element drops into chat input:
- **File path**: Insert as `/path/to/file.ext`
- **Code block**: Insert wrapped in triple backticks
- **Tool result**: Insert as blockquote with attribution: `> [agent-name's Bash result]\n> content`
- **Multiple drops**: Append with newline separator

## Implementation Approach

### Phase 1: Structured Parsing (core)
- Write a `parseTerminalOutput(text)` function that returns an array of section objects: `{ type, content, collapsed, tool?, args?, children? }`
- Replace `body.textContent = data.text` with `body.innerHTML = renderSections(sections)`
- Add fold/unfold click handlers
- CSS classes for each section type

### Phase 2: Diff Rendering
- Detect `+`/`-` line prefixes within Edit/Update blocks
- Apply green/red coloring
- Dim line numbers

### Phase 3: Draggable Elements
- Add `draggable="true"` to appropriate elements
- Wire up dragstart handlers with appropriate data
- Add drop handlers to chat input
- Visual feedback on drag (ghost preview)

### Phase 4: Context % Extraction
- Parse `Context left until auto-compact: N%` from terminal output
- Surface in the agents panel (per-agent context gauge)
- Hide the raw line from terminal view

### File Changes

- `dashboard/index.html`: Add CSS classes, update `createTerminalWidget` and `fetchTerminal`
- New function `parseTerminalOutput(text)` — could live inline or in a small `terminal-parser.mjs`
- `dashboard/server.mjs`: No changes needed (raw text is fine; parsing happens client-side)

### Size Estimate

- Parser: ~100-150 lines
- Renderer: ~80-100 lines
- CSS: ~40 lines
- Drag handlers: ~50 lines
- Total: ~300 lines of new code, mostly in index.html

## Risks & Open Questions

1. **Terminal output format isn't stable.** Claude Code updates could change the Unicode markers or layout. Parser should be lenient — fall back to raw text for unrecognized lines.

2. **Performance with large terminal buffers.** `kitty @ get-text --extent all` can return thousands of lines. The parser runs on every 5s refresh. Options:
   - Only parse the last ~200 lines (most recent activity)
   - Cache parsed result and only re-parse if text changed (content hash)
   - Use `--extent screen` instead of `--extent all` for the default view, with a "show full history" toggle

3. **Collapsed sections (`… +N lines`) are opaque.** The terminal already collapsed them — we can't expand them. Should render as-is with a visual indicator that this is a Claude Code fold, not our fold.

4. **Multi-line tool args.** Some MCP calls have args spanning multiple lines (e.g., long `message` args in `delegate`). Parser needs to handle continuation lines (indented under `⏺`).

5. **Subagent nesting.** `⏺ Agent(...)` blocks contain nested tool calls at deeper indent. Parser needs indent-level tracking, not just line-by-line.

6. **Context % scraping.** The `Context left until auto-compact: N%` line only shows on screen, not in scrollback. Need `--extent screen` in addition to `--extent all` to reliably get it. Could add a separate lightweight poll for just the screen content.
