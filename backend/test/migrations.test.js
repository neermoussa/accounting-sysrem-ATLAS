// backend/test/migrations.test.js
//
// Table-rebuild migrations must not lose rows or break foreign keys:
//  - 0009 (collections gets the 'reversed' status): rows, collection_changes
//    and customer_receipts survive and still reference "collections";
//  - 0001 (visit_records.wave_point_id nullable): visit_media rows survive
//    (with foreign keys ON inside the runner's transaction they used to be
//    cascade-deleted by DROP TABLE visit_records).
// Builds the OLD table shapes on a throwaway database, then runs the real
// migration runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mig-'));
process.env.ATLAS_DB_PATH = path.join(dir, 'data.sqlite');
const db = require('../db/init');
const { run } = require('../db/migrate');

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function downgrade() {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN');
  // collections as it was before 0009 (no 'reversed', no reversed_* columns)
  db.exec('ALTER TABLE collections RENAME TO c_tmp');
  db.exec(`CREATE TABLE collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    method TEXT NOT NULL CHECK (method IN ('cash', 'transfer')),
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_accountant_confirmation' CHECK (
      status IN ('pending_accountant_confirmation', 'pending_verification', 'confirmed', 'rejected')
    ),
    transfer_reference TEXT, notes TEXT, collected_at TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_by_id INTEGER REFERENCES users(id), confirmed_by_name TEXT, confirmed_at TEXT, rejected_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('DROP TABLE c_tmp');
  // visit_records as it was before 0001 (wave_point_id NOT NULL)
  db.exec('ALTER TABLE visit_records RENAME TO v_tmp');
  db.exec(`CREATE TABLE visit_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    wave_point_id INTEGER NOT NULL REFERENCES wave_points(id) ON DELETE CASCADE,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    form_template_id INTEGER REFERENCES visit_form_templates(id) ON DELETE SET NULL,
    result TEXT NOT NULL DEFAULT 'other' CHECK (result IN ('order_taken', 'no_order', 'shop_closed', 'refused', 'other')),
    refusal_reason TEXT, not_visited_reason TEXT, tasks_json TEXT NOT NULL DEFAULT '{}', answers_json TEXT NOT NULL DEFAULT '{}',
    voice_note_text TEXT, signature_data_url TEXT, lat REAL, lng REAL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('DROP TABLE v_tmp');
  db.exec('COMMIT');
  db.exec('PRAGMA legacy_alter_table = OFF');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec("DELETE FROM schema_migrations WHERE filename IN ('0001_visit_records_wave_point_id_nullable.js', '0009_collections_reversed_status.js')");
}

test('0001 and 0009 rebuild their tables without losing rows or breaking foreign keys', () => {
  run(); // brings the schema_migrations table up to date first
  downgrade();
  assert.ok(!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'collections'").get().sql.includes("'reversed'"));

  const cid = Number(db.prepare("INSERT INTO companies (name) VALUES ('ترحيل')").run().lastInsertRowid);
  const user = Number(db.prepare("INSERT INTO users (company_id, name, contact, password_hash, role, status) VALUES (?, 'u', 'u@x', 'x', 'manager', 'approved')").run(cid).lastInsertRowid);
  const shop = Number(db.prepare("INSERT INTO shops (company_id, name, lat, lng) VALUES (?, 's', 33.5, 36.3)").run(cid).lastInsertRowid);
  const inst = db.prepare("INSERT INTO wave_instances (company_id, rep_id, plan_date) VALUES (?, ?, '2026-01-01')").run(cid, user);
  const point = db.prepare('INSERT INTO wave_points (company_id, wave_instance_id, rep_id, shop_id, sequence) VALUES (?, ?, ?, ?, 1)').run(cid, inst.lastInsertRowid, user, shop);
  const visit = Number(db.prepare('INSERT INTO visit_records (company_id, wave_point_id, shop_id, rep_id) VALUES (?, ?, ?, ?)').run(cid, point.lastInsertRowid, shop, user).lastInsertRowid);
  db.prepare("INSERT INTO visit_media (company_id, visit_record_id, kind, url) VALUES (?, ?, 'before', '/x.jpg')").run(cid, visit);
  const col = Number(db.prepare("INSERT INTO collections (company_id, shop_id, method, amount, status) VALUES (?, ?, 'cash', 10, 'confirmed')").run(cid, shop).lastInsertRowid);
  db.prepare("INSERT INTO collection_changes (company_id, collection_id, action) VALUES (?, ?, 'confirm')").run(cid, col);
  db.prepare("INSERT INTO customer_receipts (company_id, shop_id, receipt_date, method, amount_minor, collection_id) VALUES (?, ?, '2026-01-01', 'cash', 1000, ?)").run(cid, shop, col);

  run();

  assert.equal(db.prepare('SELECT COUNT(*) c FROM visit_media').get().c, 1, 'visit_media survived 0001');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM collection_changes').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM customer_receipts WHERE collection_id = ?').get(col).c, 1);
  assert.equal(db.prepare('SELECT status FROM collections WHERE id = ?').get(col).status, 'confirmed');
  for (const t of ['collection_changes', 'customer_receipts', 'visit_media']) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t).sql;
    assert.ok(!/_tmp|_pre_0009|_new"/.test(sql), `${t} references a renamed table: ${sql}`);
  }
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'collections'").get().sql.includes("'reversed'"));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // Foreign keys are enforced against the rebuilt table: a receipt still
  // protects its collection; once it is gone the cascade to changes works.
  assert.throws(() => db.prepare('DELETE FROM collections WHERE id = ?').run(col), /FOREIGN KEY/);
  db.prepare('DELETE FROM customer_receipts WHERE collection_id = ?').run(col);
  db.prepare('DELETE FROM collections WHERE id = ?').run(col);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM collection_changes').get().c, 0);
});

test('0011 backfills accounts.report_class from the old code rules (templates, contra, cash)', () => {
  const ledger = require('../lib/ledger');
  const cid = Number(db.prepare("INSERT INTO companies (name, currency) VALUES ('تصنيف', 'USD')").run().lastInsertRowid);
  ledger.applyCoaTemplate(cid, 'trading', null);
  // Simulate a pre-0011 database: column empty, migration not applied.
  db.prepare('UPDATE accounts SET report_class = NULL WHERE company_id = ?').run(cid);
  db.prepare("DELETE FROM schema_migrations WHERE filename = '0011_account_report_class.js'").run();
  run();
  const cls = (code) => db.prepare('SELECT report_class FROM accounts WHERE company_id = ? AND code = ?').get(cid, code).report_class;
  const expected = { 1110: 'cash', 1115: 'cash', 1120: 'cash', 1130: 'current_asset', 1210: 'fixed_asset', 1290: 'contra_asset', 2110: 'current_liability', 2210: 'long_term_liability', 3200: 'equity', 4100: 'revenue', 4200: 'revenue', 5100: 'cogs', 6200: 'opex', 6850: 'opex' };
  for (const [code, c] of Object.entries(expected)) assert.equal(cls(code), c, code);
  // Same result as the template file itself.
  const t = require('../lib/coaTemplates/trading.json');
  for (const a of t.accounts) assert.equal(cls(a.code), a.report_class, `template ${a.code}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM accounts WHERE report_class IS NULL').get().c, 0);
});

test('0014 splits fx_gain_loss into fx_realized (same account, history kept) and a new fx_unrealized', () => {
  const ledger = require('../lib/ledger');
  const cid = Number(db.prepare("INSERT INTO companies (name, currency) VALUES ('صرف', 'USD')").run().lastInsertRowid);
  ledger.applyCoaTemplate(cid, 'trading', null);
  // Simulate a pre-0014 chart: one fx_gain_loss account, no fx_unrealized.
  const realized = db.prepare("SELECT * FROM accounts WHERE company_id = ? AND system_key = 'fx_realized'").get(cid);
  db.prepare("DELETE FROM accounts WHERE company_id = ? AND system_key = 'fx_unrealized'").run(cid);
  db.prepare("UPDATE accounts SET system_key = 'fx_gain_loss', name_ar = 'أرباح وخسائر فروقات الصرف' WHERE id = ?").run(realized.id);
  db.prepare("DELETE FROM schema_migrations WHERE filename = '0014_split_fx_accounts.js'").run();
  run();
  const r = db.prepare("SELECT * FROM accounts WHERE company_id = ? AND system_key = 'fx_realized'").get(cid);
  const u = db.prepare("SELECT * FROM accounts WHERE company_id = ? AND system_key = 'fx_unrealized'").get(cid);
  assert.equal(r.id, realized.id, 'same account (history kept)');
  assert.equal(r.name_ar, 'أرباح وخسائر فروقات الصرف المحققة');
  assert.equal(u.code, '6810');
  assert.equal(u.parent_id, r.parent_id);
  assert.equal(u.is_postable, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM accounts WHERE system_key = 'fx_gain_loss'").get().c, 0);
});
