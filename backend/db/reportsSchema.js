// backend/db/reportsSchema.js
//
// Financial reports (Prompt 4): budgets and the indexes the report queries
// need at 200k+ journal lines. Shared by db/init.js and
// db/migrations/0010_financial_reports.js; all IF NOT EXISTS.

const REPORTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id INTEGER NOT NULL REFERENCES fiscal_years(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, fiscal_year_id, name)
);

-- One amount per account (+ optional cost center) per fiscal period, in base
-- minor units, signed the natural way for the account (expense budget = cost).
CREATE TABLE IF NOT EXISTS budget_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  cost_center_id INTEGER REFERENCES cost_centers(id),
  period_id INTEGER NOT NULL REFERENCES fiscal_periods(id),
  amount_minor INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_lines_key ON budget_lines(budget_id, account_id, COALESCE(cost_center_id, 0), period_id);

-- Report query paths (trial balance / statements / ledger at 200k lines).
CREATE INDEX IF NOT EXISTS idx_journal_lines_account_entry ON journal_lines(account_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry_amounts ON journal_lines(entry_id, account_id, debit_minor, credit_minor);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date_status ON journal_entries(company_id, entry_date, status);
`;

function applyReportsSchema(db) {
  db.exec(REPORTS_SCHEMA_SQL);
}

module.exports = { applyReportsSchema, REPORTS_SCHEMA_SQL };
