# Dashboard v2 Plan

## Vision

Fleet dashboard becomes the primary workspace — content and communication live together. Scratch files, search results, annotations, and chat are objects in one environment, not separate tools connected by `open` commands and terminal copy-paste.

The terminal becomes a fallback for debugging, not the primary interface. Agents are managed, delegated to, and monitored from the dashboard. tlda provides the annotation layer — documents that need visual review or markup. Fleet and tlda talk to each other via drag-and-drop and shared data formats.

---

## 1. Unified Search Panel

**Replaces**: logs tab, docs tab, refs tab

One search interface with type filters instead of separate tabs. Everything searchable lives here.

- **Type filter**: conversations (JSONL sessions), events (chat/delegate/task_done), annotations (tlda changelogs), pinned refs, file edits
- **Role filter**: user, assistant, chat, delegate (already built)
- **Agent filter**: dropdown of registered agents (already built)
- **Project filter**: by working directory (already built)
- **Pinned refs**: surfaced at top, or "show pinned only" toggle
- **Click to drill in**: context modal shows surrounding conversation (already works)
- **Index file edits**: tool_use entries (Edit, Write) have file paths and content — index these so "what changed in panel-a-balance.R" works

**Depends on**: nothing (can start immediately)
**Orthogonal to**: everything else

---

## 2. Reliable Kitty Kicks

Debug and harden the notification path. Agents must absolutely get notified.

- **Terminal-agnostic**: if kitty kicks won't work reliably, switch. tmux, Terminal.app, iTerm2 are all on the table. The goal is "agent gets interrupted," not "kitty specifically."
- Audit `agent-kick` script — what failure modes exist?
- Survey interrupt mechanisms across terminals: kitty remote control, tmux send-keys, osascript for Terminal.app, iTerm2 Python API
- Test: multiple agents, various states (idle, mid-tool, in wait_for_task)
- Add kick confirmation/retry — if the kick fails, retry once, log the failure
- Consider: should the dashboard show kick status? "Kicked agent X — delivered/failed"
- Investigate: are there race conditions between fs.watch and kicks?

**Depends on**: nothing
**Orthogonal to**: everything else

---

## 3. Dashboard Terminal: Folding & Filtering

The in-dashboard terminal view (task_check output) is raw terminal dump. Make it readable.

- **Fold tool chains**: collapse Read/Edit/Grep sequences into one-line summaries ("Read 3 files, edited index.mjs")
- **Fold kicks/keepalive**: hide 📬 and keepalive noise
- **Show meaningful output**: tool results, agent decisions, chat messages
- **Verbatim toggle**: switch to raw output for debugging
- **Auto-scroll with freeze**: already have freeze button, but folded view should be the default

**Depends on**: nothing
**Orthogonal to**: everything else (but pairs well with #2 for testing)

---

## 4. Resizable Panels

Draggable separators for the dashboard layout.

- Vertical separator between main content (left) and agent panel (right)
- Horizontal separator between chat (top) and tabs (bottom) on the left
- Persist sizes in localStorage
- Sensible defaults and min sizes

**Depends on**: nothing
**Orthogonal to**: everything else

---

## 5. Gmail-Style Labels

Replace the team filter with a flexible labeling system.

- **Auto-labels**: project (from agent's cwd), manager (who delegated to them)
- **Manual labels**: assign via agent list context menu or rename-style UI
- **Filter by label**: click a label to filter chat + agent list to that group
- **Multiple labels per agent**: an agent can be in "balancing-act" and "figures"
- **Label colors**: auto-assigned or manual
- **Stored in**: agent registry (state file), persists across re-registrations

**Depends on**: nothing
**Orthogonal to**: everything else

---

## 6. Drag Search Results into Chat

Drag a search result (conversation excerpt, file reference, annotation) from the search panel into the chat input to attach it as context.

- **Drag source**: search results, ref items, timeline events
- **Drop target**: chat input area
- **Data format**: JSON payload with type, content/snippet, source location
- **Rendering**: inline preview in chat input showing what will be sent
- **Delivery**: attached to the chat message as structured context the agent can parse

**Depends on**: #1 (unified search panel) for the drag sources
**Not orthogonal**: needs #1 first

---

## 7. Scratch File Thumbnails in Chat

When an agent writes or mentions a scratch file, show a thumbnail/preview in the chat.

- Detect file paths in chat messages (scratch/*.md, *.svg, *.png)
- Render markdown previews inline (first few lines + math if present)
- SVG/PNG: actual image thumbnail
- Click to open in tlda (for annotation) or expand in-dashboard
- Replaces the `open -a "Marked 2"` workflow

**Depends on**: nothing for basic version; tlda integration for click-to-annotate
**Partially orthogonal**: basic thumbnails are independent; tlda click-through needs #8

---

## 8. tlda ↔ Fleet Drag Integration

Cross-window drag between tlda and fleet, both open in Safari (including iPad Split View).

- **tlda → fleet**: draw a selection box on the tlda canvas, drag it off the window. Captures everything inside (annotations, source text, line numbers) as a payload. Box snaps back to original position on release — acts like copy, not move. Drop into fleet chat or search.
- **fleet → tlda**: drag a search result or file reference from fleet into tlda to create an annotation or open the file for review.
- **Data format**: shared JSON schema both apps understand (annotation content, file path, line range, snippet)
- **Implementation**: HTML5 Drag and Drop API with dataTransfer — works cross-window in Safari, including iPad Split View

**Depends on**: #6 (drag into chat) for the fleet side; tlda needs drag handlers added
**Not orthogonal**: needs #6 and tlda changes

---

## Execution Plan

**Wave 1 — independent, can parallelize on worktrees:**
- #1 Unified search panel
- #2 Reliable kitty kicks
- #3 Terminal folding/filtering
- #4 Resizable panels
- #5 Gmail-style labels

**Wave 2 — depends on wave 1:**
- #6 Drag into chat (needs #1)
- #7 Scratch file thumbnails (independent but richer with #1)

**Wave 3 — cross-app:**
- #8 tlda ↔ fleet integration (needs #6 + tlda work)
