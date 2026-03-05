#!/usr/bin/env node
/**
 * Agent Manager MCP Server v3.0
 *
 * Coordinates agents via shared state file + kitty kicks for notifications.
 * All agents register at startup. Communication goes through the state file;
 * kitty sends a nudge so agents know to check.
 *
 * Tools:
 *   - register(manager?, session_id?)    register this agent (all agents call this)
 *   - delegate(agent, description, message)  assign task (manager only)
 *   - chat(message, to?)                 send message + kick recipient
 *   - wait_for_task(timeout?)            block until task/message arrives
 *   - wait_for_any(timeout?)             block until any agent reports
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, 'bin');

const STATE_FILE = `${os.homedir()}/.claude/agent-tasks.json`;
const ME = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN) : null;

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
  if (!ME) return 'Cannot identify caller — $AGENT_WIN not set.';
  const state = loadState();
  if (state.manager !== ME) return `Only the manager (win ${state.manager ?? 'unregistered'}) can do this. You are win ${ME}.`;
  return null;
}

// Resolve agent identifier — accepts number (kitty win ID) or string (agent name)
function resolveAgent(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && /^\d+$/.test(val)) return parseInt(val);
  return val; // string agent name (e.g. "todd")
}

// ---- Agent registry ----

function getAgent(state, id) {
  if (!state.agents) return null;
  return state.agents.find(a => a.id === id || a.kitty_win === id || a.name === id);
}

function removeAgent(state, id) {
  if (!state.agents) return;
  state.agents = state.agents.filter(a => a.id !== id && a.kitty_win !== id && a.name !== id);
}

function kittyWindowExists(win) {
  try {
    execSync(`${BIN}/agent-read ${win} 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
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

function kickAgent(kittyWin, message) {
  try {
    execSync(`${BIN}/agent-ask ${kittyWin} ${JSON.stringify(message)}`, {
      encoding: 'utf8', timeout: 10000,
    });
    return true;
  } catch {
    return false;
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

function isIdle(output) {
  const lines = output.split('\n').filter(l => l.trim());
  if (!lines.length) return false;
  if (lines.some(l => /esc to interrupt/.test(l))) return false;
  const chromePattern = /^[\s─━═\-]+$|^\s*(\?|esc |[0-9]+ bash|\u2193|Context left|Tip:)/;
  const filtered = lines.filter(l => !chromePattern.test(l));
  if (!filtered.length) return false;
  const last = filtered[filtered.length - 1];
  return /^[❯>]\s*$/.test(last);
}

function windowTail(output, n = 40) {
  return output.split('\n').slice(-n).join('\n');
}

// Kick an agent via kitty if they have a window. Returns whether kick was sent.
function notifyAgent(state, agentId, message) {
  const agent = getAgent(state, agentId);
  if (!agent || !agent.kitty_win) return false;
  const sent = kickAgent(agent.kitty_win, message);
  if (!sent) {
    // Window gone — clean up
    removeAgent(state, agentId);
    saveState(state);
  }
  return sent;
}

// ---- MCP server ----

const server = new Server(
  { name: 'agent-manager', version: '3.0.0' },
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
          session_id: { type: 'string', description: 'Claude session ID (for JSONL lookup)' },
          name: { type: 'string', description: 'Agent name (for headless agents without kitty window)' },
        },
      },
    },
    {
      name: 'delegate',
      description: 'Assign a task to an agent. Kicks the agent via kitty so they know to check. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: ['number', 'string'], description: 'Agent identifier — kitty window ID (number) or agent name (string, e.g. "todd")' },
          description: { type: 'string', description: 'Short human-readable description (5-10 words)' },
          message: { type: 'string', description: 'Full task message for the agent' },
          after: { description: 'Task ID or array of IDs — deferred until all complete.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
        required: ['agent', 'description', 'message'],
      },
    },
    {
      name: 'chat',
      description: 'Send a message to another agent (or the manager if "to" is omitted). Writes to state file and kicks recipient via kitty.',
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
      name: 'wait_for_any',
      description: 'Block until any agent reports (chat message to manager, task completion, or status change). Manager use.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: { type: 'number', description: 'Max seconds to wait (default 600)' },
          interval: { type: 'number', description: 'Poll interval in seconds (default 15)' },
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
          agent: { type: ['number', 'string'], description: 'Agent identifier. Omit to mark own task done.' },
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
      description: 'Step down as manager. Pass "to" to hand it to a specific agent. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: ['number', 'string'], description: 'Agent to pass manager role to. Omit to just vacate.' },
        },
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

    // Need either AGENT_WIN or a name
    if (!ME && !agentName) {
      return { content: [{ type: 'text', text: '$AGENT_WIN not set and no name provided. Set AGENT_WIN or pass name for headless agents.' }], isError: true };
    }

    const state = loadState();
    if (!state.agents) state.agents = [];

    const id = ME || agentName;

    // Guard: can't claim manager if someone else already is
    if (isManager && state.manager && state.manager !== id) {
      return { content: [{ type: 'text', text: `Manager already registered (${state.manager}). Only the current manager can re-register as manager.` }], isError: true };
    }

    // Upsert: remove old entry for this agent
    removeAgent(state, id);

    const entry = {
      id,
      registered_at: now(),
    };
    if (ME) entry.kitty_win = ME;
    if (agentName) entry.name = agentName;
    if (args.session_id) entry.session_id = args.session_id;
    if (isManager) entry.is_manager = true;

    state.agents.push(entry);

    if (isManager) {
      state.manager = id;
      // Start keepalive if not already running
      try {
        execSync(`pgrep -f ${BIN}/agent-keepalive`, { encoding: 'utf8', timeout: 5000 });
      } catch {
        exec(`${BIN}/agent-keepalive`, { detached: true, stdio: 'ignore' }).unref();
      }
    }

    saveState(state);

    const agentCount = state.agents.length;
    let msg = `Registered ${id}${isManager ? ' as manager' : ''}. ${agentCount} agent(s) registered.`;

    const refPath = `${os.homedir()}/.claude/reference/managing-agents.md`;
    const repoRefPath = path.join(__dirname, 'managing-agents.md');
    const refExists = fs.existsSync(refPath);

    if (isManager) {
      msg += ' Keepalive watcher running.';
      if (refExists) {
        msg += '\n\nRead ~/.claude/reference/managing-agents.md before proceeding.';
      } else {
        msg += `\n\n⚠ ~/.claude/reference/managing-agents.md not found. Symlink it:\n  ln -s ${repoRefPath} ${refPath}\n\nFor now, read ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    } else {
      if (refExists) {
        msg += '\n\nSee ~/.claude/reference/managing-agents.md for how to work with the manager.';
      } else {
        msg += `\n\nSee ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
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

    const to = args.to != null ? resolveAgent(args.to) : null;
    if (to) {
      const newManager = getAgent(state, to);
      if (!newManager) return { content: [{ type: 'text', text: `Agent ${to} not registered.` }], isError: true };
      newManager.is_manager = true;
      state.manager = to;
      saveState(state);
      notifyAgent(state, to, `You are now the manager. Call register_manager() to start keepalive. — former manager (win ${ME})`);
      return { content: [{ type: 'text', text: `Passed manager to ${to}.` }] };
    }

    delete state.manager;
    saveState(state);
    return { content: [{ type: 'text', text: `Stepped down as manager. Manager slot is now open.` }] };
  }

  // ---- delegate ----
  if (name === 'delegate') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const agent = resolveAgent(args.agent);
    const { description, message } = args;
    const afterRaw = args.after;
    const blockedBy = afterRaw ? (Array.isArray(afterRaw) ? afterRaw : [afterRaw]) : [];

    const state = loadState();

    const blocked = blockedBy.length > 0 && blockedBy.some(depId => {
      const dep = getTaskById(state, depId);
      return dep && dep.status !== 'done';
    });

    // Replace any existing non-done task for this agent
    state.tasks = state.tasks.filter(t => !(t.agent === agent && t.status !== 'done'));
    const taskId = `${typeof agent === 'string' ? agent : 'w' + agent}-${Date.now().toString(36)}`;
    const task = {
      id: taskId,
      agent,
      ...(typeof agent === 'number' ? { win: agent } : {}),
      description,
      message,
      delegated_at: now(),
      status: blocked ? 'blocked' : 'pending',
      last_checked: now(),
    };
    if (blockedBy.length > 0) task.blockedBy = blockedBy;
    state.tasks.push(task);
    saveState(state);

    // Kick agent via kitty if not blocked
    let kicked = false;
    if (!blocked) {
      kicked = notifyAgent(state, agent, `New task assigned: ${description}. Call wait_for_task() to receive it.`);
    }

    const pendingCount = state.tasks.filter(t => t.status === 'pending').length;
    const blockedCount = state.tasks.filter(t => t.status === 'blocked').length;
    let nudge = `${pendingCount} pending`;
    if (blockedCount > 0) nudge += `, ${blockedCount} blocked`;
    nudge += '.';
    if (pendingCount > 0) nudge += ' Call wait_for_any() to monitor.';
    const statusMsg = blocked ? `Queued (blocked by ${blockedBy.join(', ')})` : 'Delegated';
    const kickMsg = kicked ? ' (kicked)' : (!blocked && getAgent(state, agent) ? ' (no kitty window — agent must poll)' : '');
    return {
      content: [{
        type: 'text',
        text: `${statusMsg} to ${agent} [${taskId}]: ${description}${kickMsg}\n${nudge}`,
      }],
    };
  }

  // ---- chat ----
  if (name === 'chat') {
    const { message } = args;
    let to = args.to != null ? resolveAgent(args.to) : null;
    if (to == null) {
      const state = loadState();
      to = state.manager;
      if (!to) return { content: [{ type: 'text', text: 'No recipient specified and no manager registered.' }], isError: true };
    }
    const from = ME || 'unknown';
    const state = loadState();
    postMessage(state, to, from, message);
    saveState(state);

    // Kick recipient
    const kicked = notifyAgent(state, to, `New message from ${from}. Call my_task() to read it.`);

    let warning = '';
    if (ME && state.manager === ME && message.length > 200) {
      warning = '\n\n⚠ Long message (>200 chars). If assigning work, use delegate() instead.';
    }

    const kickMsg = kicked ? ' (kicked)' : '';
    return { content: [{ type: 'text', text: `Message queued for ${to}${kickMsg}.${warning}` }] };
  }

  // ---- wait_for_task ----
  if (name === 'wait_for_task') {
    if (!ME) return { content: [{ type: 'text', text: '$AGENT_WIN not set.' }], isError: true };
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

      await new Promise(r => setTimeout(r, intervalMs));
    }

    return { content: [{ type: 'text', text: 'No task or message received (timeout). Call wait_for_task() again to keep waiting.' }] };
  }

  // ---- wait_for_any ----
  if (name === 'wait_for_any') {
    const timeoutMs = Math.min(args.timeout ?? 600, 600) * 1000;
    const intervalMs = Math.min(args.interval ?? 15, 120) * 1000;
    const deadline = Date.now() + timeoutMs;

    let lastState = loadState();
    const seenMessageCount = (lastState.messages || []).filter(m => m.to === ME).length;

    while (Date.now() < deadline) {
      const state = loadState();

      // Check for new messages to manager
      const myMessages = (state.messages || []).filter(m => m.to === ME);
      if (myMessages.length > seenMessageCount) {
        const newMsgs = myMessages.slice(seenMessageCount);
        for (const m of newMsgs) m.read = true;
        saveState(state);
        const formatted = newMsgs.map(m => `[from ${m.from}] ${m.text}`).join('\n\n');
        const pending = state.tasks.filter(t => t.status === 'pending' || t.status === 'working').length;
        const next = pending > 0
          ? `\n\n${pending} task(s) still active. Call wait_for_any() again.`
          : '\n\nNo active tasks.';
        return {
          content: [{
            type: 'text',
            text: `Incoming message(s):\n\n${formatted}${next}`,
          }],
        };
      }

      // Check for tasks that became idle
      const nowIdle = state.tasks.filter(t => t.status === 'idle');
      const wasIdle = lastState.tasks.filter(t => t.status === 'idle').map(t => t.id);
      const newlyIdle = nowIdle.filter(t => !wasIdle.includes(t.id));
      if (newlyIdle.length > 0) {
        const t = newlyIdle[0];
        const remaining = state.tasks.filter(tt => tt.status === 'pending' || tt.status === 'working').length;
        const next = remaining > 0
          ? `\n\n${remaining} task(s) still active. Call wait_for_any() again.`
          : '\n\nNo other active tasks.';
        return {
          content: [{
            type: 'text',
            text: `Agent ${t.agent} idle [${t.id}: ${t.description}]${next}`,
          }],
        };
      }

      // Check for newly done tasks
      const nowDone = state.tasks.filter(t => t.status === 'done');
      const wasDone = lastState.tasks.filter(t => t.status === 'done').map(t => t.id);
      const newlyDone = nowDone.filter(t => !wasDone.includes(t.id));
      if (newlyDone.length > 0) {
        const t = newlyDone[0];
        const remaining = state.tasks.filter(tt => tt.status !== 'done' && tt.status !== 'blocked').length;
        const next = remaining > 0
          ? `\n\n${remaining} task(s) still active. Call wait_for_any() again.`
          : '\n\nNo other active tasks.';
        return {
          content: [{
            type: 'text',
            text: `Agent ${t.agent} completed [${t.id}: ${t.description}]${next}`,
          }],
        };
      }

      lastState = state;
      const wait = Math.min(intervalMs, deadline - Date.now());
      await new Promise(r => setTimeout(r, wait));
    }

    return { content: [{ type: 'text', text: 'Timeout. Call wait_for_any() again to keep monitoring.' }], isError: true };
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
        let label = `${a.id}`;
        if (a.name) label += ` (${a.name})`;
        if (a.is_manager) label += ' [manager]';
        if (a.session_id) label += ` session:${a.session_id.slice(0, 8)}`;
        if (a.kitty_win) label += ` kitty:${a.kitty_win}`;
        return label;
      });
      text += `Agents: ${agentLines.join(', ')}\n\n`;
    }

    if (!active.length) {
      text += 'No active tasks.';
      return { content: [{ type: 'text', text }] };
    }

    const lines = active.map(t => {
      const age = Math.round((Date.now() - new Date(t.delegated_at)) / 60000);
      let status = t.status;
      if (t.status === 'blocked' && t.blockedBy) {
        status = `blocked by ${t.blockedBy.join(', ')}`;
      }
      if ((t.status === 'pending' || t.status === 'working') && age > 1440) {
        status += ` [stale — ${Math.round(age / 60)}h]`;
      }
      return `[${t.id}] ${t.agent} | ${status} | ${t.description} | ${age}m ago`;
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
    if (working.length > 0) nudge += `\n\n${working.length} working — call wait_for_any() to monitor.`;
    if (pending.length > 0) nudge += ` ${pending.length} pending (awaiting agent pickup).`;
    if (blocked.length > 0) nudge += ` ${blocked.length} blocked.`;
    return { content: [{ type: 'text', text: text + nudge }] };
  }

  // ---- task_done ----
  if (name === 'task_done') {
    const agent = args.agent ? resolveAgent(args.agent) : ME;
    if (!agent) return { content: [{ type: 'text', text: 'No agent specified and $AGENT_WIN not set.' }], isError: true };

    if (agent !== ME) {
      const guard = requireManager();
      if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    }

    const state = loadState();
    const task = getTask(state, agent);
    if (!task) {
      return { content: [{ type: 'text', text: `No active task for ${agent}.` }] };
    }
    task.status = 'done';
    task.completed_at = now();
    const unblocked = unblockDependents(state, task.id);
    saveState(state);

    // Kick newly unblocked agents
    for (const u of unblocked) {
      notifyAgent(state, u.agent, `Task unblocked: ${u.description}. Call wait_for_task() to receive it.`);
    }

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
    const idle = isIdle(result.text);

    const state = loadState();
    const task = state.tasks.find(t => (t.win === win || t.agent === win) && t.status !== 'done');
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
    if (!ME) return { content: [{ type: 'text', text: '$AGENT_WIN not set.' }], isError: true };
    const state = loadState();
    const task = getTask(state, ME);
    const unread = getUnread(state, ME);

    let text = '';
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      let depInfo = '';
      if (task.blockedBy && task.blockedBy.length > 0) {
        const depDetails = task.blockedBy.map(id => {
          const dep = getTaskById(state, id);
          return dep ? `${id} (${dep.description} — ${dep.status})` : `${id} (unknown)`;
        });
        depInfo = `\nBlocked by: ${depDetails.join(', ')}`;
      }
      text = `Your task [${task.id}]: ${task.description}\nStatus: ${task.status} | ${age}m ago${depInfo}`;
    } else {
      text = `No active task for win ${ME}.`;
    }

    if (unread.length > 0) {
      // Read and return the messages inline
      markRead(state, ME);
      saveState(state);
      const formatted = unread.map(m => `[from ${m.from}] ${m.text}`).join('\n\n');
      text += `\n\n📬 Messages:\n\n${formatted}`;
    }

    return { content: [{ type: 'text', text }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
