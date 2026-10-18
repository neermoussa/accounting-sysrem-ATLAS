// backend/db/factSchema.js
//
// Prompt 12a — analytics layer, separate from the entry screens. SQLite has
// no materialised views, so:
//  - fact_* tables hold denormalised rows (base-currency minor units, with
//    the dimensions reports group by);
//  - triggers on the SOURCE tables only append the changed document to
//    fact_queue (they never compute anything inside the business
//    transaction);
//  - lib/analytics/facts.js refreshes incrementally from the queue (each
//    queued document's fact rows are deleted and rebuilt from the source)
//    and can rebuild a company from scratch with the same builders — the
//    two must give identical rows (test/analyticsFacts.test.js);
//  - fact_state keeps the freshness stamp every report shows.
// Applied by db/init.js and db/migrations/0029_analytics_facts.js.

const FACT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fact_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  fact_group TEXT NOT NULL,
  source_key TEXT NOT NULL,
  queued_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fact_queue_company ON fact_queue (company_id, id);

CREATE TABLE IF NOT EXISTS fact_state (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  refreshed_at TEXT,
  last_queue_id INTEGER NOT NULL DEFAULT 0,
  full_rebuild_at TEXT
);

-- Every posted / reversed journal line.
CREATE TABLE IF NOT EXISTS fact_journal_lines (
  line_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  entry_number TEXT,
  entry_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  account_type TEXT NOT NULL,
  report_class TEXT,
  debit_minor INTEGER NOT NULL,
  credit_minor INTEGER NOT NULL,
  branch_id INTEGER,
  cost_center_id INTEGER,
  project_id INTEGER,
  party_type TEXT,
  party_id INTEGER,
  currency_code TEXT,
  amount_original_minor INTEGER,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  is_closing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fjl_company_date ON fact_journal_lines (company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_fjl_entry ON fact_journal_lines (entry_id);

-- Expense-account lines (a subset of the journal, with the counterparty).
CREATE TABLE IF NOT EXISTS fact_expenses (
  line_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  report_class TEXT,
  amount_minor INTEGER NOT NULL,
  branch_id INTEGER,
  cost_center_id INTEGER,
  project_id INTEGER,
  supplier_id INTEGER,
  employee_id INTEGER,
  source_type TEXT NOT NULL,
  source_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fexp_company_date ON fact_expenses (company_id, entry_date);

-- Receivables control lines per customer (AR movements).
CREATE TABLE IF NOT EXISTS fact_receivables (
  line_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  customer_id INTEGER,
  region TEXT,
  rep_id INTEGER,
  debit_minor INTEGER NOT NULL,
  credit_minor INTEGER NOT NULL,
  due_date TEXT,
  method TEXT,
  source_type TEXT NOT NULL,
  source_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_frec_company ON fact_receivables (company_id, customer_id, entry_date);

-- Payables control lines per supplier (AP movements).
CREATE TABLE IF NOT EXISTS fact_payables (
  line_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  supplier_id INTEGER,
  debit_minor INTEGER NOT NULL,
  credit_minor INTEGER NOT NULL,
  due_date TEXT,
  source_type TEXT NOT NULL,
  source_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fpay_company ON fact_payables (company_id, supplier_id, entry_date);

-- Sales invoice lines (+) and credit-note lines (-), base currency; the
-- document's posted revenue is allocated over its lines, so the total
-- equals the revenue the ledger booked for it.
CREATE TABLE IF NOT EXISTS fact_sales_lines (
  fact_key TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  doc_number TEXT,
  line_id INTEGER NOT NULL,
  doc_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  region TEXT,
  rep_id INTEGER,
  branch_id INTEGER,
  warehouse_id INTEGER,
  product_id INTEGER,
  category TEXT,
  channel TEXT,
  currency_code TEXT NOT NULL,
  qty REAL NOT NULL,
  net_original_minor INTEGER NOT NULL,
  net_base_minor INTEGER NOT NULL,
  cost_base_minor INTEGER,
  entry_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fsales_company_date ON fact_sales_lines (company_id, doc_date);

-- Supplier invoice lines (+) and debit-note lines (-), base currency; the
-- document's net posted value is allocated over its lines.
CREATE TABLE IF NOT EXISTS fact_purchase_lines (
  fact_key TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  doc_number TEXT,
  line_id INTEGER NOT NULL,
  doc_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  kind TEXT NOT NULL,
  supplier_id INTEGER NOT NULL,
  product_id INTEGER,
  category TEXT,
  expense_account_id INTEGER,
  currency_code TEXT NOT NULL,
  qty REAL NOT NULL,
  net_original_minor INTEGER NOT NULL,
  net_base_minor INTEGER NOT NULL,
  entry_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fpurch_company_date ON fact_purchase_lines (company_id, doc_date);

-- Stock moves (stock ledger).
CREATE TABLE IF NOT EXISTS fact_inventory_moves (
  move_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  move_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  category TEXT,
  holder_id INTEGER NOT NULL,
  holder_kind TEXT,
  warehouse_id INTEGER,
  lot_id INTEGER,
  move_type TEXT NOT NULL,
  qty REAL NOT NULL,
  value_minor INTEGER NOT NULL,
  source_type TEXT,
  source_id INTEGER,
  entry_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_finv_company_date ON fact_inventory_moves (company_id, move_date);

-- Closed and rejected production orders with their cost.
CREATE TABLE IF NOT EXISTS fact_production_batches (
  order_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  order_number TEXT,
  production_date TEXT NOT NULL,
  ym TEXT NOT NULL,
  status TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  category TEXT,
  version_id INTEGER,
  batches REAL,
  expected_units REAL,
  actual_units REAL,
  actual_kg REAL,
  materials_minor INTEGER NOT NULL DEFAULT 0,
  labour_minor INTEGER NOT NULL DEFAULT 0,
  energy_minor INTEGER NOT NULL DEFAULT 0,
  overhead_minor INTEGER NOT NULL DEFAULT 0,
  byproduct_credit_minor INTEGER NOT NULL DEFAULT 0,
  abnormal_loss_minor INTEGER NOT NULL DEFAULT 0,
  written_off_minor INTEGER NOT NULL DEFAULT 0,
  fg_value_minor INTEGER NOT NULL DEFAULT 0,
  theoretical_minor INTEGER,
  lot_id INTEGER,
  entry_id INTEGER
);

-- Posted payroll (aggregates per department / cost center / currency).
CREATE TABLE IF NOT EXISTS fact_payroll (
  line_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  period_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  department TEXT NOT NULL,
  cost_center_id INTEGER,
  currency_code TEXT NOT NULL,
  gross_base_minor INTEGER NOT NULL,
  employer_base_minor INTEGER NOT NULL,
  deductions_base_minor INTEGER NOT NULL,
  net_base_minor INTEGER NOT NULL,
  headcount INTEGER,
  entry_id INTEGER
);

-- Change capture: the business transaction only appends a queue row.
CREATE TRIGGER IF NOT EXISTS trg_fq_journal_ins AFTER INSERT ON journal_entries BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'journal', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_journal_upd AFTER UPDATE OF status ON journal_entries BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'journal', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_sales_upd AFTER UPDATE OF status, journal_entry_id ON sales_invoices BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'sales', 'inv:' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_credit_ins AFTER INSERT ON sales_credit_notes BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'sales', 'cn:' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_credit_upd AFTER UPDATE OF journal_entry_id ON sales_credit_notes BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'sales', 'cn:' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_purchase_upd AFTER UPDATE OF status, journal_entry_id ON supplier_invoices BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'purchase', 'inv:' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_debit_ins AFTER INSERT ON supplier_debit_notes BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'purchase', 'dn:' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_debit_upd AFTER UPDATE OF journal_entry_id ON supplier_debit_notes BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'purchase', 'dn:' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_move_ins AFTER INSERT ON stock_moves BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'stock', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_move_upd AFTER UPDATE ON stock_moves BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'stock', NEW.id);
END;
-- A sales line's cost comes from its stock moves: a move re-queues its document.
CREATE TRIGGER IF NOT EXISTS trg_fq_move_sale_ins AFTER INSERT ON stock_moves WHEN NEW.source_type IN ('sales_invoice_line', 'sales_credit_note') BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'sales', CASE WHEN NEW.source_type = 'sales_credit_note' THEN 'cn:' || NEW.source_id ELSE 'inv:' || (SELECT invoice_id FROM sales_invoice_lines WHERE id = NEW.source_id) END);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_move_sale_upd AFTER UPDATE ON stock_moves WHEN NEW.source_type IN ('sales_invoice_line', 'sales_credit_note') BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'sales', CASE WHEN NEW.source_type = 'sales_credit_note' THEN 'cn:' || NEW.source_id ELSE 'inv:' || (SELECT invoice_id FROM sales_invoice_lines WHERE id = NEW.source_id) END);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_mfg_upd AFTER UPDATE OF status, cost_json ON mfg_orders BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'production', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_fq_payroll_upd AFTER UPDATE OF status, journal_entry_id ON payroll_periods BEGIN
  INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (NEW.company_id, 'payroll', NEW.id);
END;
`;

function applyFactSchema(db) {
  db.exec(FACT_SCHEMA_SQL);
}

module.exports = { applyFactSchema, FACT_SCHEMA_SQL };
