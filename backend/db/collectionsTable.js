// backend/db/collectionsTable.js
//
// The `collections` table DDL, shared by db/init.js (fresh databases) and
// migrations/0009_collections_reversed_status.js (table rebuild on existing
// databases) so both produce byte-identical schema text. 'reversed' was added
// after Prompt 3: a confirmed collection can be reversed through its own
// action, which reverses its journal entry. Who/when/why is recorded in
// collection_changes and the audit log — no new columns, so the API rows of
// companies that are not ledger-live stay byte-identical.

const COLLECTIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer')),
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_accountant_confirmation' CHECK (
    status IN ('pending_accountant_confirmation', 'pending_verification', 'confirmed', 'rejected', 'reversed')
  ),
  transfer_reference TEXT,
  notes TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by_id INTEGER REFERENCES users(id),
  confirmed_by_name TEXT,
  confirmed_at TEXT,
  rejected_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collections_company ON collections(company_id, status);
CREATE INDEX IF NOT EXISTS idx_collections_shop ON collections(shop_id, collected_at);`;

const COLLECTIONS_COPY_COLUMNS = [
  'id', 'company_id', 'shop_id', 'rep_id', 'method', 'amount', 'status', 'transfer_reference', 'notes', 'collected_at',
  'confirmed_by_id', 'confirmed_by_name', 'confirmed_at', 'rejected_reason', 'created_at', 'updated_at',
];

module.exports = { COLLECTIONS_TABLE_SQL, COLLECTIONS_COPY_COLUMNS };
