/**
 * FTS5 search index for Claude session logs and agent events.
 *
 * Incrementally indexes JSONL files from ~/.claude/projects/ and
 * the agent-messages.jsonl event log. Tracks byte offsets per file
 * so re-indexing only processes new content.
 *
 * Usage:
 *   import { SearchIndex } from './search-index.mjs';
 *   const idx = new SearchIndex();
 *   idx.buildIncremental();   // index new content
 *   const results = idx.search('kernel bandwidth', { project: '...', limit: 50 });
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const LOG_FILE = path.join(os.homedir(), '.claude', 'agent-messages.jsonl');
const DB_PATH = path.join(os.homedir(), '.claude', 'search-index.sqlite');
const TLDA_PROJECTS_DIR = path.join(os.homedir(), 'work', 'claude-tldraw', 'server', 'projects');

/**
 * Shared JSONL→event transform. Parses a single JSONL line into the
 * normalized event format used by /api/session and SSE broadcasts.
 * Returns null for lines that should be skipped.
 */
export function parseSessionLine(jsonStr) {
  let obj;
  try { obj = JSON.parse(jsonStr); } catch { return null; }
  const t = obj.type;
  if (t === 'progress' || t === 'file-history-snapshot') return null;
  const msg = obj.message || {};
  const ev = { type: t, timestamp: obj.timestamp };

  if (t === 'assistant' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    ev.blocks = content.map(c => {
      if (c.type === 'tool_use') return { type: 'tool_use', name: c.name, input: c.input, id: c.id };
      if (c.type === 'text') return { type: 'text', text: c.text };
      return { type: c.type };
    });
    if (msg.usage) {
      const u = msg.usage;
      ev.usage = {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      };
    }
  } else if (t === 'user' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    ev.blocks = content.map(c => {
      if (c.type === 'tool_result') {
        const text = typeof c.content === 'string' ? c.content :
          Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : JSON.stringify(c.content);
        return { type: 'tool_result', id: c.tool_use_id, text, is_error: c.is_error || false };
      }
      if (c.type === 'text') return { type: 'text', text: c.text };
      return { type: c.type };
    });
  } else {
    return null;
  }

  return ev;
}

export class SearchIndex {
  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._createTables();
    this._prepareStatements();
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,       -- 'session' or 'events'
        project TEXT,               -- project dir name (null for events)
        session_id TEXT,            -- session UUID (null for events)
        line INTEGER NOT NULL,      -- line number in source file
        role TEXT,                  -- 'user', 'assistant', 'chat', 'delegate', 'task_done'
        timestamp TEXT,
        from_id TEXT,               -- sender (events only)
        to_id TEXT,                 -- recipient (events only)
        text TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        text,
        content='entries',
        content_rowid='id',
        tokenize='unicode61'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;

      -- Track indexing progress per file
      CREATE TABLE IF NOT EXISTS file_offsets (
        file_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        line_offset INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0
      );

      -- Session events (derived from JSONL, same format as /api/session)
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        blocks TEXT NOT NULL,
        usage_input INTEGER,
        usage_output INTEGER,
        line_num INTEGER NOT NULL,
        file_path TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_agent ON session_events(agent_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_file ON session_events(file_path, line_num);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_unique ON session_events(file_path, line_num);

      -- UI events for playback/UX analysis
      CREATE TABLE IF NOT EXISTS ui_events (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ui_events_ts ON ui_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ui_events_type ON ui_events(event_type, timestamp);
    `);
  }

  _prepareStatements() {
    this._insertEntry = this.db.prepare(`
      INSERT INTO entries (source, project, session_id, line, role, timestamp, from_id, to_id, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._getOffset = this.db.prepare('SELECT byte_offset, line_offset, mtime_ms FROM file_offsets WHERE file_path = ?');
    this._setOffset = this.db.prepare(`
      INSERT INTO file_offsets (file_path, byte_offset, line_offset, mtime_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET byte_offset=excluded.byte_offset, line_offset=excluded.line_offset, mtime_ms=excluded.mtime_ms
    `);
    // Search queries are built dynamically to support optional agent/role/project filters

    // Session events statements
    this._insertSessionEvent = this.db.prepare(`
      INSERT OR IGNORE INTO session_events (agent_id, session_id, type, timestamp, blocks, usage_input, usage_output, line_num, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._insertSessionEventMany = this.db.transaction((rows) => {
      for (const r of rows) this._insertSessionEvent.run(...r);
    });
    this._queryEvents = this.db.prepare(`
      SELECT blocks, type, timestamp, usage_input, usage_output
      FROM session_events
      WHERE agent_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsAfter = this.db.prepare(`
      SELECT blocks, type, timestamp, usage_input, usage_output
      FROM session_events
      WHERE agent_id = ? AND timestamp > ?
      ORDER BY timestamp DESC LIMIT ?
    `);
    this._countEvents = this.db.prepare(`
      SELECT COUNT(*) as c FROM session_events WHERE agent_id = ?
    `);

    // UI events statements
    this._insertUIEvent = this.db.prepare(`
      INSERT INTO ui_events (timestamp, event_type, detail) VALUES (?, ?, ?)
    `);
    this._insertUIEventMany = this.db.transaction((rows) => {
      for (const r of rows) this._insertUIEvent.run(r.timestamp, r.event_type, JSON.stringify(r.detail));
    });
  }

  // --- Indexing ---

  async buildIncremental() {
    const t0 = Date.now();
    let filesIndexed = 0;
    let entriesAdded = 0;

    // Index event log
    const evtCount = await this._indexEventLog();
    if (evtCount > 0) { filesIndexed++; entriesAdded += evtCount; }

    // Find all JSONL session files
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
        try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
      });
    } catch { projectDirs = []; }

    for (const projDir of projectDirs) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      let files;
      try {
        files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of files) {
        const filePath = path.join(projPath, file);
        const sessionId = file.replace('.jsonl', '');
        const count = await this._indexSessionFile(filePath, projDir, sessionId);
        if (count > 0) { filesIndexed++; entriesAdded += count; }
      }
    }

    // Index tlda changelogs
    const tldaCount = await this._indexTldaChangelogs();
    filesIndexed += tldaCount.files;
    entriesAdded += tldaCount.entries;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    return { filesIndexed, entriesAdded, elapsed };
  }

  async _indexEventLog() {
    if (!fs.existsSync(LOG_FILE)) return 0;
    const stat = fs.statSync(LOG_FILE);
    const offset = this._getOffset.get(LOG_FILE);

    if (offset && offset.byte_offset >= stat.size) return 0;

    const startByte = offset?.byte_offset || 0;
    let lineNum = offset?.line_offset || 0;
    let count = 0;

    const insertStmt = this.db.prepare(`
      INSERT INTO entries (source, project, session_id, line, role, timestamp, from_id, to_id, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((entries) => {
      for (const e of entries) insertStmt.run(...e);
    });

    const entries = [];
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');
    // Skip to the right line
    for (let i = lineNum; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      lineNum = i + 1;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const evtType = parsed.type || 'chat';
      let text = parsed.message || parsed.text || parsed.description || '';
      if (typeof text === 'object') text = text.text || JSON.stringify(text);
      if (!text) continue;
      let toField = parsed.to || parsed.agent || null;
      if (Array.isArray(toField)) toField = toField.join(',');
      entries.push(['events', null, null, i + 1, evtType, parsed.timestamp || null, parsed.from || null, toField, String(text)]);
      count++;
    }

    if (entries.length > 0) insertMany(entries);
    this._setOffset.run(LOG_FILE, stat.size, lineNum, stat.mtimeMs);
    return count;
  }

  async _indexSessionFile(filePath, project, sessionId) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return 0; }
    const offset = this._getOffset.get(filePath);

    if (offset && offset.byte_offset >= stat.size) return 0;

    const startByte = offset?.byte_offset || 0;
    let lineNum = offset?.line_offset || 0;
    let count = 0;

    // Read from the byte offset
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - startByte);
    fs.readSync(fd, buf, 0, buf.length, startByte);
    fs.closeSync(fd);

    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n');

    const insertMany = this.db.transaction((entries) => {
      for (const e of entries) this._insertEntry.run(...e);
    });

    const entries = [];
    for (const line of lines) {
      lineNum++;
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      const msgType = parsed.type;
      if (msgType !== 'user' && msgType !== 'assistant') continue;

      const content = parsed.message?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(c => c?.type === 'text')
          .map(c => c.text)
          .join('\n');
      }
      if (!text) continue;
      // Truncate very long entries to keep index manageable
      if (text.length > 5000) text = text.substring(0, 5000);

      const ts = parsed.message?.timestamp || parsed.snapshot?.timestamp || null;
      entries.push(['session', project, sessionId, lineNum, msgType, ts, null, null, text]);
      count++;
    }

    if (entries.length > 0) insertMany(entries);
    this._setOffset.run(filePath, stat.size, lineNum, stat.mtimeMs);
    return count;
  }

  async _indexTldaChangelogs() {
    let files = 0, entries = 0;
    let projDirs;
    try {
      projDirs = fs.readdirSync(TLDA_PROJECTS_DIR).filter(d => {
        try { return fs.statSync(path.join(TLDA_PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
      });
    } catch { return { files: 0, entries: 0 }; }

    for (const projDir of projDirs) {
      const filePath = path.join(TLDA_PROJECTS_DIR, projDir, 'changelog.jsonl');
      if (!fs.existsSync(filePath)) continue;

      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      const offset = this._getOffset.get(filePath);
      if (offset && offset.byte_offset >= stat.size) continue;

      const startByte = offset?.byte_offset || 0;
      let lineNum = offset?.line_offset || 0;

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - startByte);
      fs.readSync(fd, buf, 0, buf.length, startByte);
      fs.closeSync(fd);

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n');
      const batch = [];

      for (const line of lines) {
        lineNum++;
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }

        if (parsed.action !== 'create' && parsed.action !== 'update') continue;

        const text = this._extractTldaText(parsed);
        if (!text) continue;

        const ts = parsed.ts ? new Date(parsed.ts).toISOString() : null;
        const role = parsed.shapeType || 'shape';
        // source='tlda', project=projDir, session_id=shapeId
        batch.push(['tlda', projDir, parsed.id || null, lineNum, role, ts, parsed.state?.meta?.createdBy || null, null, text]);
      }

      if (batch.length > 0) {
        const insertMany = this.db.transaction((rows) => {
          for (const r of rows) this._insertEntry.run(...r);
        });
        insertMany(batch);
        files++;
        entries += batch.length;
      }
      this._setOffset.run(filePath, stat.size, lineNum, stat.mtimeMs);
    }

    return { files, entries };
  }

  _extractTldaText(entry) {
    const parts = [];
    const state = entry.state || {};
    const props = state.props || {};
    const meta = state.meta || {};
    const diff = entry.diff || {};

    // math-note text
    if (props.text) parts.push(props.text);
    // Updated text from diff
    if (diff.props?.to?.text) parts.push(diff.props.to.text);

    // Arrow/shape richText (prosemirror doc)
    const richText = props.richText || diff.props?.to?.richText;
    if (richText) {
      const extracted = this._extractRichText(richText);
      if (extracted) parts.push(extracted);
    }

    // Source anchor content (the TeX line the annotation targets)
    const anchor = meta.sourceAnchor || diff.meta?.to?.sourceAnchor;
    if (anchor?.content) parts.push(anchor.content);
    if (anchor?.file && anchor?.line) parts.push(`${anchor.file}:${anchor.line}`);

    // Tabs (threaded replies on math-notes)
    if (props.tabs && Array.isArray(props.tabs)) {
      for (const tab of props.tabs) {
        if (typeof tab === 'string' && tab.trim()) parts.push(tab);
      }
    }

    return parts.length > 0 ? parts.join(' | ') : null;
  }

  _extractRichText(doc) {
    if (!doc || !doc.content) return null;
    const texts = [];
    const walk = (node) => {
      if (node.text) texts.push(node.text);
      if (node.content) for (const child of node.content) walk(child);
    };
    walk(doc);
    return texts.length > 0 ? texts.join(' ') : null;
  }

  // --- Session Events ---

  queryEvents(agentId, { after, limit = 200 } = {}) {
    const rows = after
      ? this._queryEventsAfter.all(agentId, after, limit)
      : this._queryEvents.all(agentId, limit);
    rows.reverse(); // chronological
    return rows.map(r => ({
      type: r.type,
      timestamp: r.timestamp,
      blocks: JSON.parse(r.blocks),
      usage: r.usage_input != null ? { input: r.usage_input, output: r.usage_output } : undefined,
    }));
  }

  countEvents(agentId) {
    return this._countEvents.get(agentId).c;
  }

  insertEvents(rows) {
    if (rows.length > 0) this._insertSessionEventMany(rows);
  }

  insertUIEvents(events) {
    if (events.length > 0) this._insertUIEventMany(events);
  }

  indexSessionEvents(filePath, agentId, sessionId) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return 0; }
    const offset = this._getOffset.get(filePath + ':events');
    if (offset && offset.byte_offset >= stat.size) return 0;

    const startByte = offset?.byte_offset || 0;
    let lineNum = offset?.line_offset || 0;

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - startByte);
    fs.readSync(fd, buf, 0, buf.length, startByte);
    fs.closeSync(fd);

    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n');
    const rows = [];

    for (const line of lines) {
      lineNum++;
      if (!line.trim()) continue;
      const ev = parseSessionLine(line);
      if (!ev) continue;
      rows.push([agentId, sessionId, ev.type, ev.timestamp, JSON.stringify(ev.blocks),
                  ev.usage?.input ?? null, ev.usage?.output ?? null, lineNum, filePath]);
    }

    if (rows.length > 0) this._insertSessionEventMany(rows);
    this._setOffset.run(filePath + ':events', stat.size, lineNum, stat.mtimeMs);
    return rows.length;
  }

  indexAllSessions(state) {
    const agents = state?.agents || [];
    let total = 0;
    // Build list of all project directories once
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
        try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
      });
    } catch {}
    for (const agent of agents) {
      const candidateIds = [];
      if (agent.session_id) candidateIds.push(agent.session_id);
      if (agent.session_ids) {
        for (const sid of agent.session_ids) {
          if (!candidateIds.includes(sid)) candidateIds.push(sid);
        }
      }
      if (candidateIds.length === 0) candidateIds.push(agent.id);
      for (const sid of candidateIds) {
        // Search all project directories for this session JSONL
        // (CWD-derived project hash is unreliable — agents may register from a parent dir)
        for (const dir of projectDirs) {
          const p = path.join(PROJECTS_DIR, dir, sid + '.jsonl');
          try {
            fs.statSync(p);
            total += this.indexSessionEvents(p, agent.id, sid);
            break; // found it, no need to check other dirs
          } catch {}
        }
      }
    }
    return total;
  }

  rebuildEventsIndex() {
    this.db.exec('DELETE FROM session_events');
    this.db.exec("DELETE FROM file_offsets WHERE file_path LIKE '%:events'");
  }

  // --- Search ---

  search(query, { project, agent, role, limit = 50 } = {}) {
    // FTS5 query syntax: wrap in quotes for phrase, or use as-is for term matching
    // Escape double quotes in the query
    const ftsQuery = query.replace(/"/g, '""');

    const runQuery = (q) => {
      const clauses = ['entries_fts MATCH ?'];
      const params = [q];
      if (project) { clauses.push('e.project = ?'); params.push(project); }
      if (role) { clauses.push('e.role = ?'); params.push(role); }
      if (agent && Array.isArray(agent) && agent.length > 0) {
        const placeholders = agent.map(() => '?').join(',');
        clauses.push(`(e.session_id IN (${placeholders}) OR e.from_id IN (${placeholders}) OR e.to_id IN (${placeholders}))`);
        params.push(...agent, ...agent, ...agent);
      }
      params.push(limit);
      const sql = `SELECT e.*, snippet(entries_fts, 0, '<<', '>>', '...', 40) as snippet
        FROM entries_fts f JOIN entries e ON e.id = f.rowid
        WHERE ${clauses.join(' AND ')}
        ORDER BY e.timestamp DESC LIMIT ?`;
      return this.db.prepare(sql).all(...params);
    };

    let rows;
    try {
      rows = runQuery(ftsQuery);
    } catch {
      // If FTS query syntax fails, try wrapping each word in quotes
      const safeQuery = query.split(/\s+/).map(w => `"${w.replace(/"/g, '""')}"`).join(' ');
      try {
        rows = runQuery(safeQuery);
      } catch {
        return [];
      }
    }

    return rows.map(r => ({
      source: r.source,
      project: r.project,
      sessionId: r.session_id,
      role: r.role,
      timestamp: r.timestamp,
      from: r.from_id,
      to: r.to_id,
      snippet: r.snippet.replace(/<<(.*?)>>/g, '⟨⟨$1⟩⟩'), // markers for client-side highlighting
      line: r.line,
    }));
  }

  // --- Stats ---

  stats() {
    const totalEntries = this.db.prepare('SELECT COUNT(*) as n FROM entries').get().n;
    const totalFiles = this.db.prepare('SELECT COUNT(*) as n FROM file_offsets').get().n;
    const totalBytes = this.db.prepare('SELECT SUM(byte_offset) as n FROM file_offsets').get().n || 0;
    return { totalEntries, totalFiles, totalBytes: (totalBytes / 1024 / 1024).toFixed(1) + 'MB' };
  }

  close() {
    this.db.close();
  }
}
