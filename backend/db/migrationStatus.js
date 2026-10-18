// backend/db/migrationStatus.js
//
// Which migrations a database has applied, and which are pending. Used by
// db/migrate.js (runner), db/init.js (a brand-new database is created at
// the latest schema, so every migration is stamped as applied), and
// server.js (refuses to serve while migrations are pending; /api/health).

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function listFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();
}

// { version: last applied file (or null), applied: n, pending: [files] }
function status(db) {
  ensureTable(db);
  const applied = new Set(db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename));
  const files = listFiles();
  const pending = files.filter((f) => !applied.has(f));
  const done = files.filter((f) => applied.has(f));
  return { version: done.length ? done[done.length - 1] : null, applied: done.length, pending };
}

// A database created empty by init.js already has every migration's
// schema; record them so it is not reported as pending.
function stampAll(db) {
  ensureTable(db);
  const ins = db.prepare('INSERT OR IGNORE INTO schema_migrations (filename) VALUES (?)');
  for (const f of listFiles()) ins.run(f);
}

module.exports = { MIGRATIONS_DIR, ensureTable, listFiles, status, stampAll };
