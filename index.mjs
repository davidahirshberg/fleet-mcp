#!/usr/bin/env node
/**
 * Agent Manager MCP Server v5.0
 *
 * Coordinates agents via shared state file + kitty kicks for notifications.
 * Agent identity = fleet ID (durable), backed by sqlite identity ledger.
 * See fleet-identity.md for the full identity system design.
 * Kitty window IDs are metadata for notifications only.
 *
 * Tools:
 *   - register(manager?, session_id?)    register this agent (all agents call this)
 *   - delegate(agent, description, message)  assign task (manager only)
 *   - chat(message, to?)                 send message + kick recipient
 *   - task_list()                        show active tasks + registered agents
 *   - task_done(agent?)                  mark task complete
 *   - task_check(win)                    read agent's kitty window (escape hatch)
 *   - my_task()                          show own task + unread messages
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync, exec } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { SearchIndex } from './dashboard/search-index.mjs';
import { SessionExtractor, EventExtractor, TldaExtractor } from './playback/extractors.mjs';
import { createPlayback, getPlayback, listPlaybacks, editPlayback, playbackTranscript } from './playback/storage.mjs';
import { ledger } from './identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, 'bin');

const STATE_FILE = `${os.homedir()}/.claude/agent-tasks.json`;
const LOG_FILE = `${os.homedir()}/.claude/agent-messages.jsonl`;

// --- tlda integration ---
const TLDA_PORT = 5176;
const TLDA_CONFIG = path.join(os.homedir(), '.config', 'tlda', 'config.json');
let _tldaToken = null;
try {
  const cfg = JSON.parse(fs.readFileSync(TLDA_CONFIG, 'utf8'));
  _tldaToken = cfg.tokenRw || cfg.tokenRead || null;
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
    if (_tldaToken) reqOpts.headers['Authorization'] = 'Bearer ' + _tldaToken;
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

// Highlight color → semantic meaning mapping
const HIGHLIGHT_THEMES = {
  'light-green': { type: 'approve', label: 'Good, keep this' },
  'green': { type: 'approve', label: 'Good, keep this' },
  'light-red': { type: 'reject', label: 'Fix this' },
  'red': { type: 'reject', label: 'Fix this' },
  'yellow': { type: 'question', label: 'Question / unsure' },
  'light-violet': { type: 'expand', label: 'Develop further' },
  'violet': { type: 'expand', label: 'Develop further' },
  'orange': { type: 'comment', label: 'General comment' },
  'light-blue': { type: 'info', label: 'Note / reference' },
  'blue': { type: 'info', label: 'Note / reference' },
};

// Lazy search index — opened read-only on first search call
let _searchIndex = null;
function getSearchIndex() {
  if (!_searchIndex) {
    const dbPath = `${os.homedir()}/.claude/search-index.sqlite`;
    if (!fs.existsSync(dbPath)) return null;
    _searchIndex = new SearchIndex(dbPath);
  }
  return _searchIndex;
}

// Append-only message log. Every communication event gets a line.
function logEvent(event) {
  const entry = { ...event, timestamp: new Date().toISOString() };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}
// Kitty window ID — used only for notifications (kicking agents), never for identity
const KITTY_WIN = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN)
  : process.env.KITTY_WINDOW_ID ? parseInt(process.env.KITTY_WINDOW_ID)
  : null;

// Scan JSONL files to detect the active Claude session UUID.
// Only used for manual starts (no $FLEET_ID) or as a fallback.
// See fleet-identity.md for when this is safe vs. racy.
function detectClaudeSession() {
  const cwd = process.env.PWD || '';

  // Build candidate project dirs: the cwd itself, plus the main worktree
  // if cwd is a git worktree (so agents in worktrees can find their sessions)
  const candidates = [cwd];
  try {
    const wtOutput = execSync('git worktree list --porcelain', { cwd, encoding: 'utf8', timeout: 5000 });
    const mainMatch = wtOutput.match(/^worktree (.+)$/m);
    if (mainMatch && mainMatch[1] !== cwd) candidates.push(mainMatch[1]);
  } catch { /* not a git repo or git not available */ }

  for (const dir of candidates) {
    const projectHash = dir.replace(/\//g, '-') || '-';
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectHash);
    try {
      const now = Date.now();
      const jsonls = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (jsonls.length === 0) continue;
      // Prefer the JSONL being written right now (within 30s of server start)
      const hot = jsonls.filter(f => now - f.mtime < 30000);
      if (hot.length === 1) return hot[0].name.replace('.jsonl', '');
      // Multiple hot or none — fall back to most recent
      return jsonls[0].name.replace('.jsonl', '');
    } catch { /* project dir doesn't exist */ }
  }
  return null;
}

// --- Identity resolution (see fleet-identity.md) ---
// Two-tier: $FLEET_ID env var (authoritative) → detectClaudeSession() + ledger lookup
let AGENT_ID = null;       // This MCP process's fleet ID — the canonical identity
let CLAUDE_SESSION = null;  // The detected Claude session UUID (may go stale after compaction)

function resolveIdentity() {
  // Tier 1: $FLEET_ID env var (set by spawn/respawn or inherited from shell)
  if (process.env.FLEET_ID) {
    AGENT_ID = process.env.FLEET_ID;
    // Still detect session for ledger update
    CLAUDE_SESSION = detectClaudeSession();
    return;
  }

  // Tier 2: Detect Claude session, look up in ledger
  CLAUDE_SESSION = detectClaudeSession();
  if (CLAUDE_SESSION) {
    const agent = ledger.findBySession(CLAUDE_SESSION);
    if (agent) {
      AGENT_ID = agent.fleet_id;
      return;
    }
  }

  // No identity yet — will be assigned on first register()
}

resolveIdentity();

// Agent pruning throttle — kitty checks are expensive, so only run every 5min
let _lastAgentPrune = 0;

// Scan kitty windows — returns array of { id, title, pid, cwd, has_claude, claude_pid }
function scanKittyWindows() {
  try {
    const sock = execSync('ls -t /tmp/kitty-sock-* 2>/dev/null | head -1', { encoding: 'utf8', timeout: 3000 }).trim();
    if (!sock) return [];
    const lsOut = execSync(`kitty @ --to "unix:${sock}" ls`, { encoding: 'utf8', timeout: 5000 });
    const osWindows = JSON.parse(lsOut);
    const windows = [];
    for (const osWin of osWindows) {
      for (const tab of osWin.tabs || []) {
        for (const w of tab.windows || []) {
          const fg = w.foreground_processes || [];
          const claudeProc = fg.find(p => p.cmdline && p.cmdline[0] && (p.cmdline[0] === 'claude' || p.cmdline[0].endsWith('/claude')));
          windows.push({
            id: w.id,
            title: w.title || '',
            pid: w.pid,
            cwd: claudeProc?.cwd || w.cwd || '',
            has_claude: !!claudeProc,
            claude_pid: claudeProc?.pid || null,
          });
        }
      }
    }
    return windows;
  } catch { return []; }
}

// ---- State helpers ----


function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { }
  }
  return { tasks: [], messages: [], agents: [] };
}

function saveState(state) {
  if (!state.messages) state.messages = [];
  if (!state.agents) state.agents = [];

  // Heartbeat: update last_seen and session tracking for this agent on every save
  if (AGENT_ID) {
    const me = state.agents.find(a => a.id === AGENT_ID);
    if (me) {
      me.last_seen = new Date().toISOString();
      // Clear compacting flag — agent is alive and making MCP calls
      delete me.compacting;
      delete me.compacting_since;
      // Session ID is set by register() only — don't overwrite on every save
      // (avoids stale CLAUDE_SESSION clobbering a correct value after compaction)
    }
  }

  // Sync synthetic message tasks before pruning
  syncSyntheticTasks(state);

  const now_ = Date.now();

  // Periodic agent liveness: every 5 minutes, mark agents dead if both
  // heartbeat-dead (>10min) and no live kitty window.
  if (now_ - _lastAgentPrune > 5 * 60 * 1000) {
    _lastAgentPrune = now_;
    for (const a of state.agents) {
      if (a.id === AGENT_ID || a.dead) continue;
      const lastSeenMs = a.last_seen ? now_ - new Date(a.last_seen).getTime() : Infinity;
      if (lastSeenMs < ALIVE_THRESHOLD_MS) continue;
      if (a.kitty_win && kittyWindowExists(a.kitty_win)) continue;
      a.dead = true;
      delete a.kitty_win;
      logEvent({ type: 'auto_prune', agent: a.id, name: a.friendly_name || a.name, reason: 'dead_heartbeat_no_window' });
    }
  }

  // Compute live/dead sets once, after liveness check
  const deadIds = new Set((state.agents || []).filter(a => a.dead).map(a => a.id));
  const liveIds = new Set((state.agents || []).filter(a => !a.dead).map(a => a.id));
  const humanId = resolveHumanId(state);
  const isHumanRecipient = (id) => HUMAN_ALIASES.has(id) || (humanId && id === humanId);

  // Prune done tasks (24h) and done synthetics (immediately)
  state.tasks = state.tasks.filter(t => {
    if (t.status !== 'done') return true;
    if (t.synthetic) return false;
    return (now_ - new Date(t.completed_at || t.delegated_at).getTime()) < 86400000;
  });

  // Expire stale synthetic tasks: for dead/missing agents immediately, others after 1h
  state.tasks = state.tasks.filter(t => {
    if (!t.synthetic || t.status === 'done') return true;
    if (deadIds.has(t.agent) || !liveIds.has(t.agent)) return false;
    return (now_ - new Date(t.delegated_at).getTime()) < 3600000;
  });

  // Prune messages: dead/missing agent recipients immediately, others after 1h when read
  state.messages = state.messages.filter(m => {
    const age = now_ - new Date(m.timestamp).getTime();
    if (isHumanRecipient(m.to)) return age < 3600000;
    if (deadIds.has(m.to) || (!liveIds.has(m.to) && !isHumanRecipient(m.to))) return false;
    if (!m.read) return true;
    return age < 3600000;
  });

  fs.mkdirSync(`${os.homedir()}/.claude`, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- Synthetic message tasks ----
// When an agent has unread messages, a synthetic task makes the obligation visible.
function syncSyntheticTasks(state) {
  if (!state.messages || !state.agents) return;

  // Group unread messages by recipient
  const unreadByAgent = {};
  for (const m of state.messages) {
    if (m.read) continue;
    if (!unreadByAgent[m.to]) unreadByAgent[m.to] = [];
    unreadByAgent[m.to].push(m);
  }

  // For each live agent: create, update, or resolve synthetic tasks
  const liveAgents = state.agents.filter(a => !a.dead);
  const allAgentIds = new Set(liveAgents.map(a => a.id));
  for (const agentId of allAgentIds) {
    const existing = state.tasks.find(t => t.agent === agentId && t.synthetic && t.status !== 'done');
    const unread = unreadByAgent[agentId] || [];

    if (unread.length === 0) {
      // No unread messages — resolve any existing synthetic task
      if (existing && existing.status !== 'done') {
        existing.status = 'done';
        existing.completed_at = now();
      }
      continue;
    }

    // Count by source type
    const fromSkip = unread.filter(m => isHuman(state, m.from)).length;
    const fromAgents = unread.length - fromSkip;

    let desc = `Respond to ${unread.length} message${unread.length > 1 ? 's' : ''}`;
    const parts = [];
    if (fromSkip > 0) parts.push(`${fromSkip} from skip`);
    if (fromAgents > 0) parts.push(`${fromAgents} from agents`);
    if (parts.length > 0) desc += ` (${parts.join(', ')})`;

    if (existing && existing.status !== 'done') {
      // Update existing synthetic task
      existing.description = desc;
      existing.priority = fromSkip > 0 ? 'urgent' : 'normal';
    } else {
      // Create new synthetic task
      const taskId = `${agentId.slice(0, 8)}-msg-${Date.now().toString(36)}`;
      state.tasks.push({
        id: taskId,
        agent: agentId,
        description: desc,
        message: fromSkip > 0
          ? 'You have unread messages from Skip/human. Respond promptly.'
          : 'You have unread messages from other agents. Respond at a natural break point.',
        delegated_at: now(),
        status: 'pending',
        synthetic: true,
        priority: fromSkip > 0 ? 'urgent' : 'normal',
      });
    }
  }
}

function getTask(state, agent) {
  // Prefer real tasks over synthetic ones
  return state.tasks.find(t => t.agent === agent && t.status !== 'done' && !t.synthetic)
    || state.tasks.find(t => t.agent === agent && t.status !== 'done');
}

function getTaskById(state, id) {
  return state.tasks.find(t => t.id === id);
}

function isBlocked(state, task) {
  if (!task.blockedBy || !task.blockedBy.length) return false;
  return task.blockedBy.some(depId => {
    const dep = getTaskById(state, depId);
    return dep && dep.status !== 'done';
  });
}

function unblockDependents(state, completedId) {
  const unblocked = [];
  for (const t of state.tasks) {
    if (t.status === 'blocked' && t.blockedBy) {
      if (!isBlocked(state, t)) {
        t.status = 'pending';
        unblocked.push(t);
      }
    }
  }
  return unblocked;
}

function now() {
  return new Date().toISOString();
}

function progressBar(completed, total, width = 20) {
  if (total <= 0) return '[' + '.'.repeat(width) + ']';
  const filled = Math.round(width * Math.min(completed / total, 1));
  return '[' + '#'.repeat(filled) + '.'.repeat(width - filled) + ']';
}

function requireManager() {
  if (!AGENT_ID) return 'Cannot identify caller — no session ID detected.';
  const state = loadState();
  const agent = getAgent(state, AGENT_ID);
  if (agent?.is_manager) return null;
  return `Only a manager can do this. You are ${AGENT_ID} (not a manager).`;
}

// Check if the calling manager can manage a specific agent.
// All managers are peers — any manager can manage any agent.
function requireAuthOver(state, targetId) {
  if (!AGENT_ID) return 'Cannot identify caller.';
  return null;
}

// ---- Agent registry ----

function getAgent(state, id) {
  if (!state.agents) return null;
  // Exact match on id, friendly_name, or session_id (name is display-only, not for resolution)
  const exact = state.agents.find(a =>
    a.id === id || a.friendly_name === id ||
    a.session_id === id || (a.session_ids && a.session_ids.includes(id))
  );
  return exact || null;
}

const HUMAN_ALIASES = new Set(['web', 'human', 'skip', 'user']);

/** Resolve a human alias to the actual human fleet ID from state, or return null */
function resolveHumanId(state) {
  const human = (state.agents || []).find(a => a.human);
  return human?.id || null;
}

/** Check if a string is a human alias or a human fleet ID */
function isHuman(state, id) {
  if (HUMAN_ALIASES.has(id)) return true;
  const human = (state.agents || []).find(a => a.human);
  return human && human.id === id;
}

// Set friendly_name on an agent. Returns error string if name is taken, null on success.
function nameAgent(state, agent, friendlyName) {
  const conflict = state.agents.find(a => a.id !== agent.id && a.friendly_name === friendlyName);
  if (conflict) return `Name "${friendlyName}" is already taken by ${conflict.friendly_name || conflict.name || conflict.id}.`;
  agent.friendly_name = friendlyName;
  setTabTitle(agent.kitty_win, friendlyName);
  // Sync to identity ledger
  ledger.updateName(agent.id, friendlyName);
  return null;
}

function removeAgent(state, id) {
  if (!state.agents) return;
  state.agents = state.agents.filter(a => a.id !== id && a.friendly_name !== id);
}

function setTabTitle(win, title) {
  if (!win || !title) return;
  try {
    execSync(`kitty @ set-tab-title --match id:${win} "${title.replace(/"/g, '\\"')}"`, { timeout: 5000, stdio: 'ignore' });
  } catch {}
}

function kittyWindowExists(win) {
  try {
    execSync(`${BIN}/agent-exists ${win}`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Heartbeat-based liveness: agent is alive if last_seen within threshold.
// Works for all agents (kitty and headless). Falls back to kitty check if no heartbeat.
const ALIVE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function agentAlive(agent) {
  if (!agent) return false;
  if (agent.last_seen) {
    return (Date.now() - new Date(agent.last_seen).getTime()) < ALIVE_THRESHOLD_MS;
  }
  // No heartbeat yet — fall back to kitty window check
  if (agent.kitty_win) return kittyWindowExists(agent.kitty_win);
  return false;
}

// Lazy cleanup: check if agent's kitty window still exists. Mark dead if not.
function checkAgent(state, id) {
  const agent = getAgent(state, id);
  if (!agent) return false;
  if (agent.kitty_win) {
    if (!kittyWindowExists(agent.kitty_win)) {
      agent.dead = true;
      delete agent.kitty_win;
      saveState(state);
      return false;
    }
  }
  return !agent.dead;
}

// ---- Message helpers ----

function postMessage(state, to, from, text) {
  if (!state.messages) state.messages = [];
  state.messages.push({ to, from, text, timestamp: now(), read: false });
}

function getUnread(state, agent) {
  if (!state.messages) return [];
  return state.messages.filter(m => m.to === agent && !m.read);
}

function markRead(state, agent) {
  if (!state.messages) return;
  for (const m of state.messages) {
    if (m.to === agent && !m.read) m.read = true;
  }
}

// ---- Kitty helpers ----

function kickAgent(kittyWin) {
  try {
    const result = execSync(`${BIN}/agent-kick ${kittyWin}`, {
      encoding: 'utf8', timeout: 10000,
    }).trim();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString().trim() || e.message };
  }
}

function readWindow(win) {
  try {
    const out = execSync(`${BIN}/agent-read ${win}`, { encoding: 'utf8', timeout: 10000 });
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, error: e.message || 'failed to read window' };
  }
}

function isIdle(win) {
  try {
    execSync(`${BIN}/agent-idle ${win}`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function windowTail(output, n = 40) {
  return output.split('\n').slice(-n).join('\n');
}

// Interrupt an agent via kitty ESC — for breaking into a running tool chain.
// NOT for routine notifications (fs.watch handles those).
function interruptAgent(state, agentId) {
  const agent = getAgent(state, agentId);
  if (!agent || !agent.kitty_win) return { ok: false, error: 'no kitty window' };
  const kick = kickAgent(agent.kitty_win);
  if (!kick.ok) {
    // Window gone — clean up
    removeAgent(state, agentId);
    saveState(state);
  }
  return kick;
}

// ---- MCP server ----

const server = new Server(
  { name: 'fleet', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'register',
      description: 'Register this agent. All agents call this at session start. Pass manager=true to register as manager.',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'boolean', description: 'Register as manager (default false)' },
          testing: { type: 'boolean', description: 'Deprecated, ignored. Any manager can register alongside others now.' },
          session_id: { type: 'string', description: 'Claude session ID (for JSONL lookup)' },
          name: { type: 'string', description: 'Agent name (for headless agents without kitty window)' },
        },
      },
    },
    {
      name: 'inhabit',
      description: 'Claim a fleet identity. Use when identity detection got it wrong (e.g. after MCP restart in shared cwd). Sets this agent\'s fleet ID to the specified one.',
      inputSchema: {
        type: 'object',
        properties: {
          fleet_id: { type: 'string', description: 'The fleet ID to claim (e.g. "fleet:868edc45")' },
        },
        required: ['fleet_id'],
      },
    },
    {
      name: 'delegate',
      description: 'Assign a task to an agent. Agent is notified via fs.watch on state file. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier — session UUID, agent name, or friendly name' },
          description: { type: 'string', description: 'Short human-readable description (5-10 words)' },
          message: { type: 'string', description: 'Full task message for the agent' },
          after: { description: 'Task ID or array of IDs — deferred until all complete.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          friendly_name: { type: 'string', description: 'Set a friendly name for the agent (optional, same as name_agent)' },
        },
        required: ['agent', 'description', 'message'],
      },
    },
    {
      name: 'chat',
      description: 'Send a message to another agent (or the manager if "to" is omitted). Format with markdown (headers, lists, bold) — the dashboard renders it. Writes to state file; recipient is notified via fs.watch.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { description: 'Recipient agent ID or name. Omit to send to the manager.' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['message'],
      },
    },
    {
      name: 'task_list',
      description: 'List all active (non-done) tasks and registered agents. Call at session start.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'task_done',
      description: 'Mark a task done. Call with no args to mark your own task done, or specify agent to mark another (manager only).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (session UUID, name, or friendly name). Omit to mark own task done.' },
        },
      },
    },
    {
      name: 'task_check',
      description: 'Read an agent\'s kitty terminal window (escape hatch for when agent is unresponsive). Returns window tail and status.',
      inputSchema: {
        type: 'object',
        properties: {
          win: { type: 'number', description: 'Kitty window ID' },
        },
        required: ['win'],
      },
    },
    {
      name: 'my_task',
      description: 'Show what task is assigned to this agent and any unread messages.',
      inputSchema: { type: 'object', properties: {} },
    },
    // Keep register_manager as alias for backward compat (keepalive watcher calls it)
    {
      name: 'register_manager',
      description: 'Register as manager. Alias for register(manager=true).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'unregister_manager',
      description: 'Step down as manager. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'name_agent',
      description: 'Set or change a friendly name for an agent. Manager only. Names are for manager/human communication — agents don\'t need to know their names.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (session UUID, name, or friendly name)' },
          friendly_name: { type: 'string', description: 'Friendly name (e.g. "sims guy", "survival paper")' },
        },
        required: ['agent', 'friendly_name'],
      },
    },
    {
      name: 'adopt',
      description: 'Reassign a fleet identity to a different agent. The new agent inherits the old fleet ID, friendly name, manager status, tasks, and message history. Use when an agent dies and is replaced by a fresh session. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The new agent to receive the identity (session UUID, name, or friendly name)' },
          identity: { type: 'string', description: 'The old fleet ID (or friendly name) to adopt' },
        },
        required: ['agent', 'identity'],
      },
    },
    {
      name: 'respawn',
      description: 'Resume a dead agent session. Finds an idle kitty tab (or the agent\'s old window), cd\'s to the agent\'s working directory, and runs claude --resume. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (session UUID, name, or friendly name)' },
          win: { type: 'number', description: 'Kitty window to use. Omit to auto-find an idle tab.' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'spawn',
      description: 'Launch a fresh claude agent in an idle kitty tab. The agent will register itself on startup. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Working directory for the new agent. Defaults to home directory.' },
          win: { type: 'number', description: 'Kitty window to use. Omit to auto-find an idle tab.' },
        },
      },
    },
    {
      name: 'search_logs',
      description: 'Full-text search across all agent session logs and event history. Returns matching snippets with source info. Powered by FTS5 index (fast). Use this to find past conversations, decisions, or context from any agent session.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (supports FTS5 syntax: AND, OR, "exact phrase", prefix*)' },
          project: { type: 'string', description: 'Filter to a specific project directory name (e.g. "-Users-skip-work-foo")' },
          agent: { type: 'string', description: 'Filter to a specific agent (by UUID, name, or friendly name)' },
          role: { type: 'string', description: 'Filter by role: "user" (human messages), "assistant" (agent responses), "chat", "delegate", "task_done"' },
          limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_thread',
      description: 'Export a conversation thread. Returns formatted messages for an agent, task, or time range. Useful for reading what another agent did, reviewing task history, or exporting context.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (UUID, name, or friendly name). Required unless task_id is given.' },
          task_id: { type: 'string', description: 'Task ID — returns all messages related to this task.' },
          since: { type: 'string', description: 'ISO timestamp — only messages after this time.' },
          until: { type: 'string', description: 'ISO timestamp — only messages before this time.' },
          include_delegations: { type: 'boolean', description: 'Include task delegations (default true).' },
          limit: { type: 'number', description: 'Max messages (default 50, max 200).' },
        },
      },
    },
    {
      name: 'get_refs',
      description: 'Get pinned reference material — conversation excerpts, files, and other artifacts marked as authoritative. Check this when starting a new task or when you need to understand what the human has approved.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pin_ref',
      description: 'Pin a reference — mark something as authoritative source material. Use this when you find approved content in the logs (user said "perfect", "that\'s it", etc.) or when the user tells you something is the reference. Types: "file" (a file path), "conversation" (a log excerpt), "snippet" (inline text).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '"file", "conversation", or "snippet"' },
          label: { type: 'string', description: 'Short description of what this reference is' },
          path: { type: 'string', description: 'File path (for type=file)' },
          project: { type: 'string', description: 'Project dir (for type=conversation)' },
          sessionId: { type: 'string', description: 'Session UUID (for type=conversation)' },
          line: { type: 'number', description: 'Center line number (for type=conversation)' },
          startLine: { type: 'number', description: 'Start line (for type=conversation)' },
          endLine: { type: 'number', description: 'End line (for type=conversation)' },
          content: { type: 'string', description: 'Text content (for type=snippet)' },
          note: { type: 'string', description: 'Optional note about why this is authoritative' },
        },
        required: ['type', 'label'],
      },
    },
    {
      name: 'label_agent',
      description: 'Set labels on an agent. Labels are tags for filtering and grouping agents in the dashboard. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (session UUID, name, or friendly name)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Array of label strings to set on the agent (replaces existing labels)' },
        },
        required: ['agent', 'labels'],
      },
    },
    {
      name: 'interrupt',
      description: 'Send a kitty ESC interrupt to an agent. Use this to break into an agent that is mid-tool-chain and needs to stop what it\'s doing. NOT for routine notifications — those go through fs.watch automatically. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (UUID, name, or friendly name)' },
          message: { type: 'string', description: 'Optional message to send along with the interrupt (delivered via chat)' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'restart_mcp',
      description: 'Restart MCP servers on one or all agents by sending /mcp + Enter to their kitty windows. Manager only. Use after updating fleet code that agents need to pick up.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (UUID, name, or friendly name). Omit to restart all agents.' },
        },
      },
    },
    {
      name: 'cleanup',
      description: 'Prune dead agents from registry and abandon their orphan tasks. Checks both heartbeat (10min) and kitty window liveness. Returns what was removed.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'roll_call',
      description: 'Show fleet status: who is alive, who is missing, what kitty windows exist. Reads identity ledger + scans live windows. Use before rehydrate to see what needs recovery.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'rehydrate',
      description: 'Recover fleet after a mass kill. Matches running agents to their old identities via identity ledger, or spawns missing agents. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          spawn_missing: { type: 'boolean', description: 'If true, spawn fresh agents for any ledger entries that have no live match. Default false (plan only).' },
        },
      },
    },
    {
      name: 'job_register',
      description: 'Register a cluster job for tracking. Call after sbatch. Adds the job to the manifest on the cluster so the watcher counts its output files.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'SLURM job ID (from sbatch output)' },
          label: { type: 'string', description: 'Short human-readable label (e.g. "c13 sweep fill")' },
          output_dir: { type: 'string', description: 'Directory containing output files (on cluster, e.g. ~/work/spinoffs/code/spinoff3)' },
          output_pattern: { type: 'string', description: 'Glob pattern for output files (e.g. sweep-a_grf1_h05_16-n200-rep*.rds)' },
          total_reps: { type: 'number', description: 'Total expected output files' },
          cluster: { type: 'string', description: 'Cluster hostname (default: qtm)' },
        },
        required: ['job_id', 'label', 'output_dir', 'output_pattern', 'total_reps'],
      },
    },
    {
      name: 'job_check',
      description: 'Check cluster job status. Pulls latest status from the cluster watcher, returns queue state and file counts for tracked jobs. Optionally filter to a single job.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Filter to a specific job ID. Omit to show all.' },
          cluster: { type: 'string', description: 'Cluster hostname (default: qtm)' },
        },
      },
    },
    {
      name: 'job_log',
      description: 'Tail the log for a cluster job task. SSHes to the cluster and reads the SLURM output log.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'SLURM job ID' },
          task_id: { type: 'string', description: 'Array task ID (default: most recent)' },
          lines: { type: 'number', description: 'Number of lines to tail (default: 50)' },
          stderr: { type: 'boolean', description: 'Read stderr instead of stdout (default: false)' },
          cluster: { type: 'string', description: 'Cluster hostname (default: qtm)' },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'timer',
      description: 'Set a non-blocking timer. Returns immediately — you get a 📬 notification when it fires. Use instead of `sleep X && ...` in bash.',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Duration in seconds (1–600)' },
          message: { type: 'string', description: 'Reminder message delivered when timer fires (e.g. "check build status")' },
        },
        required: ['seconds', 'message'],
      },
    },
    {
      name: 'watch_highlights',
      description: 'Start or stop watching a tlda document for new highlights. New highlights are delivered as fleet messages to the assigned agent. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'Start watching, stop watching, or list active watchers' },
          doc: { type: 'string', description: 'Document name (e.g. "retargeted-mean")' },
          agent: { type: 'string', description: 'Agent to receive highlight messages (fleet ID or friendly name). Required for start.' },
        },
        required: ['action'],
      },
    },
    // ---- Playback tools ----
    {
      name: 'playback_record',
      description: 'Extract events from sources into a new playback recording. Sources: session logs, agent events, tlda changelogs. Returns playback ID and event count.',
      inputSchema: {
        type: 'object',
        properties: {
          sources: {
            type: 'array',
            description: 'Data sources to extract from',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['session', 'events', 'tlda'], description: 'Source type' },
                id: { type: 'string', description: 'Session UUID (for type=session)' },
                project: { type: 'string', description: 'Project name (for type=session or type=tlda)' },
                agents: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to include (for type=events)' },
              },
              required: ['type'],
            },
          },
          start: { type: 'string', description: 'ISO timestamp — start of extraction range' },
          end: { type: 'string', description: 'ISO timestamp — end of extraction range' },
          title: { type: 'string', description: 'Playback title' },
        },
        required: ['sources'],
      },
    },
    {
      name: 'playback_list',
      description: 'List available playback recordings, optionally filtered by project or agent.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Filter by project name' },
          agent: { type: 'string', description: 'Filter by agent ID' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },
    {
      name: 'playback_get',
      description: 'Get a playback recording by ID. Format: "full" (all data), "summary" (metadata + event counts), "events_only" (just events).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playback ID (UUID)' },
          format: { type: 'string', enum: ['full', 'summary', 'events_only'], description: 'Output format (default: full)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'playback_edit',
      description: 'Apply editing operations to a playback. Supports: trim (select time range), annotate (add markers), speed (adjust playback speed for regions), focus (frost non-focus panels with narration overlay).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playback ID' },
          operations: {
            type: 'array',
            description: 'Edit operations to apply',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['trim', 'annotate', 'speed', 'focus'], description: 'Operation type' },
                start_ms: { type: 'number', description: 'Start time in ms (for trim, speed)' },
                end_ms: { type: 'number', description: 'End time in ms (for trim, speed)' },
                t: { type: 'number', description: 'Timestamp in ms (for annotate, focus)' },
                text: { type: 'string', description: 'Annotation text (for annotate)' },
                factor: { type: 'number', description: 'Speed multiplier (for speed)' },
                panel: { type: 'string', description: 'Panel to focus on — others get frosted (for focus). Values: chat, terminal, code, agents, tasks' },
                narration: { type: 'string', description: 'Narration text shown on the frosted panel (for focus)' },
              },
              required: ['op'],
            },
          },
        },
        required: ['id', 'operations'],
      },
    },
    {
      name: 'playback_transcript',
      description: 'Generate a human-readable transcript of a playback. Shows chat messages, annotations, focus/layout changes. Includes content density analysis to find empty stretches.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playback ID (UUID)' },
          start_ms: { type: 'number', description: 'Start time in ms (default: 0)' },
          end_ms: { type: 'number', description: 'End time in ms (default: full duration)' },
          types: { type: 'array', items: { type: 'string' }, description: 'Event types to include (default: all). Values: chat, marker, focus, layout, delegate, task_done, user_text, assistant_text, tool_call, tool_result' },
          density: { type: 'boolean', description: 'Include content density analysis per time window (default: false)' },
          window_ms: { type: 'number', description: 'Window size in ms for density analysis (default: 60000 = 1 min)' },
        },
        required: ['id'],
      },
    },
    // ---- Scratch doc sharing tools ----
    {
      name: 'share',
      description: 'Share a scratch file to tlda as a visual document. Creates or updates a tlda project with the file content. The doc appears on the canvas for iPad review with themed highlights. Returns the doc name.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the scratch/markdown file to share' },
          doc: { type: 'string', description: 'Doc name for tlda (auto-generated from filename if omitted). Lowercase alphanumeric + hyphens.' },
          title: { type: 'string', description: 'Human-readable title (defaults to first heading or filename)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'check_doc_feedback',
      description: 'Check for highlight feedback on a shared doc. Reads pen/highlighter annotations from the tlda canvas and translates themed colors into structured feedback: green=approve, red=reject, yellow=question, violet=expand. Returns feedback objects with line ranges and the highlighted text.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Doc name (as returned by share())' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'suggest',
      description: 'Post a suggestion card on a shared doc in response to feedback. The card appears as a sticky note anchored at specific lines, with optional Accept/Reject/Modify buttons for one-tap review. Use after check_doc_feedback to respond to highlights.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Doc name (as returned by share())' },
          line: { type: 'number', description: 'Source line to anchor the suggestion at' },
          text: { type: 'string', description: 'Suggestion text (supports $math$ and $$display math$$)' },
          reply_to: { type: 'string', description: 'Shape ID of the feedback to reply to (from check_doc_feedback). Creates a threaded reply instead of a new note.' },
          choices: { type: 'array', items: { type: 'string' }, description: 'Action buttons (default: ["Accept", "Reject", "Modify"])' },
          color: { type: 'string', description: 'Note color (default: orange for agent notes)' },
        },
        required: ['doc', 'text'],
      },
    },
    {
      name: 'update_shared_doc',
      description: 'Re-push a shared doc to tlda after editing it. Reads the file from its tracked path and pushes the updated content. Use after making changes in response to feedback.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Doc name (as returned by share())' },
        },
        required: ['doc'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ---- register ----
  if (name === 'register' || name === 'register_manager') {
    const isManager = name === 'register_manager' || args.manager === true;
    const agentName = args.name || null;

    // On re-registration (compaction), detect fresh session
    if (AGENT_ID) {
      const freshSession = detectClaudeSession();
      if (freshSession) CLAUDE_SESSION = freshSession;
    }

    // Need either a session UUID or a name
    if (!AGENT_ID && !CLAUDE_SESSION && !agentName) {
      return { content: [{ type: 'text', text: 'No session ID detected and no name provided. Pass session_id or name for headless agents.' }], isError: true };
    }

    const state = loadState();
    if (!state.agents) state.agents = [];

    const claudeSession = args.session_id || CLAUDE_SESSION;
    if (args.session_id && args.session_id !== CLAUDE_SESSION) {
      CLAUDE_SESSION = args.session_id;
    }

    // --- Identity resolution (see fleet-identity.md) ---
    // Two-tier: AGENT_ID (already known or from $FLEET_ID) → session/name lookup
    let resolvedFleetId = AGENT_ID || null;

    if (!resolvedFleetId && claudeSession) {
      // Look up session in ledger
      const ledgerAgent = ledger.findBySession(claudeSession);
      if (ledgerAgent) {
        resolvedFleetId = ledgerAgent.fleet_id;
        logEvent({ type: 'identity_match', agent: resolvedFleetId, reason: `ledger session match for ${claudeSession}` });
      }
    }

    // Also check state file for session match (transition period)
    if (!resolvedFleetId && claudeSession) {
      const stateMatch = state.agents.find(a =>
        a.session_id === claudeSession ||
        (a.session_ids && a.session_ids.includes(claudeSession))
      );
      if (stateMatch) {
        resolvedFleetId = stateMatch.id;
        logEvent({ type: 'identity_match', agent: resolvedFleetId, reason: `state session match for ${claudeSession}` });
      }
    }

    // Match by name in ledger (headless agents using register(name=...))
    if (!resolvedFleetId && agentName) {
      const ledgerAgent = ledger.findByName(agentName);
      if (ledgerAgent) resolvedFleetId = ledgerAgent.fleet_id;
      if (!resolvedFleetId) {
        // Check friendly_name in state (name is display-only, not for resolution)
        const stateMatch = state.agents.find(a => a.friendly_name === agentName);
        if (stateMatch) resolvedFleetId = stateMatch.id;
      }
    }

    // Uniqueness check: if resolvedFleetId is held by a different LIVE agent, reject
    if (resolvedFleetId && AGENT_ID && resolvedFleetId !== AGENT_ID) {
      const holder = getAgent(state, resolvedFleetId);
      if (holder && agentAlive(holder)) {
        return { content: [{ type: 'text', text: `Identity collision: fleet ID ${resolvedFleetId} is held by a live agent. Use adopt() to merge or cleanup() to remove the stale entry.` }], isError: true };
      }
    }

    // New agent — create fleet ID
    if (!resolvedFleetId) {
      resolvedFleetId = claudeSession ? `fleet:${claudeSession.slice(0, 8)}` : agentName;
    }

    // Find or create state entry
    let entry = state.agents.find(a => a.id === resolvedFleetId);
    if (!entry) {
      entry = { id: resolvedFleetId, registered_at: now() };
      state.agents.push(entry);
    } else {
      entry.registered_at = now();
    }

    // Update fields
    if (KITTY_WIN) entry.kitty_win = KITTY_WIN;
    if (agentName) entry.name = agentName;
    if (claudeSession) {
      entry.session_id = claudeSession;
      if (!entry.session_ids) entry.session_ids = [];
      if (!entry.session_ids.includes(claudeSession)) entry.session_ids.push(claudeSession);
    }

    entry.last_seen = now();
    delete entry.compacting;
    delete entry.compacting_since;
    delete entry.dead;
    if (process.env.PWD) entry.cwd = process.env.PWD;
    if (isManager) entry.is_manager = true;

    // Labels: preserve existing, add auto-labels
    const labels = new Set(entry.labels || []);
    if (isManager) labels.add('manager');
    if (entry.cwd) {
      const project = path.basename(entry.cwd);
      if (project && project !== '~') labels.add(project);
    }
    if (labels.size > 0) entry.labels = [...labels];

    // Uniqueness: name must be unique among live agents
    if (entry.friendly_name) {
      const nameConflict = state.agents.find(a =>
        a.id !== entry.id && (a.friendly_name === entry.friendly_name) && agentAlive(a)
      );
      if (nameConflict) {
        logEvent({ type: 'name_conflict', agent: entry.id, name: entry.friendly_name, conflictsWith: nameConflict.id });
      }
    }

    // Deregister any OTHER agent on the same kitty window — prevents stale
    // registrations from lingering after session restart
    if (KITTY_WIN) {
      const stale = state.agents.filter(a => a.kitty_win === KITTY_WIN && a.id !== entry.id);
      for (const s of stale) {
        logEvent({ type: 'deregister', agent: s.id, reason: `kitty window ${KITTY_WIN} claimed by ${entry.id}` });
        removeAgent(state, s.id);
      }
    }

    // Remove legacy top-of-chain singleton
    delete state.manager;

    // Start keepalive if this is the first manager
    if (isManager) {
      const aliveManagers = state.agents.filter(a => a.is_manager && agentAlive(a));
      if (aliveManagers.length <= 1) {
        try { execSync(`pkill -f agent-keepalive`, { timeout: 5000 }); } catch {}
        exec(`${BIN}/agent-keepalive`, { detached: true, stdio: 'ignore' }).unref();
      }
    }

    // Set this process's fleet identity
    AGENT_ID = entry.id;

    // Update the identity ledger
    const cwd = entry.cwd || process.env.PWD || null;
    ledger.upsertAgent(AGENT_ID, claudeSession, cwd, entry.friendly_name || entry.name);

    saveState(state);

    // Set kitty tab title to friendly name (or agent name) on register
    const tabLabel = entry.friendly_name || entry.name || null;
    if (tabLabel && KITTY_WIN) setTabTitle(KITTY_WIN, tabLabel);

    const agentCount = state.agents.length;
    const role = isManager ? 'manager' : 'agent';
    let msg = `Registered ${entry.id} as ${role}. ${agentCount} agent(s) registered.`;
    if (entry.friendly_name) {
      msg += `\nYour name: "${entry.friendly_name}" — other agents and the user know you by this name.`;
    }

    const refPath = `${os.homedir()}/.claude/reference/managing-agents.md`;
    const repoRefPath = path.join(__dirname, 'managing-agents.md');
    const refExists = fs.existsSync(refPath);

    if (isManager) {
      msg += '\n\nWhen you see 📬 as input, call my_task() — it means an agent sent you a message or a task changed.';
      if (refExists) {
        msg += '\nRead ~/.claude/reference/managing-agents.md before proceeding.';
      } else {
        msg += `\n\n⚠ ~/.claude/reference/managing-agents.md not found. Symlink it:\n  ln -s ${repoRefPath} ${refPath}\n\nFor now, read ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    } else {
      msg += '\n\nAfter registering: call my_task() to check for a task. If nothing, just keep working — you\'ll see 📬 when a task or message arrives.';
      msg += '\nWhen you see 📬 as input, call my_task() — it means you have a new task or message.';
      if (refExists) {
        msg += '\nSee ~/.claude/reference/managing-agents.md for how to work with the manager.';
      } else {
        msg += `\nSee ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    }
    msg += '\nChat formatting: dashboard renders markdown (**bold**, `code`, lists, headers) and LaTeX ($inline$, $$display$$). Use them in chat() messages.';

    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- unregister_manager ----
  if (name === 'unregister_manager') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const oldAgent = getAgent(state, AGENT_ID);
    if (oldAgent) delete oldAgent.is_manager;
    // Clean up legacy top-of-chain field if present
    delete state.manager;
    saveState(state);
    return { content: [{ type: 'text', text: 'Stepped down as manager.' }] };
  }

  // ---- inhabit ----
  if (name === 'inhabit') {
    const targetFleetId = args.fleet_id;
    const state = loadState();

    // Check if a different LIVE agent holds this identity
    const holder = getAgent(state, targetFleetId);
    if (holder && agentAlive(holder) && holder.id !== AGENT_ID) {
      return { content: [{ type: 'text', text: `Cannot inhabit ${targetFleetId} — it's held by a live agent. Kill or cleanup that agent first.` }], isError: true };
    }

    const oldId = AGENT_ID;

    // Move our state entry to the new identity
    const myEntry = getAgent(state, oldId);
    if (myEntry) {
      // Remove old entry for target if it exists (dead agent)
      if (holder) removeAgent(state, targetFleetId);
      myEntry.id = targetFleetId;
      // Preserve the target's friendly_name if we don't have one
      if (!myEntry.friendly_name && holder?.friendly_name) {
        myEntry.friendly_name = holder.friendly_name;
      }
    }

    // Update tasks and messages
    for (const task of (state.tasks || [])) {
      if (task.agent === oldId) task.agent = targetFleetId;
    }
    for (const msg of (state.messages || [])) {
      if (msg.to === oldId) msg.to = targetFleetId;
      if (msg.from === oldId) msg.from = targetFleetId;
    }

    AGENT_ID = targetFleetId;

    // Update ledger
    ledger.upsertAgent(targetFleetId, CLAUDE_SESSION, myEntry?.cwd || process.env.PWD, myEntry?.friendly_name || myEntry?.name);

    saveState(state);
    logEvent({ type: 'inhabit', from: oldId, to: targetFleetId });

    const name_ = myEntry?.friendly_name || targetFleetId;
    return { content: [{ type: 'text', text: `Identity changed: ${oldId} → ${targetFleetId} ("${name_}"). Tasks and messages transferred.` }] };
  }

  // ---- delegate ----
  if (name === 'delegate') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    let agent = args.agent;
    const { description, message } = args;
    const afterRaw = args.after;
    const blockedBy = afterRaw ? (Array.isArray(afterRaw) ? afterRaw : [afterRaw]) : [];

    const state = loadState();

    // Resolve friendly name / name to canonical agent ID
    const agentEntry = getAgent(state, agent);
    if (!agentEntry) return { content: [{ type: 'text', text: `Agent "${agent}" not registered.` }], isError: true };
    agent = agentEntry.id;

    // Chain of command: can only delegate to agents you manage
    const authGuard = requireAuthOver(state, agent);
    if (authGuard) return { content: [{ type: 'text', text: authGuard }], isError: true };

    // Set friendly name if provided
    if (args.friendly_name) {
      const err = nameAgent(state, agentEntry, args.friendly_name);
      if (err) return { content: [{ type: 'text', text: err }], isError: true };
    }

    const blocked = blockedBy.length > 0 && blockedBy.some(depId => {
      const dep = getTaskById(state, depId);
      return dep && dep.status !== 'done';
    });

    // Replace any existing non-done real task for this agent (preserve synthetic tasks)
    state.tasks = state.tasks.filter(t => !(t.agent === agent && t.status !== 'done' && !t.synthetic));
    // Task ID: use first 8 chars of UUID or agent name for readability
    const shortId = typeof agent === 'string' ? agent.slice(0, 8) : `w${agent}`;
    const taskId = `${shortId}-${Date.now().toString(36)}`;
    const task = {
      id: taskId,
      agent,
      description,
      message,
      delegated_by: AGENT_ID,
      delegated_at: now(),
      status: blocked ? 'blocked' : 'pending',
      last_checked: now(),
    };
    if (blockedBy.length > 0) task.blockedBy = blockedBy;
    state.tasks.push(task);
    saveState(state);
    logEvent({ type: 'delegate', from: AGENT_ID, to: agent, task_id: taskId, description, message });

    const pendingCount = state.tasks.filter(t => t.status === 'pending').length;
    const blockedCount = state.tasks.filter(t => t.status === 'blocked').length;
    let nudge = `${pendingCount} pending`;
    if (blockedCount > 0) nudge += `, ${blockedCount} blocked`;
    nudge += '.';
    const statusMsg = blocked ? `Queued (blocked by ${blockedBy.join(', ')})` : 'Delegated';
    const agentRegistered = !!getAgent(state, agent);
    const notifyMsg = !blocked && !agentRegistered ? ' ⚠ agent not registered — task created but no way to notify' : '';
    const autoNotify = !blocked && agentRegistered ? ' (agent notified automatically via fs.watch — no need to kick or message them)' : '';
    return {
      content: [{
        type: 'text',
        text: `${statusMsg} to ${agent} [${taskId}]: ${description}${notifyMsg}${autoNotify}\n${nudge}`,
      }],
    };
  }

  // ---- chat ----
  if (name === 'chat') {
    const { message } = args;
    let to = args.to != null ? args.to : null;
    const state = loadState();
    if (to == null) {
      // Route to whoever delegated our current task, or fall back to any manager
      const myTask = AGENT_ID ? state.tasks?.find(t => t.agent === AGENT_ID && t.status !== 'done') : null;
      if (myTask?.delegated_by) {
        to = myTask.delegated_by;
      } else {
        // Fall back to any live manager
        const mgr = (state.agents || []).find(a => a.is_manager && a.id !== AGENT_ID && agentAlive(a));
        to = mgr?.id; // no legacy state.manager fallback
      }
      if (!to) return { content: [{ type: 'text', text: 'No recipient specified and no manager registered.' }], isError: true };
    } else if (HUMAN_ALIASES.has(to)) {
      // Route to the human agent — resolve alias to their fleet ID
      const humanId = resolveHumanId(state);
      to = humanId || 'web'; // fallback to 'web' if no human registered yet
    } else {
      // Resolve friendly name to canonical ID
      const toEntry = getAgent(state, to);
      if (!toEntry) return { content: [{ type: 'text', text: `Recipient "${to}" not registered.` }], isError: true };
      to = toEntry.id;
    }
    const from = AGENT_ID || 'unknown';
    // Mark own messages read — if you're chatting, you've read your inbox
    if (AGENT_ID) markRead(state, AGENT_ID);
    postMessage(state, to, from, message);
    saveState(state);
    logEvent({ type: 'chat', from, to, message });

    let warning = '';
    const callerAgent = AGENT_ID ? getAgent(state, AGENT_ID) : null;
    if (callerAgent?.is_manager && message.length > 200) {
      warning = '\n\n⚠ Long message (>200 chars). If assigning work, use delegate() instead.';
    }

    // Auto-share: detect file paths in chat messages and auto-share scratch/markdown files
    let autoShareMsg = '';
    const filePathMatch = message.match(/(?:^|\s)((?:\/[\w.-]+)+\.md|(?:scratch\/[\w.-]+\.md))\b/);
    if (filePathMatch) {
      const detectedPath = filePathMatch[1];
      const resolved = path.resolve(detectedPath);
      if (fs.existsSync(resolved)) {
        const alreadyShared = (state.shared_docs || []).find(d => d.path === resolved);
        if (!alreadyShared) {
          const basename = path.basename(resolved, '.md');
          const docName = basename.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
          try {
            let fileContent = fs.readFileSync(resolved, 'utf8');
            const headingMatch = fileContent.match(/^#\s+(.+)$/m);
            const title = headingMatch ? headingMatch[1].trim() : basename;

            // Check/create tlda project
            const check = await tldaFetch(docName);
            if (check.status === 404) {
              await tldaFetch('', { method: 'POST', body: { name: docName, title, format: 'markdown', mainFile: path.basename(resolved) } });
            }
            await tldaFetch(docName + '/push', { method: 'POST', body: { files: [{ path: path.basename(resolved), content: fileContent }], sourceDir: path.dirname(resolved), session: CLAUDE_SESSION } });

            if (!state.shared_docs) state.shared_docs = [];
            state.shared_docs.push({ doc: docName, path: resolved, title, agent: AGENT_ID, shared_at: new Date().toISOString(), updated_at: new Date().toISOString() });
            saveState(state);
            logEvent({ type: 'auto_share', agent: AGENT_ID, doc: docName, path: resolved });
            autoShareMsg = `\n📄 Auto-shared "${title}" → tlda doc: **${docName}**`;
          } catch { /* tlda not running — skip auto-share silently */ }
        }
      }
    }

    const toRegistered = !!getAgent(state, to);
    const notifyMsg = (!toRegistered && !isHuman(state, to)) ? ' ⚠ recipient not registered — message saved but no way to notify' : '';
    return { content: [{ type: 'text', text: `Message queued for ${to}${notifyMsg}.${warning}${autoShareMsg}` }] };
  }


  // ---- task_list ----
  if (name === 'task_list') {
    const state = loadState();
    const active = state.tasks.filter(t => t.status !== 'done');
    const agents = state.agents || [];

    let text = '';

    // Show registered agents
    if (agents.length > 0) {
      const agentLines = agents.map(a => {
        let label = a.friendly_name ? `"${a.friendly_name}"` : (a.name || a.id);
        if (a.friendly_name && a.name) label += ` (${a.name})`;
        if (a.friendly_name) label += ` [${a.id}]`;
        if (a.dead) label += ' [dead]';
        if (a.human) label += ' [human]';
        if (a.is_manager) label += ' [manager]';
        if (a.kitty_win) label += ` kitty:${a.kitty_win}`;
        return label;
      });
      text += `Agents: ${agentLines.join(', ')}\n\n`;
    }

    if (!active.length) {
      text += 'No active tasks.';
      return { content: [{ type: 'text', text }] };
    }

    // Check if there are multiple managers (show delegated_by if so)
    const managerCount = agents.filter(a => a.is_manager).length;
    const showOwner = managerCount > 1;

    const lines = active.map(t => {
      const age = Math.round((Date.now() - new Date(t.delegated_at)) / 60000);
      let status = t.status;
      if (t.synthetic) status = `📬 ${t.priority || 'normal'}`;
      if (t.status === 'blocked' && t.blockedBy) {
        status = `blocked by ${t.blockedBy.join(', ')}`;
      }
      if (!t.synthetic && (t.status === 'pending' || t.status === 'working') && age > 1440) {
        status += ` [stale — ${Math.round(age / 60)}h]`;
      }
      let owner = '';
      if (showOwner && t.delegated_by) {
        const ownerAgent = getAgent(state, t.delegated_by);
        const ownerLabel = ownerAgent?.friendly_name || t.delegated_by;
        owner = ` | by:${ownerLabel}`;
      }
      return `[${t.id}] ${t.agent} | ${status} | ${t.description} | ${age}m ago${owner}`;
    });

    text += lines.join('\n');

    const working = active.filter(t => t.status === 'working');
    const pending = active.filter(t => t.status === 'pending');
    const idle = active.filter(t => t.status === 'idle');
    const blocked = active.filter(t => t.status === 'blocked');

    const unread = AGENT_ID ? getUnread(state, AGENT_ID) : [];

    let nudge = '';
    if (unread.length > 0) nudge += `\n\n📬 ${unread.length} unread message(s). Check them.`;
    if (idle.length > 0) nudge += `\n\n${idle.length} idle — review and delegate or mark done.`;
    if (working.length > 0) nudge += `\n\n${working.length} working.`;
    if (pending.length > 0) nudge += ` ${pending.length} pending (awaiting agent pickup).`;
    if (blocked.length > 0) nudge += ` ${blocked.length} blocked.`;
    return { content: [{ type: 'text', text: text + nudge }] };
  }

  // ---- task_done ----
  if (name === 'task_done') {
    const agent = args.agent ? args.agent : AGENT_ID;
    if (!agent) return { content: [{ type: 'text', text: 'No agent specified and no session ID detected.' }], isError: true };

    if (agent !== AGENT_ID) {
      const guard = requireManager();
      if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    }

    const state = loadState();

    if (agent !== AGENT_ID) {
      const authGuard = requireAuthOver(state, agent);
      if (authGuard) return { content: [{ type: 'text', text: authGuard }], isError: true };
    }

    const task = getTask(state, agent);
    if (!task) {
      return { content: [{ type: 'text', text: `No active task for ${agent}.` }] };
    }
    task.status = 'done';
    task.completed_at = now();
    const unblocked = unblockDependents(state, task.id);
    saveState(state);
    logEvent({ type: 'task_done', agent, task_id: task.id, description: task.description });

    // Unblocked agents get notified via fs.watch on state file

    const remaining = state.tasks.filter(t => t.status !== 'done').length;
    let msg = `Marked ${agent} task done: ${task.description}.`;
    if (unblocked.length > 0) {
      msg += `\nUnblocked: ${unblocked.map(t => `[${t.id}] ${t.agent}: ${t.description}`).join('; ')}`;
    }
    if (remaining > 0) {
      msg += ` ${remaining} task(s) remaining.`;
    } else {
      msg += ' All tasks complete.';
    }
    // Guide agents to wait for next task instead of going idle
    if (agent === AGENT_ID) {
      msg += '\n\nKeep working or use sleep() — you\'ll see 📬 when the next task arrives.';
    }
    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- task_check (kitty escape hatch) ----
  if (name === 'task_check') {
    const win = args.win;
    const result = readWindow(win);
    if (!result.ok) {
      // Window gone — clean up agent registry
      const state = loadState();
      const agent = getAgent(state, win);
      if (agent) {
        removeAgent(state, win);
        saveState(state);
      }
      return { content: [{ type: 'text', text: `Cannot read win ${win}: ${result.error}. Agent removed from registry.` }], isError: true };
    }
    const idle = isIdle(win);

    const state = loadState();
    // Find the agent by kitty window, then look up their task by UUID
    const agentEntry = state.agents?.find(a => a.kitty_win === win);
    const agentId = agentEntry?.id;
    const task = agentId ? state.tasks.find(t => t.agent === agentId && t.status !== 'done') : null;
    if (task) {
      if (idle && task.status === 'working') task.status = 'idle';
      task.last_checked = now();
      saveState(state);
    }

    const statusStr = idle ? 'IDLE' : 'WORKING';
    let taskStr = ' [no recorded task]';
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      taskStr = ` [${task.id}: ${task.description} | ${age}m ago]`;
    }

    return {
      content: [{
        type: 'text',
        text: `win ${win} ${statusStr}${taskStr}:\n${windowTail(result.text)}`,
      }],
    };
  }

  // ---- my_task ----
  if (name === 'my_task') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'No session ID detected.' }], isError: true };
    const state = loadState();
    const task = getTask(state, AGENT_ID);
    const unread = getUnread(state, AGENT_ID);

    let text = '';
    let dirty = false;
    const meAgent = getAgent(state, AGENT_ID);
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      let depInfo = '';
      if (task.blockedBy && task.blockedBy.length > 0 && isBlocked(state, task)) {
        const depDetails = task.blockedBy.map(id => {
          const dep = getTaskById(state, id);
          return dep ? `${id} (${dep.description} — ${dep.status})` : `${id} (unknown)`;
        });
        depInfo = `\nBlocked by: ${depDetails.join(', ')}`;
      }
      const nameInfo = meAgent?.friendly_name ? ` (you are "${meAgent.friendly_name}")` : '';
      text = `Your task [${task.id}]: ${task.description}${nameInfo}\nStatus: ${task.status} | ${age}m ago${depInfo}`;
      if (task.message && !task.message_shown) {
        text += `\n\n${task.message}\n\nUse chat() to report progress, results, or issues. Call task_done() when finished.`;
        task.message_shown = true;
        dirty = true;
      }
    } else {
      text = `Nothing new. Keep working or use sleep() — you'll see 📬 when a task or message arrives.`;
    }

    if (unread.length > 0) {
      const formatted = unread.map(m => {
        const fromAgent = getAgent(state, m.from);
        const fromLabel = fromAgent?.friendly_name || fromAgent?.name || m.from;
        const replyHint = isHuman(state, m.from) ? ` (reply with chat(to: "${m.from}"))` : '';
        return `[from ${fromLabel}]${replyHint} ${m.text}`;
      }).join('\n\n');
      text += `\n\n📬 Messages:\n\n${formatted}`;
      markRead(state, AGENT_ID);
      dirty = true;
    }

    if (dirty) saveState(state);
    return { content: [{ type: 'text', text }] };
  }

  // ---- name_agent ----
  if (name === 'name_agent') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const agentId = args.agent;
    const friendlyName = args.friendly_name;
    const state = loadState();
    const agent = getAgent(state, agentId);
    if (!agent) return { content: [{ type: 'text', text: `Agent ${agentId} not registered.` }], isError: true };
    const oldName = agent.friendly_name;
    const err = nameAgent(state, agent, friendlyName);
    if (err) return { content: [{ type: 'text', text: err }], isError: true };
    saveState(state);
    const msg = oldName
      ? `Renamed ${agent.id}: "${oldName}" → "${friendlyName}"`
      : `Named ${agent.id}: "${friendlyName}"`;
    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- adopt ----
  if (name === 'adopt') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const newAgent = getAgent(state, args.agent);
    if (!newAgent) return { content: [{ type: 'text', text: `Agent ${args.agent} not registered.` }], isError: true };
    const oldAgent = getAgent(state, args.identity);
    if (!oldAgent) return { content: [{ type: 'text', text: `Identity ${args.identity} not found.` }], isError: true };
    if (oldAgent.id === newAgent.id) return { content: [{ type: 'text', text: `Agent already has that identity.` }], isError: true };

    const oldId = oldAgent.id;
    const newId = newAgent.id;

    // Transfer identity: copy old agent's stable fields to new agent
    newAgent.id = oldId;
    if (oldAgent.friendly_name) newAgent.friendly_name = oldAgent.friendly_name;
    if (oldAgent.is_manager) newAgent.is_manager = true;
    // Merge session history
    const sessions = new Set([...(oldAgent.session_ids || []), ...(newAgent.session_ids || [])]);
    if (oldAgent.session_id) sessions.add(oldAgent.session_id);
    if (newAgent.session_id) sessions.add(newAgent.session_id);
    newAgent.session_ids = [...sessions];
    // Keep new agent's kitty_win, cwd, session_id, last_seen (it's the live one)

    // Update all tasks referencing old agent
    for (const task of (state.tasks || [])) {
      if (task.agent === newId) task.agent = oldId;
    }
    // Update all messages referencing old agent
    for (const msg of (state.messages || [])) {
      if (msg.to === newId) msg.to = oldId;
      if (msg.from === newId) msg.from = oldId;
    }

    // Remove old dead entry
    removeAgent(state, oldId);
    // Re-add the merged entry (removeAgent removed by id which is now shared)
    state.agents.push(newAgent);

    // Update this process's identity if we adopted ourselves
    if (AGENT_ID === newId) { AGENT_ID = oldId; }

    // Update ledger: transfer sessions from newId to oldId
    ledger.transferSessions(newId, oldId);
    ledger.upsertAgent(oldId, newAgent.session_id, newAgent.cwd, newAgent.friendly_name || newAgent.name);

    saveState(state);
    logEvent({ type: 'adopt', agent: oldId, from: newId, reason: `${newId} adopted identity ${oldId}` });

    // Send orientation message to the adopted agent
    if (args.orient !== false) {
      const name = newAgent.friendly_name || oldId;
      const orientMsg = `You have been assigned the identity "${name}" (fleet ID: ${oldId}). You are a continuation of a previous agent. Use a subagent to read your old session logs via search_logs(agent: "${oldId}") and orient yourself — figure out what you were working on, what tasks are active, and what the current state is. Report back via chat when oriented.`;
      if (!state.messages) state.messages = [];
      state.messages.push({ to: oldId, from: AGENT_ID, text: orientMsg, timestamp: now(), read: false });
      saveState(state);
    }

    return { content: [{ type: 'text', text: `${newId} adopted identity "${oldId}" (name: "${newAgent.friendly_name || '?'}"). Old entry removed. Tasks and messages transferred. Agent notified to orient.` }] };
  }

  // ---- respawn ----
  if (name === 'respawn') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const agentId = args.agent;
    const state = loadState();
    let agent = getAgent(state, agentId);

    // Fall back to identity ledger if not in live registry
    if (!agent) {
      const ledgerAgent = ledger.findByFleetId(agentId) || ledger.findByName(agentId) || ledger.findBySession(agentId);
      if (ledgerAgent) {
        agent = {
          id: ledgerAgent.fleet_id,
          session_id: ledgerAgent.session,
          session_ids: ledgerAgent.sessions || [],
          cwd: ledgerAgent.cwd,
          friendly_name: ledgerAgent.name,
          registered_at: ledgerAgent.created_at,
          last_seen: new Date().toISOString(),
        };
        if (!state.agents) state.agents = [];
        state.agents.push(agent);
      }
    }

    if (!agent) return { content: [{ type: 'text', text: `Agent ${agentId} not found in registry or ledger.` }], isError: true };
    if (!agent.session_id) return { content: [{ type: 'text', text: `Agent ${agentId} has no session_id — can't resume.` }], isError: true };

    // Find a kitty window to use
    let targetWin = args.win || null;

    if (!targetWin && agent.kitty_win && kittyWindowExists(agent.kitty_win)) {
      // Old window still alive — use it
      targetWin = agent.kitty_win;
    }

    if (!targetWin) {
      // Find any idle kitty tab via agent-windows
      try {
        const windowsJson = execSync(`${BIN}/agent-windows`, { encoding: 'utf8', timeout: 5000 });
        const windows = JSON.parse(windowsJson);
        const registeredWins = new Set((state.agents || []).filter(a => a.kitty_win).map(a => a.kitty_win));
        if (KITTY_WIN) registeredWins.add(KITTY_WIN);

        for (const win of windows) {
          if (registeredWins.has(win.id)) continue;
          if (win.at_prompt) {
            targetWin = win.id;
            break;
          }
        }
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to enumerate windows: ${e.message}` }], isError: true };
      }
    }

    if (!targetWin) {
      return { content: [{ type: 'text', text: `No idle kitty tab found. Open a new terminal tab and try again, or pass win explicitly.` }], isError: true };
    }

    // Build the command: cd to cwd if available, then claude --resume with FLEET_ID
    const parts = [];
    if (agent.cwd) parts.push(`cd ${JSON.stringify(agent.cwd)}`);
    parts.push(`FLEET_ID=${agent.id} claude --resume ${agent.session_id}`);
    const cmd = parts.join(' && ');

    // Send the resume command directly via kitty
    try {
      const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (!sock) throw new Error('no kitty socket found');
      const escaped = cmd.replace(/\\/g, '\\\\');
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" "${escaped}"`, { encoding: 'utf8', timeout: 10000 });
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" '\\r'`, { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to send to kitty win ${targetWin}: ${e.message}` }], isError: true };
    }

    // Update registry: new kitty window, clear dead flag
    agent.kitty_win = targetWin;
    delete agent.dead;
    saveState(state);

    const label = agent.friendly_name || agent.name || agent.id;
    setTabTitle(targetWin, label);
    return { content: [{ type: 'text', text: `Respawning "${label}" in win ${targetWin}: ${cmd}` }] };
  }

  // ---- spawn ----
  if (name === 'spawn') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

    const cwd = args.cwd || os.homedir();
    let targetWin = args.win || null;

    try {
      const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (!sock) throw new Error('no kitty socket found');

      if (!targetWin) {
        // Launch a new tab, get the window ID back
        const winId = execSync(`kitty @ --to "unix:${sock}" launch --type=tab --cwd "${cwd}"`, { encoding: 'utf8', timeout: 10000 }).trim();
        targetWin = parseInt(winId, 10);
        if (isNaN(targetWin)) throw new Error(`kitty launch returned unexpected value: ${winId}`);
      }

      // Pre-create fleet ID so the new agent knows its identity immediately
      const spawnFleetId = `fleet:${crypto.randomUUID().slice(0, 8)}`;
      ledger.upsertAgent(spawnFleetId, null, cwd, null);

      // Send claude command with FLEET_ID in env
      const cmd = `cd ${JSON.stringify(cwd)} && FLEET_ID=${spawnFleetId} claude`;
      const escaped = cmd.replace(/\\/g, '\\\\');
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" "${escaped}"`, { encoding: 'utf8', timeout: 10000 });
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" '\\r'`, { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to spawn: ${e.message}` }], isError: true };
    }

    // Set a placeholder tab title until the agent registers and gets named
    setTabTitle(targetWin, 'new-agent');

    // Kick after delay so the agent registers on startup
    const kickWin = targetWin;
    setTimeout(() => {
      try { execSync(`${BIN}/agent-kick ${kickWin}`, { timeout: 10000 }); } catch {}
    }, 15000);

    return { content: [{ type: 'text', text: `Spawned new agent in win ${targetWin} (cwd: ${cwd}). Will kick in ~15s to trigger registration. Once registered, find its UUID via task_list() and use delegate() with that.` }] };
  }

  // ---- get_refs ----
  if (name === 'get_refs') {
    const refsFile = `${os.homedir()}/.claude/references.json`;
    let refs = [];
    try { refs = JSON.parse(fs.readFileSync(refsFile, 'utf8')); } catch {}
    if (refs.length === 0) {
      return { content: [{ type: 'text', text: 'No references pinned.' }] };
    }
    const lines = refs.map(r => {
      const parts = [`[${r.type}] ${r.label}`];
      if (r.note) parts.push(r.note);
      if (r.type === 'file') parts.push(r.path);
      if (r.type === 'conversation') parts.push(`${r.project} / ${r.sessionId?.slice(0, 8)} lines ${r.startLine}-${r.endLine}`);
      if (r.preview) parts.push(r.preview);
      return parts.join('\n  ');
    });
    return { content: [{ type: 'text', text: `${refs.length} reference(s):\n\n${lines.join('\n\n')}` }] };
  }

  // ---- pin_ref ----
  if (name === 'pin_ref') {
    const refsFile = `${os.homedir()}/.claude/references.json`;
    let refs = [];
    try { refs = JSON.parse(fs.readFileSync(refsFile, 'utf8')); } catch {}
    const ref = {
      id: 'ref-' + Date.now().toString(36),
      type: args.type,
      label: args.label,
      note: args.note || '',
      path: args.path,
      project: args.project,
      sessionId: args.sessionId,
      line: args.line,
      startLine: args.startLine,
      endLine: args.endLine,
      content: args.content,
      created: now(),
      pinned_by: AGENT_ID || 'unknown',
    };
    refs.push(ref);
    fs.writeFileSync(refsFile, JSON.stringify(refs, null, 2));
    logEvent({ type: 'pin_ref', from: AGENT_ID || 'unknown', ref_type: args.type, label: args.label });
    return { content: [{ type: 'text', text: `Pinned: [${args.type}] ${args.label}` }] };
  }

  // ---- search_logs ----
  if (name === 'search_logs') {
    const idx = getSearchIndex();
    if (!idx) {
      return { content: [{ type: 'text', text: 'Search index not available. The dashboard server builds the index — make sure it has run at least once.' }], isError: true };
    }

    const query = args.query;
    if (!query || query.length < 2) {
      return { content: [{ type: 'text', text: 'Query must be at least 2 characters.' }], isError: true };
    }

    const limit = Math.min(args.limit || 20, 100);
    let agentIds;
    if (args.agent) {
      const state = loadState();
      // Collect all matching agent IDs (friendly_name, session_id)
      // Prefix match is intentional here — search_logs is read-only, broad matching is useful
      const matches = (state.agents || []).filter(a =>
        a.id === args.agent || a.friendly_name === args.agent ||
        a.id.startsWith(args.agent)
      );
      const ids = new Set();
      for (const a of matches) {
        ids.add(a.id);
        if (a.session_id) ids.add(a.session_id);
        if (a.session_ids) for (const sid of a.session_ids) ids.add(sid);
      }
      if (ids.size === 0) ids.add(args.agent);
      agentIds = [...ids];
    }
    let results = idx.search(query, { project: args.project || undefined, agent: agentIds, role: args.role || undefined, limit });

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No results for "${query}".` }] };
    }

    // Format results
    const state = loadState();
    const lines = results.map(r => {
      const parts = [];
      if (r.timestamp) parts.push(new Date(r.timestamp).toLocaleString());
      if (r.source === 'events') {
        const from = r.from ? (getAgent(state, r.from)?.friendly_name || r.from) : '';
        parts.push(`[${r.role}] ${from}`);
      } else {
        const proj = r.project?.match(/work-(.+)$/)?.[1]?.replace(/-/g, '/') || r.project || '';
        parts.push(`[${r.role}] ${proj}`);
        if (r.sessionId) parts.push(r.sessionId.slice(0, 8));
      }
      // Clean up snippet markers
      const snippet = r.snippet.replace(/⟨⟨/g, '**').replace(/⟩⟩/g, '**');
      parts.push(snippet);
      return parts.join(' | ');
    });

    const stats = idx.stats();

    // Log search event so dashboard can show what agents searched for
    const filters = [];
    if (args.agent) filters.push(`agent=${args.agent}`);
    if (args.role) filters.push(`role=${args.role}`);
    if (args.project) filters.push(`project=${args.project}`);
    const snippets = results.slice(0, 5).map(r => {
      const snip = r.snippet.replace(/⟨⟨/g, '').replace(/⟩⟩/g, '');
      return snip.length > 120 ? snip.slice(0, 120) + '...' : snip;
    });
    logEvent({
      type: 'search',
      from: AGENT_ID || 'unknown',
      query: args.query,
      filters: filters.join(', '),
      resultCount: results.length,
      snippets,
    });

    return { content: [{ type: 'text', text: `${results.length} results (index: ${stats.totalEntries} entries, ${stats.totalFiles} files)\n\n${lines.join('\n\n')}` }] };
  }

  // ---- get_thread ----
  if (name === 'get_thread') {
    const state = loadState();
    const messages = state.messages || [];
    const tasks = state.tasks || [];
    let filtered = [];

    if (args.task_id) {
      // Find the task and its agent
      const task = tasks.find(t => t.id === args.task_id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${args.task_id} not found.` }], isError: true };
      }
      const agentId = task.agent;
      filtered = messages.filter(m => m.from === agentId || m.to === agentId);
      // Include the delegation itself
      const delegations = [];
      if (args.include_delegations !== false) {
        // Read from event log for richer history
        try {
          const logLines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
          for (const line of logLines) {
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            if (e.type === 'delegate' && (e.agent === agentId || e.to === agentId)) {
              delegations.push(e);
            }
            if (e.type === 'task_done' && (e.agent === agentId || e.from === agentId)) {
              delegations.push(e);
            }
            if (e.type === 'chat' && (e.from === agentId || e.to === agentId)) {
              if (!filtered.find(m => m.timestamp === e.timestamp && m.text === (e.message || e.text))) {
                filtered.push({ from: e.from, to: e.to, text: e.message || e.text, timestamp: e.timestamp });
              }
            }
          }
        } catch {}
        filtered = [...delegations.map(d => ({
          from: d.from || d.delegated_by,
          to: d.to || d.agent,
          text: d.type === 'delegate' ? `[DELEGATE] ${d.description}\n${d.message}` : `[DONE] ${d.description || ''}`,
          timestamp: d.timestamp,
        })), ...filtered];
      }
    } else if (args.agent) {
      const agentEntry = getAgent(state, args.agent);
      if (!agentEntry) {
        return { content: [{ type: 'text', text: `Agent "${args.agent}" not found.` }], isError: true };
      }
      const agentId = agentEntry.id;
      // Read from event log for full history
      try {
        const logLines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
        for (const line of logLines) {
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.from === agentId || e.to === agentId || e.agent === agentId) {
            const text = e.type === 'delegate'
              ? `[DELEGATE] ${e.description}\n${e.message || ''}`
              : e.type === 'task_done'
              ? `[DONE] ${e.description || ''}`
              : e.message || e.text || '';
            filtered.push({ from: e.from, to: e.to || e.agent, text, timestamp: e.timestamp });
          }
        }
      } catch {}
    } else {
      return { content: [{ type: 'text', text: 'Provide either agent or task_id.' }], isError: true };
    }

    // Apply time filters
    if (args.since) filtered = filtered.filter(m => m.timestamp >= args.since);
    if (args.until) filtered = filtered.filter(m => m.timestamp <= args.until);

    // Sort by time, deduplicate, limit
    filtered.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    const seen = new Set();
    filtered = filtered.filter(m => {
      const key = `${m.timestamp}|${m.from}|${(m.text || '').slice(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const limit = Math.min(args.limit || 50, 200);
    filtered = filtered.slice(-limit);

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: 'No messages found for the given criteria.' }] };
    }

    // Format as readable thread
    const lines = filtered.map(m => {
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
      const fromAgent = getAgent(state, m.from);
      const from = fromAgent?.friendly_name || fromAgent?.name || m.from?.slice?.(0, 8) || m.from;
      const toAgent = getAgent(state, m.to);
      const to = toAgent?.friendly_name || toAgent?.name || m.to?.slice?.(0, 8) || m.to;
      return `[${ts}] ${from} → ${to}\n${m.text}`;
    });

    return { content: [{ type: 'text', text: `${filtered.length} messages:\n\n${lines.join('\n\n---\n\n')}` }] };
  }

  // ---- label_agent ----
  if (name === 'label_agent') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const agent = getAgent(state, args.agent);
    if (!agent) return { content: [{ type: 'text', text: `Agent "${args.agent}" not registered.` }], isError: true };
    agent.labels = args.labels || [];
    saveState(state);
    const label = agent.friendly_name || agent.name || agent.id;
    return { content: [{ type: 'text', text: `Labels for ${label}: ${agent.labels.join(', ') || '(none)'}` }] };
  }

  // ---- interrupt ----
  if (name === 'interrupt') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const { agent, message } = args;
    const entry = getAgent(state, agent);
    if (!entry) {
      return { content: [{ type: 'text', text: `Agent "${agent}" not registered.` }], isError: true };
    }
    const authGuard = requireAuthOver(state, entry.id);
    if (authGuard) return { content: [{ type: 'text', text: authGuard }], isError: true };

    // Optionally send a message first so the agent knows why they were interrupted
    if (message) {
      postMessage(state, entry.id, AGENT_ID || 'manager', message);
      saveState(state);
      logEvent({ type: 'chat', from: AGENT_ID || 'manager', to: entry.id, message });
    }

    const kick = interruptAgent(state, entry.id);
    if (!kick.ok) {
      return { content: [{ type: 'text', text: `Agent "${agent}" — kick failed: ${kick.error}. Message delivered via state file.` }] };
    }
    return { content: [{ type: 'text', text: `Interrupted ${entry.friendly_name || entry.id} (${kick.result})${message ? ' (with message)' : ''}.` }] };
  }

  // ---- restart_mcp ----
  if (name === 'restart_mcp') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const targets = [];
    if (args.agent) {
      const entry = getAgent(state, args.agent);
      if (!entry) return { content: [{ type: 'text', text: `Agent "${args.agent}" not registered.` }], isError: true };
      if (!entry.kitty_win) return { content: [{ type: 'text', text: `Agent "${args.agent}" has no kitty window.` }], isError: true };
      targets.push(entry);
    } else {
      targets.push(...state.agents.filter(a => a.kitty_win && a.id !== AGENT_ID));
    }
    const results = [];
    for (const t of targets) {
      try {
        // Send /mcp + Enter via kitty to trigger Claude Code's MCP restart
        // Must send ESC after /mcp to dismiss autocomplete menu, then Enter
        const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 3000 }).trim();
        const match = `--match "id:${t.kitty_win}"`;
        execSync(`kitty @ --to "unix:${sock}" send-text ${match} '\\x1b'`, { timeout: 5000 });
        execSync(`kitty @ --to "unix:${sock}" send-text ${match} '/mcp'`, { timeout: 5000 });
        execSync(`kitty @ --to "unix:${sock}" send-text ${match} '\\x1b'`, { timeout: 5000 });
        execSync(`kitty @ --to "unix:${sock}" send-text ${match} '\\r'`, { timeout: 5000 });
        results.push(`${t.friendly_name || t.id}: sent`);
      } catch {
        results.push(`${t.friendly_name || t.id}: failed`);
      }
    }
    return { content: [{ type: 'text', text: `MCP restart → ${targets.length} agent(s):\n${results.join('\n')}` }] };
  }

  // ---- cleanup ----
  if (name === 'cleanup') {
    const state = loadState();
    const agents = state.agents || [];
    const now = Date.now();
    const removed = [];
    const orphaned = [];

    for (const a of agents) {
      if (a.id === AGENT_ID || a.dead) continue;
      const lastSeenMs = a.last_seen ? now - new Date(a.last_seen).getTime() : Infinity;
      if (lastSeenMs < ALIVE_THRESHOLD_MS) continue;
      if (a.kitty_win && kittyWindowExists(a.kitty_win)) continue;
      a.dead = true;
      delete a.kitty_win;
      removed.push({ id: a.id, name: a.friendly_name || a.name, last_seen: a.last_seen });
      logEvent({ type: 'cleanup', agent: a.id, name: a.friendly_name || a.name, reason: 'dead' });
    }

    // Tasks for dead agents stay active — they can be respawned or reassigned
    if (removed.length > 0) {
      for (const t of state.tasks) {
        if (t.status !== 'done' && !t.synthetic && removed.some(r => r.id === t.agent)) {
          orphaned.push({ id: t.id, agent: t.agent, description: t.description });
        }
      }
    }

    saveState(state);
    const lines = [];
    if (removed.length === 0 && orphaned.length === 0) {
      lines.push('Nothing to clean up — all agents are alive or already gone.');
    } else {
      if (removed.length) lines.push(`Removed ${removed.length} dead agent(s): ${removed.map(r => r.name || r.id).join(', ')}`);
      if (orphaned.length) lines.push(`Abandoned ${orphaned.length} orphan task(s): ${orphaned.map(o => o.description).join(', ')}`);
      lines.push(`${state.agents.length} agent(s) remaining.`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ---- roll_call ----
  if (name === 'roll_call') {
    const state = loadState();
    const agents = state.agents || [];
    const windows = scanKittyWindows();
    const now = Date.now();

    const kittyIdSet = new Set(windows.map(w => w.id));
    const lines = [];

    // Classify live agents
    const alive = [], stale = [], dead = [];
    for (const a of agents) {
      const lastSeenMs = a.last_seen ? now - new Date(a.last_seen).getTime() : Infinity;
      const heartbeat = lastSeenMs < ALIVE_THRESHOLD_MS;
      const windowUp = a.kitty_win ? kittyIdSet.has(a.kitty_win) : null;
      const label = a.friendly_name || a.name || a.id;
      const info = `${label} (${a.id}) — kitty:${a.kitty_win || 'none'}, cwd: ${a.cwd || '?'}, seen ${lastSeenMs === Infinity ? 'never' : Math.round(lastSeenMs/1000) + 's ago'}`;
      if (heartbeat && windowUp !== false) alive.push(info);
      else if (heartbeat || windowUp) stale.push(info);
      else dead.push(info);
    }

    if (alive.length) lines.push(`Alive (${alive.length}):\n  ${alive.join('\n  ')}`);
    if (stale.length) lines.push(`Stale (${stale.length}):\n  ${stale.join('\n  ')}`);
    if (dead.length) lines.push(`Dead (${dead.length}):\n  ${dead.join('\n  ')}`);

    // Ledger entries not in registry
    const registryIds = new Set(agents.map(a => a.id));
    const ledgerAgents = ledger.listAgents();
    const missing = ledgerAgents.filter(r => !registryIds.has(r.fleet_id));
    if (missing.length) {
      lines.push(`\nIn ledger but gone (${missing.length}):`);
      for (const m of missing) {
        const label = m.name || m.fleet_id;
        lines.push(`  ${label} (${m.fleet_id}) — cwd: ${m.cwd || '?'}, session: ${m.session || '?'}`);
      }
    }

    // Unregistered windows with claude
    const registeredWins = new Set(agents.filter(a => a.kitty_win).map(a => a.kitty_win));
    const unmatchedWins = windows.filter(w => w.has_claude && !registeredWins.has(w.id));
    if (unmatchedWins.length) {
      lines.push(`\nUnregistered claude windows (${unmatchedWins.length}):`);
      for (const w of unmatchedWins) {
        lines.push(`  kitty:${w.id} — cwd: ${w.cwd}, pid: ${w.claude_pid}`);
      }
    }

    // Idle windows
    const idle = windows.filter(w => !w.has_claude);
    if (idle.length) {
      lines.push(`\nIdle windows (${idle.length}): ${idle.map(w => `kitty:${w.id}`).join(', ')}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') || 'No agents, no ledger entries, no windows.' }] };
  }

  // ---- rehydrate ----
  if (name === 'rehydrate') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

    const state = loadState();
    const ledgerAgents = ledger.listAgents();
    const windows = scanKittyWindows();
    const spawnMissing = args.spawn_missing === true;

    const registryIds = new Set((state.agents || []).map(a => a.id));
    const registeredWins = new Set((state.agents || []).filter(a => a.kitty_win).map(a => a.kitty_win));

    // Match unregistered claude windows to missing ledger entries
    const unmatchedWindows = windows.filter(w => w.has_claude && !registeredWins.has(w.id));
    const missingFromRegistry = ledgerAgents.filter(r => !registryIds.has(r.fleet_id));

    const matched = [];
    const ambiguous = [];

    for (const w of unmatchedWindows) {
      const candidates = missingFromRegistry.filter(r => r.cwd === w.cwd);
      if (candidates.length === 1) {
        matched.push({ window: w, ledgerEntry: candidates[0] });
        missingFromRegistry.splice(missingFromRegistry.indexOf(candidates[0]), 1);
      } else {
        ambiguous.push({ window: w, candidates });
      }
    }

    const lines = [];

    // Apply matches
    if (matched.length) {
      lines.push(`Matched ${matched.length} agent(s):`);
      for (const m of matched) {
        const r = m.ledgerEntry;
        const w = m.window;
        const entry = {
          id: r.fleet_id,
          registered_at: new Date().toISOString(),
          kitty_win: w.id,
          session_id: r.session,
          session_ids: r.sessions || [],
          friendly_name: r.name || null,
          cwd: r.cwd,
          last_seen: new Date().toISOString(),
        };
        state.agents = (state.agents || []).filter(a => a.id !== r.fleet_id && a.kitty_win !== w.id);
        state.agents.push(entry);
        logEvent({ type: 'rehydrate', agent: r.fleet_id, name: r.name, kitty_win: w.id, reason: 'cwd_match' });
        lines.push(`  ${r.name || r.fleet_id} -> kitty:${w.id} (cwd: ${r.cwd})`);
      }
      saveState(state);
    }

    if (ambiguous.length) {
      lines.push(`\nAmbiguous (${ambiguous.length} window(s) — manual matching needed):`);
      for (const u of ambiguous) {
        lines.push(`  kitty:${u.window.id} (cwd: ${u.window.cwd}) — ${u.candidates.length} candidates: ${u.candidates.map(c => c.name || c.fleet_id).join(', ') || 'none'}`);
      }
    }

    if (missingFromRegistry.length) {
      lines.push(`\nStill missing (${missingFromRegistry.length}):`);
      for (const r of missingFromRegistry) {
        lines.push(`  ${r.name || r.fleet_id} (${r.fleet_id}) — cwd: ${r.cwd}`);
      }

      if (spawnMissing) {
        lines.push('\nSpawning missing agents...');
        for (const r of missingFromRegistry) {
          try {
            const cwd = r.cwd || os.homedir();
            const sock = execSync('ls -t /tmp/kitty-sock-* 2>/dev/null | head -1', { encoding: 'utf8', timeout: 3000 }).trim();
            if (!sock) { lines.push(`  ${r.name || r.fleet_id}: no kitty socket`); continue; }
            const result = execSync(`kitty @ --to "unix:${sock}" launch --type=tab --cwd="${cwd}" --title="${r.name || r.fleet_id}" -- zsh -c 'FLEET_ID=${r.fleet_id} claude'`, { encoding: 'utf8', timeout: 10000 }).trim();
            lines.push(`  ${r.name || r.fleet_id}: spawned (${result})`);
            logEvent({ type: 'rehydrate', action: 'spawn', agent: r.fleet_id, name: r.name, cwd });
          } catch (e) {
            lines.push(`  ${r.name || r.fleet_id}: failed (${e.message})`);
          }
        }
      }
    }

    if (!matched.length && !ambiguous.length && !missingFromRegistry.length) {
      lines.push('Nothing to rehydrate — all ledger entries are in the registry.');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ---- job_register ----
  if (name === 'job_register') {
    const { job_id, label, output_dir, output_pattern, total_reps, cluster } = args;
    const host = cluster || 'qtm';
    const manifestLine = `${job_id}\t${output_dir}\t${output_pattern}\t${total_reps}\t${label}`;

    try {
      execSync(`ssh ${host} 'echo "${manifestLine}" >> ~/.cluster-status/manifest.tsv'`, {
        encoding: 'utf8', timeout: 15000,
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to register job on ${host}: ${e.message}` }], isError: true };
    }

    const state = loadState();
    if (!state.cluster_jobs) state.cluster_jobs = [];
    state.cluster_jobs.push({
      id: job_id, label, output_dir, output_pattern, total_reps,
      cluster: host, agent: AGENT_ID, registered_at: now(),
    });
    saveState(state);

    logEvent({ type: 'job_register', job_id, label, cluster: host, agent: AGENT_ID });
    return { content: [{ type: 'text', text: `Registered job ${job_id} (${label}) on ${host}. Watcher will track ${output_pattern} in ${output_dir}.` }] };
  }

  // ---- job_check ----
  if (name === 'job_check') {
    const host = args.cluster || 'qtm';
    const localDir = path.join(os.homedir(), '.claude', 'cluster-status');

    try {
      fs.mkdirSync(localDir, { recursive: true });
      execSync(`scp -q ${host}:~/.cluster-status/status.json ${localDir}/${host}.json`, {
        encoding: 'utf8', timeout: 15000,
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to pull status from ${host}: ${e.message}` }], isError: true };
    }

    let status;
    try {
      status = JSON.parse(fs.readFileSync(path.join(localDir, `${host}.json`), 'utf8'));
    } catch (e) {
      return { content: [{ type: 'text', text: `No status file from ${host}. Is the watcher installed? Run: cluster/setup.sh ${host}` }], isError: true };
    }

    let jobs = status.jobs || [];
    if (args.job_id) {
      jobs = jobs.filter(j => j.id === args.job_id);
    }

    const lines = [];
    lines.push(`Cluster: ${host} | Updated: ${status.timestamp}`);
    lines.push('');

    const queueEntries = Object.entries(status.queue || {});
    if (queueEntries.length > 0) {
      lines.push('Queue:');
      for (const [jid, q] of queueEntries) {
        lines.push(`  ${jid} (${q.name}): ${q.running} running, ${q.pending} pending`);
      }
    } else {
      lines.push('Queue: empty');
    }
    lines.push('');

    if (jobs.length > 0) {
      lines.push('Tracked jobs:');
      for (const j of jobs) {
        const pct = j.total > 0 ? Math.round(100 * j.completed / j.total) : 0;
        const bar = progressBar(j.completed, j.total);
        const queueStatus = j.in_queue ? ` | ${j.running}R ${j.pending}P` : ' | done';
        lines.push(`  ${j.id} ${j.label}: ${bar} ${j.completed}/${j.total} (${pct}%)${queueStatus}`);
      }
    } else if (args.job_id) {
      lines.push(`Job ${args.job_id} not found in manifest.`);
    } else {
      lines.push('No tracked jobs. Use job_register after sbatch.');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ---- job_log ----
  if (name === 'job_log') {
    const { job_id, task_id, stderr } = args;
    const host = args.cluster || 'qtm';
    const nlines = args.lines || 50;
    const ext = stderr ? 'err' : 'out';

    let cmd;
    if (task_id) {
      cmd = `find ~ -maxdepth 5 -name "*-${job_id}_${task_id}.${ext}" -newer ~/.cluster-status/manifest.tsv 2>/dev/null | head -1`;
    } else {
      cmd = `find ~ -maxdepth 5 -name "*-${job_id}_*.${ext}" 2>/dev/null | xargs ls -t 2>/dev/null | head -1`;
    }

    try {
      const logFile = execSync(`ssh ${host} '${cmd}'`, {
        encoding: 'utf8', timeout: 15000,
      }).trim();

      if (!logFile) {
        return { content: [{ type: 'text', text: `No log file found for job ${job_id}${task_id ? ' task ' + task_id : ''} on ${host}.` }] };
      }

      const logContent = execSync(`ssh ${host} 'tail -${nlines} "${logFile}"'`, {
        encoding: 'utf8', timeout: 15000,
      });

      return { content: [{ type: 'text', text: `${logFile}:\n\n${logContent}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to read log: ${e.message}` }], isError: true };
    }
  }

  // ---- timer (non-blocking) ----
  if (name === 'timer') {
    const seconds = Math.min(Math.max(args.seconds || 10, 1), 600);
    const message = args.message || 'Timer fired';
    const state = loadState();
    const agent = (state.agents || []).find(a => a.id === AGENT_ID);
    if (agent) {
      if (!agent._timers) agent._timers = [];
      const timerId = `timer-${Date.now()}`;
      agent._timers.push({
        id: timerId,
        until: new Date(Date.now() + seconds * 1000).toISOString(),
        message,
      });
      saveState(state);
      // Fire after delay: deliver message to self via state file
      setTimeout(() => {
        try {
          const s = loadState();
          // Add message to self
          if (!s.messages) s.messages = [];
          s.messages.push({
            to: AGENT_ID,
            from: AGENT_ID,
            text: `⏰ ${message}`,
            timestamp: new Date().toISOString(),
            read: false,
            _timer: true,
          });
          // Remove this timer from agent state
          const a = (s.agents || []).find(a => a.id === AGENT_ID);
          if (a?._timers) {
            a._timers = a._timers.filter(t => t.id !== timerId);
            if (a._timers.length === 0) delete a._timers;
          }
          saveState(s);
          // Kick self via kitty if we have a window
          if (a?.kitty_win) {
            try { kickAgent(a.kitty_win); } catch {}
          }
        } catch {}
      }, seconds * 1000);
    }
    return { content: [{ type: 'text', text: `Timer set: ${seconds}s → "${message}". You'll get 📬 when it fires.` }] };
  }

  // ---- watch_highlights ----
  if (name === 'watch_highlights') {
    if (!isManager) return { content: [{ type: 'text', text: 'Manager only.' }], isError: true };
    const action = args.action;
    const state = loadState();
    if (!state.highlight_watchers) state.highlight_watchers = [];

    if (action === 'list') {
      if (state.highlight_watchers.length === 0) {
        return { content: [{ type: 'text', text: 'No active highlight watchers.' }] };
      }
      const lines = state.highlight_watchers.map(w => {
        const a = getAgent(state, w.agent);
        const label = a?.friendly_name || w.agent;
        return `- **${w.doc}** → ${label}`;
      });
      return { content: [{ type: 'text', text: `Active watchers:\n${lines.join('\n')}` }] };
    }

    if (action === 'stop') {
      if (!args.doc) return { content: [{ type: 'text', text: 'Missing doc parameter.' }], isError: true };
      state.highlight_watchers = state.highlight_watchers.filter(w => w.doc !== args.doc);
      saveState(state);
      return { content: [{ type: 'text', text: `Stopped watching "${args.doc}".` }] };
    }

    if (action === 'start') {
      if (!args.doc || !args.agent) return { content: [{ type: 'text', text: 'Missing doc or agent parameter.' }], isError: true };
      const agent = getAgent(state, args.agent);
      const agentId = agent ? agent.id : args.agent;
      state.highlight_watchers = state.highlight_watchers.filter(w => w.doc !== args.doc);
      state.highlight_watchers.push({ doc: args.doc, agent: agentId });
      saveState(state);
      const label = agent?.friendly_name || agentId;
      return { content: [{ type: 'text', text: `Watching "${args.doc}" → highlights delivered to ${label}. Dashboard bridge will pick this up within 10s.` }] };
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
  }

  // ---- playback_record ----
  if (name === 'playback_record') {
    const sources = args.sources;
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return { content: [{ type: 'text', text: 'At least one source is required.' }], isError: true };
    }

    const allEvents = [];
    const sourceMeta = [];

    for (const src of sources) {
      if (src.type === 'session') {
        if (!src.id) {
          return { content: [{ type: 'text', text: 'Session source requires an id (session UUID).' }], isError: true };
        }
        const extractor = new SessionExtractor();
        const events = extractor.extract(src.id, { project: src.project, start: args.start, end: args.end });
        allEvents.push(...events);
        sourceMeta.push({ type: 'session', id: src.id, project: src.project });
      } else if (src.type === 'events') {
        const extractor = new EventExtractor();
        const events = extractor.extract({ agents: src.agents, start: args.start, end: args.end });
        allEvents.push(...events);
        sourceMeta.push({ type: 'events', agents: src.agents });
      } else if (src.type === 'tlda') {
        if (!src.project) {
          return { content: [{ type: 'text', text: 'tlda source requires a project name.' }], isError: true };
        }
        const extractor = new TldaExtractor();
        const events = extractor.extract(src.project, { start: args.start, end: args.end });
        allEvents.push(...events);
        sourceMeta.push({ type: 'tlda', project: src.project });
      }
    }

    if (allEvents.length === 0) {
      return { content: [{ type: 'text', text: 'No events found for the given sources and time range.' }] };
    }

    const result = createPlayback({
      title: args.title,
      sources: sourceMeta,
      events: allEvents,
      start: args.start,
      end: args.end,
    });

    logEvent({ type: 'playback_record', from: AGENT_ID || 'unknown', playbackId: result.id, eventCount: result.event_count, title: args.title });

    return { content: [{ type: 'text', text: `Playback created: ${result.id}\n\nTitle: ${result.title}\nEvents: ${result.event_count}\nDuration: ${(result.duration_ms / 1000).toFixed(1)}s\nSources: ${result.sources}` }] };
  }

  // ---- playback_list ----
  if (name === 'playback_list') {
    const playbacks = listPlaybacks({ project: args.project, agent: args.agent, limit: args.limit });

    if (playbacks.length === 0) {
      return { content: [{ type: 'text', text: 'No playbacks found.' }] };
    }

    const lines = playbacks.map(pb => {
      const types = Object.entries(pb.event_types).map(([k, v]) => `${k}:${v}`).join(', ');
      return `**${pb.title}** (${pb.id.slice(0, 8)})\n  ${pb.event_count} events (${types}) | ${(pb.duration_ms / 1000).toFixed(0)}s | ${new Date(pb.created).toLocaleString()}`;
    });

    return { content: [{ type: 'text', text: `${playbacks.length} playback(s):\n\n${lines.join('\n\n')}` }] };
  }

  // ---- playback_get ----
  if (name === 'playback_get') {
    if (!args.id) {
      return { content: [{ type: 'text', text: 'Playback ID is required.' }], isError: true };
    }

    const playback = getPlayback(args.id, args.format || 'full');
    if (!playback) {
      return { content: [{ type: 'text', text: `Playback ${args.id} not found.` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(playback, null, 2) }] };
  }

  // ---- playback_edit ----
  if (name === 'playback_edit') {
    if (!args.id || !args.operations) {
      return { content: [{ type: 'text', text: 'Playback ID and operations are required.' }], isError: true };
    }

    const result = editPlayback(args.id, args.operations);
    if (!result) {
      return { content: [{ type: 'text', text: `Playback ${args.id} not found.` }], isError: true };
    }

    return { content: [{ type: 'text', text: `Edited playback ${result.id}: ${result.edit_count} edit(s), ${result.event_count} events.` }] };
  }

  // ---- playback_transcript ----
  if (name === 'playback_transcript') {
    if (!args.id) {
      return { content: [{ type: 'text', text: 'Playback ID is required.' }], isError: true };
    }

    const result = playbackTranscript(args.id, {
      startT: args.start_ms || 0,
      endT: args.end_ms,
      types: args.types,
      density: args.density || false,
      windowMs: args.window_ms || 60000,
    });
    if (!result) {
      return { content: [{ type: 'text', text: `Playback ${args.id} not found.` }], isError: true };
    }

    return { content: [{ type: 'text', text: result.transcript }] };
  }

  // ---- share ----
  if (name === 'share') {
    const filePath = args.path;
    if (!filePath) {
      return { content: [{ type: 'text', text: 'Path is required.' }], isError: true };
    }

    // Resolve the file
    const resolved = path.resolve(filePath);
    let content;
    try {
      content = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read file: ${e.message}` }], isError: true };
    }

    // Generate doc name from filename if not provided
    const basename = path.basename(resolved, path.extname(resolved));
    const docName = (args.doc || basename).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!docName) {
      return { content: [{ type: 'text', text: 'Could not generate a valid doc name. Provide one explicitly.' }], isError: true };
    }

    // Extract title from first heading or use provided title
    let title = args.title;
    if (!title) {
      const headingMatch = content.match(/^#\s+(.+)$/m);
      title = headingMatch ? headingMatch[1].trim() : basename;
    }

    const mainFile = path.basename(resolved);

    try {
      // Check if project exists
      const check = await tldaFetch(docName);
      if (check.status === 404) {
        // Create project
        const createRes = await tldaFetch('', {
          method: 'POST',
          body: { name: docName, title, format: 'markdown', mainFile },
        });
        if (createRes.status >= 400) {
          return { content: [{ type: 'text', text: `Failed to create tlda project: ${JSON.stringify(createRes.data)}` }], isError: true };
        }
      }

      // Push file content
      const pushRes = await tldaFetch(docName + '/push', {
        method: 'POST',
        body: {
          files: [{ path: mainFile, content }],
          sourceDir: path.dirname(resolved),
          session: CLAUDE_SESSION,
        },
      });
      if (pushRes.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to push to tlda: ${JSON.stringify(pushRes.data)}` }], isError: true };
      }

      // Track shared doc in state
      const state = loadState();
      if (!state.shared_docs) state.shared_docs = [];
      const existing = state.shared_docs.find(d => d.doc === docName);
      if (existing) {
        existing.updated_at = new Date().toISOString();
        existing.path = resolved;
        existing.agent = AGENT_ID;
      } else {
        state.shared_docs.push({
          doc: docName,
          path: resolved,
          title,
          agent: AGENT_ID,
          shared_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      saveState(state);
      logEvent({ type: 'share', agent: AGENT_ID, doc: docName, path: resolved, title });

      return { content: [{ type: 'text', text: `Shared "${title}" as tlda doc: **${docName}**\nFile: ${resolved}\nThe doc is now live on the canvas for review. Use \`check_doc_feedback("${docName}")\` to read highlight feedback.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}. Is tlda running on port ${TLDA_PORT}?` }], isError: true };
    }
  }

  // ---- check_doc_feedback ----
  if (name === 'check_doc_feedback') {
    const doc = args.doc;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Doc name is required.' }], isError: true };
    }

    try {
      // Read pen/highlighter annotations from tlda
      const shapesRes = await tldaFetch(doc + '/shapes?type=highlight,draw');
      if (shapesRes.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to read shapes: ${JSON.stringify(shapesRes.data)}` }], isError: true };
      }

      const shapes = Array.isArray(shapesRes.data) ? shapesRes.data : [];

      // Also read math-note annotations (sticky notes with text feedback)
      const notesRes = await tldaFetch(doc + '/shapes?type=math-note');
      const notes = Array.isArray(notesRes.data) ? notesRes.data : [];

      // Read the source file for line content extraction
      const state = loadState();
      const sharedDoc = (state.shared_docs || []).find(d => d.doc === doc);
      let sourceLines = [];
      if (sharedDoc?.path) {
        try { sourceLines = fs.readFileSync(sharedDoc.path, 'utf8').split('\n'); } catch {}
      }

      // Process highlights into structured feedback
      const feedback = [];

      for (const shape of shapes) {
        const color = shape.props?.color || shape.meta?.color || 'orange';
        const theme = HIGHLIGHT_THEMES[color] || { type: 'comment', label: color };
        const startLine = shape.meta?.sourceAnchor?.startLine || shape.meta?.startLine;
        const endLine = shape.meta?.sourceAnchor?.endLine || shape.meta?.endLine || startLine;

        if (!startLine) continue; // Skip shapes without source anchors

        // Extract the highlighted text from source
        const text = sourceLines.length > 0
          ? sourceLines.slice(startLine - 1, endLine).join('\n')
          : `(lines ${startLine}-${endLine})`;

        feedback.push({
          type: theme.type,
          label: theme.label,
          color,
          lines: [startLine, endLine],
          text,
          shapeId: shape.id,
        });
      }

      // Process sticky notes as text feedback
      for (const note of notes) {
        if (note.meta?.createdBy === 'claude') continue; // Skip agent's own notes
        const anchor = note.meta?.sourceAnchor;
        const line = anchor?.line || anchor?.startLine;
        feedback.push({
          type: 'note',
          label: 'Text feedback',
          color: note.props?.color || 'yellow',
          lines: line ? [line, anchor?.endLine || line] : null,
          text: note.props?.text || '',
          done: note.props?.done || false,
          shapeId: note.id,
        });
      }

      if (feedback.length === 0) {
        return { content: [{ type: 'text', text: `No feedback on "${doc}" yet. The doc is on the canvas — waiting for highlights.` }] };
      }

      // Format feedback summary
      const summary = feedback.map(f => {
        const lineRef = f.lines ? `L${f.lines[0]}${f.lines[1] !== f.lines[0] ? '-' + f.lines[1] : ''}` : '';
        const icon = { approve: '✅', reject: '❌', question: '❓', expand: '💡', comment: '💬', note: '📝', info: 'ℹ️' }[f.type] || '•';
        return `${icon} **${f.type}** ${lineRef}: ${f.text.slice(0, 200)}${f.text.length > 200 ? '...' : ''}`;
      }).join('\n');

      return { content: [{ type: 'text', text: `**Feedback on "${doc}"** (${feedback.length} items):\n\n${summary}\n\n---\nRaw feedback:\n${JSON.stringify(feedback, null, 2)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}. Is tlda running?` }], isError: true };
    }
  }

  // ---- suggest ----
  if (name === 'suggest') {
    const { doc, text } = args;
    if (!doc || !text) {
      return { content: [{ type: 'text', text: 'Doc and text are required.' }], isError: true };
    }

    const choices = args.choices || ['Accept', 'Reject', 'Modify'];
    const color = args.color || 'orange';
    const line = args.line || null;
    const replyTo = args.reply_to || null;

    try {
      if (replyTo) {
        // Reply to an existing annotation thread
        const replyRes = await tldaFetch(doc + '/shapes', {
          method: 'POST',
          body: {
            type: 'math-note',
            props: { text, color, choices },
            meta: { createdBy: 'claude', replyTo, sourceAnchor: line ? { line } : undefined },
          },
        });
        if (replyRes.status >= 400) {
          return { content: [{ type: 'text', text: `Failed to post reply: ${JSON.stringify(replyRes.data)}` }], isError: true };
        }
        logEvent({ type: 'suggest', agent: AGENT_ID, doc, line, replyTo, text: text.slice(0, 200) });
        return { content: [{ type: 'text', text: `Posted reply on "${doc}" ${line ? 'at L' + line : ''} (replying to ${replyTo}). Choices: ${choices.join(', ')}` }] };
      } else {
        // Create new suggestion note
        const noteRes = await tldaFetch(doc + '/shapes', {
          method: 'POST',
          body: {
            type: 'math-note',
            props: { text, color, choices },
            meta: { createdBy: 'claude', sourceAnchor: line ? { line } : undefined },
          },
        });
        if (noteRes.status >= 400) {
          return { content: [{ type: 'text', text: `Failed to post suggestion: ${JSON.stringify(noteRes.data)}` }], isError: true };
        }
        logEvent({ type: 'suggest', agent: AGENT_ID, doc, line, text: text.slice(0, 200) });
        return { content: [{ type: 'text', text: `Posted suggestion on "${doc}" ${line ? 'at L' + line : ''}. Choices: ${choices.join(', ')}` }] };
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- update_shared_doc ----
  if (name === 'update_shared_doc') {
    const doc = args.doc;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Doc name is required.' }], isError: true };
    }

    const state = loadState();
    const sharedDoc = (state.shared_docs || []).find(d => d.doc === doc);
    if (!sharedDoc) {
      return { content: [{ type: 'text', text: `Doc "${doc}" not found in shared docs. Share it first with share().` }], isError: true };
    }

    let content;
    try {
      content = fs.readFileSync(sharedDoc.path, 'utf8');
    } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read file: ${e.message}` }], isError: true };
    }

    const mainFile = path.basename(sharedDoc.path);

    try {
      const pushRes = await tldaFetch(doc + '/push', {
        method: 'POST',
        body: {
          files: [{ path: mainFile, content }],
          sourceDir: path.dirname(sharedDoc.path),
          session: CLAUDE_SESSION,
        },
      });
      if (pushRes.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to push update: ${JSON.stringify(pushRes.data)}` }], isError: true };
      }

      sharedDoc.updated_at = new Date().toISOString();
      saveState(state);
      logEvent({ type: 'update_doc', agent: AGENT_ID, doc, path: sharedDoc.path });

      return { content: [{ type: 'text', text: `Updated "${doc}" on tlda. The canvas will reload with the new content.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
