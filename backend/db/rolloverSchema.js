// backend/db/rolloverSchema.js
//
// Year rollover protection (before Prompt 12):
//  - posting_failures: a posting refused because no fiscal period covers its
//    date is held here (visible queue with a retry action) instead of being
//    lost or silently dropped; resolved when the same document posts.
// Applied by db/init.js and db/migrations/0027_year_rollover.js.

const ROLLOVER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS posting_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  label TEXT,
  posting_date TEXT,
  error_code TEXT NOT NULL,
  message TEXT,
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_posting_failures_open ON posting_failures (company_id, kind, source_id) WHERE status = 'open';
`;

function applyRolloverSchema(db) {
  db.exec(ROLLOVER_SCHEMA_SQL);
}

module.exports = { applyRolloverSchema, ROLLOVER_SCHEMA_SQL };
