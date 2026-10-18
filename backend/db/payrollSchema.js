// backend/db/payrollSchema.js
//
// Prompt 11-lite — the ACCOUNTING side of payroll only. Attendance, leave,
// shifts and the payroll calculation live in the separate HR program; this
// side imports its results per period and posts them (lib/payroll.js).
//  - payroll_settings: the accounts payroll posts to (per company);
//  - payroll_periods: one imported batch per (company, period, external id),
//    with the content hash (idempotent re-import), status and the accrual
//    entry; a changed re-import needs the period reopened with a reason;
//  - payroll_lines: per department / cost center / currency: gross,
//    deductions (incl. advance recoveries), employer contributions, net;
//  - payroll_advance_recoveries: advance recoveries carried by the import;
//  - employee_advances: advances paid through a treasury voucher, by the
//    HR program's employee reference;
//  - payroll_payments: treasury vouchers that pay a period's net salaries;
//  - labor_cost_rates: effective-dated labour cost per hour per cost
//    center / product line (read by production orders, used by Prompt 16).
// Applied by db/init.js and db/migrations/0026_payroll.js.

const PAYROLL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payroll_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  expense_account_id INTEGER NOT NULL REFERENCES accounts(id),
  employer_expense_account_id INTEGER NOT NULL REFERENCES accounts(id),
  salaries_payable_account_id INTEGER NOT NULL REFERENCES accounts(id),
  deductions_payable_account_id INTEGER NOT NULL REFERENCES accounts(id),
  advances_account_id INTEGER NOT NULL REFERENCES accounts(id),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported', 'posted', 'reopened')),
  content_hash TEXT NOT NULL,
  import_count INTEGER NOT NULL DEFAULT 1,
  posting_date TEXT NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  rates_json TEXT,
  reopen_reason TEXT,
  imported_by INTEGER REFERENCES users(id),
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  posted_by INTEGER REFERENCES users(id),
  posted_at TEXT,
  reopened_by INTEGER REFERENCES users(id),
  reopened_at TEXT,
  UNIQUE (company_id, period, external_id)
);

CREATE TABLE IF NOT EXISTS payroll_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  line_no INTEGER NOT NULL,
  department TEXT NOT NULL,
  cost_center_id INTEGER REFERENCES cost_centers(id),
  currency_code TEXT NOT NULL,
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  deductions_minor INTEGER NOT NULL CHECK (deductions_minor >= 0),
  employer_contrib_minor INTEGER NOT NULL DEFAULT 0 CHECK (employer_contrib_minor >= 0),
  net_minor INTEGER NOT NULL CHECK (net_minor >= 0),
  headcount INTEGER,
  UNIQUE (period_id, line_no)
);

CREATE TABLE IF NOT EXISTS payroll_advance_recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_ref TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  base_minor INTEGER,
  posted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employee_advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_ref TEXT NOT NULL,
  employee_name TEXT,
  currency_code TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  advance_date TEXT NOT NULL,
  voucher_id INTEGER NOT NULL UNIQUE REFERENCES treasury_vouchers(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  currency_code TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  voucher_id INTEGER NOT NULL UNIQUE REFERENCES treasury_vouchers(id),
  payable_base_minor INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deduction types (social insurance, income tax, ...), each with its own
-- payable account; 'default' mirrors payroll_settings.deductions_payable.
CREATE TABLE IF NOT EXISTS payroll_deduction_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, code)
);

-- A line's deductions / employer contributions split by type (absent =
-- the whole amount is the default type).
CREATE TABLE IF NOT EXISTS payroll_line_deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  line_id INTEGER NOT NULL REFERENCES payroll_lines(id),
  type_id INTEGER NOT NULL REFERENCES payroll_deduction_types(id),
  deduction_minor INTEGER NOT NULL DEFAULT 0 CHECK (deduction_minor >= 0),
  employer_minor INTEGER NOT NULL DEFAULT 0 CHECK (employer_minor >= 0)
);

-- What a posted period credited to each deduction type (per currency).
CREATE TABLE IF NOT EXISTS payroll_period_deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  type_id INTEGER NOT NULL REFERENCES payroll_deduction_types(id),
  currency_code TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  base_minor INTEGER NOT NULL
);

-- Treasury vouchers that pay a deduction type (to the authority / fund).
CREATE TABLE IF NOT EXISTS payroll_deduction_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type_id INTEGER NOT NULL REFERENCES payroll_deduction_types(id),
  currency_code TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  voucher_id INTEGER NOT NULL UNIQUE REFERENCES treasury_vouchers(id),
  payable_base_minor INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS labor_cost_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cost_center_id INTEGER REFERENCES cost_centers(id),
  product_line TEXT,
  rate_per_hour_minor INTEGER NOT NULL CHECK (rate_per_hour_minor >= 0),
  effective_from TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_labor_cost_rates ON labor_cost_rates (company_id, COALESCE(cost_center_id, 0), COALESCE(product_line, ''), effective_from);
`;

function applyPayrollSchema(db) {
  db.exec(PAYROLL_SCHEMA_SQL);
}

module.exports = { applyPayrollSchema, PAYROLL_SCHEMA_SQL };
