// backend/db/stockSchema.js
//
// Stock ledger (Prompt 8a). The single record of every quantity change is
// stock_moves, per product per HOLDER (a warehouse, a vehicle, a rep, or
// the pooled car stock) — not company-level. Valuation is kept per product
// per holder (stock_pools: quantity + value; FIFO adds stock_layers), so a
// transfer moves cost between holders and each inventory account (warehouse
// stock vs stock in custody) always equals the value of its holders.
// factory_inventory / car_inventory stay as the pooled projections the
// existing screens read (sum over warehouse holders / custody holders).
// Activation is per company (stock_activation_runs: dry run, then execute):
// until then nothing here is written and the old flows are byte-identical
// (test/warehouseGolden.test.js).
// Applied by db/init.js and db/migrations/0019_stock_ledger.js.

const STOCK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stock_holders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('warehouse', 'vehicle', 'rep', 'car_pool')),
  ref_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, kind, ref_id)
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  holder_id INTEGER NOT NULL REFERENCES stock_holders(id),
  lot_id INTEGER,
  qty REAL NOT NULL,
  unit_cost_minor REAL NOT NULL DEFAULT 0,
  value_minor INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('average', 'fifo', 'standard')),
  move_type TEXT NOT NULL CHECK (move_type IN ('opening', 'receipt', 'purchase_return', 'landed_cost', 'sale', 'sale_return', 'transfer_out', 'transfer_in', 'adjustment', 'count', 'wastage', 'return_restock', 'reclass_in', 'reclass_out', 'revaluation', 'production_issue', 'production_return', 'production_output', 'production_byproduct')),
  source_type TEXT NOT NULL,
  source_id INTEGER,
  group_key TEXT,
  reason_code TEXT,
  move_date TEXT NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_moves(company_id, product_id, holder_id, id);
CREATE INDEX IF NOT EXISTS idx_stock_moves_source ON stock_moves(company_id, source_type, source_id);

-- Quantity + value per product per holder (all methods; for FIFO the value
-- is the sum of the holder's layers).
CREATE TABLE IF NOT EXISTS stock_pools (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  holder_id INTEGER NOT NULL REFERENCES stock_holders(id),
  qty REAL NOT NULL DEFAULT 0,
  value_minor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, holder_id)
);

-- FIFO cost layers per product per holder. source_* = the document the
-- quantity came in on (a goods receipt line keeps its layer through
-- transfers, so a debit note can find the original cost incl. landed).
CREATE TABLE IF NOT EXISTS stock_layers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  holder_id INTEGER NOT NULL REFERENCES stock_holders(id),
  in_move_id INTEGER NOT NULL REFERENCES stock_moves(id),
  origin_type TEXT,
  origin_id INTEGER,
  layer_date TEXT NOT NULL,
  qty_in REAL NOT NULL,
  qty_remaining REAL NOT NULL,
  value_remaining_minor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_layers_open ON stock_layers(product_id, holder_id, qty_remaining, id);

CREATE TABLE IF NOT EXISTS stock_move_layers (
  move_id INTEGER NOT NULL REFERENCES stock_moves(id),
  layer_id INTEGER NOT NULL REFERENCES stock_layers(id),
  qty REAL NOT NULL,
  value_minor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_move_layers_move ON stock_move_layers(move_id);

-- Valuation method per category (else the company setting
-- inventory_valuation_method, default average).
CREATE TABLE IF NOT EXISTS stock_category_methods (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('average', 'fifo', 'standard')),
  PRIMARY KEY (company_id, category)
);

CREATE TABLE IF NOT EXISTS stock_activation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('dry_run', 'executed')),
  fingerprint TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  dry_run_id INTEGER REFERENCES stock_activation_runs(id),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Standard cost per product (minor units of base per base unit).
CREATE TABLE IF NOT EXISTS product_standard_costs (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  standard_cost_minor INTEGER NOT NULL CHECK (standard_cost_minor >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Activation: a product with stock but a missing / zero cost is valued at
-- zero only after someone acknowledges it with a written reason (audited).
CREATE TABLE IF NOT EXISTS stock_cost_acknowledgements (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, product_id)
);

-- Daily reconciliation: inventory accounts vs valuation, projections vs moves.
CREATE TABLE IF NOT EXISTS stock_reconciliation_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  ledger_minor INTEGER NOT NULL,
  valuation_minor INTEGER NOT NULL,
  difference_minor INTEGER NOT NULL,
  qty_mismatches INTEGER NOT NULL DEFAULT 0,
  details_json TEXT,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Kept out of the products table so product API responses (and the
// warehouse golden snapshot) are unchanged.
// [table, column, definition]
const STOCK_COLUMNS = [];

function applyStockSchema(db) {
  db.exec(STOCK_SCHEMA_SQL);
  for (const [table, column, def] of STOCK_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

module.exports = { applyStockSchema, STOCK_SCHEMA_SQL };
