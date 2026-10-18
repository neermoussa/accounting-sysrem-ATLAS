// backend/db/currencySchema.js
//
// Multi-currency (Prompt 5). Shared by db/init.js (fresh databases) and
// db/migrations/0013_multi_currency.js; CREATE ... IF NOT EXISTS plus
// column additions guarded by PRAGMA table_info (same ALTER text on both
// paths, so sqlite_master is identical).
//
// Rates are rate_e8 (x1e8) + rate_quote in the most-significant direction
// (lib/fxRate.js). Document money is INTEGER minor units of the DOCUMENT
// currency; *_base_minor columns are base-currency minor units, fixed when
// the document is posted.

const CURRENCY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  currency_code TEXT NOT NULL,
  rate_e8 INTEGER NOT NULL CHECK (rate_e8 >= 100000000),
  rate_quote TEXT NOT NULL CHECK (rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  effective_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'api', 'central_bank')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup ON exchange_rates(company_id, currency_code, effective_at);

-- Realized FX on a receipt allocation: one row per settlement; its journal
-- entry (source_type 'fx_realized', source_id = this id) posts the
-- difference between the base paid and the invoice base relieved.
CREATE TABLE IF NOT EXISTS fx_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  receipt_id INTEGER NOT NULL REFERENCES customer_receipts(id),
  invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  fx_minor INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fx_settlements_invoice ON fx_settlements(company_id, invoice_id);

-- Period-end unrealized revaluation runs (posted only; previews are not stored).
CREATE TABLE IF NOT EXISTS fx_revaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  reversal_date TEXT NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  reversal_entry_id INTEGER REFERENCES journal_entries(id),
  total_minor INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, as_of)
);
`;

// [table, column, ALTER definition]
const COLUMNS = [
  ['sales_invoices', 'rate_e8', 'INTEGER'],
  ['sales_invoices', 'rate_quote', "TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base'))"],
  ['sales_invoices', 'total_base_minor', 'INTEGER'],
  ['sales_credit_notes', 'rate_e8', 'INTEGER'],
  ['sales_credit_notes', 'rate_quote', "TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base'))"],
  ['sales_credit_notes', 'total_base_minor', 'INTEGER'],
  ['customer_receipts', 'currency_code', 'TEXT'],
  ['customer_receipts', 'amount_original_minor', 'INTEGER'],
  ['customer_receipts', 'rate_e8', 'INTEGER'],
  ['customer_receipts', 'rate_quote', "TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base'))"],
  // receipt_allocations.amount_minor = INVOICE currency settled (base for base
  // invoices, as before). The rest are NULL for same-currency base rows.
  ['receipt_allocations', 'receipt_amount_minor', 'INTEGER'],
  ['receipt_allocations', 'base_paid_minor', 'INTEGER'],
  ['receipt_allocations', 'base_relieved_minor', 'INTEGER'],
  ['receipt_allocations', 'settlement_rate_e8', 'INTEGER'],
  ['receipt_allocations', 'settlement_rate_quote', 'TEXT'],
];

function applyCurrencySchema(db) {
  db.exec(CURRENCY_SCHEMA_SQL);
  for (const [table, column, def] of COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

module.exports = { applyCurrencySchema, CURRENCY_SCHEMA_SQL };
