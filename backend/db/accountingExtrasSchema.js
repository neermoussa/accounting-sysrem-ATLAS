// backend/db/accountingExtrasSchema.js
//
// Prompt 10 — the remaining accounting-core items (lib/fixedAssets.js,
// lib/taxCodes.js, lib/recurringEntries.js):
//  - tax codes with effective-dated rates and their tax account; links from
//    sales / credit-note / supplier-invoice lines to the code used (side
//    tables: no new columns on existing tables, so a company without tax
//    codes keeps byte-identical documents and responses);
//  - fixed asset categories (accounts), the asset register, monthly
//    depreciation (one row per asset per period -> idempotent), disposal;
//    supplier-invoice lines that create an asset when posted;
//  - recurring journal templates (fixed amounts, accruals with automatic
//    reversal, prepayment amortisation) and their runs (one per template per
//    scheduled date -> never twice).
// Applied by db/init.js and db/migrations/0024_accounting_extras.js.

const ACCOUNTING_EXTRAS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tax_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sales', 'purchase')),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, code)
);

-- A rate applies from effective_from until the next row's date.
CREATE TABLE IF NOT EXISTS tax_code_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_code_id INTEGER NOT NULL REFERENCES tax_codes(id),
  rate_bp INTEGER NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
  effective_from TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tax_code_id, effective_from)
);

-- The tax code a document line used (sales_invoice_line, sales_credit_note_line,
-- supplier_invoice_line): rate and account as resolved on the document date,
-- and whether the line price included the tax.
CREATE TABLE IF NOT EXISTS document_line_tax (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  line_type TEXT NOT NULL CHECK (line_type IN ('sales_invoice_line', 'sales_credit_note_line', 'supplier_invoice_line')),
  line_id INTEGER NOT NULL,
  tax_code_id INTEGER NOT NULL REFERENCES tax_codes(id),
  rate_bp INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  inclusive INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (line_type, line_id)
);

-- The price mode chosen explicitly when the company starts using tax codes
-- (inclusive = prices include tax, exclusive = tax on top). Until a row
-- exists, a company that has tax codes cannot post a taxed document.
-- Mirrors companies.price_display_mode ('with_tax' / 'without_tax').
CREATE TABLE IF NOT EXISTS company_tax_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  price_mode TEXT NOT NULL CHECK (price_mode IN ('inclusive', 'exclusive')),
  chosen_by INTEGER REFERENCES users(id),
  chosen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fa_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  asset_account_id INTEGER NOT NULL REFERENCES accounts(id),
  accumulated_account_id INTEGER NOT NULL REFERENCES accounts(id),
  expense_account_id INTEGER NOT NULL REFERENCES accounts(id),
  -- Gain / loss on disposal (one account, net: a gain credits it, a loss debits it).
  disposal_account_id INTEGER NOT NULL REFERENCES accounts(id),
  default_life_months INTEGER,
  default_method TEXT NOT NULL DEFAULT 'straight_line' CHECK (default_method IN ('straight_line', 'declining_balance')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS fixed_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_number TEXT,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES fa_categories(id),
  cost_minor INTEGER NOT NULL CHECK (cost_minor > 0),
  salvage_minor INTEGER NOT NULL DEFAULT 0 CHECK (salvage_minor >= 0),
  purchase_date TEXT NOT NULL,
  depreciation_start TEXT NOT NULL,
  useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
  method TEXT NOT NULL CHECK (method IN ('straight_line', 'declining_balance')),
  declining_rate_bp INTEGER,
  -- Accumulated depreciation brought in when an existing asset is registered.
  opening_accumulated_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fully_depreciated', 'disposed')),
  supplier_invoice_id INTEGER REFERENCES supplier_invoices(id),
  supplier_invoice_line_id INTEGER UNIQUE REFERENCES supplier_invoice_lines(id),
  disposal_date TEXT,
  disposal_proceeds_minor INTEGER,
  disposal_gain_loss_minor INTEGER,
  disposal_entry_id INTEGER REFERENCES journal_entries(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One depreciation amount per asset per month (YYYY-MM): re-running a
-- period never posts twice.
CREATE TABLE IF NOT EXISTS fa_depreciation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES fixed_assets(id),
  period TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (asset_id, period)
);

-- Supplier-invoice expense lines that become a fixed asset when the
-- invoice is posted (the line is debited to the category's asset account).
CREATE TABLE IF NOT EXISTS supplier_invoice_line_assets (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_line_id INTEGER NOT NULL PRIMARY KEY REFERENCES supplier_invoice_lines(id),
  category_id INTEGER NOT NULL REFERENCES fa_categories(id),
  name TEXT,
  useful_life_months INTEGER,
  salvage_minor INTEGER NOT NULL DEFAULT 0,
  method TEXT
);

-- Recurring journal templates.
--   recurring : the same lines every period (rent, subscriptions)
--   accrual   : the lines at period end, reversed automatically on the first
--               day of the next period
--   prepayment: total_minor amortised over occurrences periods
--               (Dr expense / Cr prepaid asset), the last period takes the remainder
CREATE TABLE IF NOT EXISTS recurring_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recurring', 'accrual', 'prepayment')),
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
  start_date TEXT NOT NULL,
  end_date TEXT,
  occurrences INTEGER,
  lines_json TEXT,
  total_minor INTEGER,
  debit_account_id INTEGER REFERENCES accounts(id),
  credit_account_id INTEGER REFERENCES accounts(id),
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recurring_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES recurring_templates(id),
  run_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  reversal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (template_id, run_date)
);
`;

function applyAccountingExtrasSchema(db) {
  db.exec(ACCOUNTING_EXTRAS_SCHEMA_SQL);
}

module.exports = { applyAccountingExtrasSchema, ACCOUNTING_EXTRAS_SCHEMA_SQL };
