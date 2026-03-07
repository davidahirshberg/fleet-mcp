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

function kickManager(state) {
  const mgrId = state.manager;
  if (!mgrId) return false;
  const agent = (state.agents || []).find(a => a.id === mgrId);
  const win = agent?.kitty_win || mgrId;
  try {
    execSync(`${BIN}/agent-kick ${win}`, { timeout: 10000 });
    return true;
  } catch {
    return false;
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
const server = http.createServer((req, res) => {
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
        const kicked = kickManager(state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, kicked }));
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
      const results = searchIndex.search(query, { project: project || undefined, limit });
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
        execSync(`${BIN}/agent-kick ${agent.kitty_win}`, { timeout: 10000 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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
        if (!agent.kitty_win) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'Message delivered (no kitty window — cannot ESC)' })); return; }
        execSync(`${BIN}/agent-kick ${agent.kitty_win}`, { timeout: 10000 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: `Interrupted ${agent.friendly_name || agent.id.slice(0, 8)}` }));
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

  // Serve local files (images only, for chat thumbnails)
  if (url.pathname === '/api/file' && req.method === 'GET') {
    const filePath = url.searchParams.get('path') || '';
    // Resolve to absolute, normalize
    const resolved = path.resolve(filePath);
    // Only serve image files
    const ext = path.extname(resolved).toLowerCase();
    const mimeTypes = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mime = mimeTypes[ext];
    if (!mime) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'only image files allowed' }));
      return;
    }
    try {
      const data = fs.readFileSync(resolved);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
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
