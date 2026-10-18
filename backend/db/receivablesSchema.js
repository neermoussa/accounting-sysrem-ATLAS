// backend/db/receivablesSchema.js
//
// Receivables (Prompt 3): customer receipts, their allocation to invoices,
// post-dated cheques and the daily AR reconciliation check. Shared by
// db/init.js and db/migrations/0007_receivables.js; all IF NOT EXISTS.
// Money is INTEGER minor units of the base currency.

const RECEIVABLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customer_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  receipt_number TEXT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  receipt_date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'cheque', 'other')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  collection_id INTEGER REFERENCES collections(id),
  cheque_id INTEGER,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reversal_entry_id INTEGER REFERENCES journal_entries(id),
  reversal_reason TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_receipts_shop ON customer_receipts(company_id, shop_id, receipt_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_receipts_number ON customer_receipts(company_id, receipt_number) WHERE receipt_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_receipts_collection ON customer_receipts(collection_id) WHERE collection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS receipt_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  receipt_id INTEGER NOT NULL REFERENCES customer_receipts(id),
  invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  allocation_date TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'manual' CHECK (method IN ('auto', 'manual')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (receipt_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_receipt_allocations_invoice ON receipt_allocations(invoice_id);

CREATE TABLE IF NOT EXISTS cheques_received (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  cheque_number TEXT NOT NULL,
  bank_name TEXT,
  received_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'in_portfolio' CHECK (status IN ('in_portfolio', 'deposited', 'cleared', 'bounced')),
  receipt_id INTEGER REFERENCES customer_receipts(id),
  clear_entry_id INTEGER REFERENCES journal_entries(id),
  bounce_reason TEXT,
  deposited_at TEXT,
  cleared_at TEXT,
  bounced_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, shop_id, cheque_number, bank_name)
);
CREATE INDEX IF NOT EXISTS idx_cheques_received_status ON cheques_received(company_id, status, due_date);

CREATE TABLE IF NOT EXISTS ar_reconciliation_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  check_date TEXT NOT NULL,
  control_minor INTEGER NOT NULL,
  subledger_minor INTEGER NOT NULL,
  difference_minor INTEGER NOT NULL,
  difference_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, check_date)
);

-- Go-live open items (owner request after Prompt 3): an Excel of each
-- customer's still-open invoices (number, dates, amount) so migrated debt is
-- aged from its real due dates. The residual vs the customer's latest
-- balance snapshot stays a single 'legacy/undated' opening line.
CREATE TABLE IF NOT EXISTS open_item_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'used', 'discarded')),
  row_count INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  used_run_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_open_item_imports_company ON open_item_imports(company_id, status);

CREATE TABLE IF NOT EXISTS open_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  import_id INTEGER NOT NULL REFERENCES open_item_imports(id),
  row_no INTEGER NOT NULL,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  UNIQUE (import_id, shop_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_open_items_import ON open_items(import_id, shop_id);
`;

function applyReceivablesSchema(db) {
  db.exec(RECEIVABLES_SCHEMA_SQL);
}

module.exports = { applyReceivablesSchema, RECEIVABLES_SCHEMA_SQL };
