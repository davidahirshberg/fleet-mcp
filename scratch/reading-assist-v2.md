# Reading-Assist v2 — Highlight Semantics & Understanding Maps

<!-- session: fleet:868edc45 files: scratch/reading-agent-design.md, scratch/reading-assist-spec.md -->

## The Problem

Highlighting "explain this" conflates two distinct intents:

1. **"Needs proof/citation"** — I understand this, but it's not rigorous enough. Needs a real proof, or a proper citation done in checker-friendly style (full result stated as a lemma in our notation, translation guide, referenced at point of use).

2. **"I don't get this"** — Genuinely need explanation. Agent triages: explain in a math-note vs. rewrite the doc section. Agent should calibrate to what the reader already knows (provenance: who wrote it, whether reader has reviewed it before, whether they proposed the idea).

## Color Protocol v2

Severity-ordered (red = most severe, standard intuition):

| Color | Severity | Intent | Agent action |
|---|---|---|---|
| **Red** | 🔴 Critical | "This is wrong" | Fix the error. Annotate what was wrong and what changed. |
| **Orange** | 🟠 Needs work | "Needs proof/citation" | Provide proof or checker-friendly citation. Reader understands it but it's not rigorous enough. |
| **Yellow** | 🟡 Explain | "I don't get this" | Triage: explain in a math-note vs. rewrite. Calibrate to reader's knowledge via understanding map + provenance. |
| **Blue** | 🔵 Polish | "Notation/presentation" | Fix notation or presentation issue. |
| **Green** | 🟢 Approve | "Good, keep this" | Mark as approved. Structural suggestions welcome. |
| **Violet** | — | Personal notes | Ignore. |

Red and yellow are now distinct: red = "wrong", orange = "I get it but it needs rigor", yellow = "explain this to me." If a highlight is inconsistent with the understanding map (e.g., yellow on a section the reader already approved), the agent should ask: "did you mean orange (needs citation) rather than yellow (explain)?"

## Understanding Maps

Per-user, **line-level** status tracking. Graphically, it's just a highlight in the left margin — nothing heavier. Three states:

| Status | Meaning | Margin indicator |
|---|---|---|
| **Approved** | Reader understands and is satisfied | Green thin line |
| **Understood, not satisfied** | Reader gets it but presentation needs work | Yellow thin line |
| **Unchecked** | New or unreviewed content | No line (or gray) |

### Multi-user collaboration

This generalizes to collaborative annotation. When Dmitry and Skip both work on a doc:

- **Each user has their own understanding map** — stored per-user in doc metadata
- **Margin visualization**: stacked thin lines in the left margin, one per collaborator. Dmitry's map might extend further (more sections approved) than Skip's.
- **Read-only across users**: you can see Dmitry's map but can't edit it. Only he can change his own status.
- **Highlight-to-change**: highlight over a margin status line (your own) to cycle the state.
- **Agent context**: when responding to a highlight, the agent checks the reader's understanding map. If the section is "approved" by the reader, a yellow highlight means "needs rigor" (meaning 1). If "unchecked", it means "explain" (meaning 2).

### Visual design

```
Left margin (per section):
  ┃ ┃  ← two thin vertical lines (Dmitry green, Skip yellow)
  ┃    ← Dmitry approved this section, Skip hasn't reviewed it yet
       ← neither has reviewed this
```

Granularity is line-by-line — just highlights, graphically. Highlight over your own margin line to change status. Others' lines are visible but not interactive.

### Agent response calibration

When responding to highlights, agents should consider:

1. **Text provenance** — who wrote this section? If the reader wrote it, don't explain their own ideas back to them.
2. **Reference provenance** — are we citing the reader's own paper? They don't need the result explained.
3. **Understanding map** — what's the reader's current status on this section?
4. **Response options for "explain" highlights**:
   - Satisfied — leave it for now
   - Need more detail in the explanation
   - Need the explanation woven into the doc (hard to understand how it fits together)
   - "I have no idea what you're talking about" — start from scratch

These options could be surfaced as follow-up highlight colors or as interactive choices in the math-note response.

## Implementation Notes

- **Storage**: tlda doc metadata, keyed by user identity. Syncs with the doc naturally.
- **Initial state**: pre-populate from provenance. If Skip wrote lines 1-50 (git blame, overleaf history), mark those as "understood" for Skip. Same for other authors. Agent does this on first read as a prep step.
- **Margin bar shapes**: ReadingAssistBarShape already exists — extend to render per-user status lines at line granularity.
- **Fleet identity**: provides user IDs for multi-user maps.
- **`place_response_bar`**: already created by reading-ui — extend with status tracking.
- **Explain response flow**: interactive buttons in math-note responses:
  - "Satisfied — leave it"
  - "Need more detail"
  - "Weave into the doc"
  - "No idea what you're talking about"

  Buttons trigger follow-up agent action (deeper explanation, doc rewrite, etc.).
