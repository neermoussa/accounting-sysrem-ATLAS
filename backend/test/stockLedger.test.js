// backend/test/stockLedger.test.js
//
// Prompt 8a — stock ledger:
//  - activation: dry run required, plan change refused, opening moves per
//    holder + one inventory_opening entry, inventory banner gone, legacy
//    tables untouched by activation;
//  - a count adjustment, a manual adjustment (damage) and transfers
//    (custody transfer warehouse -> vehicle; transfer document) post
//    correct entries; factory stock goes down on a custody transfer;
//  - sales: COGS from the sale move; credit note restock at the sale's cost;
//  - returns restock into the rep's custody; offline car count;
//  - purchasing: receipt (standard: variance to PPV), landed cost to the
//    stock still on hand (rest to COGS), debit note at the ORIGINAL cost
//    layer incl. landed cost (FIFO and average);
//  - insufficient stock refused; method locked while stock exists;
//    standard-cost change revalues; daily reconciliation stores a check and
//    flags a manual entry on inventory; failure injection; tenant refs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-stock-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const faults = require('../lib/faultInjection');
const S = require('../lib/stockLedger');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const D = new Date().toISOString().slice(0, 10);
let listener;
let base;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const lines = (entryId) => db.prepare('SELECT a.system_key k, a.code, l.debit_minor d, l.credit_minor c FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId);
const net = (ls, key) => ls.filter((l) => l.k === key).reduce((s, l) => s + l.d - l.c, 0);
const legacy = (t, pid) => db.prepare(`SELECT current_quantity q FROM ${t} WHERE product_id = ?`).get(pid)?.q ?? 0;
const pool = (pid, hid) => S.poolRow(ctx.co.companyId, pid, hid);
function assertReconciled(label) {
  const r = S.reconcile(ctx.co.companyId);
  assert.equal(r.difference_minor, 0, `${label}: inventory accounts = valuation (${JSON.stringify(r)})`);
  assert.equal(r.inventory_difference_minor, 0, `${label}: warehouse account = warehouse holders`);
  assert.deepEqual(r.qty_mismatches, [], `${label}: legacy quantities = stock moves`);
}

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة دفتر المخزون');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m);
  const mk = async (name, category, cost) => {
    const id = await h.mkProduct(m, { name, category });
    db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(cost, id);
    return id;
  };
  const pA = await mk('مادة متوسط', null, 2);
  const pB = await mk('مادة فيفو', 'fifo', 3);
  const pC = await mk('مادة معيارية', 'std', 4);
  const shop = await h.mkShop(m, 'زبون المخزون');
  ok((await h.goLive(m, D)).res);
  const rep = await createRep(base, m, { name: 'مندوب المخزون', permissions: ['view_app', 'request_returns', 'confirm_custody_transfer_receipt', 'record_collections'] });
  const vehicle = ok(await m.post('/api/companies/vehicles', { label: 'سيارة المخزون' }), 201);
  const wh = ok(await m.post('/api/companies/warehouses', { name: 'المستودع الرئيسي', kind: 'factory' }), 201);
  // Stock before activation, through the existing screens.
  ok(await m.post('/api/factory-inventory', { product_id: pA, current_quantity: 100 }), 201);
  ok(await m.post('/api/factory-inventory', { product_id: pB, current_quantity: 50 }), 201);
  ok(await m.post('/api/factory-inventory', { product_id: pC, current_quantity: 20 }), 201);
  ok(await m.post('/api/inventory', { product_id: pA, current_quantity: 10 }), 201);
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد المخزون', currencyCode: 'USD' }), 201);
  ctx = { co, m, pA, pB, pC, shop, rep, vehicle, wh, supplier, acc: (c) => accounts.find((a) => a.code === c).id };
});
test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('activation: methods first, dry run required, plan change refused, opening moves + inventory_opening entry, banner gone', async () => {
  const { m, pA, pB, pC, co } = ctx;
  ok(await m.put('/api/stock/method', { category: 'fifo', method: 'fifo' }));
  assert.equal((await m.put('/api/stock/method', { category: 'std', method: 'standard' })).body.error, 'standard_cost_missing');
  ok(await m.put(`/api/stock/standard-costs/${pC}`, { standardCost: '4.00' }));
  ok(await m.put('/api/stock/method', { category: 'std', method: 'standard' }));
  const before = ok(await m.get(`/api/financial-reports/balance-sheet?asOf=${D}`));
  assert.equal(before.inventory_opening_missing, true, 'banner before activation');
  assert.equal((await m.post('/api/stock/activation', { dryRunId: 999 })).body.error, 'dry_run_required');
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  assert.equal(dry.ok, true, JSON.stringify(dry.problems));
  assert.deepEqual(dry.rows.map((r) => [r.table, r.product_id, r.qty, r.value_minor]), [
    ['factory_inventory', pA, 100, 20000], ['factory_inventory', pB, 50, 15000], ['factory_inventory', pC, 20, 8000], ['car_inventory', pA, 10, 2000],
  ]);
  assert.deepEqual(dry.opening_entry, { inventory_minor: 43000, custody_minor: 2000 });
  // Quantities change after the dry run -> refused.
  const fa = db.prepare('SELECT id FROM factory_inventory WHERE product_id = ?').get(pA).id;
  ok(await m.put(`/api/factory-inventory/${fa}/quantity`, { current_quantity: 101 }));
  assert.equal((await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id })).body.error, 'plan_changed');
  ok(await m.put(`/api/factory-inventory/${fa}/quantity`, { current_quantity: 100 }));
  const dry2 = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  faults.arm('stock.activation.after_moves');
  assert.equal((await m.post('/api/stock/activation', { dryRunId: dry2.dry_run_id })).status, 500);
  faults.disarmAll();
  assert.equal(S.isActive(co.companyId), false, 'failure rolled back');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE company_id = ?').get(co.companyId).c, 0);
  const act = ok(await m.post('/api/stock/activation', { dryRunId: dry2.dry_run_id }));
  assert.equal(act.moves, 4);
  const e = lines(act.journal_entry_id);
  assert.deepEqual([net(e, 'inventory'), net(e, 'inventory_custody'), net(e, 'opening_balance_equity')], [43000, 2000, -45000]);
  assert.equal(db.prepare('SELECT source_type FROM journal_entries WHERE id = ?').get(act.journal_entry_id).source_type, 'inventory_opening');
  assert.equal(ok(await m.get(`/api/financial-reports/balance-sheet?asOf=${D}`)).inventory_opening_missing, false, 'banner gone');
  assert.equal(legacy('factory_inventory', pA), 100, 'legacy untouched by activation');
  assert.equal(legacy('car_inventory', pA), 10);
  assertReconciled('after activation');
  ctx.whHolder = S.warehouseHolder(co.companyId, null);
  ctx.carPool = S.carPoolHolder(co.companyId);
  assert.equal(ctx.whHolder.ref_id, ctx.wh.id, 'the existing warehouse is the default holder');
  // Method change now locked for products with stock.
  assert.equal((await m.put('/api/stock/method', { method: 'fifo' })).body.error, 'method_locked');
});

test('count adjustment and manual (damage) adjustment post correct entries; screens keep legacy = moves', async () => {
  const { m, pA } = ctx;
  const fa = db.prepare('SELECT id FROM factory_inventory WHERE product_id = ?').get(pA).id;
  const c = ok(await m.post('/api/factory-inventory/count/confirm', { filename: 'جرد', rows: [{ itemName: 'مادة متوسط', matchedItemId: fa, expectedQuantity: 100, countedQuantity: 97, variance: -3, classification: 'minor', reason: 'نقص' }] }), 201);
  const mv = db.prepare("SELECT * FROM stock_moves WHERE source_type = 'inventory_count' AND source_id = ?").get(c.count.id);
  assert.deepEqual([mv.move_type, mv.qty, mv.value_minor, mv.reason_code], ['count', -3, -600, 'نقص']);
  const e = lines(mv.journal_entry_id);
  assert.deepEqual([net(e, 'inventory'), net(e, 'inventory_adjustments')], [-600, 600]);
  assert.equal(legacy('factory_inventory', pA), 97);
  // Damage write-off on a holder (8b adds wastage documents; here: adjustment with a reason).
  const adj = ok(await m.post('/api/stock/adjustments', { productId: pA, holderId: ctx.whHolder.id, newQty: 95, reasonCode: 'تلف' }), 201);
  assert.equal(adj.delta, -2);
  assert.deepEqual([net(lines(db.prepare('SELECT journal_entry_id j FROM stock_moves WHERE id = ?').get(adj.moveId).j), 'inventory')], [-400]);
  assert.equal(legacy('factory_inventory', pA), 95, 'adjustment syncs legacy');
  // Screen quantity edit up.
  ok(await m.put(`/api/factory-inventory/${fa}/quantity`, { current_quantity: 100 }));
  assert.equal(pool(pA, ctx.whHolder.id).qty, 100);
  assertReconciled('after adjustments');
});

test('custody transfer moves stock warehouse -> vehicle at cost (factory down, car up) with one entry; transfer document', async () => {
  const { m, rep, pA, vehicle, wh } = ctx;
  const tr = ok(await m.post('/api/custody-transfers', { warehouseId: wh.id, vehicleId: vehicle.id, repId: rep.userId }), 201);
  ok(await m.post(`/api/custody-transfers/${tr.id}/items`, { productId: pA, productName: 'مادة متوسط', preparedQty: 30 }), 201);
  ok(await m.post(`/api/custody-transfers/${tr.id}/ready`, {}));
  const item = ok(await m.get(`/api/custody-transfers/${tr.id}`)).items[0];
  faults.arm('stock.custody_transfer.after_entry');
  const failed = await rep.client.post(`/api/custody-transfers/${tr.id}/confirm-receipt`, { items: [{ itemId: item.id, receivedQty: 30 }] });
  assert.equal(failed.status, 500);
  faults.disarmAll();
  assert.equal(legacy('factory_inventory', pA), 100, 'nothing moved');
  assert.equal(db.prepare('SELECT status FROM custody_transfers WHERE id = ?').get(tr.id).status, 'loading');
  // Receipt was confirmed before the close failed: close again.
  const closed = ok(await m.post(`/api/custody-transfers/${tr.id}/close`, {}));
  assert.equal(closed.status, 'closed');
  assert.equal(legacy('factory_inventory', pA), 70, 'factory stock goes down (stock ledger only)');
  assert.equal(legacy('car_inventory', pA), 40);
  const vh = S.vehicleHolder(ctx.co.companyId, vehicle.id);
  assert.equal(pool(pA, vh.id).qty, 30);
  const mv = db.prepare("SELECT journal_entry_id j FROM stock_moves WHERE source_type = 'custody_transfer' AND source_id = ? AND move_type = 'transfer_in'").get(tr.id);
  const e = lines(mv.j);
  assert.deepEqual([net(e, 'inventory_custody'), net(e, 'inventory')], [6000, -6000]);
  // Transfer document vehicle -> car pool (both custody: same account, still recorded).
  const t = ok(await m.post('/api/stock/transfers', { productId: pA, fromHolderId: vh.id, toHolderId: ctx.carPool.id, qty: 5 }), 201);
  assert.equal(t.value, 1000);
  assert.equal(net(lines(t.journal_entry_id), 'inventory_custody'), 0);
  assert.equal(pool(pA, ctx.carPool.id).qty, 15);
  // Insufficient stock refused, nothing written.
  const r = await m.post('/api/stock/transfers', { productId: pA, fromHolderId: vh.id, toHolderId: ctx.whHolder.id, qty: 500 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'insufficient_stock');
  assertReconciled('after transfers');
  ctx.vh = vh;
});

test('sales: COGS = sale move cost; credit note restock returns at the sale cost; returns restock + offline count into custody', async () => {
  const { m, rep, shop, pA, pB } = ctx;
  const inv = ok(await m.post('/api/sales/invoices', { shopId: shop, invoiceDate: D, lines: [{ productId: pA, qty: 10, unitPrice: '5' }, { productId: pB, qty: 4, unitPrice: '9' }] }), 201);
  const posted = ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  const e = lines(posted.journal_entry_id);
  assert.equal(net(e, 'cogs'), 2000 + 1200, 'A 10 x 2.00 (average) + B 4 x 3.00 (FIFO opening layer)');
  assert.equal(net(e, 'inventory'), -3200);
  assert.equal(pool(pA, ctx.whHolder.id).qty, 60);
  const cn = ok(await m.post('/api/sales/credit-notes', { invoiceId: inv.id, restock: true, lines: [{ invoiceLineId: posted.lines[1].id, qty: 1 }] }), 201);
  const ce = lines(cn.journal_entry_id);
  assert.deepEqual([net(ce, 'inventory'), net(ce, 'cogs')], [300, -300], 'back at the sale cost');
  // Returns: restock into the filing rep's custody (their vehicle? no vehicle link -> the rep).
  const ret = ok(await rep.client.post('/api/returns', { shopId: shop, items: [{ productId: pA, productName: 'مادة متوسط', qty: 2, unitValue: 5 }] }), 201);
  ok(await m.put(`/api/returns/${ret.id}/items/${ret.items[0].id}/inspect`, { inspectionStatus: 'valid', inspectedQty: 2 }));
  ok(await m.post(`/api/returns/${ret.id}/approve`, {}));
  const rh = S.custodyHolderForRep(ctx.co.companyId, rep.userId);
  assert.equal(pool(pA, rh.id).qty, 2);
  assert.equal(legacy('car_inventory', pA), 42);
  // Offline car count sets the pooled car total.
  ok(await m.post('/api/sync/batch', { operations: [{ clientId: 'x', idempotencyKey: 'stock-count-1', entityType: 'inventory_count', operation: 'create', payload: { productId: pA, quantity: 40 } }] }), 201);
  assert.equal(legacy('car_inventory', pA), 40);
  assertReconciled('after sales and returns');
});

test('purchasing: receipt into the warehouse, landed cost to stock on hand (rest COGS), debit note at the original layer incl. landed (FIFO + average); standard variance', async () => {
  const { m, supplier, pA, pB, pC } = ctx;
  const approver = await createRep(base, m, { permissions: ['approve_purchase_orders', 'view_purchases'] });
  const po = async (lns) => {
    const p = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: D, lines: lns }), 201);
    const s = ok(await m.post(`/api/purchasing/orders/${p.id}/submit`, {}));
    ok(await approver.client.post(`/api/purchasing/orders/${p.id}/approve`, {}));
    return s;
  };
  // FIFO product B: receive 10 @ 5.00, landed 10.00 -> layer 60.00 (6.00/unit).
  const pb = await po([{ productId: pB, qty: 10, unitPrice: '5' }]);
  const grn = ok(await m.post(`/api/purchasing/orders/${pb.id}/receive`, { receiptDate: D, lines: [{ poLineId: pb.lines[0].id, qty: 10 }] }), 201);
  assert.equal(net(lines(grn.journal_entry_id), 'inventory'), 5000);
  const lc = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: supplier.id, receiptId: grn.id, landedMethod: 'value', invoiceDate: D, lines: [{ description: 'شحن', qty: 1, unitPrice: '10' }] }), 201);
  const lcp = ok(await m.post(`/api/purchasing/invoices/${lc.id}/post`, {}));
  assert.equal(net(lines(lcp.journal_entry.id), 'inventory'), 1000, 'all 10 still on hand -> all to stock');
  const binv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: pb.id, invoiceDate: D, lines: [{ poLineId: pb.lines[0].id, qty: 10, unitPrice: '5' }] }), 201);
  const bposted = ok(await m.post(`/api/purchasing/invoices/${binv.id}/post`, {}));
  // Debit note: 4 returned -> out at 4 x 6.00 = 24.00 (its own layer incl. landed), invoice value 20.00 -> PPV 4.00.
  const dn = ok(await m.post('/api/purchasing/debit-notes', { invoiceId: binv.id, returnGoods: true, lines: [{ invoiceLineId: bposted.lines[0].id, qty: 4 }] }), 201);
  const dl = lines(db.prepare('SELECT journal_entry_id j FROM supplier_debit_notes WHERE id = ?').get(dn.id).j);
  assert.deepEqual([net(dl, 'ap_control'), net(dl, 'inventory'), net(dl, 'purchase_price_variance')], [2000, -2400, 400]);
  const mv = db.prepare("SELECT * FROM stock_moves WHERE source_type = 'supplier_debit_note' AND source_id = ?").get(dn.id);
  assert.deepEqual([mv.move_type, mv.qty, mv.value_minor], ['purchase_return', -4, -2400]);
  // Average product A: receive 20 @ 3.50 (pool avg changes), landed 4.00, return 5 at receipt cost (3.50 + 0.20).
  const pa = await po([{ productId: pA, qty: 20, unitPrice: '3.5' }]);
  const grnA = ok(await m.post(`/api/purchasing/orders/${pa.id}/receive`, { receiptDate: D, lines: [{ poLineId: pa.lines[0].id, qty: 20 }] }), 201);
  const lcA = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: supplier.id, receiptId: grnA.id, landedMethod: 'value', invoiceDate: D, lines: [{ description: 'جمارك', qty: 1, unitPrice: '4' }] }), 201);
  ok(await m.post(`/api/purchasing/invoices/${lcA.id}/post`, {}));
  const ainv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: pa.id, invoiceDate: D, lines: [{ poLineId: pa.lines[0].id, qty: 20, unitPrice: '3.5' }] }), 201);
  const aposted = ok(await m.post(`/api/purchasing/invoices/${ainv.id}/post`, {}));
  const dnA = ok(await m.post('/api/purchasing/debit-notes', { invoiceId: ainv.id, returnGoods: true, lines: [{ invoiceLineId: aposted.lines[0].id, qty: 5 }] }), 201);
  const dlA = lines(db.prepare('SELECT journal_entry_id j FROM supplier_debit_notes WHERE id = ?').get(dnA.id).j);
  assert.deepEqual([net(dlA, 'inventory'), net(dlA, 'purchase_price_variance')], [-1850, 100], '5 x (3.50 + 0.20) out; invoice 17.50 -> PPV 1.00');
  // Standard product C (4.00): receive 5 @ 4.60 -> stock 20.00, variance 3.00 to PPV.
  const pc = await po([{ productId: pC, qty: 5, unitPrice: '4.6' }]);
  const grnC = ok(await m.post(`/api/purchasing/orders/${pc.id}/receive`, { receiptDate: D, lines: [{ poLineId: pc.lines[0].id, qty: 5 }] }), 201);
  const gc = lines(grnC.journal_entry_id);
  assert.deepEqual([net(gc, 'inventory'), net(gc, 'purchase_price_variance'), net(gc, 'grni')], [2000, 300, -2300]);
  // Standard cost change revalues the stock (25 units x +0.40 = 10.00 to PPV).
  const sc = ok(await m.put(`/api/stock/standard-costs/${pC}`, { standardCost: '4.40' }));
  assert.equal(sc.revalued, 1);
  assert.equal(pool(pC, ctx.whHolder.id).value_minor, 11000);
  assertReconciled('after purchasing');
});

test('daily reconciliation stores a check; a manual entry on inventory is flagged with a notification', async () => {
  const { m, co } = ctx;
  S.runDailyReconciliation();
  const chk = db.prepare('SELECT * FROM stock_reconciliation_checks WHERE company_id = ? ORDER BY id DESC').get(co.companyId);
  assert.equal(chk.ok, 1);
  S.runDailyReconciliation();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_reconciliation_checks WHERE company_id = ?').get(co.companyId).c, 1, 'once a day');
  ok(await m.post('/api/ledger/entries', { date: D, description: 'قيد يدوي على المخزون', post: true, lines: [{ accountId: ctx.acc('1150'), debit: '1' }, { accountId: ctx.acc('3100'), credit: '1' }] }), 201);
  const r = S.reconcile(co.companyId, { store: true });
  assert.equal(r.ok, false);
  assert.equal(r.difference_minor, 100);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE company_id = ? AND type = 'stock_reconciliation_failed'").get(co.companyId));
});

test('tenant refs + permissions on /api/stock', async () => {
  const { m } = ctx;
  const other = await h.createUsdCompany(base, 'شركة مخزون أخرى');
  await h.setupLedger(other.manager);
  const op = await h.mkProduct(other.manager, { name: 'غريب' });
  const oh = ok(await other.manager.post('/api/stock/holders', { kind: 'car_pool' }), 201);
  const foreign = (r, what) => assert.ok(r.status === 400 && /^invalid_/.test(r.body.error), `${what}: ${JSON.stringify(r.body)}`);
  foreign(await m.post('/api/stock/transfers', { productId: op, fromHolderId: ctx.whHolder.id, toHolderId: ctx.carPool.id, qty: 1 }), 'transfer product');
  foreign(await m.post('/api/stock/transfers', { productId: ctx.pA, fromHolderId: oh.id, toHolderId: ctx.carPool.id, qty: 1 }), 'transfer holder');
  foreign(await m.post('/api/stock/adjustments', { productId: ctx.pA, holderId: oh.id, newQty: 1, reasonCode: 'x' }), 'adjust holder');
  foreign(await m.put(`/api/stock/standard-costs/${op}`, { standardCost: '1' }), 'standard cost');
  foreign(await m.get(`/api/stock/moves?productId=${op}`), 'moves');
  foreign(await m.get(`/api/stock/valuation?holderId=${oh.id}`), 'valuation');
  foreign(await m.post('/api/stock/holders', { kind: 'warehouse', refId: db.prepare('SELECT id FROM warehouses WHERE company_id = ? LIMIT 1').get(other.companyId)?.id || 999999 }), 'holder warehouse');
  const nobody = await createRep(base, m, { permissions: ['view_app'] });
  for (const [method, url] of [['get', '/api/stock/valuation'], ['post', '/api/stock/activation/dry-run'], ['post', '/api/stock/adjustments'], ['put', '/api/stock/method']]) assert.equal((await nobody.client[method](url, {})).status, 403, url);
});
