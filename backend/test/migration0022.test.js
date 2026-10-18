// backend/test/migration0022.test.js
//
// Migration 0022 widens two CHECK lists by rebuilding the tables
// (stock_moves.move_type, sync_operations.entity_type). On a database in
// the pre-0022 shape WITH rows: every row survives, foreign keys stay
// valid, the new values are accepted, and the schema equals a fresh init.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const backend = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-m22-'));
const run = (file, code) => execFileSync(process.execPath, ['-e', code], { cwd: backend, env: { ...process.env, NODE_ENV: 'test', ATLAS_DB_PATH: file }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const schema = (file) => {
  const d = new DatabaseSync(file, { readOnly: true });
  const rows = d.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => `${r.type} ${r.name} ${r.sql.replace(/\s+/g, ' ')}`);
  d.close();
  return rows;
};

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('0022 rebuilds stock_moves and sync_operations with rows: nothing lost, FKs valid, new values accepted, schema = fresh init', () => {
  const fresh = path.join(scratch, 'fresh.sqlite');
  const old = path.join(scratch, 'old.sqlite');
  run(fresh, "require('./db/init')");
  run(old, "require('./db/init')");
  // Put `old` back into the pre-0022 shape, with rows in both tables.
  const d = new DatabaseSync(old);
  d.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;');
  for (const [t, newList, oldList] of [
    ['stock_moves', ", 'production_issue', 'production_return', 'production_output', 'production_byproduct')", ')'],
    ['sync_operations', ", 'production_issue', 'production_output', 'production_wastage')", ')'],
  ]) {
    const sql = d.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t).sql;
    const idx = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t).map((r) => r.sql);
    d.exec(`ALTER TABLE ${t} RENAME TO ${t}_x`);
    for (const r of d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(`${t}_x`)) d.exec(`DROP INDEX ${r.name}`);
    d.exec(sql.replace(newList, oldList));
    d.exec(`DROP TABLE ${t}_x`);
    for (const s of idx) d.exec(s);
  }
  d.exec("INSERT INTO companies (id, name) VALUES (1, 'x')");
  d.exec("INSERT INTO users (id, company_id, name, contact, password_hash, status) VALUES (1, 1, 'u', 'u@x', 'h', 'approved')");
  d.exec("INSERT INTO products (id, company_id, name) VALUES (1, 1, 'p')");
  d.exec("INSERT INTO stock_holders (id, company_id, kind, name) VALUES (1, 1, 'warehouse', 'w')");
  d.exec("INSERT INTO stock_moves (id, company_id, product_id, holder_id, move_type, qty, value_minor, move_date, method, source_type) VALUES (1, 1, 1, 1, 'receipt', 5, 500, '2026-01-01', 'average', 't'), (2, 1, 1, 1, 'sale', -2, -200, '2026-01-02', 'average', 't')");
  d.exec("INSERT INTO stock_layers (id, company_id, product_id, holder_id, in_move_id, layer_date, qty_in, qty_remaining, value_remaining_minor) VALUES (1, 1, 1, 1, 1, '2026-01-01', 5, 3, 300)");
  d.exec("INSERT INTO sync_operations (company_id, user_id, idempotency_key, entity_type, payload_json) VALUES (1, 1, 'k1', 'visit', '{}'), (1, 1, 'k2', 'inventory_count', '{}')");
  assert.throws(() => d.exec("INSERT INTO sync_operations (company_id, user_id, idempotency_key, entity_type, payload_json) VALUES (1, 1, 'k3', 'production_output', '{}')"), /CHECK/);
  d.prepare('DELETE FROM schema_migrations WHERE filename = ?').run('0022_manufacturing.js');
  d.close();
  const out = execFileSync(process.execPath, ['db/migrate.js'], { cwd: backend, env: { ...process.env, NODE_ENV: 'test', ATLAS_DB_PATH: old }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /applied 0022_manufacturing\.js/);
  const a = new DatabaseSync(old);
  assert.deepEqual([a.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, a.prepare('SELECT COUNT(*) c FROM sync_operations').get().c, a.prepare('SELECT COUNT(*) c FROM stock_layers').get().c], [2, 2, 1]);
  assert.deepEqual(a.prepare('PRAGMA foreign_key_check').all(), []);
  a.exec("INSERT INTO sync_operations (company_id, user_id, idempotency_key, entity_type, payload_json) VALUES (1, 1, 'k3', 'production_output', '{}')");
  a.exec("INSERT INTO stock_moves (company_id, product_id, holder_id, move_type, qty, value_minor, move_date, method, source_type) VALUES (1, 1, 1, 'production_issue', -1, -100, '2026-01-03', 'average', 'mfg_order')");
  assert.equal(a.prepare("SELECT COUNT(*) c FROM schema_migrations WHERE filename = '0022_manufacturing.js'").get().c, 1);
  a.close();
  assert.deepEqual(schema(old), schema(fresh));
});
