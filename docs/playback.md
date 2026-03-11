# Playback

Fleet can record multi-agent sessions and replay them as interactive timelines. Recordings capture chat messages, tool calls, task state changes, and agent activity — everything needed to watch a session unfold.

## Recording

```
playback_record(title, sources, project?)
```

- `title`: Human-readable name for the recording
- `sources`: Agent session IDs or log files to include
- `project`: Optional project filter

Recordings are stored as JSON files in `~/.claude/playbacks/`.

## Managing recordings

| Tool | Description |
|------|-------------|
| `playback_list(project?, limit?)` | List available recordings |
| `playback_get(id)` | Get recording metadata |
| `playback_edit(id, ...)` | Edit: trim, add markers, rename |
| `playback_transcript(id, ...)` | Export as formatted text |

## Viewing

The dashboard includes a playback viewer — select a recording to watch it as an interactive timeline. Events play back in real time (with speed controls), showing agent activity as it happened.

The [demo](https://davidahirshberg.github.io/fleet-mcp/) on the project landing page is itself a playback recording.
