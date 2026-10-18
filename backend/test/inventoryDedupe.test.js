// backend/test/inventoryDedupe.test.js
//
// One stock row per product per holder: duplicates seeded the way an old
// database could have them (unique index absent), then
//  - the merge refuses without a dry run, and when duplicates changed
//    after the dry run;
//  - the dry run reports groups, rows and summed quantities, writes no stock;
//  - executing merges exactly that report: quantities summed into the
//    oldest row, merged rows archived whole, one audit row per group,
//    notifications pointed at the survivor, unique index created (a new
//    duplicate is refused);
//  - migration 0018 refuses on unreviewed duplicates;
//  - flows that add stock match by product, not name (renamed product).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-dedupe-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const db = require('../db/init');
const dedupe = require('../lib/inventoryDedupe');
const { applyQty } = require('../lib/holderStock');

test.after(() => {
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

let co;
let pA;
let pB;
let pC;
const idx = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'uq_%_inventory_product'").all().map((r) => r.name).sort();

test('seeded duplicates: dry run required, report, stale refusal, merge with audit trail, unique index', () => {
  co = Number(db.prepare("INSERT INTO companies (name, currency) VALUES ('شركة مكررات', 'USD')").run().lastInsertRowid);
  const mk = (n) => Number(db.prepare('INSERT INTO products (company_id, name) VALUES (?, ?)').run(co, n).lastInsertRowid);
  pA = mk('سكر');
  pB = mk('طحين');
  pC = mk('ملح');
  assert.deepEqual(idx(), ['uq_car_inventory_product', 'uq_factory_inventory_product'], 'fresh database has the indexes');
  // Simulate an old database: no unique index, duplicates present.
  db.exec('DROP INDEX uq_factory_inventory_product; DROP INDEX uq_car_inventory_product;');
  const ins = (t, name, p, q, min = 0) => Number(db.prepare(`INSERT INTO ${t} (company_id, item_name, product_id, current_quantity, min_quantity) VALUES (?, ?, ?, ?, ?)`).run(co, name, p, q, min).lastInsertRowid);
  const a1 = ins('factory_inventory', 'سكر', pA, 10, 2);
  const a2 = ins('factory_inventory', 'سكر #2', pA, 5, 4);
  ins('factory_inventory', 'ملح', pC, 7);
  const b1 = ins('car_inventory', 'طحين', pB, 3);
  ins('car_inventory', 'طحين قديم', pB, 4);
  ins('car_inventory', 'طحين 2', pB, 1.5);
  db.prepare("INSERT INTO notifications (company_id, type, message_ar, message_en, entity_type, entity_id) VALUES (?, 'low_stock', 'x', 'x', 'factory_inventory', ?)").run(co, a2);
  const before = db.prepare('SELECT COUNT(*) c FROM factory_inventory').get().c + db.prepare('SELECT COUNT(*) c FROM car_inventory').get().c;

  assert.throws(() => dedupe.execute(db), (e) => e.code === 'dry_run_required');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM factory_inventory').get().c + db.prepare('SELECT COUNT(*) c FROM car_inventory').get().c, before, 'nothing merged');
  assert.throws(() => require('../db/migrations/0018_inventory_unique').up(db), (e) => e.code === 'dry_run_required', 'migration refuses on unreviewed duplicates');

  const dry = dedupe.dryRun(db);
  assert.equal(dry.duplicate_groups, 2);
  assert.equal(dry.rows_to_merge, 3);
  const gA = dry.groups.find((g) => g.product_id === pA);
  const gB = dry.groups.find((g) => g.product_id === pB);
  assert.deepEqual([gA.survivor_id, gA.merged_quantity, gA.merged_min_quantity], [a1, 15, 4]);
  assert.deepEqual([gB.survivor_id, gB.merged_quantity], [b1, 8.5]);
  assert.equal(db.prepare('SELECT current_quantity q FROM factory_inventory WHERE id = ?').get(a1).q, 10, 'dry run writes no stock');

  // Duplicates change after the dry run -> refused.
  db.prepare('UPDATE factory_inventory SET current_quantity = 6 WHERE id = ?').run(a2);
  assert.throws(() => dedupe.execute(db), (e) => e.code === 'dry_run_stale');

  dedupe.dryRun(db);
  const r = db.transaction(() => dedupe.execute(db))();
  assert.equal(r.executed, true);
  assert.deepEqual(db.prepare('SELECT id, current_quantity q, min_quantity m FROM factory_inventory WHERE product_id = ?').all(pA).map((x) => ({ ...x })), [{ id: a1, q: 16, m: 4 }]);
  assert.deepEqual(db.prepare('SELECT id, current_quantity q FROM car_inventory WHERE product_id = ?').all(pB).map((x) => ({ ...x })), [{ id: b1, q: 8.5 }]);
  assert.equal(db.prepare('SELECT current_quantity q FROM factory_inventory WHERE product_id = ?').get(pC).q, 7, 'non-duplicates untouched');
  const archived = db.prepare('SELECT * FROM inventory_merged_rows WHERE run_id = ? ORDER BY id').all(r.run_id);
  assert.equal(archived.length, 3);
  assert.equal(JSON.parse(archived[0].row_json).item_name, 'سكر #2');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'inventory.dedupe.merge' AND company_id = ?").get(co).c, 2);
  assert.equal(db.prepare("SELECT entity_id FROM notifications WHERE company_id = ? AND type = 'low_stock'").get(co).entity_id, a1, 'notification follows the survivor');
  assert.deepEqual(idx(), ['uq_car_inventory_product', 'uq_factory_inventory_product']);
  assert.throws(() => db.prepare("INSERT INTO car_inventory (company_id, item_name, product_id, current_quantity) VALUES (?, 'طحين جديد', ?, 1)").run(co, pB), /UNIQUE/);
  // Re-running is a no-op.
  assert.equal(dedupe.execute(db).executed, false);
});

test('stock writers match by product, not name: a renamed product adds to its existing row', () => {
  db.prepare("UPDATE products SET name = 'طحين أبيض' WHERE id = ?").run(pB);
  const row = applyQty('car_inventory', co, pB, 'طحين أبيض', 2);
  assert.equal(row.current_quantity, 10.5);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM car_inventory WHERE product_id = ?').get(pB).c, 1);
  const set = applyQty('car_inventory', co, pB, 'whatever', 4, { mode: 'set' });
  assert.equal(set.current_quantity, 4);
  // New product whose name is used by ANOTHER product's row: own row, suffixed name.
  db.prepare("UPDATE factory_inventory SET item_name = 'فلفل' WHERE product_id = ?").run(pC);
  const pD = Number(db.prepare("INSERT INTO products (company_id, name) VALUES (?, 'فلفل')").run(co).lastInsertRowid);
  const d = applyQty('factory_inventory', co, pD, 'فلفل', 1);
  assert.equal(d.item_name, `فلفل #${pD}`);
  assert.equal(db.prepare('SELECT current_quantity q FROM factory_inventory WHERE product_id = ?').get(pC).q, 7, 'the other product is untouched');
});
