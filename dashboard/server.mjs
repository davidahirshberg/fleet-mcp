#!/usr/bin/env node
/**
 * Agent Dashboard — lightweight web UI for monitoring and chatting with agents.
 *
 * Usage: node dashboard/server.mjs [--port PORT]
 *
 * Features:
 *   - Live task list, agent registry, chat messages
 *   - SSE for real-time updates (watches state file)
 *   - Chat input routes messages to the manager via the state file + kitty kick
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execSync, execFileSync, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { SearchIndex, parseSessionLine } from './search-index.mjs';
import { SessionExtractor, EventExtractor, TldaExtractor } from '../playback/extractors.mjs';
import { createPlayback, getPlayback, listPlaybacks, editPlayback, trimCopy } from '../playback/storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin');
const STATE_FILE = path.join(os.homedir(), '.claude', 'agent-tasks.json');
const LOG_FILE = path.join(os.homedir(), '.claude', 'agent-messages.jsonl');
const HTML_FILE = path.join(__dirname, 'index.html');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const REFS_FILE = path.join(os.homedir(), '.claude', 'references.json');

// --- tlda integration ---
const TLDA_PORT = 5176;
const TLDA_CONFIG = path.join(os.homedir(), '.config', 'tlda', 'config.json');
let tldaToken = null;
try {
  const cfg = JSON.parse(fs.readFileSync(TLDA_CONFIG, 'utf8'));
  tldaToken = cfg.tokenRw || cfg.tokenRead || null;
} catch {}

function tldaFetch(apiPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: 'localhost',
      port: TLDA_PORT,
      path: '/api/projects/' + apiPath,
      method: opts.method || 'GET',
      headers: { ...opts.headers },
    };
    if (tldaToken) reqOpts.headers['Authorization'] = 'Bearer ' + tldaToken;
    if (opts.body) reqOpts.headers['Content-Type'] = 'application/json';
    const req = http.request(reqOpts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function logEvent(event) {
  const entry = { ...event, timestamp: new Date().toISOString() };
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch {}
}

// --- Search index ---
const searchIndex = new SearchIndex();
// Build index in background on startup
searchIndex.buildIncremental().then(r => {
  console.log(`Search index: ${r.entriesAdded} entries indexed in ${r.elapsed}s`);
}).catch(e => console.error('Search index build failed:', e.message));
// Index session events on startup (incremental — fast if already indexed)
try {
  const state = loadState();
  const evCount = searchIndex.indexAllSessions(state);
  if (evCount > 0) console.log(`Session events: ${evCount} events indexed`);
} catch (e) { console.error('Session events index failed:', e.message); }
// Re-index every 60s to pick up new content
setInterval(() => searchIndex.buildIncremental().catch(() => {}), 60000);

let PORT = 5199;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) {
    PORT = parseInt(process.argv[i + 1]);
    i++;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { tasks: [], messages: [], agents: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function findAgent(state, query) {
  if (!query) return null;
  return (state.agents || []).find(a =>
    a.id === query || a.friendly_name === query || a.name === query ||
    a.session_id === query || (a.session_ids && a.session_ids.includes(query)) ||
    (a.id && a.id.startsWith(query))
  );
}

function kickAgentById(state, agentId) {
  if (!agentId || agentId === 'web') return { ok: false, error: 'invalid target' };
  const agent = (state.agents || []).find(a => a.id === agentId);
  const win = agent?.kitty_win;
  if (!win) return { ok: false, error: 'no kitty window' };
  try {
    const result = execSync(`${BIN}/agent-kick ${win}`, { encoding: 'utf8', timeout: 10000 }).trim();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString().trim() || e.message };
  }
}

// --- SSE clients ---
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

function broadcastEvent(eventType, data) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// Watch state file for changes
let debounceTimer = null;
function onStateChange() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const state = loadState();
    broadcast(state);
    // Update session watchers when agent list changes
    syncSessionWatchers(state);
  }, 200);
}

try {
  fs.watch(STATE_FILE, { persistent: false }, onStateChange);
} catch {
  // State file might not exist yet — poll instead
  setInterval(() => {
    try {
      fs.statSync(STATE_FILE);
      onStateChange();
    } catch {}
  }, 2000);
}

// --- Session JSONL watchers ---
// Watch each registered agent's session JSONL for tool call updates
const sessionWatchers = new Map(); // agentId -> { watcher, path, offset, debounce }

function syncSessionWatchers(state) {
  const agents = state.agents || [];
  const activeIds = new Set();

  for (const agent of agents) {
    const cwd = agent.cwd || '';
    const projectHash = cwd.replace(/\//g, '-');
    // Find freshest JSONL across all session IDs (handles compaction)
    const candidateIds = [];
    if (agent.session_id) candidateIds.push(agent.session_id);
    if (agent.session_ids) {
      for (const sid of agent.session_ids) {
        if (!candidateIds.includes(sid)) candidateIds.push(sid);
      }
    }
    if (candidateIds.length === 0) candidateIds.push(agent.id);
    let jsonlPath = null;
    let bestMtime = 0;
    for (const sid of candidateIds) {
      const p = path.join(PROJECTS_DIR, projectHash, sid + '.jsonl');
      try {
        const stat = fs.statSync(p);
        if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; jsonlPath = p; }
      } catch {}
    }

    if (!jsonlPath) continue;
    activeIds.add(agent.id);

    if (sessionWatchers.has(agent.id)) {
      const w = sessionWatchers.get(agent.id);
      if (w.path === jsonlPath) continue; // already watching
      // Path changed — close old watcher
      try { w.watcher.close(); } catch {}
    }

    // Start watching
    const offset = { value: 0 };
    try {
      const stat = fs.statSync(jsonlPath);
      offset.value = stat.size; // start from current end
    } catch {}

    try {
      let debounce = null;
      const watcher = fs.watch(jsonlPath, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => readNewSessionLines(agent.id, jsonlPath, offset), 150);
      });
      sessionWatchers.set(agent.id, { watcher, path: jsonlPath, offset, debounce: null });
    } catch {}
  }

  // Close watchers for agents no longer registered
  for (const [id, w] of sessionWatchers) {
    if (!activeIds.has(id)) {
      try { w.watcher.close(); } catch {}
      sessionWatchers.delete(id);
    }
  }
}

function readNewSessionLines(agentId, jsonlPath, offset) {
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.size <= offset.value) return; // no new data

    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(stat.size - offset.value);
    fs.readSync(fd, buf, 0, buf.length, offset.value);
    fs.closeSync(fd);
    offset.value = stat.size;

    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n').filter(l => l.trim());
    const events = [];
    const dbRows = [];
    const sessionId = path.basename(jsonlPath, '.jsonl');
    let lineNum = 0; // approximate — offset-based, not absolute

    for (const line of lines) {
      lineNum++;
      const ev = parseSessionLine(line);
      if (!ev) continue;
      events.push(ev);
      dbRows.push([agentId, sessionId, ev.type, ev.timestamp, JSON.stringify(ev.blocks),
                    ev.usage?.input ?? null, ev.usage?.output ?? null, lineNum, jsonlPath]);
    }

    // Insert into SQLite
    if (dbRows.length > 0) {
      try { searchIndex.insertEvents(dbRows); } catch {}
    }

    if (events.length > 0) {
      broadcastEvent('session', { agent: agentId, events });
    }
  } catch {}
}

// Initial sync
try { syncSessionWatchers(loadState()); } catch {}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // SSE endpoint
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(loadState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // State snapshot
  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadState()));
    return;
  }

  // Send chat message
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { message, to, cc, attachments, _raw } = JSON.parse(body);
        if (!message && (!attachments || !attachments.length)) { res.writeHead(400); res.end('missing message'); return; }
        if (!to) { res.writeHead(400); res.end('missing "to" — specify a recipient'); return; }
        const state = loadState();
        const resolve = (id) => {
          const a = (state.agents || []).find(a =>
            a.id === id || a.friendly_name === id || a.name === id ||
            (a.id && a.id.startsWith(id))
          );
          return a ? a.id : id;
        };
        const recipient = resolve(to);
        // Resolve cc list (broadcast recipients)
        const ccResolved = cc && cc.length ? cc.map(resolve) : null;
        // Build message text, appending attachment summaries
        let text = message || '';
        if (attachments && attachments.length) {
          const parts = attachments.map(a => `[${a.type || 'attachment'}] ${a.snippet || ''} (from ${a.source || 'unknown'})`);
          text = text ? text + '\n\n' + parts.join('\n') : parts.join('\n');
        }
        if (!state.messages) state.messages = [];
        const msg = {
          to: recipient,
          from: 'web',
          text,
          timestamp: new Date().toISOString(),
          read: false,
        };
        if (ccResolved) msg.cc = ccResolved;
        if (attachments && attachments.length) msg.attachments = attachments;
        if (_raw) msg._raw = true;
        state.messages.push(msg);
        saveState(state);
        logEvent({ type: 'chat', from: 'web', to: recipient, cc: ccResolved, message: text });
        const kick = kickAgentById(state, recipient);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, kick }));
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
    return;
  }

  // Retract a message: if unread, delete it; if read, mark retracted
  if (url.pathname === '/api/retract' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { timestamp, from } = JSON.parse(body);
        if (!timestamp) { res.writeHead(400); res.end('missing timestamp'); return; }
        const state = loadState();
        const idx = (state.messages || []).findIndex(m =>
          m.timestamp === timestamp && m.from === (from || 'web')
        );
        if (idx < 0) { res.writeHead(404); res.end('message not found'); return; }
        const msg = state.messages[idx];
        if (!msg.read) {
          // Unread: delete entirely — agent never saw it
          state.messages.splice(idx, 1);
        } else {
          // Read: mark retracted so agent knows to ignore
          msg._retracted = true;
        }
        saveState(state);
        logEvent({ type: 'retract', from: from || 'web', timestamp, deleted: !msg.read });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: !msg._retracted }));
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
    return;
  }

  // List projects
  if (url.pathname === '/api/logs/projects' && req.method === 'GET') {
    try {
      const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
        try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
      });
      const projects = dirs.map(d => {
        const parts = d.replace(/^-/, '').split('-');
        // Reconstruct path: -Users-skip-work-foo -> /Users/skip/work/foo
        const readable = '/' + parts.join('/');
        return { id: d, path: readable };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(projects));
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
    return;
  }

  // Search logs (FTS5-powered)
  if (url.pathname === '/api/logs/search' && req.method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const project = url.searchParams.get('project') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    if (!query || query.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'query must be at least 2 characters' }));
      return;
    }

    try {
      const role = url.searchParams.get('role') || '';
      const agentParam = url.searchParams.get('agent') || '';
      let agentIds;
      if (agentParam) {
        const state = loadState();
        const matches = (state.agents || []).filter(a =>
          a.id === agentParam || a.name === agentParam || a.friendly_name === agentParam ||
          a.id.startsWith(agentParam)
        );
        const ids = new Set();
        for (const a of matches) { ids.add(a.id); if (a.session_id) ids.add(a.session_id); if (a.session_ids) for (const sid of a.session_ids) ids.add(sid); }
        if (ids.size === 0) ids.add(agentParam);
        agentIds = [...ids];
      }
      const results = searchIndex.search(query, { project: project || undefined, role: role || undefined, agent: agentIds, limit });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results, total: results.length, query }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Search index stats
  if (url.pathname === '/api/logs/stats' && req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(searchIndex.stats()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Get session context (surrounding messages)
  if (url.pathname === '/api/logs/context' && req.method === 'GET') {
    const project = url.searchParams.get('project') || '';
    const sessionId = url.searchParams.get('session') || '';
    const line = parseInt(url.searchParams.get('line') || '0');
    const radius = Math.min(parseInt(url.searchParams.get('radius') || '5'), 20);

    if (!project || !sessionId || !line) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project, session, and line required' }));
      return;
    }

    try {
      const filePath = path.join(PROJECTS_DIR, project, sessionId + '.jsonl');
      // Prevent path traversal
      if (!filePath.startsWith(PROJECTS_DIR)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid path' }));
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }

      // Read lines around the match
      const startLine = Math.max(1, line - radius);
      const endLine = line + radius;
      let sedResult;
      try {
        sedResult = execFileSync('sed', ['-n', `${startLine},${endLine}p`, filePath],
          { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
        );
      } catch { sedResult = ''; }

      const messages = [];
      const lines = sedResult.split('\n').filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        let parsed;
        try { parsed = JSON.parse(lines[i]); } catch { continue; }
        if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;

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

        // Truncate very long messages
        if (text.length > 2000) text = text.substring(0, 2000) + '...';

        messages.push({
          role: parsed.type === 'user' ? 'user' : 'assistant',
          text,
          line: startLine + i,
          isTarget: startLine + i === line,
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages, sessionId, project }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Timeline — chronological event stream from agent-messages.jsonl
  if (url.pathname === '/api/logs/timeline' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
    const before = url.searchParams.get('before') || null; // ISO timestamp for pagination

    try {
      if (!fs.existsSync(LOG_FILE)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: [] }));
        return;
      }

      // Read all events (file is small — append-only log of manager operations)
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      const events = [];
      for (const line of lines) {
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (before && parsed.timestamp >= before) continue;
        events.push(parsed);
      }

      // Sort newest first, take limit
      events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      const page = events.slice(0, limit);

      // Resolve agent names from current state
      const state = loadState();
      const agentMap = {};
      for (const a of (state.agents || [])) {
        agentMap[a.id] = a.friendly_name || a.name || a.id;
        if (a.name) agentMap[a.name] = a.friendly_name || a.name;
      }
      agentMap['web'] = 'skip';

      const resolved = page.map(e => ({
        ...e,
        fromLabel: agentMap[e.from] || String(e.from || ''),
        toLabel: agentMap[e.to] || agentMap[e.agent] || String(e.to || e.agent || ''),
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: resolved }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- References ---

  function loadRefs() {
    try { return JSON.parse(fs.readFileSync(REFS_FILE, 'utf8')); } catch { return []; }
  }
  function saveRefs(refs) {
    fs.writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2));
  }

  if (url.pathname === '/api/refs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadRefs()));
    return;
  }

  if (url.pathname === '/api/refs' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const ref = JSON.parse(body);
        ref.id = 'ref-' + Date.now().toString(36);
        ref.created = new Date().toISOString();
        const refs = loadRefs();
        refs.push(ref);
        saveRefs(refs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ref));
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    });
    return;
  }

  if (url.pathname === '/api/refs/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id, label, note } = JSON.parse(body);
        const refs = loadRefs();
        const ref = refs.find(r => r.id === id);
        if (!ref) { res.writeHead(404); res.end('not found'); return; }
        if (label !== undefined) ref.label = label;
        if (note !== undefined) ref.note = note;
        saveRefs(refs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ref));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });
    return;
  }

  if (url.pathname === '/api/refs' && req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400); res.end('missing id'); return; }
    const refs = loadRefs().filter(r => r.id !== id);
    saveRefs(refs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Command endpoints ---

  // Peek: read agent's terminal
  if (url.pathname === '/api/peek' && req.method === 'GET') {
    const agentQuery = url.searchParams.get('agent') || '';
    if (!agentQuery) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent required' })); return; }
    const state = loadState();
    const agent = findAgent(state, agentQuery);
    if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
    if (!agent.kitty_win) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent has no kitty window' })); return; }
    try {
      const text = execFileSync(path.join(BIN, 'agent-read'), [String(agent.kitty_win)],
        { encoding: 'utf8', timeout: 5000 }).trim();
      const label = agent.friendly_name || agent.name || agent.id;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text, label, win: agent.kitty_win }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'read failed: ' + e.message }));
    }
    return;
  }

  // Send text to agent's kitty terminal
  if (url.pathname === '/api/send-text' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agent: agentQuery, text, enter } = JSON.parse(body);
        const state = loadState();
        const agent = findAgent(state, agentQuery);
        if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
        if (!agent.kitty_win) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no kitty window' })); return; }
        const socks = fs.readdirSync('/tmp').filter(f => f.startsWith('kitty-sock-')).map(f => '/tmp/' + f);
        let sent = false;
        for (const sock of socks) {
          try {
            if (text) {
              execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${agent.kitty_win}" -- ${JSON.stringify(text)}`, { timeout: 5000, stdio: 'pipe' });
            }
            if (enter !== false) {
              execSync(`kitty @ --to "unix:${sock}" send-key --match "id:${agent.kitty_win}" enter`, { timeout: 5000, stdio: 'pipe' });
            }
            sent = true;
            break;
          } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: sent }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Send a key to agent's kitty terminal
  if (url.pathname === '/api/send-key' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agent: agentQuery, key } = JSON.parse(body);
        const state = loadState();
        const agent = findAgent(state, agentQuery);
        if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
        if (!agent.kitty_win) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no kitty window' })); return; }
        const socks = fs.readdirSync('/tmp').filter(f => f.startsWith('kitty-sock-')).map(f => '/tmp/' + f);
        let sent = false;
        for (const sock of socks) {
          try {
            execSync(`kitty @ --to "unix:${sock}" send-key --match "id:${agent.kitty_win}" ${key}`, { timeout: 5000, stdio: 'pipe' });
            sent = true;
            break;
          } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: sent }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Session: read agent's JSONL log as structured events (from SQLite)
  if (url.pathname === '/api/session' && req.method === 'GET') {
    const agentQuery = url.searchParams.get('agent') || '';
    const afterTs = url.searchParams.get('after') || '';
    const limit = parseInt(url.searchParams.get('limit') || '200');
    if (!agentQuery) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent required' })); return; }
    const state = loadState();
    const agent = findAgent(state, agentQuery);
    if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }

    try {
      const events = searchIndex.queryEvents(agent.id, { after: afterTs || undefined, limit });
      const label = agent.friendly_name || agent.name || agent.id;
      // Get sessionId for metadata
      const sessionId = agent.session_id || agent.id;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const total = searchIndex.countEvents(agent.id);
      res.end(JSON.stringify({ events, label, sessionId, total }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'query failed: ' + e.message }));
    }
    return;
  }

  // Spawn: launch a new agent
  if (url.pathname === '/api/spawn' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { cwd } = body ? JSON.parse(body) : {};
        const dir = cwd || os.homedir();
        const result = execSync(`kitty @ launch --type=tab --cwd="${dir}" -- zsh -c 'claude'`, { encoding: 'utf8', timeout: 10000 }).trim();
        const win = parseInt(result) || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, win }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Kick: send notification to agent
  if (url.pathname === '/api/kick' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agent: agentQuery } = JSON.parse(body);
        const state = loadState();
        const agent = findAgent(state, agentQuery);
        if (!agent?.kitty_win) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found or no window' })); return; }
        const kick = kickAgentById(state, agent.id);
        res.writeHead(kick.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(kick));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Interrupt: send ESC + optional message
  if (url.pathname === '/api/interrupt' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agent: agentQuery, message } = JSON.parse(body);
        const state = loadState();
        const agent = findAgent(state, agentQuery);
        if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
        if (message) {
          if (!state.messages) state.messages = [];
          state.messages.push({ to: agent.id, from: 'web', text: message, timestamp: new Date().toISOString(), read: false });
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }
        if (!agent.kitty_win) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no kitty window — message delivered via state file only' })); return; }
        const kick = kickAgentById(state, agent.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...kick, agent: agent.friendly_name || agent.id }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Label agent
  if (url.pathname === '/api/label' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agent: agentQuery, labels } = JSON.parse(body);
        if (!agentQuery || !Array.isArray(labels)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent and labels[] required' })); return; }
        const state = loadState();
        const agent = findAgent(state, agentQuery);
        if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
        agent.labels = labels;
        saveState(state);
        logEvent({ type: 'label', agent: agent.id, labels });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent: agent.id, labels }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Rename agent
  if (url.pathname === '/api/rename' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agent: agentQuery, name: newName } = JSON.parse(body);
        if (!agentQuery || newName == null) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent and name required' })); return; }
        const state = loadState();
        const agent = findAgent(state, agentQuery);
        if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
        agent.friendly_name = newName || undefined;
        saveState(state);
        logEvent({ type: 'rename', agent: agent.id, name: newName });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent: agent.id, name: newName }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Reindex: rebuild search index
  if (url.pathname === '/api/reindex' && req.method === 'POST') {
    try {
      // Rebuild events index too
      searchIndex.rebuildEventsIndex();
      const state = loadState();
      const eventsCount = searchIndex.indexAllSessions(state);
      searchIndex.buildIncremental().then(result => {
        result.sessionEvents = eventsCount;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // UI event recording (single)
  if (url.pathname === '/api/ui-event' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        searchIndex.insertUIEvents([event]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // UI event recording (batch)
  if (url.pathname === '/api/ui-events' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const events = JSON.parse(body);
        if (!Array.isArray(events)) throw new Error('expected array');
        searchIndex.insertUIEvents(events);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: events.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Export conversation thread as markdown
  if (url.pathname === '/api/export' && req.method === 'GET') {
    const agentQuery = url.searchParams.get('agent') || '';
    const since = url.searchParams.get('since') || '';
    const until = url.searchParams.get('until') || '';
    const format = url.searchParams.get('format') || 'markdown';

    if (!agentQuery) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent parameter required' }));
      return;
    }

    try {
      const state = loadState();
      const agent = findAgent(state, agentQuery);
      const agentId = agent?.id || agentQuery;
      const agentName = agent?.friendly_name || agent?.name || agentId;

      // Read full event log
      let events = [];
      if (fs.existsSync(LOG_FILE)) {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.from === agentId || e.to === agentId || e.agent === agentId) {
            events.push(e);
          }
        }
      }

      if (since) events = events.filter(e => e.timestamp >= since);
      if (until) events = events.filter(e => e.timestamp <= until);
      events.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

      // Build agent name map
      const nameMap = { web: 'skip' };
      for (const a of (state.agents || [])) {
        nameMap[a.id] = a.friendly_name || a.name || a.id;
      }

      const lines = events.map(e => {
        const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
        const from = nameMap[e.from] || (e.from?.slice?.(0, 8) || e.from);
        const to = nameMap[e.to || e.agent] || ((e.to || e.agent)?.slice?.(0, 8) || '');
        if (e.type === 'delegate') {
          return `### [${ts}] ${from} → ${to} (DELEGATE)\n**${e.description}**\n\n${e.message || ''}`;
        }
        if (e.type === 'task_done') {
          return `### [${ts}] ${to} — DONE\n${e.description || ''}`;
        }
        return `**[${ts}] ${from} → ${to}**\n${e.message || e.text || ''}`;
      });

      const md = `# Thread: ${agentName}\n\n${lines.join('\n\n---\n\n')}\n`;

      if (format === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agent: agentName, events, markdown: md }));
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/markdown',
          'Content-Disposition': `attachment; filename="thread-${agentName}.md"`,
        });
        res.end(md);
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Agent activity sparkline data
  if (url.pathname === '/api/activity' && req.method === 'GET') {
    try {
      if (!fs.existsSync(LOG_FILE)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      const now = Date.now();
      const windowMs = 6 * 60 * 60 * 1000; // 6 hours
      const bucketMs = 15 * 60 * 1000; // 15-minute buckets
      const numBuckets = Math.ceil(windowMs / bucketMs);
      const activity = {}; // agentId -> array of counts

      for (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e.timestamp) continue;
        const t = new Date(e.timestamp).getTime();
        if (now - t > windowMs) continue;
        const bucket = numBuckets - 1 - Math.floor((now - t) / bucketMs);
        if (bucket < 0 || bucket >= numBuckets) continue;

        const agents = new Set();
        if (e.from && e.from !== 'web' && e.from !== 'keepalive') agents.add(e.from);
        if (e.to && e.to !== 'web') agents.add(e.to);
        if (e.agent) agents.add(e.agent);

        for (const aid of agents) {
          if (!activity[aid]) activity[aid] = new Array(numBuckets).fill(0);
          activity[aid][bucket]++;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activity));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve local files (images + text for chat thumbnails)
  if (url.pathname === '/api/file' && req.method === 'GET') {
    const filePath = url.searchParams.get('path') || '';
    const resolved = path.resolve(filePath);

    // Safe path check: must be under /tmp/, contain /scratch/, or be under server cwd
    const serverCwd = process.cwd();
    const isSafe = resolved.startsWith('/tmp/') ||
                   resolved.includes('/scratch/') ||
                   resolved.startsWith(serverCwd + '/') ||
                   resolved.startsWith(os.homedir() + '/.claude/');
    if (!isSafe) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path not allowed — must be under scratch/, /tmp/, or cwd' }));
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const imageMimes = {
      '.svg': 'image/svg+xml', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp',
    };
    const textExts = new Set([
      '.md', '.r', '.mjs', '.js', '.ts', '.py', '.tex', '.sh', '.css',
      '.html', '.json', '.yaml', '.yml', '.txt', '.csv', '.toml', '.zsh',
      '.bash', '.lua', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp',
    ]);

    const isImage = !!imageMimes[ext];
    const isText = textExts.has(ext);

    if (!isImage && !isText) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported file type' }));
      return;
    }

    try {
      if (isImage) {
        const data = fs.readFileSync(resolved);
        let mime = imageMimes[ext];
        if (data[0] === 0x3C) {
          const head = data.slice(0, 256).toString('utf8');
          if (head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'))) {
            mime = 'image/svg+xml';
          }
        }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        res.end(data);
      } else {
        const maxLines = parseInt(url.searchParams.get('lines') || '0');
        let content = fs.readFileSync(resolved, 'utf8');
        let truncated = false;
        if (maxLines > 0) {
          const allLines = content.split('\n');
          if (allLines.length > maxLines) {
            content = allLines.slice(0, maxLines).join('\n');
            truncated = true;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ content, truncated, path: resolved }));
      }
    } catch (e) {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // Upload image (paste/drop from chat)
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const uploadDir = '/tmp/fleet-uploads';
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        // Detect format from first bytes
        let ext = 'png';
        if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
        else if (buf[0] === 0x47 && buf[1] === 0x49) ext = 'gif';
        else if (buf[0] === 0x52 && buf[1] === 0x49) ext = 'webp';
        else if (buf[0] === 0x3C) {
          const head = buf.slice(0, 256).toString('utf8');
          if (head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'))) ext = 'svg';
        }
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const filePath = path.join(uploadDir, name);
        fs.writeFileSync(filePath, buf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: filePath, url: `/api/file?path=${encodeURIComponent(filePath)}` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- tlda proxy routes ---

  // List tlda projects
  if (url.pathname === '/api/tlda/projects' && req.method === 'GET') {
    try {
      const r = await tldaFetch('');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tlda server unreachable: ' + e.message }));
    }
    return;
  }

  // List annotations for a project
  if (url.pathname.startsWith('/api/tlda/') && url.pathname.endsWith('/annotations') && req.method === 'GET') {
    const project = url.pathname.split('/')[3];
    try {
      const r = await tldaFetch(project + '/shapes?type=math-note');
      const shapes = Array.isArray(r.data) ? r.data : [];
      const annotations = shapes.filter(s => s.type === 'math-note' && s.typeName === 'shape').map(s => ({
        id: s.id,
        text: s.props?.text || '',
        color: s.props?.color || 'black',
        x: Math.round(s.x || 0),
        y: Math.round(s.y || 0),
        done: s.props?.done || false,
        anchor: s.meta?.sourceAnchor || null,
        tabs: s.props?.tabs || null,
        activeTab: s.props?.activeTab || 0,
        createdAt: s.meta?.createdAt || null,
        createdBy: s.meta?.createdBy || null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project, annotations }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Update an annotation (edit text)
  if (url.pathname.startsWith('/api/tlda/') && url.pathname.includes('/annotations/') && req.method === 'PUT') {
    const parts = url.pathname.split('/');
    const project = parts[3];
    const shapeId = decodeURIComponent(parts[5]);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const updates = JSON.parse(body);
        const r = await tldaFetch(project + '/shapes/' + encodeURIComponent(shapeId), {
          method: 'PUT',
          body: { props: updates },
        });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.data));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Delete an annotation
  if (url.pathname.startsWith('/api/tlda/') && url.pathname.includes('/annotations/') && req.method === 'DELETE') {
    const parts = url.pathname.split('/');
    const project = parts[3];
    const shapeId = decodeURIComponent(parts[5]);
    try {
      const r = await tldaFetch(project + '/shapes/' + encodeURIComponent(shapeId), { method: 'DELETE' });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Scroll to a location in a doc
  if (url.pathname.startsWith('/api/tlda/') && url.pathname.endsWith('/scroll') && req.method === 'POST') {
    const project = url.pathname.split('/')[3];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { x, y } = JSON.parse(body);
        const r = await tldaFetch(project + '/signal', {
          method: 'POST',
          body: { key: 'signal:forward-scroll', x, y, timestamp: Date.now() },
        });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.data));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Playback API ---

  // List playbacks
  if (url.pathname === '/api/playbacks' && req.method === 'GET') {
    const project = url.searchParams.get('project') || undefined;
    const agent = url.searchParams.get('agent') || undefined;
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const playbacks = listPlaybacks({ project, agent, limit });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(playbacks));
    return;
  }

  // Get playback by ID
  if (url.pathname.startsWith('/api/playbacks/') && req.method === 'GET') {
    const id = url.pathname.split('/')[3];
    const format = url.searchParams.get('format') || 'full';
    const playback = getPlayback(id, format);
    if (!playback) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Playback not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(playback));
    return;
  }

  // Record a new playback
  if (url.pathname === '/api/playbacks' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sources, start, end, title } = JSON.parse(body);
        const allEvents = [];
        const sourceMeta = [];

        for (const src of sources) {
          if (src.type === 'session') {
            const ext = new SessionExtractor();
            allEvents.push(...ext.extract(src.id, { project: src.project, start, end }));
            sourceMeta.push({ type: 'session', id: src.id, project: src.project });
          } else if (src.type === 'events') {
            const ext = new EventExtractor();
            allEvents.push(...ext.extract({ agents: src.agents, start, end }));
            sourceMeta.push({ type: 'events', agents: src.agents });
          } else if (src.type === 'tlda') {
            const ext = new TldaExtractor();
            allEvents.push(...ext.extract(src.project, { start, end }));
            sourceMeta.push({ type: 'tlda', project: src.project });
          }
        }

        const result = createPlayback({ title, sources: sourceMeta, events: allEvents, start, end });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Edit a playback
  if (url.pathname.startsWith('/api/playbacks/') && url.pathname.endsWith('/edit') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { operations } = JSON.parse(body);
        const result = editPlayback(id, operations);
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Playback not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Trim-copy a playback (create excerpt)
  if (url.pathname.startsWith('/api/playbacks/') && url.pathname.endsWith('/trim') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { startT, endT, title, tags } = JSON.parse(body);
        const result = trimCopy(id, { startT, endT, title, tags });
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Playback not found' }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Cannot read index.html');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent dashboard: http://localhost:${PORT}`);
  // Show Tailscale IP if available
  try {
    const ip = execSync("ifconfig | grep 'inet 100\\.' | awk '{print $2}'", { encoding: 'utf8' }).trim();
    if (ip) console.log(`  Tailscale: http://${ip}:${PORT}`);
  } catch {}
});
