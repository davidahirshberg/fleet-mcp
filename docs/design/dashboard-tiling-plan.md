# Dashboard Tiling WM — Plan

## Vision

The dashboard becomes a tiling window manager. Fixed layout disappears. Every pane is a widget instance with parameters. Users split, resize, and rearrange freely. Layout persists across reloads.

---

## Widget Types

| Widget | Params | Notes |
|--------|--------|-------|
| **chat** | `filter: agentId[]` | Chat log + input, filtered to specific agents. Unfiltered = all. |
| **terminal** | `agent: agentId` | Live task_check output for one agent. |
| **search** | `query?, type?, role?` | Unified search with filters. |
| **agents** | none | Agent list with status, sparklines, labels. |
| **tasks** | `status?: pending\|done` | Task list. Could split active vs completed. |
| **cluster** | none | Cluster job progress bars. |
| **tlda** | `project: string` | iframe embed of a tlda project. |
| **timeline** | none | Event timeline. |

Each widget is a self-contained render function that takes a container DOM element and params. Widgets subscribe to SSE updates independently.

---

## Layout Model

Binary split tree. Each node is either:
- A **leaf**: `{ type: 'leaf', widget: 'chat', params: { filter: [...] }, id: 'pane-1' }`
- A **split**: `{ type: 'split', direction: 'horizontal' | 'vertical', ratio: 0.5, children: [node, node] }`

```
         split(h, 0.6)
        /              \
  split(v, 0.5)       leaf(agents)
  /          \
leaf(chat)  leaf(terminal)
```

This is the same model tmux/i3/vim use. Simple, composable, serializable.

### Default Layout

```
split(h, 0.65)
├── split(v, 0.55)
│   ├── chat (unfiltered)
│   └── split(h, 0.5)
│       ├── search
│       └── terminal (no agent selected)
└── split(v, 0.5)
    ├── agents
    └── tasks
```

Roughly matches the current layout but every pane is resizable and replaceable.

---

## Commands

Vim-style commands via the existing `/` command palette:

| Command | Action |
|---------|--------|
| `/sp [widget] [params]` | Split current pane horizontally, new pane below |
| `/vsp [widget] [params]` | Split current pane vertically, new pane right |
| `/close` | Close current pane (parent absorbs sibling) |
| `/only` | Close all panes except current |
| `/set widget [params]` | Change current pane's widget type |
| `/layout save [name]` | Save current layout to localStorage |
| `/layout load [name]` | Load a named layout |
| `/layout reset` | Reset to default |

"Current pane" = last-clicked pane (highlighted border).

### Shortcuts

- `Cmd+Shift+S` — horizontal split
- `Cmd+Shift+V` — vertical split
- `Cmd+W` — close pane
- `Cmd+1..9` — focus pane by index
- Arrow keys (with modifier) — move focus between panes

---

## Implementation

### Phase 1: Layout Engine

The core. Everything else builds on this.

1. **LayoutTree class**: Binary tree with split/leaf nodes. Methods:
   - `splitPane(paneId, direction, widget, params)` — split a leaf into a split node
   - `closePane(paneId)` — remove leaf, parent becomes its sibling
   - `resize(nodeId, ratio)` — change split ratio
   - `serialize() / deserialize()` — JSON for localStorage
   - `render(container)` — recursive DOM creation

2. **Pane container**: Each leaf gets a `<div class="pane">` with:
   - A thin header bar: widget type label + close button
   - A content area where the widget renders
   - Focus ring on click

3. **Drag handles**: Between split children, a 4px drag handle for resizing. Same as current resizable panels but generalized.

4. **Migration**: Current hardcoded layout functions (`renderChat`, `renderAgents`, `renderTerminal`, `renderSearch`) become widget render functions that take `(container, params, state)`. The existing code mostly works — just needs to target a passed-in container instead of `$('chatLog')` etc.

### Phase 2: Widget Refactor

Extract each panel into a widget factory:

```javascript
const WIDGETS = {
  chat: { create(container, params) { ... }, update(state) { ... }, destroy() { ... } },
  terminal: { create(container, params) { ... }, update(state) { ... }, destroy() { ... } },
  search: { create(container, params) { ... }, update(state) { ... }, destroy() { ... } },
  // ...
}
```

Each widget:
- `create(container, params)`: Initial DOM setup, event listeners
- `update(state)`: Called on SSE state update
- `destroy()`: Cleanup (intervals, listeners)

The tricky part: the current code uses global IDs (`$('chatLog')`, `$('agentList')`). Each widget instance needs scoped selectors. Options:
- Give each instance a unique prefix: `container.querySelector('.chat-log')` instead of `$('chatLog')`
- Or keep one global state object and have widgets read from it

**Recommendation**: Scoped selectors. Widgets create their own DOM with class-based selectors. This naturally supports multiple instances.

### Phase 3: Commands + Persistence

1. Hook `/sp`, `/vsp`, `/close` etc. into the existing command palette
2. Serialize layout to localStorage on every change
3. Deserialize on page load (fall back to default layout)
4. Add keyboard shortcuts

### Phase 4: Terminal-Follows-Chat

When you click an agent name in chat or the agent list, the nearest terminal widget auto-switches to that agent. If no terminal widget exists, offer to split one.

---

## Risks and Mitigations

**Risk: massive refactor breaks everything**
- Mitigation: Phase 1 can wrap the existing layout. Start by making the current fixed layout expressible as a LayoutTree, then add splitting. Existing render functions keep working.

**Risk: multiple widget instances fight over global state**
- Mitigation: Scoped selectors from the start. No `$('id')` in widget code.

**Risk: SSE update performance with many widgets**
- Mitigation: Each widget's `update()` is lightweight — just DOM diffing. SSE already fires on every state change; adding more consumers is fine.

**Risk: mobile / iPad layout**
- Mitigation: On small screens, collapse to single-pane with tab switcher. Detect via media query.

---

## Execution Order

1. **Layout engine** (Phase 1) — the foundation. ~1 session.
2. **Widget refactor** (Phase 2) — extract chat, terminal, agents, search. ~1 session per widget, parallelizable.
3. **Commands + persistence** (Phase 3) — quick once Phase 1 is done.
4. **Terminal-follows-chat** (Phase 4) — quick feature on top.
5. **Top-of-chain removal** — can happen any time, independent.
6. **Chat-polish agent's work** — independent, just renders into the chat widget.
7. **Cluster-port agent's work** — adds a new widget type, independent.

Phases 1-2 are the big lift. 3-4 are incremental. 5-7 are already in flight.
