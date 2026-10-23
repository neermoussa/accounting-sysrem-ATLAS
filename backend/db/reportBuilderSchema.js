// backend/db/reportBuilderSchema.js
//
// Prompt 12b — the Report Builder's saved, scheduled and sent reports.
//  - saved_reports: a query spec (lib/analytics/query.js) with a name,
//    private to its owner or shared in the company; soft-deleted;
//  - report_schedules: run a saved report daily / weekly / monthly at a
//    local time (fixed UTC offset, default +03:00 Damascus), as its owner,
//    into a file (xlsx / pdf / csv); next_run_at is UTC;
//  - report_runs: one row per produced file; UNIQUE (schedule_id,
//    scheduled_for) makes a scheduled slot run at most once;
//  - report_sends: a request to send a run's file by e-mail or WhatsApp to
//    explicit recipients; nothing is sent until a person approves it.
// Applied by db/init.js and db/migrations/0032_report_builder.js.

const REPORT_BUILDER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  spec_json TEXT NOT NULL,
  needs TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_saved_reports_name ON saved_reports (company_id, owner_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_saved_reports_company ON saved_reports (company_id, visibility);

CREATE TABLE IF NOT EXISTS report_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_id INTEGER NOT NULL REFERENCES saved_reports(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  time_of_day TEXT NOT NULL,
  weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
  utc_offset_minutes INTEGER NOT NULL DEFAULT 180,
  format TEXT NOT NULL DEFAULT 'xlsx' CHECK (format IN ('xlsx', 'pdf', 'csv')),
  lang TEXT NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar', 'en')),
  is_active INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  last_slot_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON report_schedules (is_active, next_run_at);

CREATE TABLE IF NOT EXISTS report_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_id INTEGER NOT NULL REFERENCES saved_reports(id),
  schedule_id INTEGER REFERENCES report_schedules(id),
  scheduled_for TEXT,
  missed_slots INTEGER NOT NULL DEFAULT 0,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('schedule', 'manual')),
  run_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  format TEXT NOT NULL CHECK (format IN ('xlsx', 'pdf', 'csv')),
  lang TEXT NOT NULL DEFAULT 'ar',
  spec_json TEXT,
  needs TEXT NOT NULL DEFAULT '',
  period_from TEXT,
  period_to TEXT,
  file_path TEXT,
  file_name TEXT,
  row_count INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE (schedule_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_report_runs_report ON report_runs (company_id, report_id, id);

CREATE TABLE IF NOT EXISTS report_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES report_runs(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipients_json TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'partially_sent', 'failed', 'rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_reason TEXT,
  results_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_report_sends_company ON report_sends (company_id, status);
`;

function applyReportBuilderSchema(db) {
  db.exec(REPORT_BUILDER_SCHEMA_SQL);
}

module.exports = { applyReportBuilderSchema, REPORT_BUILDER_SCHEMA_SQL };
