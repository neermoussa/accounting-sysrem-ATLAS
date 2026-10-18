// backend/db/migrate.js
//
// Minimal, safe migration runner for Atlas.
//
// WHY THIS EXISTS
// ----------------
// Atlas has historically had NO migration framework. `db/init.js` is ~1950
// lines of `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
// statements — no `ALTER TABLE`, no `DROP TABLE`, no `DELETE FROM`, no
// destructive statement of any kind (verified by grep as of this pass).
// That means running `init.js` against an EXISTING, populated database is
// safe: every statement either already matches the live schema (no-op) or
// adds a table/index that doesn't exist yet. It never touches existing rows
// and never alters an existing table's columns.
//
// This DOES NOT mean Atlas has ever had a real migration story. Every schema
// change to date was made by hand-editing `init.js` and, in dev, deleting
// `data.sqlite*` to get a clean recreate. On any already-deployed instance
// with real tenant data, that workflow is not available — you cannot delete
// production data to "pick up" a schema change. Until now there has been
// NO tracked record of which schema-shape state a given deployed database is
// actually in, beyond "whatever the currently-checked-out init.js produces
// when run against an empty DB." That is a real risk for any live deployment
// predating this commit: this migration system does not retroactively
// reconstruct that history, it only starts tracking from here forward.
//
// WHAT THIS RUNNER DOES
// ----------------------
// 1. Ensures a `schema_migrations` table exists (id, filename, applied_at).
// 2. Runs `db/init.js`'s CREATE-TABLE/CREATE-INDEX statements by simply
//    `require`-ing init.js (it is already idempotent and additive — see
//    above) — this is step (a) from the brief: it is always safe to run
//    against a populated DB.
// 3. Reads `db/migrations/*.js` in filename order (use a numeric prefix,
//    e.g. `0002_add_foo_column.js`), and for each one NOT already recorded
//    in `schema_migrations`, runs its exported `up(db)` function inside a
//    transaction, then records it. Already-applied files are skipped —
//    running this script twice is a no-op the second time.
//
// WRITING A NEW MIGRATION
// ------------------------
// Add a new file to `db/migrations/`, named `NNNN_short_description.js`
// (zero-padded, strictly increasing), exporting:
//
//   module.exports.up = function up(db) {
//     db.exec(`ALTER TABLE shops ADD COLUMN foo TEXT`);
//   };
//
// Rules for migrations written from now on:
//   - Never DROP a table/column or DELETE rows in a migration meant for a
//     live/production database. Additive changes only (new tables, new
//     nullable/defaulted columns, new indexes) unless a human has explicitly
//     signed off on a destructive one and a backup plan is documented.
//   - Each migration file runs exactly once, tracked by filename in
//     `schema_migrations` — do not edit an already-applied migration file's
//     contents after it has shipped; add a new migration instead.
//   - Keep every migration idempotent where practical (`IF NOT EXISTS`,
//     `PRAGMA table_info` checks before `ALTER TABLE ... ADD COLUMN`) since
//     `up()` re-running after a partial failure should not corrupt state.
//
// USAGE
// -----
//   node db/migrate.js
//
// This is safe to run on every deploy/startup. It is NOT currently wired
// into `server.js` startup automatically — that wiring is a deliberate
// choice left to whoever owns the deploy process, since auto-running schema
// changes on every process boot is its own risk tradeoff worth a conscious
// decision rather than being silently introduced here.

const fs = require('fs');
const path = require('path');

function run() {
  // Loading init.js has the side effect of opening/creating data.sqlite and
  // running every CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
  // statement. Safe against an existing populated DB (see header comment).
  const db = require('./init');

  const ms = require('./migrationStatus');
  ms.ensureTable(db);
  const migrationsDir = ms.MIGRATIONS_DIR;
  const files = ms.listFiles();
  if (!files.length) {
    console.log('[migrate] no migrations found, nothing to do beyond init.js baseline.');
    return;
  }

  const appliedRows = db.prepare('SELECT filename FROM schema_migrations').all();
  const applied = new Set(appliedRows.map((r) => r.filename));

  let ranCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const mod = require(path.join(migrationsDir, file));
    if (typeof mod.up !== 'function') {
      console.warn(`[migrate] skipping ${file}: no exported up(db) function`);
      continue;
    }
    console.log(`[migrate] applying ${file}...`);
    // Table rebuilds (SQLite's 12-step ALTER procedure) must run with
    // foreign keys OFF, which SQLite only honours OUTSIDE a transaction —
    // otherwise renaming a table rewrites the REFERENCES clauses of every
    // child table, and dropping it cascades deletes. A migration opts in with
    // `module.exports.foreignKeysOff = true`; the runner then turns FKs off
    // around the transaction and refuses to commit unless
    // PRAGMA foreign_key_check comes back clean.
    if (mod.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      // Only violations the migration itself introduced count; a live DB may
      // already carry old dangling references that must not block upgrades.
      const fkKey = (r) => `${r.table}|${r.rowid}|${r.parent}|${r.fkid}`;
      const fkBefore = mod.foreignKeysOff ? new Set(db.prepare('PRAGMA foreign_key_check').all().map(fkKey)) : null;
      const txn = db.transaction(() => {
        mod.up(db);
        if (mod.foreignKeysOff) {
          const broken = db.prepare('PRAGMA foreign_key_check').all().filter((r) => !fkBefore.has(fkKey(r)));
          if (broken.length) throw new Error(`[migrate] ${file} introduced ${broken.length} foreign key violation(s); rolled back`);
        }
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
      });
      txn();
    } finally {
      if (mod.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
    ranCount += 1;
    console.log(`[migrate] applied ${file}`);
  }

  if (ranCount === 0) {
    console.log('[migrate] database is up to date, no pending migrations.');
  } else {
    console.log(`[migrate] applied ${ranCount} migration(s).`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
