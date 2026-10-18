// backend/db/stockLotsSchema.js
//
// Prompt 8b: lots and expiry (lot-level balances per holder; FEFO picking),
// per-product stock settings (lot tracking, reorder point / quantity),
// stock count documents with approval and reason codes, wastage / damage /
// loss and repacking documents. Kept in separate tables (no new columns on
// products, so product API responses stay unchanged). Applied by
// db/init.js and db/migrations/0020_stock_lots.js.

const STOCK_LOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS product_stock_settings (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  track_lots INTEGER NOT NULL DEFAULT 0,
  reorder_point REAL,
  reorder_qty REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_code TEXT NOT NULL,
  production_date TEXT,
  expiry_date TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_lot TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'quarantine', 'rejected', 'expired')),
  status_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, product_id, lot_code)
);
CREATE INDEX IF NOT EXISTS idx_stock_lots_expiry ON stock_lots(company_id, status, expiry_date);

CREATE TABLE IF NOT EXISTS stock_lot_balances (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lot_id INTEGER NOT NULL REFERENCES stock_lots(id),
  holder_id INTEGER NOT NULL REFERENCES stock_holders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (lot_id, holder_id)
);

-- Stock count document: draft (lines counted) -> approved (differences
-- posted as 'count' moves with their reason codes) | rejected.
CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  count_number TEXT,
  holder_id INTEGER NOT NULL REFERENCES stock_holders(id),
  count_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  reject_reason TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stock_count_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES stock_lots(id),
  expected_qty REAL NOT NULL,
  counted_qty REAL NOT NULL,
  reason_code TEXT,
  value_minor INTEGER,
  UNIQUE (count_id, product_id, lot_id)
);

-- Wastage / damage / loss (out, to inventory_wastage) and repacking
-- (out of one product, into another at the same value).
CREATE TABLE IF NOT EXISTS stock_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wastage', 'repack')),
  reason_code TEXT NOT NULL,
  holder_id INTEGER NOT NULL REFERENCES stock_holders(id),
  doc_date TEXT NOT NULL,
  notes TEXT,
  value_minor INTEGER NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, doc_number)
);
CREATE TABLE IF NOT EXISTS stock_document_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES stock_lots(id),
  qty REAL NOT NULL CHECK (qty > 0),
  value_minor INTEGER NOT NULL DEFAULT 0
);
`;

function applyStockLotsSchema(db) {
  db.exec(STOCK_LOTS_SCHEMA_SQL);
}

module.exports = { applyStockLotsSchema, STOCK_LOTS_SCHEMA_SQL };
