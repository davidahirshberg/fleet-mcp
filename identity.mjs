/**
 * Fleet Identity Ledger
 *
 * Sqlite-backed authoritative mapping: fleet_id ↔ Claude session UUIDs.
 * See fleet-identity.md for the full design.
 *
 * Usage:
 *   import { ledger } from './identity.mjs';
 *   ledger.upsertAgent(fleetId, session, cwd, name);
 *   const agent = ledger.findBySession(sessionUUID);
 *   const agent = ledger.findByFleetId(fleetId);
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DB_PATH = path.join(os.homedir(), '.claude', 'fleet-identity.sqlite');
const ROSTER_DIR = path.join(os.homedir(), '.claude', 'fleet-roster');
const STATE_FILE = path.join(os.homedir(), '.claude', 'agent-tasks.json');

let _db = null;

function getDb() {
  if (_db) return _db;
  const needsMigration = !fs.existsSync(DB_PATH);
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      fleet_id TEXT PRIMARY KEY,
      session TEXT,
      cwd TEXT,
      name TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session TEXT PRIMARY KEY,
      fleet_id TEXT NOT NULL REFERENCES agents(fleet_id),
      cwd TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_fleet ON sessions(fleet_id);

    CREATE TABLE IF NOT EXISTS hosts (
      host TEXT PRIMARY KEY,
      fleet_id TEXT NOT NULL REFERENCES agents(fleet_id),
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_hosts_fleet ON hosts(fleet_id);
  `);

  // Migration: add type column if missing
  const cols = _db.pragma('table_info(agents)').map(c => c.name);
  if (!cols.includes('type')) {
    _db.exec(`ALTER TABLE agents ADD COLUMN type TEXT DEFAULT 'ai'`);
  }

  // Migrate from roster breadcrumbs + state file on first run
  if (needsMigration) {
    migrateFromRoster();
  }

  return _db;
}

function migrateFromRoster() {
  const db = _db;
  const now = new Date().toISOString();
  const imported = new Set();

  // 1. Import from roster breadcrumbs
  try {
    if (fs.existsSync(ROSTER_DIR)) {
      const files = fs.readdirSync(ROSTER_DIR).filter(f => f.endsWith('.json'));
      const insert = db.transaction(() => {
        for (const f of files) {
          try {
            const b = JSON.parse(fs.readFileSync(path.join(ROSTER_DIR, f), 'utf8'));
            if (!b.fleet_id) continue;
            if (imported.has(b.fleet_id)) continue;
            imported.add(b.fleet_id);

            db.prepare(`
              INSERT OR IGNORE INTO agents (fleet_id, session, cwd, name, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(b.fleet_id, b.session_id || null, b.cwd || null,
                   b.friendly_name || b.name || null, b.registered_at || now, now);

            // Insert all known sessions
            const sessions = b.session_ids || [];
            if (b.session_id && !sessions.includes(b.session_id)) sessions.push(b.session_id);
            for (const s of sessions) {
              db.prepare(`
                INSERT OR IGNORE INTO sessions (session, fleet_id, cwd, created_at)
                VALUES (?, ?, ?, ?)
              `).run(s, b.fleet_id, b.cwd || null, now);
            }
          } catch { continue; }
        }
      });
      insert();
    }
  } catch { /* roster dir missing */ }

  // 2. Import from state file (catches headless agents not in roster)
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const agents = state.agents || [];
      const insert = db.transaction(() => {
        for (const a of agents) {
          const fleetId = a.id;
          if (!fleetId || imported.has(fleetId)) continue;
          imported.add(fleetId);

          db.prepare(`
            INSERT OR IGNORE INTO agents (fleet_id, session, cwd, name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(fleetId, a.session_id || null, a.cwd || null,
                 a.friendly_name || a.name || null, a.registered_at || now, now);

          const sessions = a.session_ids || [];
          if (a.session_id && !sessions.includes(a.session_id)) sessions.push(a.session_id);
          for (const s of sessions) {
            db.prepare(`
              INSERT OR IGNORE INTO sessions (session, fleet_id, cwd, created_at)
              VALUES (?, ?, ?, ?)
            `).run(s, fleetId, a.cwd || null, now);
          }
        }
      });
      insert();
    }
  } catch { /* state file missing or invalid */ }
}

/** Look up an agent by fleet_id */
function findByFleetId(fleetId) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE fleet_id = ?').get(fleetId);
  if (!agent) return null;
  const sessions = db.prepare('SELECT session FROM sessions WHERE fleet_id = ?').all(fleetId).map(r => r.session);
  return { ...agent, sessions };
}

/** Look up an agent by Claude session UUID */
function findBySession(session) {
  const db = getDb();
  const row = db.prepare('SELECT fleet_id FROM sessions WHERE session = ?').get(session);
  if (!row) return null;
  return findByFleetId(row.fleet_id);
}

/** Look up an agent by display name */
function findByName(name) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
  if (!agent) return null;
  const sessions = db.prepare('SELECT session FROM sessions WHERE fleet_id = ?').all(agent.fleet_id).map(r => r.session);
  return { ...agent, sessions };
}

/** Create or update an agent in the ledger */
function upsertAgent(fleetId, session, cwd, name) {
  const db = getDb();
  const now = new Date().toISOString();

  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM agents WHERE fleet_id = ?').get(fleetId);
    if (existing) {
      // Update — preserve name if not provided
      db.prepare(`
        UPDATE agents SET session = COALESCE(?, session), cwd = COALESCE(?, cwd),
          name = COALESCE(?, name), updated_at = ?
        WHERE fleet_id = ?
      `).run(session, cwd, name, now, fleetId);
    } else {
      db.prepare(`
        INSERT INTO agents (fleet_id, session, cwd, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(fleetId, session, cwd, name, now, now);
    }

    // Record the session mapping
    if (session) {
      db.prepare(`
        INSERT OR REPLACE INTO sessions (session, fleet_id, cwd, created_at)
        VALUES (?, ?, ?, ?)
      `).run(session, fleetId, cwd, now);
    }
  })();
}

/** Update just the display name */
function updateName(fleetId, name) {
  const db = getDb();
  db.prepare('UPDATE agents SET name = ?, updated_at = ? WHERE fleet_id = ?')
    .run(name, new Date().toISOString(), fleetId);
}

/** List all agents in the ledger */
function listAgents() {
  const db = getDb();
  const agents = db.prepare('SELECT * FROM agents ORDER BY updated_at DESC').all();
  for (const a of agents) {
    a.sessions = db.prepare('SELECT session FROM sessions WHERE fleet_id = ?').all(a.fleet_id).map(r => r.session);
  }
  return agents;
}

/** Generate a deterministic fleet ID from user@host */
function fleetIdFromHost(userAtHost) {
  const hash = crypto.createHash('sha256').update(userAtHost).digest('hex').slice(0, 8);
  return `fleet:${hash}`;
}

/** Look up an agent by user@host */
function findByHost(userAtHost) {
  const db = getDb();
  const row = db.prepare('SELECT fleet_id FROM hosts WHERE host = ?').get(userAtHost);
  if (!row) return null;
  return findByFleetId(row.fleet_id);
}

/** Create or update a human agent in the ledger */
function upsertHuman(fleetId, userAtHost, name) {
  const db = getDb();
  const now = new Date().toISOString();

  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM agents WHERE fleet_id = ?').get(fleetId);
    if (existing) {
      db.prepare(`
        UPDATE agents SET name = COALESCE(?, name), type = 'human', updated_at = ?
        WHERE fleet_id = ?
      `).run(name, now, fleetId);
    } else {
      db.prepare(`
        INSERT INTO agents (fleet_id, session, cwd, name, type, created_at, updated_at)
        VALUES (?, NULL, NULL, ?, 'human', ?, ?)
      `).run(fleetId, name, now, now);
    }

    if (userAtHost) {
      db.prepare(`
        INSERT OR REPLACE INTO hosts (host, fleet_id, created_at)
        VALUES (?, ?, ?)
      `).run(userAtHost, fleetId, now);
    }
  })();
}

/** Get all user@host pairs for a fleet ID */
function getHosts(fleetId) {
  const db = getDb();
  return db.prepare('SELECT host FROM hosts WHERE fleet_id = ?').all(fleetId).map(r => r.host);
}

/** Remove an agent and its session mappings */
function removeAgent(fleetId) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE fleet_id = ?').run(fleetId);
    db.prepare('DELETE FROM hosts WHERE fleet_id = ?').run(fleetId);
    db.prepare('DELETE FROM agents WHERE fleet_id = ?').run(fleetId);
  })();
}

/** Transfer sessions from one agent to another (for adopt) */
function transferSessions(fromFleetId, toFleetId) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE sessions SET fleet_id = ? WHERE fleet_id = ?').run(toFleetId, fromFleetId);
    // Update the target agent's current session to the most recent one
    const latest = db.prepare('SELECT session FROM sessions WHERE fleet_id = ? ORDER BY created_at DESC LIMIT 1').get(toFleetId);
    if (latest) {
      db.prepare('UPDATE agents SET session = ?, updated_at = ? WHERE fleet_id = ?')
        .run(latest.session, new Date().toISOString(), toFleetId);
    }
  })();
}

export const ledger = {
  findByFleetId,
  findBySession,
  findByName,
  findByHost,
  upsertAgent,
  upsertHuman,
  updateName,
  listAgents,
  removeAgent,
  transferSessions,
  fleetIdFromHost,
  getHosts,
  getDb,
};
