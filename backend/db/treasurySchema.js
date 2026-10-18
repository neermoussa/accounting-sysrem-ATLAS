// backend/db/treasurySchema.js
//
// Treasury (Prompt 7): cash boxes / bank accounts (each on its own ledger
// account, each with a currency) + per-user access, treasury vouchers
// (RV receipt, PV payment, EV expense, TR transfer, BF bank fee), cheques
// issued, bank statements + reconciliation, rep cash handovers per
// currency, and the foreign-currency side tables for rep collections.
// Applied by db/init.js (fresh databases) and
// db/migrations/0017_treasury.js (existing ones); all IF NOT EXISTS, and
// column additions guarded by PRAGMA table_info (same ALTER on both paths).
//
// Ledger rows are only ever written through lib/ledger.js; these tables
// hold the documents and point at their journal entries.

const TREASURY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cash_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cash', 'bank')),
  currency_code TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  bank_name TEXT,
  account_number TEXT,
  iban TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name),
  UNIQUE (company_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_cash_boxes_company ON cash_boxes(company_id, is_active);

-- Per-user access: a user without manage_cash_boxes may only use the boxes
-- listed here for them.
CREATE TABLE IF NOT EXISTS cash_box_users (
  cash_box_id INTEGER NOT NULL REFERENCES cash_boxes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (cash_box_id, user_id)
);

-- Vouchers. Amounts: *_original_minor in the box currency, *_base_minor in
-- base. Draft -> approved (= posted, entry written) -> reversed; or draft ->
-- rejected / deleted.
CREATE TABLE IF NOT EXISTS treasury_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_number TEXT,
  type TEXT NOT NULL CHECK (type IN ('receipt', 'payment', 'expense', 'transfer', 'bank_fee')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'rejected', 'reversed')),
  voucher_date TEXT NOT NULL,
  cash_box_id INTEGER NOT NULL REFERENCES cash_boxes(id),
  to_cash_box_id INTEGER REFERENCES cash_boxes(id),
  counter_account_id INTEGER REFERENCES accounts(id),
  party_type TEXT CHECK (party_type IS NULL OR party_type IN ('employee')),
  party_id INTEGER,
  currency_code TEXT NOT NULL,
  amount_original_minor INTEGER NOT NULL CHECK (amount_original_minor > 0),
  tax_original_minor INTEGER NOT NULL DEFAULT 0,
  to_currency_code TEXT,
  to_amount_original_minor INTEGER,
  rate_e8 INTEGER,
  rate_quote TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  to_rate_e8 INTEGER,
  to_rate_quote TEXT CHECK (to_rate_quote IS NULL OR to_rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  amount_base_minor INTEGER,
  to_amount_base_minor INTEGER,
  fx_minor INTEGER NOT NULL DEFAULT 0,
  payee TEXT,
  reference TEXT,
  description TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  reject_reason TEXT,
  reversed_by INTEGER REFERENCES users(id),
  reversed_at TEXT,
  reverse_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, voucher_number)
);
CREATE INDEX IF NOT EXISTS idx_treasury_vouchers ON treasury_vouchers(company_id, status, voucher_date);

-- Cheques issued (from a bank box). Lifecycle: issued -> in_transit ->
-- cleared | bounced; issued/in_transit -> cancelled.
CREATE TABLE IF NOT EXISTS cheques_issued (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cheque_number TEXT NOT NULL,
  cash_box_id INTEGER NOT NULL REFERENCES cash_boxes(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  counter_account_id INTEGER REFERENCES accounts(id),
  payee TEXT,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  amount_original_minor INTEGER NOT NULL CHECK (amount_original_minor > 0),
  rate_e8 INTEGER,
  rate_quote TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  amount_base_minor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'in_transit', 'cleared', 'bounced', 'cancelled')),
  supplier_payment_id INTEGER REFERENCES supplier_payments(id),
  issue_entry_id INTEGER REFERENCES journal_entries(id),
  clear_entry_id INTEGER REFERENCES journal_entries(id),
  clear_fx_minor INTEGER NOT NULL DEFAULT 0,
  status_reason TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  handed_at TEXT,
  cleared_at TEXT,
  bounced_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, cash_box_id, cheque_number)
);
CREATE INDEX IF NOT EXISTS idx_cheques_issued_status ON cheques_issued(company_id, status, due_date);

-- Bank statements (imported) and their lines. amount_minor in the box
-- currency: + money in, - money out.
CREATE TABLE IF NOT EXISTS bank_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cash_box_id INTEGER NOT NULL REFERENCES cash_boxes(id),
  file_name TEXT,
  date_from TEXT,
  date_to TEXT,
  opening_balance_minor INTEGER,
  closing_balance_minor INTEGER,
  line_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  statement_id INTEGER NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  cash_box_id INTEGER NOT NULL REFERENCES cash_boxes(id),
  line_no INTEGER NOT NULL,
  line_date TEXT NOT NULL,
  description TEXT,
  reference TEXT,
  amount_minor INTEGER NOT NULL,
  balance_minor INTEGER,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'suggested', 'matched', 'ignored')),
  journal_line_id INTEGER REFERENCES journal_lines(id),
  confidence INTEGER,
  match_method TEXT,
  matched_by INTEGER REFERENCES users(id),
  matched_at TEXT,
  UNIQUE (statement_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_bank_lines_box ON bank_statement_lines(company_id, cash_box_id, status);
-- A ledger line is matched to at most one statement line.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_lines_journal ON bank_statement_lines(journal_line_id) WHERE journal_line_id IS NOT NULL;

-- Rep cash handover: one currency per document. expected = what the rep's
-- confirmed cash collections in that currency add up to; counted = what the
-- accountant counted into the box.
CREATE TABLE IF NOT EXISTS rep_cash_handovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  handover_number TEXT NOT NULL,
  rep_id INTEGER NOT NULL REFERENCES users(id),
  cash_box_id INTEGER NOT NULL REFERENCES cash_boxes(id),
  currency_code TEXT NOT NULL,
  handover_date TEXT NOT NULL,
  expected_original_minor INTEGER NOT NULL,
  counted_original_minor INTEGER NOT NULL CHECK (counted_original_minor >= 0),
  over_short_original_minor INTEGER NOT NULL,
  carried_base_minor INTEGER NOT NULL,
  rate_e8 INTEGER,
  rate_quote TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  counted_base_minor INTEGER NOT NULL,
  over_short_base_minor INTEGER NOT NULL,
  fx_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, handover_number)
);
CREATE TABLE IF NOT EXISTS rep_cash_handover_items (
  handover_id INTEGER NOT NULL REFERENCES rep_cash_handovers(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount_original_minor INTEGER NOT NULL,
  base_minor INTEGER NOT NULL,
  PRIMARY KEY (handover_id, collection_id)
);

-- Rep collections in a foreign currency (and rep cash held in custody).
-- Kept OUT of the collections table so base-currency collections (and the
-- legacy golden snapshot) are byte-identical. rate is locked at
-- confirmation; until then rate_e8 holds the estimate shown to the rep.
CREATE TABLE IF NOT EXISTS collection_fx (
  collection_id INTEGER PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  currency_code TEXT NOT NULL,
  amount_original_minor INTEGER NOT NULL CHECK (amount_original_minor > 0),
  rate_e8 INTEGER,
  rate_quote TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base')),
  base_minor INTEGER,
  locked_at TEXT,
  locked_by INTEGER REFERENCES users(id)
);
`;

// [table, column, definition]
const TREASURY_COLUMNS = [
  // Received cheques: own currency + rate locked when recorded (= confirmed
  // by the accountant), and the bank box they cleared into.
  ['cheques_received', 'currency_code', 'TEXT'],
  ['cheques_received', 'amount_original_minor', 'INTEGER'],
  ['cheques_received', 'rate_e8', 'INTEGER'],
  ['cheques_received', 'rate_quote', "TEXT CHECK (rate_quote IS NULL OR rate_quote IN ('base_per_foreign', 'foreign_per_base'))"],
  ['cheques_received', 'cash_box_id', 'INTEGER REFERENCES cash_boxes(id)'],
  ['cheques_received', 'clear_fx_minor', 'INTEGER'],
];

function applyTreasurySchema(db) {
  db.exec(TREASURY_SCHEMA_SQL);
  for (const [table, column, def] of TREASURY_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

module.exports = { applyTreasurySchema, TREASURY_SCHEMA_SQL };
