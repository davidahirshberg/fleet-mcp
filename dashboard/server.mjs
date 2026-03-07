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
import { SearchIndex } from './search-index.mjs';

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
});
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

// Watch state file for changes
let debounceTimer = null;
function onStateChange() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    broadcast(loadState());
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
        const { message, to } = JSON.parse(body);
        if (!message) { res.writeHead(400); res.end('missing message'); return; }
        const state = loadState();
        const recipient = to != null ? to : state.manager;
        if (!recipient) { res.writeHead(400); res.end('no manager registered'); return; }
        if (!state.messages) state.messages = [];
        state.messages.push({
          to: recipient,
          from: 'web',
          text: message,
          timestamp: new Date().toISOString(),
          read: false,
        });
        saveState(state);
        logEvent({ type: 'chat', from: 'web', to: recipient, message });
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
        for (const a of matches) { ids.add(a.id); if (a.session_id) ids.add(a.session_id); }
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
        agentMap[a.id] = a.friendly_name || a.name || String(a.id).slice(0, 8);
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
    const agent = (state.agents || []).find(a =>
      a.id === agentQuery || a.friendly_name === agentQuery || a.name === agentQuery ||
      (a.id && a.id.startsWith(agentQuery))
    );
    if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
    if (!agent.kitty_win) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent has no kitty window' })); return; }
    try {
      const text = execFileSync(path.join(BIN, 'agent-read'), [String(agent.kitty_win)],
        { encoding: 'utf8', timeout: 5000 }).trim();
      const label = agent.friendly_name || agent.name || agent.id.slice(0, 8);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text, label, win: agent.kitty_win }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'read failed: ' + e.message }));
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
        const agent = (state.agents || []).find(a =>
          a.id === agentQuery || a.friendly_name === agentQuery || a.name === agentQuery
        );
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
        const agent = (state.agents || []).find(a =>
          a.id === agentQuery || a.friendly_name === agentQuery || a.name === agentQuery ||
          a.id.startsWith(agentQuery)
        );
        if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'agent not found' })); return; }
        if (message) {
          if (!state.messages) state.messages = [];
          state.messages.push({ to: agent.id, from: 'web', text: message, timestamp: new Date().toISOString(), read: false });
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }
        if (!agent.kitty_win) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no kitty window — message delivered via state file only' })); return; }
        const kick = kickAgentById(state, agent.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...kick, agent: agent.friendly_name || agent.id.slice(0, 8) }));
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
        const agent = (state.agents || []).find(a =>
          a.id === agentQuery || a.friendly_name === agentQuery || a.name === agentQuery ||
          (a.id && a.id.startsWith(agentQuery))
        );
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
        const agent = (state.agents || []).find(a =>
          a.id === agentQuery || a.friendly_name === agentQuery || a.name === agentQuery ||
          (a.id && a.id.startsWith(agentQuery))
        );
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
      searchIndex.buildIncremental().then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
      const agent = (state.agents || []).find(a =>
        a.id === agentQuery || a.friendly_name === agentQuery || a.name === agentQuery
      );
      const agentId = agent?.id || agentQuery;
      const agentName = agent?.friendly_name || agent?.name || agentId.slice(0, 8);

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
        nameMap[a.id] = a.friendly_name || a.name || a.id.slice(0, 8);
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
