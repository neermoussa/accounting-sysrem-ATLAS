// backend/db/purchasingSchema.js
//
// Suppliers and purchasing (Prompt 6). Shared by db/init.js (fresh
// databases) and db/migrations/0015_purchasing.js; all IF NOT EXISTS.
//
// Money: INTEGER minor units of the DOCUMENT currency (*_minor), with base
// amounts in *_base_minor fixed at posting. Rates are rate_e8 + rate_quote
// (lib/fxRate.js). Quantities are REAL (same as sales lines).

const PURCHASING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  currency_code TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  tax_number TEXT,
  default_tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (default_tax_rate_bp BETWEEN 0 AND 10000),
  -- Manual rating (1-5) next to the computed ratings (on-time, price, quality).
  manual_rating INTEGER CHECK (manual_rating IS NULL OR manual_rating BETWEEN 1 AND 5),
  rating_notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_code ON suppliers(company_id, code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT,
  price_date TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL,
  unit_price_base_minor INTEGER,
  source_type TEXT NOT NULL CHECK (source_type IN ('quotation', 'purchase_order', 'supplier_invoice')),
  source_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_price_history ON supplier_price_history(company_id, supplier_id, product_id, price_date);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_number TEXT,
  request_date TEXT NOT NULL,
  needed_by TEXT,
  warehouse_id INTEGER REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled')),
  notes TEXT,
  requested_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_requests_number ON purchase_requests(company_id, request_number) WHERE request_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchase_request_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  UNIQUE (request_id, line_no)
);

CREATE TABLE IF NOT EXISTS supplier_quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  quotation_number TEXT,
  request_id INTEGER REFERENCES purchase_requests(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  quotation_date TEXT NOT NULL,
  valid_until TEXT,
  supplier_ref TEXT,
  currency_code TEXT NOT NULL,
  lead_time_days INTEGER,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'selected', 'rejected')),
  total_minor INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_quotations_number ON supplier_quotations(company_id, quotation_number) WHERE quotation_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_quotation_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  quotation_id INTEGER NOT NULL REFERENCES supplier_quotations(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  request_line_id INTEGER REFERENCES purchase_request_lines(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  UNIQUE (quotation_id, line_no)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  po_number TEXT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  request_id INTEGER REFERENCES purchase_requests(id),
  quotation_id INTEGER REFERENCES supplier_quotations(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  order_date TEXT NOT NULL,
  expected_date TEXT,
  currency_code TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  estimated_base_minor INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'partially_received', 'received', 'closed', 'cancelled')),
  -- PROMPT 13 HOOK: approvals engine. Until then: amount threshold +
  -- an optional named approver (lib/purchasing.js approvePurchaseOrder).
  approver_user_id INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_number ON purchase_orders(company_id, po_number) WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(company_id, supplier_id, status);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  request_line_id INTEGER REFERENCES purchase_request_lines(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  net_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  received_qty REAL NOT NULL DEFAULT 0,
  invoiced_qty REAL NOT NULL DEFAULT 0,
  UNIQUE (po_id, line_no)
);

-- Goods receipt: Dr inventory / Cr GRNI at the receipt-date rate.
CREATE TABLE IF NOT EXISTS goods_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  receipt_number TEXT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  receipt_date TEXT NOT NULL,
  supplier_delivery_ref TEXT,
  currency_code TEXT NOT NULL,
  rate_e8 INTEGER NOT NULL,
  rate_quote TEXT NOT NULL CHECK (rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  total_base_minor INTEGER NOT NULL DEFAULT 0,
  landed_base_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goods_receipts_number ON goods_receipts(company_id, receipt_number) WHERE receipt_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  receipt_id INTEGER NOT NULL REFERENCES goods_receipts(id),
  line_no INTEGER NOT NULL,
  po_line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  rejected_qty REAL NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  weight_kg REAL,
  unit_price_minor INTEGER NOT NULL,
  -- base value of the accepted qty at the receipt rate (= GRNI credited)
  value_base_minor INTEGER NOT NULL,
  landed_base_minor INTEGER NOT NULL DEFAULT 0,
  invoiced_qty REAL NOT NULL DEFAULT 0,
  grni_cleared_base_minor INTEGER NOT NULL DEFAULT 0,
  returned_qty REAL NOT NULL DEFAULT 0,
  UNIQUE (receipt_id, line_no)
);

-- kind: goods (PO, three-way matched) | landed_cost (allocated to a
-- receipt's lines, adds to item cost) | expense (no PO) | opening (a
-- supplier's opening balance, so it ages and can be paid).
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_number TEXT,
  supplier_invoice_ref TEXT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  kind TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'landed_cost', 'expense', 'opening')),
  po_id INTEGER REFERENCES purchase_orders(id),
  receipt_id INTEGER REFERENCES goods_receipts(id),
  landed_method TEXT CHECK (landed_method IS NULL OR landed_method IN ('value', 'weight', 'quantity')),
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  currency_code TEXT NOT NULL,
  rate_e8 INTEGER,
  rate_quote TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  total_base_minor INTEGER,
  debited_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  match_status TEXT NOT NULL DEFAULT 'not_checked' CHECK (match_status IN ('not_checked', 'matched', 'mismatch', 'approved', 'not_required')),
  match_details_json TEXT,
  mismatch_approved_by INTEGER REFERENCES users(id),
  mismatch_approved_at TEXT,
  mismatch_reason TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  posted_by INTEGER REFERENCES users(id),
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_number ON supplier_invoices(company_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_ref ON supplier_invoices(company_id, supplier_id, supplier_invoice_ref) WHERE supplier_invoice_ref IS NOT NULL AND status <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(company_id, supplier_id, status);

CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  po_line_id INTEGER REFERENCES purchase_order_lines(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  net_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  expense_account_id INTEGER REFERENCES accounts(id),
  landed_kind TEXT CHECK (landed_kind IS NULL OR landed_kind IN ('shipping', 'customs', 'transport', 'insurance', 'other')),
  debited_qty REAL NOT NULL DEFAULT 0,
  -- set at posting (goods lines): net in base, GRNI cleared, price variance
  line_base_minor INTEGER,
  grni_cleared_base_minor INTEGER,
  ppv_base_minor INTEGER,
  UNIQUE (invoice_id, line_no)
);

-- Where a landed-cost invoice's base amount went (receipt line -> share).
CREATE TABLE IF NOT EXISTS landed_cost_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
  receipt_line_id INTEGER NOT NULL REFERENCES goods_receipt_lines(id),
  method TEXT NOT NULL,
  basis REAL NOT NULL,
  amount_base_minor INTEGER NOT NULL,
  product_cost_before REAL,
  product_cost_after REAL
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_number TEXT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  payment_date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'cheque', 'other')),
  currency_code TEXT NOT NULL,
  amount_original_minor INTEGER NOT NULL CHECK (amount_original_minor > 0),
  rate_e8 INTEGER NOT NULL,
  rate_quote TEXT NOT NULL CHECK (rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  reversal_entry_id INTEGER REFERENCES journal_entries(id),
  reversal_reason TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_payments_number ON supplier_payments(company_id, payment_number) WHERE payment_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
  invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  payment_amount_minor INTEGER NOT NULL CHECK (payment_amount_minor > 0),
  base_paid_minor INTEGER NOT NULL,
  base_relieved_minor INTEGER NOT NULL,
  allocation_date TEXT NOT NULL,
  fx_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (payment_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_payment_allocations_invoice ON supplier_payment_allocations(invoice_id);

-- Purchase return / debit note against a posted goods invoice: invoice
-- currency at the invoice rate (no FX), Dr AP / Cr inventory (+ input tax).
CREATE TABLE IF NOT EXISTS supplier_debit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  debit_note_number TEXT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
  note_date TEXT NOT NULL,
  reason TEXT,
  return_goods INTEGER NOT NULL DEFAULT 1,
  currency_code TEXT NOT NULL,
  rate_e8 INTEGER NOT NULL,
  rate_quote TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  total_base_minor INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_debit_notes_number ON supplier_debit_notes(company_id, debit_note_number) WHERE debit_note_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_debit_note_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  debit_note_id INTEGER NOT NULL REFERENCES supplier_debit_notes(id),
  line_no INTEGER NOT NULL,
  invoice_line_id INTEGER NOT NULL REFERENCES supplier_invoice_lines(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  net_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  inventory_base_minor INTEGER NOT NULL DEFAULT 0,
  UNIQUE (debit_note_id, line_no)
);

-- Realized FX on supplier payments (source_type 'fx_realized_ap').
CREATE TABLE IF NOT EXISTS ap_fx_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
  invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  fx_minor INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Columns added after Prompt 6 (migration 0016): same guarded ALTER on the
// fresh and the migrated path.
// [table, column, definition]
const PURCHASING_COLUMNS = [
  // Receipt-vs-invoice exchange-rate difference on the same quantity
  // (posted to fx_realized); ppv_base_minor keeps the price difference only.
  ['supplier_invoice_lines', 'fx_base_minor', 'INTEGER'],
];

function applyPurchasingSchema(db) {
  db.exec(PURCHASING_SCHEMA_SQL);
  for (const [table, column, def] of PURCHASING_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

module.exports = { applyPurchasingSchema, PURCHASING_SCHEMA_SQL };
