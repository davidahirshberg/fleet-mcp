#!/usr/bin/env node
/**
 * Agent Manager MCP Server
 *
 * Tracks delegated agent tasks across sessions. Tools:
 *   - delegate(win, description, message)   send task + record
 *   - chat(win, message)                    send non-task message (no tracking)
 *   - wait_for_idle(win, timeout)            block until agent idle
 *   - wait_for_any(timeout)                  block until ANY pending agent idle
 *   - task_list()                            show pending tasks
 *   - task_done(win)                         mark complete
 *   - task_check(win)                        snapshot window now
 *   - register_manager()                     register as manager, start keepalive
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

// ---- State helpers ----

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { }
  }
  return { tasks: [] };
}

function saveState(state) {
  fs.mkdirSync(`${os.homedir()}/.claude`, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getTask(state, win) {
  return state.tasks.find(t => t.win === win && t.status !== 'done');
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
        // All deps done — send the deferred message and activate
        if (t.deferredMessage) {
          try { sendMessage(t.win, `[You are agent in kitty window ${t.win}. Use chat() to report progress, results, or issues — don't wait to be checked on.] ${t.deferredMessage}`); } catch { }
          delete t.deferredMessage;
        }
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
  const callerWin = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN) : null;
  const state = loadState();
  if (!callerWin) return 'Cannot identify caller — $AGENT_WIN not set.';
  if (state.manager_win !== callerWin) return `Only the manager (win ${state.manager_win ?? 'unregistered'}) can do this. You are win ${callerWin}.`;
  return null;
}

// ---- Agent window helpers ----

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
  // Claude Code UI chrome appears after the prompt — skip it all
  // Horizontal rules (─), status bar (? for shortcuts, esc to interrupt, etc.)
  // "esc to interrupt" means agent is actively working — not idle
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

function sendEnter(win) {
  const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
  if (sock) execSync(`kitty @ --to "unix:${sock}" send-key --match id:${win} enter`, { timeout: 5000 });
}

function hasUnsubmittedText(output) {
  // Detect text sitting at the ❯ prompt without having been submitted.
  // After a successful send+enter, the agent starts working (no ❯ line visible)
  // or shows response output. If ❯ has text after it, enter didn't fire.
  const lines = output.split('\n').filter(l => l.trim());
  const chromePattern = /^[\s─━═\-]+$|^\s*(\?|esc |[0-9]+ bash|\u2193|Context left|Tip:|ctrl\+)/;
  const filtered = lines.filter(l => !chromePattern.test(l));
  if (!filtered.length) return false;
  const last = filtered[filtered.length - 1];
  // ❯ with text after it = unsubmitted input (but not UI messages like "Press up to edit")
  if (/Press up to edit|queued messages/.test(last)) return false;
  return /^[❯>]\s+\S/.test(last);
}

function sendMessage(win, message) {
  // agent-ask accepts win + message; use shell so message can contain special chars
  const escaped = message.replace(/'/g, `'\\''`);
  execSync(`${BIN}/agent-ask ${win} '${escaped}'`, { timeout: 15000 });

  // Verify the enter went through — agent-ask's send-text + send-key is racy.
  // Check for text sitting at the ❯ prompt (sent but not submitted).
  execSync('sleep 0.5');
  const result = readWindow(win);
  if (result.ok && hasUnsubmittedText(result.text)) {
    // Text at prompt — enter didn't fire. Retry.
    sendEnter(win);
    execSync('sleep 0.5');
    const retry = readWindow(win);
    if (retry.ok && hasUnsubmittedText(retry.text)) {
      // Still stuck after retry
      throw new Error(`Message sent to win ${win} but enter failed after retry — text sitting at prompt`);
    }
  }
}

// ---- MCP server ----

const server = new Server(
  { name: 'agent-manager', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'delegate',
      description: 'Send a task to an agent window and record it in persistent state. Returns task ID.',
      inputSchema: {
        type: 'object',
        properties: {
          win: { type: 'number', description: 'Kitty window ID' },
          description: { type: 'string', description: 'Short human-readable description of the task (5-10 words)' },
          message: { type: 'string', description: 'Full message to send to the agent' },
          after: { description: 'Task ID or array of task IDs that must complete before this task starts. Message is deferred until all dependencies are done.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
        required: ['win', 'description', 'message'],
      },
    },
    {
      name: 'wait_for_idle',
      description: 'Block until the agent in window WIN hits an idle prompt (❯), then return the window tail. Polls every INTERVAL seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          win: { type: 'number', description: 'Kitty window ID' },
          timeout: { type: 'number', description: 'Max seconds to wait (default 1800)' },
          interval: { type: 'number', description: 'Poll interval in seconds (default 60)' },
        },
        required: ['win'],
      },
    },
    {
      name: 'wait_for_any',
      description: 'Block until ANY pending/in-progress agent goes idle. Returns which window went idle and its tail. Use this instead of wait_for_idle when managing multiple agents.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: { type: 'number', description: 'Max seconds to wait (default 1800)' },
          interval: { type: 'number', description: 'Poll interval in seconds (default 60)' },
        },
      },
    },
    {
      name: 'task_list',
      description: 'List all active (non-done) delegated tasks. Call at session start to see what is pending.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'task_done',
      description: 'Mark the active task for a window as done.',
      inputSchema: {
        type: 'object',
        properties: {
          win: { type: 'number', description: 'Kitty window ID' },
        },
        required: ['win'],
      },
    },
    {
      name: 'task_check',
      description: 'Snapshot the current state of an agent window. Updates task status if idle.',
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
      description: 'Show what task is assigned to this window. Uses $AGENT_WIN to identify the calling agent. Returns task description, status, age, and any dependency info.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'chat',
      description: 'Send a message to another agent. If win is omitted, sends to the manager. Workers: use this to report results, ask questions, or flag issues without waiting to be checked on.',
      inputSchema: {
        type: 'object',
        properties: {
          win: { type: 'number', description: 'Kitty window ID. Omit to send to the manager.' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['message'],
      },
    },
    {
      name: 'register_manager',
      description: 'Register the calling session as the manager. Window ID is auto-detected from $AGENT_WIN (set by the claude alias). The keepalive watcher kicks the manager (not workers) when there is pending work, idle agents, or cluster jobs.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ---- delegate ----
  if (name === 'delegate') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const { win, description, message } = args;
    const afterRaw = args.after;
    const blockedBy = afterRaw ? (Array.isArray(afterRaw) ? afterRaw : [afterRaw]) : [];

    const state = loadState();

    // Check if blocked by unfinished tasks
    const blocked = blockedBy.length > 0 && blockedBy.some(depId => {
      const dep = getTaskById(state, depId);
      return dep && dep.status !== 'done';
    });

    if (!blocked) {
      // Send immediately, prefixed with window identity
      try {
        sendMessage(win, `[You are agent in kitty window ${win}. Use chat() to report progress, results, or issues — don't wait to be checked on.] ${message}`);
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send message to win ${win}: ${e.message}` }], isError: true };
      }
    }

    // Replace any existing non-done task for this window
    state.tasks = state.tasks.filter(t => !(t.win === win && t.status !== 'done'));
    const taskId = `w${win}-${Date.now().toString(36)}`;
    const task = {
      id: taskId,
      win,
      description,
      delegated_at: now(),
      status: blocked ? 'blocked' : 'pending',
      last_checked: now(),
    };
    if (blocked) {
      task.blockedBy = blockedBy;
      task.deferredMessage = message;
    } else if (blockedBy.length > 0) {
      task.blockedBy = blockedBy; // record deps even if already done
    }
    state.tasks.push(task);
    saveState(state);

    const pendingCount = state.tasks.filter(t => t.status === 'pending').length;
    const blockedCount = state.tasks.filter(t => t.status === 'blocked').length;
    const idleWins = state.tasks.filter(t => t.status === 'idle').map(t => t.win);
    let nudge = `${pendingCount} pending`;
    if (blockedCount > 0) nudge += `, ${blockedCount} blocked`;
    nudge += '.';
    if (idleWins.length > 0) nudge += ` Idle agents available: win ${idleWins.join(', ')}. Any tasks for them?`;
    if (pendingCount > 0) nudge += ' Call wait_for_any() to monitor.';
    const statusMsg = blocked ? `Queued (blocked by ${blockedBy.join(', ')})` : 'Delegated';
    return {
      content: [{
        type: 'text',
        text: `${statusMsg} to win ${win} [${taskId}]: ${description}\n${nudge}`,
      }],
    };
  }

  // ---- wait_for_idle ----
  if (name === 'wait_for_idle') {
    const win = args.win;
    const timeoutMs = (args.timeout ?? 1800) * 1000;
    const intervalMs = (args.interval ?? 60) * 1000;
    const deadline = Date.now() + timeoutMs;

    // Check immediately first
    let result = readWindow(win);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Cannot read win ${win}: ${result.error}` }], isError: true };
    }
    if (isIdle(result.text)) {
      const state = loadState();
      const task = getTask(state, win);
      if (task) { task.status = 'idle'; task.last_checked = now(); saveState(state); }
      return { content: [{ type: 'text', text: `win ${win} already idle:\n${windowTail(result.text)}` }] };
    }

    // Poll loop
    while (Date.now() < deadline) {
      const wait = Math.min(intervalMs, deadline - Date.now());
      await new Promise(r => setTimeout(r, wait));
      result = readWindow(win);
      if (!result.ok) continue; // transient read failure, keep polling
      if (isIdle(result.text)) {
        const state = loadState();
        const task = getTask(state, win);
        if (task) { task.status = 'idle'; task.last_checked = now(); saveState(state); }
        return { content: [{ type: 'text', text: `win ${win} idle:\n${windowTail(result.text)}` }] };
      }
      // Update last_checked even while still working
      const state = loadState();
      const task = getTask(state, win);
      if (task) { task.last_checked = now(); saveState(state); }
    }

    return { content: [{ type: 'text', text: `Timeout waiting for win ${win} to go idle.` }], isError: true };
  }

  // ---- wait_for_any ----
  if (name === 'wait_for_any') {
    const maxTimeout = 600; // 10 min cap — don't let manager zone out in a wait loop
    const timeoutMs = Math.min(args.timeout ?? 600, maxTimeout) * 1000;
    const intervalMs = Math.min(args.interval ?? 60, 120) * 1000; // cap interval at 2 min
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const state = loadState();
      const pending = state.tasks.filter(t => t.status === 'pending');
      const blocked = state.tasks.filter(t => t.status === 'blocked');
      if (!pending.length) {
        const blockedMsg = blocked.length > 0 ? ` (${blocked.length} blocked — waiting on dependencies)` : '';
        return { content: [{ type: 'text', text: `No pending tasks to watch.${blockedMsg}` }] };
      }

      for (const task of pending) {
        const result = readWindow(task.win);
        if (!result.ok) continue; // transient read failure, skip this window
        if (isIdle(result.text)) {
          task.status = 'idle';
          task.last_checked = now();
          saveState(state);
          const remaining = state.tasks.filter(t => t.status === 'pending').length;
          const next = remaining > 0
            ? `\n\n${remaining} task(s) still pending. Review this output: what follow-up tasks does it suggest? Delegate them now. Then call wait_for_any() again.`
            : '\n\nNo other pending tasks. Review this output: what follow-up tasks does it suggest? What gaps remain? If nothing obvious, look around — check project scratch files, TODOs, open questions, recent discussion. Try to find useful work before going idle. Only report to user if genuinely nothing remains.';
          return {
            content: [{
              type: 'text',
              text: `win ${task.win} idle [${task.id}: ${task.description}]:\n${windowTail(result.text)}${next}`,
            }],
          };
        }
      }

      // Update last_checked for all pending
      for (const task of pending) { task.last_checked = now(); }
      saveState(state);

      const wait = Math.min(intervalMs, deadline - Date.now());
      await new Promise(r => setTimeout(r, wait));
    }

    return { content: [{ type: 'text', text: 'Timeout waiting for any agent to go idle.' }], isError: true };
  }

  // ---- task_list ----
  if (name === 'task_list') {
    const state = loadState();
    const active = state.tasks.filter(t => t.status !== 'done');
    if (!active.length) {

      return { content: [{ type: 'text', text: 'No active delegated tasks.' }] };
    }
    // Refresh status from actual window state
    let changed = false;
    for (const t of active) {
      if (t.status === 'pending') {
        const result = readWindow(t.win);
        if (result.ok && isIdle(result.text)) {
          t.status = 'idle';
          t.last_checked = now();
          changed = true;
        }
      }
    }
    if (changed) saveState(state);

    const lines = active.map(t => {
      const age = Math.round((Date.now() - new Date(t.delegated_at)) / 60000);
      let status = t.status;
      if (t.status === 'blocked' && t.blockedBy) {
        status = `blocked by ${t.blockedBy.join(', ')}`;
      }
      if (t.status === 'pending' && age > 1440) {
        status = `pending [stale — ${Math.round(age / 60)}h, check window]`;
      }
      return `[${t.id}] win ${t.win} | ${status} | ${t.description} | ${age}m ago`;
    });
    const pending = active.filter(t => t.status === 'pending');
    const idle = active.filter(t => t.status === 'idle');
    const blocked = active.filter(t => t.status === 'blocked');
    let nudge = '';
    if (idle.length > 0) nudge = `\n\n${idle.length} idle — review their output. What follow-up tasks does it suggest? Delegate or mark done.`;
    if (pending.length > 0) nudge += `${nudge ? ' ' : '\n\n'}${pending.length} pending — call wait_for_any() to monitor.`;
    if (blocked.length > 0) nudge += ` ${blocked.length} blocked — waiting on dependencies.`;
    if (idle.length > 0 && pending.length === 0 && blocked.length === 0) nudge += ' Are there additional tasks to delegate?';
    return { content: [{ type: 'text', text: lines.join('\n') + nudge }] };
  }

  // ---- task_done ----
  if (name === 'task_done') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const task = getTask(state, args.win);
    if (!task) {
      return { content: [{ type: 'text', text: `No active task for win ${args.win}.` }] };
    }
    task.status = 'done';
    task.completed_at = now();
    // Auto-unblock dependents
    const unblocked = unblockDependents(state, task.id);
    saveState(state);
    const remaining = state.tasks.filter(t => t.status === 'pending' || t.status === 'idle').length;
    const blockedRemaining = state.tasks.filter(t => t.status === 'blocked').length;
    let msg = `Marked win ${args.win} task done: ${task.description}.`;
    if (unblocked.length > 0) {
      msg += `\nUnblocked ${unblocked.length} task(s): ${unblocked.map(t => `[${t.id}] win ${t.win}: ${t.description}`).join('; ')}`;
    }
    const active = remaining + blockedRemaining;
    if (active > 0) {
      msg += ` ${remaining} pending, ${blockedRemaining} blocked — review idle agents or call wait_for_any().`;
    } else {
      msg += ' All tasks complete. What does the completed work enable? What gaps remain? Look around — check scratch files, TODOs, open questions, recent discussion, project state. Find useful work before going idle. Only report to user if genuinely nothing remains.';
    }
    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- task_check ----
  if (name === 'task_check') {
    const win = args.win;
    const result = readWindow(win);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Cannot read win ${win}: ${result.error}` }], isError: true };
    }
    const idle = isIdle(result.text);

    const state = loadState();
    const task = getTask(state, win);
    if (task) {
      if (idle) task.status = 'idle';
      task.last_checked = now();
      saveState(state);
    }

    const statusStr = idle ? 'IDLE' : 'WORKING';
    let taskStr = ' [no recorded task]';
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      let depInfo = '';
      if (task.blockedBy && task.blockedBy.length > 0) {
        depInfo = ` (blocked by ${task.blockedBy.join(', ')})`;
      }
      taskStr = ` [${task.id}: ${task.description} | ${age}m ago${depInfo}]`;
    }

    // Nudge about other agents to fight tunnel vision
    const others = state.tasks.filter(t => t.status !== 'done' && t.win !== win);
    const otherIdle = others.filter(t => t.status === 'idle');
    const otherStale = others.filter(t => t.status === 'pending' && (Date.now() - new Date(t.last_checked)) > 600000);
    let nudge = '';
    if (otherIdle.length > 0) {
      nudge += `\n\n⚠ ${otherIdle.length} other agent(s) idle: ${otherIdle.map(t => `win ${t.win} (${t.description})`).join(', ')}. Check on them before diving deeper here.`;
    }
    if (otherStale.length > 0) {
      nudge += `\n\n⚠ ${otherStale.length} agent(s) not checked in 10+ min: ${otherStale.map(t => `win ${t.win} (${t.description})`).join(', ')}.`;
    }

    return {
      content: [{
        type: 'text',
        text: `win ${win} ${statusStr}${taskStr}:\n${windowTail(result.text)}${nudge}`,
      }],
    };
  }

  // ---- my_task ----
  if (name === 'my_task') {
    const win = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN) : null;
    if (!win) {
      return { content: [{ type: 'text', text: '$AGENT_WIN not set. Launch claude with the alias.' }], isError: true };
    }
    const state = loadState();
    const task = getTask(state, win);
    if (!task) {
      return { content: [{ type: 'text', text: `No active task assigned to win ${win}.` }] };
    }
    const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
    let depInfo = '';
    if (task.blockedBy && task.blockedBy.length > 0) {
      const depDetails = task.blockedBy.map(id => {
        const dep = getTaskById(state, id);
        return dep ? `${id} (${dep.description} — ${dep.status})` : `${id} (unknown)`;
      });
      depInfo = `\nBlocked by: ${depDetails.join(', ')}`;
    }
    const others = state.tasks.filter(t => t.status !== 'done' && t.win !== win);
    let othersInfo = '';
    if (others.length > 0) {
      othersInfo = '\n\nOther active tasks:\n' + others.map(t => `  win ${t.win} | ${t.status} | ${t.description}`).join('\n');
    }
    return { content: [{ type: 'text', text: `Your task [${task.id}]: ${task.description}\nStatus: ${task.status} | ${age}m ago${depInfo}${othersInfo}\n\nReminder: Use chat() to report progress, results, issues, or questions — don't wait to be checked on.` }] };
  }

  // ---- chat ----
  if (name === 'chat') {
    const { message } = args;
    const callerWin = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN) : null;
    let win = args.win;
    if (!win) {
      const state = loadState();
      win = state.manager_win;
      if (!win) return { content: [{ type: 'text', text: 'No win specified and no manager registered.' }], isError: true };
    }
    const prefix = callerWin ? `[win ${callerWin}] ` : '';
    try {
      sendMessage(win, `${prefix}${message}`);
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to send to win ${win}: ${e.message}` }], isError: true };
    }

    // Warn manager if chat() looks like it should be delegate()
    const state = loadState();
    let warning = '';
    if (callerWin && state.manager_win === callerWin && message.length > 200) {
      warning = '\n\n⚠ This message is long (>200 chars). If you\'re assigning work, use delegate() instead — chat() bypasses task tracking, so keepalive and task_list won\'t know about it.';
    }

    return { content: [{ type: 'text', text: `Sent to win ${win}.${warning}` }] };
  }

  // ---- register_manager ----
  if (name === 'register_manager') {
    const win = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN) : null;
    if (!win) {
      return { content: [{ type: 'text', text: '$AGENT_WIN not set. Launch claude with the alias (which sets AGENT_WIN=$KITTY_WINDOW_ID automatically).' }], isError: true };
    }
    const state = loadState();
    state.manager_win = win;
    saveState(state);

    // Start keepalive if not already running
    try {
      const existing = execSync(`pgrep -f ${BIN}/agent-keepalive`, { encoding: 'utf8', timeout: 5000 }).trim();
      // already running
    } catch {
      // not running — start it
      exec(`${BIN}/agent-keepalive`, { detached: true, stdio: 'ignore' }).unref();
    }

    return { content: [{ type: 'text', text: `Registered win ${win} as manager. Keepalive watcher running.\n\nRead ~/.claude/reference/managing-agents.md before proceeding.` }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
