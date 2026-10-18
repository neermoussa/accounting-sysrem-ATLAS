// backend/db/ledgerSchema.js
//
// Double-entry ledger schema (Prompt 1). Kept in its own module so that
// db/init.js (fresh databases) and db/migrations/0002_ledger_core.js
// (existing databases) run the exact same statements and therefore always
// produce the same end schema. Every statement is IF NOT EXISTS, so running
// it twice is a no-op.
//
// Money: every amount column here is an INTEGER in minor units of the
// relevant currency (see currencies.minor_unit_digits). Exchange rates are
// INTEGER parts-per-million (base units per 1 unit of the line currency).
//
// The ONLY writer of journal_entries / journal_lines is lib/ledger.js. The
// triggers at the bottom are a database-level safety net on top of that:
// a posted (or reversed) entry and its lines cannot be changed or deleted
// by any SQL, except the single status/link update that reverseEntry makes.

const LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS currencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  minor_unit_digits INTEGER NOT NULL DEFAULT 2 CHECK (minor_unit_digits BETWEEN 0 AND 4),
  is_base INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, code)
);

-- Branches are a JSON string array on companies.branches_json, not a table.
-- branches_ref gives each branch name a stable id that journal entries can
-- reference; lib/ledger.js syncs it from branches_json on demand.
CREATE TABLE IF NOT EXISTS branches_ref (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  parent_id INTEGER REFERENCES accounts(id),
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  is_postable INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  currency_code TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  system_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounts_company_parent ON accounts(company_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_system_key ON accounts(company_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS fiscal_years (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, year)
);

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id INTEGER NOT NULL REFERENCES fiscal_years(id),
  year INTEGER NOT NULL,
  number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 12),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  locked_at TEXT,
  locked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, year, number)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_dates ON fiscal_periods(company_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS cost_centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_number TEXT,
  entry_date TEXT NOT NULL,
  period_id INTEGER REFERENCES fiscal_periods(id),
  branch_id INTEGER REFERENCES branches_ref(id),
  description TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  reverses_entry_id INTEGER REFERENCES journal_entries(id),
  reversed_by_entry_id INTEGER REFERENCES journal_entries(id),
  reversal_reason TEXT,
  idempotency_key TEXT,
  created_by INTEGER REFERENCES users(id),
  posted_by INTEGER REFERENCES users(id),
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date ON journal_entries(company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_status ON journal_entries(company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_number ON journal_entries(company_id, entry_number) WHERE entry_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_idem ON journal_entries(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Same source document cannot be posted twice while its entry stands; once
-- that entry is reversed (status='reversed') the source may post again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(company_id, source_type, source_id) WHERE source_id IS NOT NULL AND status = 'posted';

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit_minor INTEGER NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency_code TEXT NOT NULL,
  amount_original_minor INTEGER NOT NULL,
  exchange_rate_ppm INTEGER NOT NULL DEFAULT 1000000 CHECK (exchange_rate_ppm > 0),
  cost_center_id INTEGER REFERENCES cost_centers(id),
  project_id INTEGER REFERENCES projects(id),
  party_type TEXT CHECK (party_type IS NULL OR party_type IN ('customer', 'supplier', 'employee')),
  party_id INTEGER,
  memo TEXT,
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(company_id, account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);

CREATE TABLE IF NOT EXISTS journal_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  file_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_attachments_entry ON journal_attachments(entry_id);

-- ---------------------------------------------------------------------
-- Safety-net triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_je_no_update_posted
BEFORE UPDATE ON journal_entries
WHEN OLD.status IN ('posted', 'reversed') AND NOT (
  OLD.status = 'posted' AND NEW.status = 'reversed'
  AND OLD.reversed_by_entry_id IS NULL AND NEW.reversed_by_entry_id IS NOT NULL
  AND NEW.company_id = OLD.company_id
  AND NEW.entry_number IS OLD.entry_number
  AND NEW.entry_date IS OLD.entry_date
  AND NEW.period_id IS OLD.period_id
  AND NEW.branch_id IS OLD.branch_id
  AND NEW.description IS OLD.description
  AND NEW.source_type IS OLD.source_type
  AND NEW.source_id IS OLD.source_id
  AND NEW.reverses_entry_id IS OLD.reverses_entry_id
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.created_by IS OLD.created_by
  AND NEW.posted_by IS OLD.posted_by
  AND NEW.posted_at IS OLD.posted_at
)
BEGIN
  SELECT RAISE(ABORT, 'posted_entry_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_je_no_delete_posted
BEFORE DELETE ON journal_entries
WHEN OLD.status IN ('posted', 'reversed')
BEGIN
  SELECT RAISE(ABORT, 'posted_entry_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_jl_no_insert_posted
BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) IS NOT 'draft'
BEGIN
  SELECT RAISE(ABORT, 'posted_entry_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_jl_no_update_posted
BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) IS NOT 'draft'
  OR (SELECT status FROM journal_entries WHERE id = NEW.entry_id) IS NOT 'draft'
BEGIN
  SELECT RAISE(ABORT, 'posted_entry_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_jl_no_delete_posted
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) IN ('posted', 'reversed')
BEGIN
  SELECT RAISE(ABORT, 'posted_entry_immutable');
END;

-- A locked period is permanent: nothing may change its status again.
CREATE TRIGGER IF NOT EXISTS trg_fp_locked_permanent
BEFORE UPDATE ON fiscal_periods
WHEN OLD.status = 'locked'
BEGIN
  SELECT RAISE(ABORT, 'period_locked');
END;

-- A period holding posted entries can never be deleted.
CREATE TRIGGER IF NOT EXISTS trg_fp_no_delete_used
BEFORE DELETE ON fiscal_periods
WHEN EXISTS (SELECT 1 FROM journal_entries WHERE period_id = OLD.id AND status IN ('posted', 'reversed'))
BEGIN
  SELECT RAISE(ABORT, 'period_has_entries');
END;

-- branches_ref follows companies.branches_json on every write path (setup
-- wizard, settings, raw SQL). Removed/renamed branches are deactivated, not
-- deleted, so journal entries keep a valid branch_id.
CREATE TRIGGER IF NOT EXISTS trg_companies_branches_insert
AFTER INSERT ON companies
BEGIN
  INSERT OR IGNORE INTO branches_ref (company_id, name)
  SELECT NEW.id, n FROM (SELECT trim(CASE WHEN j.type = 'text' THEN j.value ELSE json_extract(j.value, '$.name') END) AS n
    FROM json_each(CASE WHEN json_valid(NEW.branches_json) THEN NEW.branches_json ELSE '[]' END) j) WHERE n IS NOT NULL AND n <> '';
  UPDATE branches_ref SET is_active = CASE WHEN name IN (SELECT trim(CASE WHEN j.type = 'text' THEN j.value ELSE json_extract(j.value, '$.name') END) AS n
    FROM json_each(CASE WHEN json_valid(NEW.branches_json) THEN NEW.branches_json ELSE '[]' END) j) THEN 1 ELSE 0 END
  WHERE company_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_companies_branches_update
AFTER UPDATE OF branches_json ON companies
BEGIN
  INSERT OR IGNORE INTO branches_ref (company_id, name)
  SELECT NEW.id, n FROM (SELECT trim(CASE WHEN j.type = 'text' THEN j.value ELSE json_extract(j.value, '$.name') END) AS n
    FROM json_each(CASE WHEN json_valid(NEW.branches_json) THEN NEW.branches_json ELSE '[]' END) j) WHERE n IS NOT NULL AND n <> '';
  UPDATE branches_ref SET is_active = CASE WHEN name IN (SELECT trim(CASE WHEN j.type = 'text' THEN j.value ELSE json_extract(j.value, '$.name') END) AS n
    FROM json_each(CASE WHEN json_valid(NEW.branches_json) THEN NEW.branches_json ELSE '[]' END) j) THEN 1 ELSE 0 END
  WHERE company_id = NEW.id;
END;

-- Base currency is fixed once the books have posted entries.
CREATE TRIGGER IF NOT EXISTS trg_companies_currency_locked
BEFORE UPDATE OF currency ON companies
WHEN NEW.currency IS NOT OLD.currency
  AND EXISTS (SELECT 1 FROM journal_entries WHERE company_id = OLD.id AND status IN ('posted', 'reversed'))
BEGIN
  SELECT RAISE(ABORT, 'currency_locked');
END;
`;

// accounts.report_class (after Prompt 4) is added by ALTER on BOTH paths
// (fresh init and migration 0011), so sqlite_master text is identical.
const REPORT_CLASS_COLUMN_SQL = `ALTER TABLE accounts ADD COLUMN report_class TEXT CHECK (report_class IS NULL OR report_class IN (
  'cash', 'current_asset', 'fixed_asset', 'contra_asset', 'current_liability', 'long_term_liability', 'equity', 'revenue', 'cogs', 'opex', 'other'))`;

function ensureReportClassColumn(db) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  if (!cols.includes('report_class')) db.exec(REPORT_CLASS_COLUMN_SQL);
}

// journal_lines.rate_e8 / rate_quote (before Prompt 5): the exact rate at
// 1e8 scale in its most-significant direction (lib/fxRate.js). Older lines
// keep only exchange_rate_ppm (base per foreign x1e6); readers fall back to
// it when rate_e8 is NULL. Same ALTER on fresh and migrated databases.
function ensureFxRateColumns(db) {
  const cols = db.prepare('PRAGMA table_info(journal_lines)').all().map((c) => c.name);
  if (!cols.includes('rate_e8')) db.exec('ALTER TABLE journal_lines ADD COLUMN rate_e8 INTEGER CHECK (rate_e8 IS NULL OR rate_e8 > 0)');
  if (!cols.includes('rate_quote')) {
    db.exec("ALTER TABLE journal_lines ADD COLUMN rate_quote TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base'))");
  }
}

function applyLedgerSchema(db) {
  db.exec(LEDGER_SCHEMA_SQL);
  ensureReportClassColumn(db);
  ensureFxRateColumns(db);
}

module.exports = { applyLedgerSchema, ensureReportClassColumn, ensureFxRateColumns, LEDGER_SCHEMA_SQL };
