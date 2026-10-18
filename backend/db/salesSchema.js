// backend/db/salesSchema.js
//
// Sales documents + customer sub-ledger support (Prompt 2). Shared by
// db/init.js (fresh databases) and db/migrations/0005_sales_documents.js
// (existing ones), all IF NOT EXISTS. Money columns are INTEGER minor units
// of the document currency (base currency only until Prompt 5).

const SALES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sales_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_number TEXT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  branch_id INTEGER REFERENCES branches_ref(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  order_id INTEGER REFERENCES orders(id),
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  currency_code TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  rounding_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  credited_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  notes TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  posted_by INTEGER REFERENCES users(id),
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_company ON sales_invoices(company_id, status, invoice_date);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_shop ON sales_invoices(shop_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoices_number ON sales_invoices(company_id, invoice_number) WHERE invoice_number IS NOT NULL;
-- One live invoice per order (cancelled ones free the order again).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoices_order ON sales_invoices(company_id, order_id) WHERE order_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id),
  description TEXT,
  qty REAL NOT NULL CHECK (qty > 0),
  unit_key TEXT,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  net_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  revenue_account_id INTEGER REFERENCES accounts(id),
  unit_cost_minor INTEGER,
  price_source TEXT,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE IF NOT EXISTS sales_credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  credit_note_number TEXT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  invoice_id INTEGER REFERENCES sales_invoices(id),
  return_request_id INTEGER REFERENCES return_requests(id),
  note_date TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  reason TEXT,
  restock INTEGER NOT NULL DEFAULT 0,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  rounding_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_credit_notes_shop ON sales_credit_notes(shop_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_credit_notes_number ON sales_credit_notes(company_id, credit_note_number) WHERE credit_note_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_credit_notes_return ON sales_credit_notes(company_id, return_request_id) WHERE return_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_credit_note_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  credit_note_id INTEGER NOT NULL REFERENCES sales_credit_notes(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  invoice_line_id INTEGER REFERENCES sales_invoice_lines(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT,
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price_minor INTEGER NOT NULL,
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  unit_cost_minor INTEGER,
  UNIQUE (credit_note_id, line_no)
);

-- Revenue account per product category; categories without a row post to
-- the sales_revenue system account.
CREATE TABLE IF NOT EXISTS product_category_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  revenue_account_id INTEGER NOT NULL REFERENCES accounts(id),
  UNIQUE (company_id, category)
);

-- Balances imported from the external system (Amin) after a company has
-- gone live on the ledger. Kept for reconciliation only — they never
-- overwrite ledger-derived balances.
CREATE TABLE IF NOT EXISTS external_balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  balance REAL NOT NULL,
  source_file TEXT,
  import_batch_id INTEGER,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, shop_id, report_date)
);

-- Go-live audit trail: every recorded dry run and the execution, with the
-- full plan, the backup taken right before executing, and the exact
-- confirmation text the user typed.
CREATE TABLE IF NOT EXISTS ledger_go_live_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('dry_run', 'executed')),
  go_live_date TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  dry_run_id INTEGER REFERENCES ledger_go_live_runs(id),
  backup_path TEXT,
  confirmation_text TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_go_live_runs_company ON ledger_go_live_runs(company_id, kind, created_at);
`;

function applySalesSchema(db) {
  db.exec(SALES_SCHEMA_SQL);
}

module.exports = { applySalesSchema, SALES_SCHEMA_SQL };
