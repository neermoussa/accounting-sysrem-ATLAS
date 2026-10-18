// backend/db/migrations/0009_collections_reversed_status.js
//
// Adds 'reversed' to collections.status (CHECK). SQLite can't
// alter a CHECK in place, so this rebuilds the table:
//   1. rename the old table aside with legacy_alter_table=ON, so the foreign
//      keys of collection_changes / customer_receipts keep pointing at the
//      name "collections";
//   2. create the new table from db/collectionsTable.js (the exact text
//      db/init.js uses, so fresh and upgraded schemas are identical);
//   3. copy every row with an explicit column list; drop the old table
//      (its indexes go with it; the new ones come from step 2).
// Runs with foreign keys OFF (db/migrate.js `foreignKeysOff`): with FKs on,
// SQLite rewrites the children's REFERENCES to the renamed table and a DROP
// would cascade. The runner checks foreign_key_check before committing.
// Idempotent: no-op when 'reversed' is already allowed. Never deletes rows.

const { COLLECTIONS_TABLE_SQL, COLLECTIONS_COPY_COLUMNS } = require('../collectionsTable');

module.exports.foreignKeysOff = true;

module.exports.up = function up(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collections'").get();
  if (!row || row.sql.includes("'reversed'")) return;
  const before = db.prepare('SELECT COUNT(*) c FROM collections').get().c;
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    db.exec('ALTER TABLE collections RENAME TO collections_pre_0009');
    db.exec('DROP INDEX IF EXISTS idx_collections_company');
    db.exec('DROP INDEX IF EXISTS idx_collections_shop');
    db.exec(COLLECTIONS_TABLE_SQL);
    const cols = COLLECTIONS_COPY_COLUMNS.join(', ');
    db.exec(`INSERT INTO collections (${cols}) SELECT ${cols} FROM collections_pre_0009`);
    db.exec('DROP TABLE collections_pre_0009');
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
  const after = db.prepare('SELECT COUNT(*) c FROM collections').get().c;
  if (after !== before) throw new Error(`0009: row count changed ${before} -> ${after}`);
  // The children must still reference "collections", not the renamed table.
  for (const t of ['collection_changes', 'customer_receipts']) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql || '';
    if (sql.includes('collections_pre_0009')) throw new Error(`0009: ${t} references the renamed table; rolled back`);
  }
};
