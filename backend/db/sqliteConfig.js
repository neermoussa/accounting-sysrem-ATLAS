// backend/db/sqliteConfig.js
//
// One busy timeout for every SQLite connection to the Atlas database: the
// server (db/init.js), scripts (backup, deploy, migrate), go-live backups
// and tests. A connection that meets another connection's write lock waits
// up to this long instead of failing at once with "database is locked".
// Write transactions start with BEGIN IMMEDIATE (db/init.js transaction
// shim, lib/ledger.js tx) so they take the write lock up front and never
// fail on a read-to-write upgrade (SQLITE_BUSY_SNAPSHOT, which no timeout
// can fix).

const BUSY_TIMEOUT_MS = 5000;

module.exports = { BUSY_TIMEOUT_MS };
