// backend/db/migrations/0001_visit_records_wave_point_id_nullable.js
//
// visit_records.wave_point_id was declared NOT NULL in db/init.js, but the
// unplanned-visit code path in routes/waves.js (POST /points/:id/visit with
// id === 'unplanned') deliberately inserts wave_point_id = NULL — there is
// no wave point behind an unplanned visit. Every unplanned visit therefore
// 500s with a NOT NULL constraint failure.
//
// SQLite cannot ALTER TABLE ... ALTER COLUMN to drop a NOT NULL constraint,
// so this performs the standard 12-step SQLite table-rebuild procedure:
// create a replacement table with the corrected schema, copy every row
// across with an explicit column list (no WHERE, no reordering), drop the
// old table, rename the replacement into place, and recreate the indexes
// that existed on the original table. db/init.js's own CREATE TABLE
// statement for visit_records has also been updated to declare
// wave_point_id without NOT NULL, so a fresh database never needs this
// migration to "fix" something that was never wrong for it — this file and
// init.js agree on the end-state schema.
//
// Idempotent: if wave_point_id is already nullable (this migration already
// ran, or a fresh DB created after the init.js fix), up() is a no-op.

// Added after Prompt 3: run with foreign keys OFF (db/migrate.js). Inside the
// runner's transaction the PRAGMA below is a no-op, so DROP TABLE
// visit_records used to cascade-delete every visit_media row. Databases that
// already applied this file are not affected by this change.
module.exports.foreignKeysOff = true;

module.exports.up = function up(db) {
  const columns = db.prepare("PRAGMA table_info(visit_records)").all();
  const wavePointCol = columns.find((c) => c.name === 'wave_point_id');
  if (!wavePointCol) {
    // Table doesn't exist yet (shouldn't happen — init.js runs first), or
    // the column is gone entirely. Nothing for this migration to do.
    return;
  }
  if (wavePointCol.notnull === 0) {
    // Already nullable — migration already applied via this path, or a
    // fresh DB created after init.js was updated. No-op.
    return;
  }

  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec(`
      CREATE TABLE visit_records_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        wave_point_id INTEGER REFERENCES wave_points(id) ON DELETE CASCADE,
        shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        form_template_id INTEGER REFERENCES visit_form_templates(id) ON DELETE SET NULL,
        result TEXT NOT NULL DEFAULT 'other' CHECK (result IN ('order_taken', 'no_order', 'shop_closed', 'refused', 'other')),
        refusal_reason TEXT,
        not_visited_reason TEXT,
        tasks_json TEXT NOT NULL DEFAULT '{}',
        answers_json TEXT NOT NULL DEFAULT '{}',
        voice_note_text TEXT,
        signature_data_url TEXT,
        lat REAL,
        lng REAL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      INSERT INTO visit_records_new (
        id, company_id, wave_point_id, shop_id, rep_id, form_template_id, result,
        refusal_reason, not_visited_reason, tasks_json, answers_json, voice_note_text,
        signature_data_url, lat, lng, recorded_at, created_at
      )
      SELECT
        id, company_id, wave_point_id, shop_id, rep_id, form_template_id, result,
        refusal_reason, not_visited_reason, tasks_json, answers_json, voice_note_text,
        signature_data_url, lat, lng, recorded_at, created_at
      FROM visit_records
    `);

    db.exec('DROP TABLE visit_records');
    db.exec('ALTER TABLE visit_records_new RENAME TO visit_records');

    // Recreate the indexes that existed on the original table (see db/init.js).
    db.exec('CREATE INDEX IF NOT EXISTS idx_visit_records_point ON visit_records(wave_point_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_visit_records_rep ON visit_records(company_id, rep_id, recorded_at)');
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }

  const fkIssues = db.prepare('PRAGMA foreign_key_check(visit_records)').all();
  if (fkIssues.length > 0) {
    throw new Error(
      `[migration 0001] foreign_key_check found ${fkIssues.length} issue(s) after rebuilding visit_records: ${JSON.stringify(fkIssues)}`
    );
  }
};
