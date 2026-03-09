#!/usr/bin/env node
/**
 * Agent Manager MCP Server v4.0
 *
 * Coordinates agents via shared state file + kitty kicks for notifications.
 * Agent identity = session UUID (auto-detected from most recent JSONL).
 * Kitty window IDs are metadata for notifications only.
 *
 * Tools:
 *   - register(manager?, session_id?)    register this agent (all agents call this)
 *   - delegate(agent, description, message)  assign task (manager only)
 *   - chat(message, to?)                 send message + kick recipient
 *   - wait_for_task(timeout?)            block until task/message arrives
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
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { SearchIndex } from './dashboard/search-index.mjs';
import { SessionExtractor, EventExtractor, TldaExtractor } from './playback/extractors.mjs';
import { createPlayback, getPlayback, listPlaybacks, editPlayback } from './playback/storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, 'bin');

const STATE_FILE = `${os.homedir()}/.claude/agent-tasks.json`;
const LOG_FILE = `${os.homedir()}/.claude/agent-messages.jsonl`;

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
// Kitty window ID — used only for notifications (kicking agents)
const KITTY_WIN = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN)
  : process.env.KITTY_WINDOW_ID ? parseInt(process.env.KITTY_WINDOW_ID)
  : null;

// Agent identity = session UUID (auto-detected from most recent JSONL)
// When multiple sessions share a project dir, prefer the one actively being
// written (mtime within last 30s) over the most-recently-modified overall.
// This avoids picking a stale session that another agent happened to touch.
function detectSessionId() {
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

const MY_SESSION = detectSessionId();
let MY_FLEET_ID = null;
let ME = MY_SESSION;

// ---- State helpers ----

// Wait for state file to change, or timeout. Replaces blind polling.
function waitForStateChange(maxMs) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => { watcher.close(); resolve(); }, maxMs);
    let watcher;
    try {
      watcher = fs.watch(STATE_FILE, { persistent: false }, () => {
        clearTimeout(timeout);
        watcher.close();
        resolve();
      });
      watcher.on('error', () => {
        clearTimeout(timeout);
        watcher.close();
        resolve();
      });
    } catch {
      // fs.watch failed (file doesn't exist yet, etc.) — fall back to timeout
      clearTimeout(timeout);
      setTimeout(resolve, Math.min(maxMs, 5000));
    }
  });
}

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
  if (ME) {
    const me = state.agents.find(a => a.id === ME);
    if (me) {
      me.last_seen = new Date().toISOString();
      // Clear compacting flag — agent is alive and making MCP calls
      delete me.compacting;
      delete me.compacting_since;
      // Track session history
      if (MY_SESSION) {
        if (!me.session_ids) me.session_ids = [];
        if (me.session_id && !me.session_ids.includes(me.session_id)) me.session_ids.push(me.session_id);
        if (!me.session_ids.includes(MY_SESSION)) me.session_ids.push(MY_SESSION);
        me.session_id = MY_SESSION;
      }
    }
  }

  // Prune: drop done tasks older than 24h, read messages older than 1h
  const now_ = Date.now();
  state.tasks = state.tasks.filter(t => {
    if (t.status !== 'done') return true;
    return (now_ - new Date(t.completed_at || t.delegated_at).getTime()) < 86400000;
  });
  state.messages = state.messages.filter(m => {
    if (!m.read) return true;
    return (now_ - new Date(m.timestamp).getTime()) < 3600000;
  });

  fs.mkdirSync(`${os.homedir()}/.claude`, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getTask(state, agent) {
  return state.tasks.find(t => t.agent === agent && t.status !== 'done');
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

function requireManager() {
  if (!ME) return 'Cannot identify caller — no session ID detected.';
  const state = loadState();
  const agent = getAgent(state, ME);
  if (agent?.is_manager) return null;
  return `Only a manager can do this. You are ${ME} (not a manager).`;
}

// Check if the calling manager can manage a specific agent.
// All managers are peers — any manager can manage any agent.
function requireAuthOver(state, targetId) {
  if (!ME) return 'Cannot identify caller.';
  return null;
}

// ---- Agent registry ----

function getAgent(state, id) {
  if (!state.agents) return null;
  // Exact match on id, name, friendly_name, or session_id
  const exact = state.agents.find(a =>
    a.id === id || a.name === id || a.friendly_name === id ||
    a.session_id === id || (a.session_ids && a.session_ids.includes(id))
  );
  if (exact) return exact;
  // Prefix match on id (must be unambiguous)
  const prefixMatches = state.agents.filter(a => a.id.startsWith(id));
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

function removeAgent(state, id) {
  if (!state.agents) return;
  state.agents = state.agents.filter(a => a.id !== id && a.name !== id && a.friendly_name !== id);
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

// Lazy cleanup: check if agent's kitty window still exists. Remove if not.
function checkAgent(state, id) {
  const agent = getAgent(state, id);
  if (!agent) return false;
  if (agent.kitty_win) {
    if (!kittyWindowExists(agent.kitty_win)) {
      removeAgent(state, id);
      saveState(state);
      return false;
    }
  }
  return true;
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
      description: 'Send a message to another agent (or the manager if "to" is omitted). Writes to state file; recipient is notified via fs.watch.',
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
      name: 'wait_for_task',
      description: 'Block until a task or message arrives for this agent. Call this when idle. Returns the task message or chat messages.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: { type: 'number', description: 'Max seconds to wait (default 600)' },
        },
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
      description: 'Apply editing operations to a playback. Supports: trim (select time range), annotate (add markers), speed (adjust playback speed for regions).',
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
                op: { type: 'string', enum: ['trim', 'annotate', 'speed'], description: 'Operation type' },
                start_ms: { type: 'number', description: 'Start time in ms (for trim, speed)' },
                end_ms: { type: 'number', description: 'End time in ms (for trim, speed)' },
                t: { type: 'number', description: 'Timestamp in ms (for annotate)' },
                text: { type: 'string', description: 'Annotation text (for annotate)' },
                factor: { type: 'number', description: 'Speed multiplier (for speed)' },
              },
              required: ['op'],
            },
          },
        },
        required: ['id', 'operations'],
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

    // Need either a session UUID or a name
    if (!MY_SESSION && !agentName) {
      return { content: [{ type: 'text', text: 'No session ID detected and no name provided. Pass session_id or name for headless agents.' }], isError: true };
    }

    const state = loadState();
    if (!state.agents) state.agents = [];

    const sessionId = args.session_id || MY_SESSION;

    // 3-way identity matching:
    // 1. Match by session_id → same agent, known session
    let existingAgent = null;
    if (sessionId) {
      existingAgent = state.agents.find(a =>
        a.session_id === sessionId ||
        (a.session_ids && a.session_ids.includes(sessionId))
      );
    }
    // 2. Match by kitty_win (active <30min) → post-compaction same window
    if (!existingAgent && KITTY_WIN) {
      const candidate = state.agents.find(a => a.kitty_win === KITTY_WIN);
      if (candidate?.last_seen) {
        const seenAgo = Date.now() - new Date(candidate.last_seen).getTime();
        if (seenAgo < 30 * 60 * 1000) {
          existingAgent = candidate;
          logEvent({ type: 'identity_match', agent: candidate.id, reason: `kitty_win ${KITTY_WIN} match (${Math.round(seenAgo/1000)}s ago), new session ${sessionId}` });
        }
      }
    }
    // 3. Match by name (headless agents)
    if (!existingAgent && agentName) {
      existingAgent = state.agents.find(a => a.name === agentName);
    }

    let entry;
    if (existingAgent) {
      // Update existing agent — preserve identity, update session
      entry = existingAgent;
      entry.registered_at = now();
      if (KITTY_WIN) entry.kitty_win = KITTY_WIN;
      if (agentName) entry.name = agentName;
      // Track session history
      if (sessionId) {
        if (!entry.session_ids) entry.session_ids = [];
        if (entry.session_id && !entry.session_ids.includes(entry.session_id)) {
          entry.session_ids.push(entry.session_id);
        }
        if (!entry.session_ids.includes(sessionId)) {
          entry.session_ids.push(sessionId);
        }
        entry.session_id = sessionId;
      }
    } else {
      // New agent — fleet ID = first session ID (or name for headless)
      const fleetId = sessionId || agentName;
      entry = {
        id: fleetId,
        registered_at: now(),
      };
      if (KITTY_WIN) entry.kitty_win = KITTY_WIN;
      if (agentName) entry.name = agentName;
      if (sessionId) {
        entry.session_id = sessionId;
        entry.session_ids = [sessionId];
      }
      state.agents.push(entry);
    }

    entry.last_seen = now();
    // Clear compacting flag (set by PreCompact hook) — agent is back
    delete entry.compacting;
    delete entry.compacting_since;
    // Capture working directory for respawn
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

    // Deregister any OTHER agent on the same kitty window — prevents stale
    // registrations from lingering after session restart
    if (KITTY_WIN) {
      const stale = state.agents.filter(a => a.kitty_win === KITTY_WIN && a.id !== entry.id);
      for (const s of stale) {
        logEvent({ type: 'deregister', agent: s.id, reason: `kitty window ${KITTY_WIN} claimed by ${entry.id}` });
        removeAgent(state, s.id);
      }
    }

    // Remove legacy top-of-chain singleton — all managers are peers
    delete state.manager;

    // Start keepalive if this is the first manager (or restart if stale)
    if (isManager) {
      const aliveManagers = state.agents.filter(a => a.is_manager && agentAlive(a));
      if (aliveManagers.length <= 1) {
        // First live manager — ensure keepalive is running
        try { execSync(`pkill -f agent-keepalive`, { timeout: 5000 }); } catch {}
        exec(`${BIN}/agent-keepalive`, { detached: true, stdio: 'ignore' }).unref();
      }
    }

    // Set this process's fleet identity
    MY_FLEET_ID = entry.id;
    ME = MY_FLEET_ID;

    saveState(state);

    const agentCount = state.agents.length;
    const role = isManager ? 'manager' : 'agent';
    let msg = `Registered ${entry.id} as ${role}. ${agentCount} agent(s) registered.`;

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
      msg += '\n\nWhen you see 📬 as input, call my_task() — it means you have a new task or message.';
      if (refExists) {
        msg += '\nSee ~/.claude/reference/managing-agents.md for how to work with the manager.';
      } else {
        msg += `\nSee ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    }

    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- unregister_manager ----
  if (name === 'unregister_manager') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const oldAgent = getAgent(state, ME);
    if (oldAgent) delete oldAgent.is_manager;
    // Clean up legacy top-of-chain field if present
    delete state.manager;
    saveState(state);
    return { content: [{ type: 'text', text: 'Stepped down as manager.' }] };
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
      if (agentEntry) agentEntry.friendly_name = args.friendly_name;
    }

    const blocked = blockedBy.length > 0 && blockedBy.some(depId => {
      const dep = getTaskById(state, depId);
      return dep && dep.status !== 'done';
    });

    // Replace any existing non-done task for this agent
    state.tasks = state.tasks.filter(t => !(t.agent === agent && t.status !== 'done'));
    // Task ID: use first 8 chars of UUID or agent name for readability
    const shortId = typeof agent === 'string' ? agent.slice(0, 8) : `w${agent}`;
    const taskId = `${shortId}-${Date.now().toString(36)}`;
    const task = {
      id: taskId,
      agent,
      description,
      message,
      delegated_by: ME,
      delegated_at: now(),
      status: blocked ? 'blocked' : 'pending',
      last_checked: now(),
    };
    if (blockedBy.length > 0) task.blockedBy = blockedBy;
    state.tasks.push(task);
    saveState(state);
    logEvent({ type: 'delegate', from: ME, to: agent, task_id: taskId, description, message });

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
      const myTask = ME ? state.tasks?.find(t => t.agent === ME && t.status !== 'done') : null;
      if (myTask?.delegated_by) {
        to = myTask.delegated_by;
      } else {
        // Fall back to any live manager
        const mgr = (state.agents || []).find(a => a.is_manager && a.id !== ME && agentAlive(a));
        to = mgr?.id; // no legacy state.manager fallback
      }
      if (!to) return { content: [{ type: 'text', text: 'No recipient specified and no manager registered.' }], isError: true };
    } else if (to === 'web' || to === 'skip' || to === 'human') {
      // Route to the dashboard — message is saved to state, dashboard picks it up via SSE
      to = 'web';
    } else {
      // Resolve friendly name to canonical ID
      const toEntry = getAgent(state, to);
      if (!toEntry) return { content: [{ type: 'text', text: `Recipient "${to}" not registered.` }], isError: true };
      to = toEntry.id;
    }
    const from = ME || 'unknown';
    postMessage(state, to, from, message);
    saveState(state);
    logEvent({ type: 'chat', from, to, message });

    let warning = '';
    const callerAgent = ME ? getAgent(state, ME) : null;
    if (callerAgent?.is_manager && message.length > 200) {
      warning = '\n\n⚠ Long message (>200 chars). If assigning work, use delegate() instead.';
    }

    const toRegistered = !!getAgent(state, to);
    const notifyMsg = (!toRegistered && to !== 'web') ? ' ⚠ recipient not registered — message saved but no way to notify' : '';
    return { content: [{ type: 'text', text: `Message queued for ${to}${notifyMsg}.${warning}` }] };
  }

  // ---- wait_for_task ----
  if (name === 'wait_for_task') {
    if (!ME) return { content: [{ type: 'text', text: 'No session ID detected.' }], isError: true };
    const timeoutMs = Math.min(args.timeout ?? 600, 600) * 1000;
    const intervalMs = 5000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const state = loadState();

      // Check for unread messages first
      const unread = getUnread(state, ME);
      if (unread.length > 0) {
        markRead(state, ME);
        saveState(state);
        const formatted = unread.map(m => `[from ${m.from}] ${m.text}`).join('\n\n');
        return { content: [{ type: 'text', text: `Messages received:\n\n${formatted}` }] };
      }

      // Check for blocked tasks whose deps are all done — transition to pending
      for (const t of state.tasks) {
        if (t.agent === ME && t.status === 'blocked' && !isBlocked(state, t)) {
          t.status = 'pending';
        }
      }

      // Check for a pending task assigned to me
      const task = state.tasks.find(t => t.agent === ME && t.status === 'pending' && !t.acknowledged);
      if (task) {
        task.acknowledged = true;
        task.status = 'working';
        task.last_checked = now();
        saveState(state);
        return {
          content: [{
            type: 'text',
            text: `Task assigned [${task.id}]: ${task.description}\n\n${task.message}\n\nUse chat() to report progress, results, or issues. Call task_done() when finished.`,
          }],
        };
      }

      // Wait for state file change (fs.watch) instead of blind polling
      await waitForStateChange(Math.min(intervalMs, deadline - Date.now()));
    }

    return { content: [{ type: 'text', text: 'No task or message received (timeout). Call wait_for_task() again to keep waiting.' }] };
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
      if (t.status === 'blocked' && t.blockedBy) {
        status = `blocked by ${t.blockedBy.join(', ')}`;
      }
      if ((t.status === 'pending' || t.status === 'working') && age > 1440) {
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

    const unread = ME ? getUnread(state, ME) : [];

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
    const agent = args.agent ? args.agent : ME;
    if (!agent) return { content: [{ type: 'text', text: 'No agent specified and no session ID detected.' }], isError: true };

    if (agent !== ME) {
      const guard = requireManager();
      if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    }

    const state = loadState();

    if (agent !== ME) {
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
    if (agent === ME) {
      msg += '\n\nCall wait_for_task() to wait for your next assignment.';
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
    if (!ME) return { content: [{ type: 'text', text: 'No session ID detected.' }], isError: true };
    const state = loadState();
    const task = getTask(state, ME);
    const unread = getUnread(state, ME);

    let text = '';
    let dirty = false;
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
      text = `Your task [${task.id}]: ${task.description}\nStatus: ${task.status} | ${age}m ago${depInfo}`;
      if (task.message && !task.message_shown) {
        text += `\n\n${task.message}\n\nUse chat() to report progress, results, or issues. Call task_done() when finished.`;
        task.message_shown = true;
        dirty = true;
      }
    } else {
      text = `Nothing new.`;
    }

    if (unread.length > 0) {
      markRead(state, ME);
      dirty = true;
      const formatted = unread.map(m => `[from ${m.from}] ${m.text}`).join('\n\n');
      text += `\n\n📬 Messages:\n\n${formatted}`;
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
    agent.friendly_name = friendlyName;
    saveState(state);
    const msg = oldName
      ? `Renamed ${agent.id}: "${oldName}" → "${friendlyName}"`
      : `Named ${agent.id}: "${friendlyName}"`;
    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- respawn ----
  if (name === 'respawn') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const agentId = args.agent;
    const state = loadState();
    const agent = getAgent(state, agentId);
    if (!agent) return { content: [{ type: 'text', text: `Agent ${agentId} not found in registry.` }], isError: true };
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

    // Build the command: cd to cwd if available, then claude --resume
    const parts = [];
    if (agent.cwd) parts.push(`cd ${JSON.stringify(agent.cwd)}`);
    parts.push(`claude --resume ${agent.session_id}`);
    const cmd = parts.join(' && ');

    // Send the resume command directly via kitty (not agent-kick — we need to send actual text, not 📬)
    try {
      const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (!sock) throw new Error('no kitty socket found');
      const escaped = cmd.replace(/\\/g, '\\\\');
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" "${escaped}"`, { encoding: 'utf8', timeout: 10000 });
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" '\\r'`, { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to send to kitty win ${targetWin}: ${e.message}` }], isError: true };
    }

    // Update registry: new kitty window
    agent.kitty_win = targetWin;
    saveState(state);

    const label = agent.friendly_name || agent.name || agent.id;
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

      // Send claude command
      const cmd = `cd ${JSON.stringify(cwd)} && claude`;
      const escaped = cmd.replace(/\\/g, '\\\\');
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" "${escaped}"`, { encoding: 'utf8', timeout: 10000 });
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" '\\r'`, { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to spawn: ${e.message}` }], isError: true };
    }

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
      pinned_by: ME || 'unknown',
    };
    refs.push(ref);
    fs.writeFileSync(refsFile, JSON.stringify(refs, null, 2));
    logEvent({ type: 'pin_ref', from: ME || 'unknown', ref_type: args.type, label: args.label });
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
      // Collect all matching agent IDs (name, friendly_name, session_id)
      const matches = (state.agents || []).filter(a =>
        a.id === args.agent || a.name === args.agent || a.friendly_name === args.agent ||
        a.id.startsWith(args.agent)
      );
      const ids = new Set();
      for (const a of matches) {
        ids.add(a.id);
        if (a.session_id) ids.add(a.session_id);
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
      from: ME || 'unknown',
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
      const from = m.from === 'web' ? 'skip' : (getAgent(state, m.from)?.friendly_name || m.from?.slice?.(0, 8) || m.from);
      const to = m.to === 'web' ? 'skip' : (getAgent(state, m.to)?.friendly_name || m.to?.slice?.(0, 8) || m.to);
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
      postMessage(state, entry.id, ME || 'manager', message);
      saveState(state);
      logEvent({ type: 'chat', from: ME || 'manager', to: entry.id, message });
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
      targets.push(...state.agents.filter(a => a.kitty_win && a.id !== ME));
    }
    const results = [];
    for (const t of targets) {
      try {
        // Send /mcp + Enter via kitty to trigger Claude Code's MCP restart
        const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 3000 }).trim();
        execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${t.kitty_win}" '/mcp\n'`, { timeout: 5000 });
        results.push(`${t.friendly_name || t.id}: sent`);
      } catch {
        results.push(`${t.friendly_name || t.id}: failed`);
      }
    }
    return { content: [{ type: 'text', text: `MCP restart → ${targets.length} agent(s):\n${results.join('\n')}` }] };
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

    logEvent({ type: 'playback_record', from: ME || 'unknown', playbackId: result.id, eventCount: result.event_count, title: args.title });

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

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
