/**
 * Playback extractors — read raw log formats and emit normalized playback events.
 *
 * Three extractors:
 *   - SessionExtractor: reads JSONL session logs → user_text, assistant_text, tool_call, tool_result
 *   - EventExtractor: reads agent-messages.jsonl → chat, delegate, task_done
 *   - TldaExtractor: reads changelog.jsonl → annotation, stroke
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const LOG_FILE = path.join(os.homedir(), '.claude', 'agent-messages.jsonl');
const TLDA_PROJECTS_DIR = path.join(os.homedir(), 'work', 'claude-tldraw', 'server', 'projects');

/**
 * Extract events from a Claude Code session JSONL file.
 *
 * Each JSONL line has: { type, uuid, parentUuid, sessionId, timestamp, message: { role, content[] } }
 * Content items are: { type: "text" }, { type: "tool_use", name, input }, { type: "tool_result", tool_use_id, content }
 */
export class SessionExtractor {
  /**
   * @param {string} sessionId - Session UUID
   * @param {object} opts
   * @param {string} opts.project - Project directory name (e.g. "-Users-skip-work-fleet")
   * @param {string} opts.start - ISO timestamp (inclusive)
   * @param {string} opts.end - ISO timestamp (inclusive)
   */
  extract(sessionId, opts = {}) {
    const filePath = this._findSessionFile(sessionId, opts.project);
    if (!filePath) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    const events = [];
    const startMs = opts.start ? new Date(opts.start).getTime() : -Infinity;
    const endMs = opts.end ? new Date(opts.end).getTime() : Infinity;

    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;

      const ts = parsed.timestamp || parsed.message?.timestamp;
      if (!ts) continue;
      const tsMs = new Date(ts).getTime();
      if (tsMs < startMs || tsMs > endMs) continue;

      const contentArr = parsed.message?.content;
      if (!contentArr) continue;

      const items = Array.isArray(contentArr) ? contentArr : [{ type: 'text', text: contentArr }];

      for (const item of items) {
        if (item.type === 'text' && item.text) {
          events.push({
            ts: tsMs,
            type: parsed.type === 'user' ? 'user_text' : 'assistant_text',
            source: 'session',
            sourceId: sessionId,
            data: { text: item.text },
          });
        } else if (item.type === 'tool_use') {
          events.push({
            ts: tsMs,
            type: 'tool_call',
            source: 'session',
            sourceId: sessionId,
            data: {
              tool: item.name,
              toolUseId: item.id,
              input: item.input,
            },
          });
          // Extract name/label changes from fleet MCP tool calls
          const toolName = item.name || '';
          const inp = item.input || {};
          if (toolName.endsWith('__name_agent') && inp.agent && inp.friendly_name) {
            events.push({
              ts: tsMs, type: 'name_change', source: 'session', sourceId: sessionId,
              data: { agent: inp.agent, friendly_name: inp.friendly_name },
            });
          } else if (toolName.endsWith('__delegate') && inp.friendly_name && inp.agent) {
            events.push({
              ts: tsMs, type: 'name_change', source: 'session', sourceId: sessionId,
              data: { agent: inp.agent, friendly_name: inp.friendly_name },
            });
          } else if (toolName.endsWith('__label_agent') && inp.agent && inp.labels) {
            events.push({
              ts: tsMs, type: 'label_change', source: 'session', sourceId: sessionId,
              data: { agent: inp.agent, labels: inp.labels },
            });
          }
        } else if (item.type === 'tool_result') {
          // Summarize large tool results
          const resultContent = typeof item.content === 'string' ? item.content
            : Array.isArray(item.content) ? item.content.map(c => c.text || '').join('\n')
            : JSON.stringify(item.content);
          const summary = resultContent.length > 500
            ? resultContent.slice(0, 500) + `... (${resultContent.length} chars)`
            : resultContent;
          events.push({
            ts: tsMs,
            type: 'tool_result',
            source: 'session',
            sourceId: sessionId,
            data: {
              toolUseId: item.tool_use_id,
              summary,
              content: resultContent,
            },
          });
        }
      }
    }

    return events;
  }

  _findSessionFile(sessionId, project) {
    // If project given, look directly
    if (project) {
      const fp = path.join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
      if (fs.existsSync(fp)) return fp;
    }
    // Search all project dirs
    try {
      const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
        try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
      });
      for (const dir of dirs) {
        const fp = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(fp)) return fp;
      }
    } catch { /* */ }
    return null;
  }
}

/**
 * Extract events from agent-messages.jsonl.
 * Each line: { type: "chat"|"delegate"|"task_done"|"search", from, to, message, timestamp }
 */
export class EventExtractor {
  /**
   * @param {object} opts
   * @param {string[]} opts.agents - Filter to these agent IDs
   * @param {string} opts.start - ISO timestamp
   * @param {string} opts.end - ISO timestamp
   */
  extract(opts = {}) {
    if (!fs.existsSync(LOG_FILE)) return [];

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    const events = [];
    const startMs = opts.start ? new Date(opts.start).getTime() : -Infinity;
    const endMs = opts.end ? new Date(opts.end).getTime() : Infinity;
    const agentSet = opts.agents ? new Set(opts.agents) : null;

    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      const evtType = parsed.type;
      if (!evtType || evtType === 'search') continue; // skip search events

      const ts = parsed.timestamp;
      if (!ts) continue;
      const tsMs = new Date(ts).getTime();
      if (tsMs < startMs || tsMs > endMs) continue;

      // Filter by agent involvement
      if (agentSet) {
        const involved = [parsed.from, parsed.to, parsed.agent].filter(Boolean);
        if (!involved.some(id => agentSet.has(id))) continue;
      }

      if (evtType === 'chat') {
        events.push({
          ts: tsMs,
          type: 'chat',
          source: 'events',
          data: {
            from: parsed.from,
            to: parsed.to,
            text: parsed.message || '',
          },
        });
      } else if (evtType === 'delegate') {
        events.push({
          ts: tsMs,
          type: 'delegate',
          source: 'events',
          data: {
            from: parsed.from,
            to: parsed.to,
            taskId: parsed.task_id,
            description: parsed.description || '',
            text: parsed.message || '',
          },
        });
      } else if (evtType === 'task_done') {
        events.push({
          ts: tsMs,
          type: 'task_done',
          source: 'events',
          data: {
            agent: parsed.agent,
            taskId: parsed.task_id,
            description: parsed.description || '',
          },
        });
      }
    }

    return events;
  }
}

/**
 * Extract events from tlda changelog.jsonl.
 * Each line: { ts, action: "create"|"update"|"delete", id, shapeType, state?, diff? }
 */
export class TldaExtractor {
  /**
   * @param {string} project - tlda project name (e.g. "bregman")
   * @param {object} opts
   * @param {string} opts.start - ISO timestamp
   * @param {string} opts.end - ISO timestamp
   */
  extract(project, opts = {}) {
    const filePath = path.join(TLDA_PROJECTS_DIR, project, 'changelog.jsonl');
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    const events = [];
    const startMs = opts.start ? new Date(opts.start).getTime() : -Infinity;
    const endMs = opts.end ? new Date(opts.end).getTime() : Infinity;

    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      const tsMs = parsed.ts;
      if (!tsMs || tsMs < startMs || tsMs > endMs) continue;

      const shapeType = parsed.shapeType || parsed.state?.type || 'unknown';
      const isPenLike = shapeType === 'draw' || shapeType === 'highlight';

      // Extract text content from the shape
      let text = '';
      if (parsed.state?.props?.text) {
        text = parsed.state.props.text;
      } else if (parsed.diff?.props?.to?.text) {
        text = parsed.diff.props.to.text;
      }

      // Extract source anchor if present
      const anchor = parsed.state?.meta?.sourceAnchor || parsed.diff?.meta?.to?.sourceAnchor || null;

      events.push({
        ts: tsMs,
        type: isPenLike ? 'stroke' : 'annotation',
        source: 'tlda',
        sourceId: project,
        data: {
          action: parsed.action,
          shapeId: parsed.id,
          shapeType,
          text,
          color: parsed.state?.props?.color || parsed.diff?.props?.to?.color || null,
          sourceAnchor: anchor,
        },
      });
    }

    return events;
  }
}
