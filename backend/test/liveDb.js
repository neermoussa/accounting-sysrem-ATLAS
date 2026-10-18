// backend/test/liveDb.js
//
// Tests that read or write the database of a RUNNING server open a second
// SQLite connection. The server writes on its own (requests, and the
// background sweeps that start 3 s after boot), so that connection must
// wait for the server's write lock like the server waits for it (both use
// a 5 s busy timeout) — without it a write that lands inside a server
// write fails at once with "database is locked" (CI run #16).

const { DatabaseSync } = require('node:sqlite');

const { BUSY_TIMEOUT_MS } = require('../db/sqliteConfig');

function openLiveDb(dbPath, options = {}) {
  return require('../lib/clock').attachSqlite(new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS, ...options }));
}

module.exports = { openLiveDb, BUSY_TIMEOUT_MS };
