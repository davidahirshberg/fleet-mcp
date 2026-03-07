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
    this._searchStmt = this.db.prepare(`
      SELECT e.*, snippet(entries_fts, 0, '<<', '>>', '...', 40) as snippet
      FROM entries_fts f
      JOIN entries e ON e.id = f.rowid
      WHERE entries_fts MATCH ?
      ORDER BY e.timestamp DESC
      LIMIT ?
    `);
    this._searchProjectStmt = this.db.prepare(`
      SELECT e.*, snippet(entries_fts, 0, '<<', '>>', '...', 40) as snippet
      FROM entries_fts f
      JOIN entries e ON e.id = f.rowid
      WHERE entries_fts MATCH ? AND e.project = ?
      ORDER BY e.timestamp DESC
      LIMIT ?
    `);
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

    const insertMany = this.db.transaction((entries) => {
      for (const e of entries) this._insertEntry.run(...e);
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
      const text = parsed.message || parsed.text || parsed.description || '';
      if (!text) continue;
      entries.push(['events', null, null, i + 1, evtType, parsed.timestamp || null, parsed.from || null, parsed.to || parsed.agent || null, text]);
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

  // --- Search ---

  search(query, { project, limit = 50 } = {}) {
    // FTS5 query syntax: wrap in quotes for phrase, or use as-is for term matching
    // Escape double quotes in the query
    const ftsQuery = query.replace(/"/g, '""');

    let rows;
    try {
      if (project) {
        rows = this._searchProjectStmt.all(ftsQuery, project, limit);
      } else {
        rows = this._searchStmt.all(ftsQuery, limit);
      }
    } catch {
      // If FTS query syntax fails, try wrapping each word in quotes
      const safeQuery = query.split(/\s+/).map(w => `"${w.replace(/"/g, '""')}"`).join(' ');
      try {
        if (project) {
          rows = this._searchProjectStmt.all(safeQuery, project, limit);
        } else {
          rows = this._searchStmt.all(safeQuery, limit);
        }
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
