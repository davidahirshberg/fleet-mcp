/**
 * Playback storage — save/load/list playbacks as JSON files.
 * Storage: ~/.claude/playbacks/<uuid>.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const PLAYBACKS_DIR = path.join(os.homedir(), '.claude', 'playbacks');

function ensureDir() {
  if (!fs.existsSync(PLAYBACKS_DIR)) {
    fs.mkdirSync(PLAYBACKS_DIR, { recursive: true });
  }
}

/**
 * Create a new playback from extracted events.
 * @param {object} opts
 * @param {string} opts.title
 * @param {object[]} opts.sources - Source descriptors [{type, id?, project?, agents?}]
 * @param {object[]} opts.events - Normalized events from extractors
 * @param {string} opts.start - ISO timestamp
 * @param {string} opts.end - ISO timestamp
 * @returns {object} Saved playback metadata
 */
export function createPlayback({ title, sources, events, start, end, agents, tags }) {
  ensureDir();

  // Sort events by timestamp
  events.sort((a, b) => a.ts - b.ts);

  // Compute relative timestamps (t) from the earliest event
  const baseTs = events.length > 0 ? events[0].ts : 0;
  const normalized = events.map(e => ({
    t: e.ts - baseTs,
    type: e.type,
    source: e.source,
    sourceId: e.sourceId,
    data: e.data,
  }));

  const id = crypto.randomUUID();
  const durationMs = events.length > 0 ? events[events.length - 1].ts - events[0].ts : 0;

  const playback = {
    id,
    version: 1,
    title: title || 'Untitled playback',
    created: new Date().toISOString(),
    sources,
    time_range: {
      start: start || (events.length > 0 ? new Date(events[0].ts).toISOString() : null),
      end: end || (events.length > 0 ? new Date(events[events.length - 1].ts).toISOString() : null),
    },
    duration_ms: durationMs,
    edits: [],
    tags: tags || [],
    agents: agents || [],
    events: normalized,
  };

  const filePath = path.join(PLAYBACKS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(playback, null, 2));

  return {
    id,
    title: playback.title,
    event_count: normalized.length,
    duration_ms: durationMs,
    sources: sources.length,
  };
}

/**
 * Get a playback by ID.
 * @param {string} id
 * @param {string} format - "full", "summary", "events_only"
 */
export function getPlayback(id, format = 'full') {
  const filePath = path.join(PLAYBACKS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  const playback = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (format === 'summary') {
    // Event counts by type
    const counts = {};
    for (const e of playback.events) {
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    return {
      id: playback.id,
      title: playback.title,
      created: playback.created,
      sources: playback.sources,
      time_range: playback.time_range,
      duration_ms: playback.duration_ms,
      event_count: playback.events.length,
      event_types: counts,
      edits: playback.edits.length,
    };
  }

  if (format === 'events_only') {
    return { id: playback.id, events: playback.events };
  }

  return playback;
}

/**
 * List all playbacks, optionally filtered.
 */
export function listPlaybacks({ project, agent, tag, limit = 50 } = {}) {
  ensureDir();

  const files = fs.readdirSync(PLAYBACKS_DIR).filter(f => f.endsWith('.json'));
  const playbacks = [];

  for (const file of files) {
    try {
      const fp = path.join(PLAYBACKS_DIR, file);
      const raw = fs.readFileSync(fp, 'utf8');
      const pb = JSON.parse(raw);

      // Filter by project
      if (project && !pb.sources.some(s => s.project === project || s.id === project)) continue;
      // Filter by agent
      if (agent && !pb.sources.some(s => s.agents?.includes(agent) || s.id === agent)) continue;
      // Filter by tag
      if (tag && !(pb.tags || []).includes(tag)) continue;

      // Event counts by type
      const counts = {};
      for (const e of pb.events) {
        counts[e.type] = (counts[e.type] || 0) + 1;
      }

      const timewarps = (pb.edits || [])
        .filter(e => e.op === 'timewarp' && e.timewarp)
        .map(e => e.timewarp.name);

      playbacks.push({
        id: pb.id,
        title: pb.title,
        created: pb.created,
        duration_ms: pb.duration_ms,
        event_count: pb.events.length,
        event_types: counts,
        sources: pb.sources,
        tags: pb.tags || [],
        timewarps,
      });
    } catch { continue; }
  }

  // Sort by created date, newest first
  playbacks.sort((a, b) => new Date(b.created) - new Date(a.created));
  return playbacks.slice(0, limit);
}

/**
 * Apply edit operations to a playback.
 * @param {string} id
 * @param {object[]} operations - [{op: "trim"|"annotate"|"speed", ...}]
 */
export function editPlayback(id, operations) {
  const filePath = path.join(PLAYBACKS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  const playback = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  for (const op of operations) {
    playback.edits.push(op);

    if (op.op === 'annotate') {
      // Insert a marker event at the specified time
      playback.events.push({
        t: op.t,
        type: 'marker',
        source: 'editorial',
        data: { text: op.text, style: op.style || 'note' },
      });
      playback.events.sort((a, b) => a.t - b.t);
    }
    if (op.op === 'layout') {
      // Insert a layout event — player applies it via innerDv.fromJSON
      playback.events.push({
        t: op.t,
        type: 'layout',
        source: 'editorial',
        data: op.layout,
      });
      playback.events.sort((a, b) => a.t - b.t);
    }
    if (op.op === 'focus') {
      // Insert a focus event — player frosts non-focus panels and shows narration
      playback.events.push({
        t: op.t,
        type: 'focus',
        source: 'editorial',
        data: { panel: op.panel, narration: op.narration },
      });
      playback.events.sort((a, b) => a.t - b.t);
    }
    // trim and speed are render-time operations — stored in edits, applied by the player
  }

  fs.writeFileSync(filePath, JSON.stringify(playback, null, 2));

  return {
    id: playback.id,
    edit_count: playback.edits.length,
    event_count: playback.events.length,
  };
}

/**
 * Create a trimmed copy of a playback (excerpt).
 * @param {string} id - Source playback ID
 * @param {object} opts
 * @param {number} opts.startT - Start time (ms from playback start)
 * @param {number} opts.endT - End time (ms from playback start)
 * @param {string} opts.title - Title for the excerpt
 * @param {string[]} opts.tags - Tags for the excerpt
 */
/**
 * Generate a human-readable transcript of a playback.
 * Shows chat messages, annotations, focus/layout changes, and content density.
 * @param {string} id
 * @param {object} opts
 * @param {number} opts.startT - Start time in ms (default: 0)
 * @param {number} opts.endT - End time in ms (default: duration)
 * @param {string[]} opts.types - Event types to include (default: all)
 * @param {boolean} opts.density - Include content density analysis per time window
 * @param {number} opts.windowMs - Window size for density analysis (default: 60000 = 1 min)
 */
export function playbackTranscript(id, { startT = 0, endT, types, density = false, windowMs = 60000 } = {}) {
  const playback = getPlayback(id);
  if (!playback) return null;

  const end = endT ?? playback.duration_ms;
  const includeTypes = types ? new Set(types) : null;

  const lines = [];
  lines.push(`# Transcript: ${playback.title}`);
  lines.push(`# Duration: ${(playback.duration_ms / 60000).toFixed(1)} min | Events: ${playback.events.length}`);
  lines.push('');

  // Format time as h:mm:ss
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // Collect events in range
  const events = playback.events.filter(e => {
    if (e.t < startT || e.t > end) return false;
    if (includeTypes && !includeTypes.has(e.type)) return false;
    return true;
  });

  // Transcript lines
  for (const ev of events) {
    const time = fmtTime(ev.t);
    switch (ev.type) {
      case 'chat': {
        const from = ev.data?.from || ev.sourceId || '?';
        const to = ev.data?.to || '';
        const text = (ev.data?.text || '').slice(0, 200);
        const fromLabel = from.includes('web') ? 'Skip' : from.slice(0, 12);
        const toLabel = to.includes('web') ? '→Skip' : to ? `→${to.slice(0, 12)}` : '';
        lines.push(`[${time}] 💬 ${fromLabel}${toLabel}: ${text}`);
        break;
      }
      case 'marker':
        lines.push(`[${time}] 📌 ${ev.data?.text || ''}`);
        break;
      case 'focus': {
        const panel = ev.data?.panel || 'none';
        const narr = ev.data?.narration ? ` — "${ev.data.narration.slice(0, 100)}"` : '';
        lines.push(`[${time}] 🎯 FOCUS: ${panel}${narr}`);
        break;
      }
      case 'layout':
        lines.push(`[${time}] 📐 LAYOUT: ${JSON.stringify(ev.data)?.slice(0, 150)}`);
        break;
      case 'delegate': {
        const desc = ev.data?.description || ev.data?.message?.slice(0, 100) || '';
        lines.push(`[${time}] 📋 DELEGATE: ${desc}`);
        break;
      }
      case 'task_done':
        lines.push(`[${time}] ✅ TASK_DONE: ${ev.data?.agent || ev.sourceId || ''}`);
        break;
      case 'user_text':
        lines.push(`[${time}] 👤 USER: ${(ev.data?.text || String(ev.data || '')).slice(0, 200)}`);
        break;
      case 'assistant_text':
        lines.push(`[${time}] 🤖 AGENT: ${(ev.data?.text || String(ev.data || '')).slice(0, 200)}`);
        break;
      case 'tool_call':
        lines.push(`[${time}] 🔧 TOOL: ${ev.data?.name || ev.data?.tool || '?'}(${JSON.stringify(ev.data?.args || ev.data?.input || {}).slice(0, 100)})`);
        break;
      case 'tool_result': {
        const summary = ev.data?.summary || ev.data?.result || '';
        lines.push(`[${time}] 📎 RESULT: ${String(summary).slice(0, 150)}`);
        break;
      }
      default:
        lines.push(`[${time}] [${ev.type}] ${JSON.stringify(ev.data)?.slice(0, 150)}`);
    }
  }

  // Content density analysis
  if (density) {
    lines.push('');
    lines.push('# --- Content Density ---');
    const windows = [];
    for (let t = startT; t < end; t += windowMs) {
      const wEnd = Math.min(t + windowMs, end);
      const wEvents = playback.events.filter(e => e.t >= t && e.t < wEnd);
      const counts = {};
      for (const e of wEvents) counts[e.type] = (counts[e.type] || 0) + 1;
      if (wEvents.length > 0) {
        windows.push({ t, count: wEvents.length, counts });
      }
    }
    // Show windows with content, flag empty stretches
    let lastEnd = startT;
    for (const w of windows) {
      if (w.t - lastEnd > windowMs * 2) {
        lines.push(`[${fmtTime(lastEnd)} – ${fmtTime(w.t)}] ⚫ EMPTY (${((w.t - lastEnd) / 60000).toFixed(1)} min gap)`);
      }
      const types = Object.entries(w.counts).map(([k, v]) => `${k}:${v}`).join(' ');
      lines.push(`[${fmtTime(w.t)}] ${w.count} events — ${types}`);
      lastEnd = w.t + windowMs;
    }
  }

  // Layout edits summary
  const layoutEdits = (playback.edits || []).filter(e => e.op === 'layout');
  if (layoutEdits.length > 0) {
    lines.push('');
    lines.push('# --- Layout Edits ---');
    for (const le of layoutEdits.sort((a, b) => a.t - b.t)) {
      const panels = (le.panels || []).map(p => p.widget).join(' + ');
      lines.push(`[${fmtTime(le.t)}] ${panels}`);
    }
  }

  // Timewarp summary
  const twEdits = (playback.edits || []).filter(e => e.op === 'timewarp');
  if (twEdits.length > 0) {
    lines.push('');
    lines.push('# --- Timewarps ---');
    for (const tw of twEdits) {
      lines.push(`"${tw.timewarp?.name || 'unnamed'}": ${tw.timewarp?.regions?.length || 0} regions`);
      for (const r of (tw.timewarp?.regions || [])) {
        lines.push(`  [${fmtTime(r.start_ms)} – ${fmtTime(r.end_ms)}] @ ${r.speed}×`);
      }
    }
  }

  return {
    id: playback.id,
    title: playback.title,
    line_count: lines.length,
    transcript: lines.join('\n'),
  };
}

export function trimCopy(id, { startT, endT, title, tags }) {
  const source = getPlayback(id);
  if (!source) return null;

  const trimmed = source.events.filter(e => e.t >= startT && e.t <= endT);
  const baseT = trimmed.length > 0 ? trimmed[0].t : 0;
  const rebaseEvents = trimmed.map(e => ({ ...e, t: e.t - baseT }));
  const durationMs = rebaseEvents.length > 0 ? rebaseEvents[rebaseEvents.length - 1].t : 0;

  const baseMs = source.time_range?.start ? new Date(source.time_range.start).getTime() : 0;

  const newId = crypto.randomUUID();
  const excerpt = {
    id: newId,
    version: 1,
    title: title || `Excerpt from ${source.title}`,
    created: new Date().toISOString(),
    sources: [...source.sources, { type: 'excerpt', parent: id, startT, endT }],
    time_range: {
      start: new Date(baseMs + startT).toISOString(),
      end: new Date(baseMs + endT).toISOString(),
    },
    duration_ms: durationMs,
    edits: [],
    tags: tags || [],
    agents: source.agents || [],
    events: rebaseEvents,
  };

  ensureDir();
  const filePath = path.join(PLAYBACKS_DIR, `${newId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(excerpt, null, 2));

  return {
    id: newId,
    title: excerpt.title,
    event_count: rebaseEvents.length,
    duration_ms: durationMs,
    parent: id,
  };
}
