// backend/test/stockLedgerProperty.test.js
//
// Prompt 8 "Done when": inventory valuation total = ledger inventory
// balance after a random sequence of 200 moves under EACH valuation method
// (average, FIFO, standard). Operations go through the real documents and
// screens: goods receipts, landed costs, debit notes (at original layers),
// sales invoices, credit notes with restock, transfer documents between two
// warehouses / a vehicle / the car pool, manual adjustments and counts.
// After every operation, independently of the engine's own pools:
//   sum(moves.value) = sum(pools.value) = ledger inventory + custody stock,
//   warehouse account = warehouse holders, custody account = custody holders,
//   legacy factory/car quantities = moves, no negative holder, and (FIFO)
//   the open layers add up to each pool.
// After Prompt 8b one product is lot-tracked (receipts carry lots, FEFO on
// every way out), and wastage documents and approved stock-count documents
// join the mix. Per holder and product: sum(lot balances) = sum(moves) =
// the pool row; per lot and holder: lot balance = its moves; no negative
// lot balance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-stockprop-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const S = require('../lib/stockLedger');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const D = new Date().toISOString().slice(0, 10);
let listener;
let base;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
test.before(() => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function invariants(cid, label) {
  const movesTotal = db.prepare('SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ?').get(cid).v;
  const poolsTotal = db.prepare('SELECT COALESCE(SUM(value_minor), 0) v FROM stock_pools WHERE company_id = ?').get(cid).v;
  assert.equal(movesTotal, poolsTotal, `${label}: sum of moves = sum of pools`);
  const r = S.reconcile(cid);
  assert.equal(r.ledger_minor, movesTotal, `${label}: ledger inventory accounts = valuation`);
  assert.equal(r.inventory_difference_minor, 0, `${label}: warehouse account = warehouse holders`);
  assert.equal(r.custody_difference_minor, 0, `${label}: custody account = custody holders`);
  assert.deepEqual(r.qty_mismatches, [], `${label}: legacy quantities = moves`);
  const neg = db.prepare('SELECT * FROM stock_pools WHERE company_id = ? AND qty < -1e-9').all(cid);
  assert.deepEqual(neg, [], `${label}: no negative holder`);
  const byMoves = db.prepare('SELECT product_id, holder_id, SUM(qty) q, SUM(value_minor) v FROM stock_moves WHERE company_id = ? GROUP BY product_id, holder_id').all(cid);
  for (const m of byMoves) {
    const p = S.poolRow(cid, m.product_id, m.holder_id);
    assert.ok(Math.abs(p.qty - m.q) < 1e-6 && p.value_minor === m.v, `${label}: pool ${m.product_id}/${m.holder_id} = its moves`);
    if (S.methodFor(cid, m.product_id) === 'fifo') {
      const l = db.prepare('SELECT COALESCE(SUM(qty_remaining), 0) q, COALESCE(SUM(value_remaining_minor), 0) v FROM stock_layers WHERE product_id = ? AND holder_id = ?').get(m.product_id, m.holder_id);
      assert.ok(Math.abs(l.q - p.qty) < 1e-6 && l.v === p.value_minor, `${label}: FIFO layers = pool ${m.product_id}/${m.holder_id}`);
    }
  }
  // Lots (Prompt 8b): for every holder of a tracked product,
  // sum(lot balances) = sum(moves) = pool row; each lot balance = its moves.
  for (const m of byMoves) {
    if (!S.isTracked(cid, m.product_id)) continue;
    const lotSum = db.prepare('SELECT COALESCE(SUM(qty), 0) q FROM stock_lot_balances WHERE product_id = ? AND holder_id = ?').get(m.product_id, m.holder_id).q;
    assert.ok(Math.abs(lotSum - m.q) < 1e-6, `${label}: lots ${lotSum} = moves ${m.q} for ${m.product_id}/${m.holder_id}`);
    assert.ok(Math.abs(lotSum - S.poolRow(cid, m.product_id, m.holder_id).qty) < 1e-6, `${label}: lots = pool row ${m.product_id}/${m.holder_id}`);
  }
  const tracked = db.prepare('SELECT product_id FROM product_stock_settings WHERE company_id = ? AND track_lots = 1').all(cid).map((r) => r.product_id);
  for (const pid of tracked) {
    const byLotMoves = db.prepare('SELECT lot_id, holder_id, SUM(qty) q FROM stock_moves WHERE company_id = ? AND product_id = ? AND lot_id IS NOT NULL GROUP BY lot_id, holder_id').all(cid, pid);
    for (const x of byLotMoves) {
      const b = db.prepare('SELECT COALESCE(SUM(qty), 0) q FROM stock_lot_balances WHERE lot_id = ? AND holder_id = ?').get(x.lot_id, x.holder_id).q;
      // Opening stock entered the UNASSIGNED lot when tracking was switched on (no move carries it).
      const opening = db.prepare("SELECT COALESCE(SUM(m.qty), 0) q FROM stock_moves m JOIN stock_lots l ON l.lot_code = 'UNASSIGNED' AND l.id = ? WHERE m.product_id = ? AND m.holder_id = ? AND m.lot_id IS NULL").get(x.lot_id, pid, x.holder_id).q;
      assert.ok(Math.abs(b - x.q - opening) < 1e-6, `${label}: lot ${x.lot_id} @ ${x.holder_id} balance ${b} = its moves ${x.q} (+ opening ${opening})`);
    }
  }
  assert.deepEqual(db.prepare('SELECT * FROM stock_lot_balances WHERE company_id = ? AND qty < -1e-9').all(cid), [], `${label}: no negative lot balance`);
  const bad = db.prepare('SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.company_id = ? GROUP BY e.id HAVING SUM(l.debit_minor) <> SUM(l.credit_minor)').all(cid);
  assert.deepEqual(bad, [], `${label}: entries balance`);
}

// Independent costing oracle: replays every move of the company in order,
// without the engine's pools, and checks each OUT move's value.
//   average : out = whole pool value, or round(value * qty / pool qty)
//             (purchase returns leave at their receipt cost: skipped);
//   standard: out = round(standard cost * qty), or the whole pool value;
//   fifo    : the out consumed the OLDEST open layers in order (purchase
//             returns: their own receipt layers first), and its value = the
//             sum of the consumed pieces.
function costingOracle(cid) {
  const moves = db.prepare('SELECT * FROM stock_moves WHERE company_id = ? ORDER BY id').all(cid);
  const pools = new Map();
  const layerQty = new Map();
  let checked = 0;
  for (const mv of moves) {
    const key = `${mv.product_id}/${mv.holder_id}`;
    const pl = pools.get(key) || { q: 0, v: 0 };
    if (mv.qty < 0) {
      const q = -mv.qty;
      const all = Math.abs(pl.q - q) < 1e-9;
      if (mv.method === 'average' && mv.move_type !== 'purchase_return') {
        assert.equal(-mv.value_minor, all ? pl.v : Math.round((pl.v * q) / pl.q), `average out move ${mv.id}`);
        checked += 1;
      } else if (mv.method === 'standard') {
        const std = db.prepare('SELECT standard_cost_minor s FROM product_standard_costs WHERE product_id = ?').get(mv.product_id).s;
        if (!all) assert.equal(-mv.value_minor, Math.round(std * q), `standard out move ${mv.id}`);
        checked += 1;
      } else if (mv.method === 'fifo') {
        const pieces = db.prepare('SELECT ml.*, l.layer_date, l.origin_type, l.origin_id FROM stock_move_layers ml JOIN stock_layers l ON l.id = ml.layer_id WHERE ml.move_id = ? ORDER BY ml.rowid').all(mv.id);
        assert.equal(pieces.reduce((t, x) => t + x.value_minor, 0), -mv.value_minor, `fifo out ${mv.id}: value = pieces`);
        assert.ok(Math.abs(pieces.reduce((t, x) => t + x.qty, 0) - q) < 1e-6, `fifo out ${mv.id}: qty = pieces`);
        if (mv.move_type !== 'purchase_return') {
          const open = db.prepare('SELECT id, layer_date FROM stock_layers WHERE product_id = ? AND holder_id = ? AND in_move_id < ? ORDER BY layer_date, id').all(mv.product_id, mv.holder_id, mv.id)
            .filter((l) => (layerQty.get(l.id) || 0) > 1e-9);
          pieces.forEach((pc, i) => {
            assert.equal(pc.layer_id, open[i].id, `fifo out ${mv.id}: piece ${i} is the oldest open layer`);
            if (i < pieces.length - 1) assert.ok(Math.abs(pc.qty - layerQty.get(pc.layer_id)) < 1e-6, `fifo out ${mv.id}: earlier layers fully used`);
          });
        }
        for (const pc of pieces) layerQty.set(pc.layer_id, (layerQty.get(pc.layer_id) || 0) - pc.qty);
        checked += 1;
      }
    } else if (mv.method === 'fifo' && mv.qty > 0) {
      const layer = db.prepare('SELECT id, qty_in FROM stock_layers WHERE in_move_id = ?').get(mv.id);
      layerQty.set(layer.id, layer.qty_in);
    }
    pools.set(key, { q: pl.q + mv.qty, v: pl.v + mv.value_minor });
  }
  return checked;
}

async function runMethod(method, seed) {
  const R = rng(seed);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const co = await h.createUsdCompany(base, `شركة خاصية ${method}`);
  const m = co.manager;
  const cid = co.companyId;
  const { accounts } = await h.setupLedger(m);
  const acc = (c) => accounts.find((a) => a.code === c).id;
  const products = [];
  for (const [i, name] of ['أ', 'ب', 'ج'].entries()) {
    const id = await h.mkProduct(m, { name: `مادة ${name}` });
    db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(2 + i, id);
    products.push(id);
  }
  const shop = await h.mkShop(m, 'زبون');
  ok((await h.goLive(m, D)).res);
  const w1 = ok(await m.post('/api/companies/warehouses', { name: 'مستودع 1', kind: 'factory' }), 201);
  const w2 = ok(await m.post('/api/companies/warehouses', { name: 'مستودع 2', kind: 'factory' }), 201);
  const veh = ok(await m.post('/api/companies/vehicles', { label: 'سيارة' }), 201);
  for (const p of products) ok(await m.post('/api/factory-inventory', { product_id: p, current_quantity: 40 }), 201);
  if (method === 'standard') for (const [i, p] of products.entries()) ok(await m.put(`/api/stock/standard-costs/${p}`, { standardCost: String(2 + i) }));
  ok(await m.put('/api/stock/method', { method }));
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const holders = [S.warehouseHolder(cid, w1.id), S.warehouseHolder(cid, w2.id), S.vehicleHolder(cid, veh.id), S.carPoolHolder(cid)];
  const tracked = products[0];
  ok(await m.put(`/api/stock/products/${tracked}/settings`, { trackLots: true }));
  const lotOf = () => { const n = 1 + Math.floor(R() * 4); return { lotCode: `L${n}`, expiryDate: new Date(Date.now() + n * 30 * 86400000).toISOString().slice(0, 10) }; };
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد', currencyCode: 'USD' }), 201);
  const approver = await createRep(base, m, { permissions: ['approve_purchase_orders', 'view_purchases'] });
  invariants(cid, `${method} start`);
  const receipts = [];
  const invoices = [];
  const counts = {};
  let ops = 0;
  const qtyOf = (p, hId) => S.poolRow(cid, p, hId).qty;
  const movesNow = () => db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE company_id = ? AND move_type <> 'opening'").get(cid).c;
  for (let i = 0; (ops < 200 || movesNow() < 200) && i < 900; i++) {
    const op = pick(['receipt', 'receipt', 'landed', 'invoice_posted', 'debit_note', 'sale', 'sale', 'credit', 'transfer', 'transfer', 'adjust', 'count', 'wastage', 'count_doc']);
    const p = pick(products);
    const label = `${method} op ${ops} ${op}`;
    if (op === 'receipt') {
      const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: D, warehouseId: pick([w1, w2]).id, lines: [{ productId: p, qty: 1 + Math.floor(R() * 20), unitPrice: (1 + R() * 6).toFixed(2) }] }), 201);
      const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
      ok(await approver.client.post(`/api/purchasing/orders/${po.id}/approve`, {}));
      const g = ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: D, lines: [{ poLineId: s.lines[0].id, qty: s.lines[0].qty, ...(p === tracked ? lotOf() : {}) }] }), 201);
      receipts.push({ po: s, grn: g, invoiced: false });
    } else if (op === 'landed' && receipts.length) {
      const r = pick(receipts);
      const lc = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: supplier.id, receiptId: r.grn.id, landedMethod: 'value', invoiceDate: D, lines: [{ description: 'شحن', qty: 1, unitPrice: (R() * 9 + 0.5).toFixed(2) }] }), 201);
      ok(await m.post(`/api/purchasing/invoices/${lc.id}/post`, {}));
    } else if (op === 'invoice_posted' && receipts.some((r) => !r.invoiced)) {
      const r = receipts.find((x) => !x.invoiced);
      const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: r.po.id, invoiceDate: D, lines: [{ poLineId: r.po.lines[0].id, qty: r.po.lines[0].qty, unitPrice: (r.po.lines[0].unit_price_minor / 100).toFixed(2) }] }), 201);
      r.inv = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
      r.invoiced = true;
    } else if (op === 'debit_note' && receipts.some((r) => r.invoiced && !r.returned)) {
      const r = receipts.find((x) => x.invoiced && !x.returned);
      const rl = db.prepare('SELECT * FROM goods_receipt_lines WHERE receipt_id = ?').get(r.grn.id);
      const origin = db.prepare("SELECT COALESCE(SUM(qty_remaining), 0) q FROM stock_layers WHERE origin_type = 'goods_receipt_line' AND origin_id = ?").get(rl.id).q;
      const holderQty = qtyOf(rl.product_id, S.warehouseHolder(cid, r.grn.warehouse_id).id);
      const can = method === 'fifo' ? Math.min(origin, rl.qty) : Math.min(holderQty, rl.qty);
      const q = Math.floor(can / 2);
      r.returned = true;
      if (q < 1) continue;
      ok(await m.post('/api/purchasing/debit-notes', { invoiceId: r.inv.id, returnGoods: true, lines: [{ invoiceLineId: r.inv.lines[0].id, qty: q }] }), 201);
    } else if (op === 'sale') {
      const hw = pick([w1, w2]);
      const avail = qtyOf(p, S.warehouseHolder(cid, hw.id).id);
      const q = Math.floor(avail * R());
      if (q < 1) continue;
      const inv = ok(await m.post('/api/sales/invoices', { shopId: shop, invoiceDate: D, warehouseId: hw.id, lines: [{ productId: p, qty: q, unitPrice: '9' }] }), 201);
      invoices.push(ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {})));
    } else if (op === 'credit' && invoices.length) {
      const inv = invoices.splice(Math.floor(R() * invoices.length), 1)[0];
      const q = Math.max(1, Math.floor(inv.lines[0].qty / 2));
      ok(await m.post('/api/sales/credit-notes', { invoiceId: inv.id, restock: true, lines: [{ invoiceLineId: inv.lines[0].id, qty: q }] }), 201);
    } else if (op === 'transfer') {
      const from = pick(holders);
      const to = pick(holders.filter((x) => x.id !== from.id));
      const q = Math.round(qtyOf(p, from.id) * R() * 1000) / 1000;
      if (q <= 0.001) continue;
      ok(await m.post('/api/stock/transfers', { productId: p, fromHolderId: from.id, toHolderId: to.id, qty: q }), 201);
    } else if (op === 'adjust') {
      const hd = pick(holders);
      const cur = qtyOf(p, hd.id);
      const nq = Math.max(0, Math.round((cur + (R() * 20 - 8)) * 100) / 100);
      ok(await m.post('/api/stock/adjustments', { productId: p, holderId: hd.id, newQty: nq, reasonCode: 'اختبار' }), 201);
    } else if (op === 'wastage') {
      const hd = pick(holders);
      const q = Math.round(qtyOf(p, hd.id) * R() * 0.5 * 1000) / 1000;
      if (q <= 0.001) continue;
      ok(await m.post('/api/stock/wastage', { holderId: hd.id, reasonCode: pick(['damage', 'expiry', 'loss']), lines: [{ productId: p, qty: q }] }), 201);
    } else if (op === 'count_doc') {
      const hd = pick(holders);
      let line;
      if (p === tracked) {
        const lot = db.prepare('SELECT lot_id, qty FROM stock_lot_balances WHERE product_id = ? AND holder_id = ? AND qty > 1e-9 ORDER BY lot_id').all(p, hd.id);
        if (!lot.length) continue;
        const l = pick(lot);
        line = { productId: p, lotId: l.lot_id, countedQty: Math.max(0, Math.round(l.qty + (R() * 6 - 3))), reasonCode: 'counting_error' };
      } else {
        line = { productId: p, countedQty: Math.max(0, Math.round(qtyOf(p, hd.id) + (R() * 6 - 3))), reasonCode: 'counting_error' };
      }
      const c = ok(await m.post('/api/stock/counts', { holderId: hd.id, countDate: D, lines: [line] }), 201);
      ok(await m.post(`/api/stock/counts/${c.id}/approve`, {}));
    } else if (op === 'count') {
      if (p === tracked) continue; // the legacy count screen has no lot field
      const row = db.prepare('SELECT id, current_quantity q FROM factory_inventory WHERE product_id = ?').get(p);
      const counted = Math.max(0, Math.round(row.q + (R() * 6 - 3)));
      ok(await m.post('/api/factory-inventory/count/confirm', { rows: [{ itemName: 'x', matchedItemId: row.id, expectedQuantity: row.q, countedQuantity: counted, classification: 'minor' }] }), 201);
    } else continue;
    counts[op] = (counts[op] || 0) + 1;
    ops += 1;
    invariants(cid, label);
  }
  assert.ok(ops >= 200, `${method}: ${ops} operations ran`);
  for (const k of ['receipt', 'landed', 'sale', 'credit', 'transfer', 'adjust', 'count', 'wastage', 'count_doc']) assert.ok(counts[k] > 0, `${method}: ${k} exercised (${JSON.stringify(counts)})`);
  const checked = costingOracle(cid);
  assert.ok(checked >= 30, `${method}: ${checked} out moves checked against the oracle`);
  assert.ok(movesNow() >= 200, `${method}: ${movesNow()} stock moves after the opening`);
  const lotMoves = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT lot_id) l FROM stock_moves WHERE company_id = ? AND lot_id IS NOT NULL').get(cid);
  assert.ok(lotMoves.c >= 10 && lotMoves.l >= 3, `${method}: lots exercised (${JSON.stringify(lotMoves)})`);
  return counts;
}

for (const [method, seed] of [['average', 801], ['fifo', 802], ['standard', 803]]) {
  test(`property (${method}): valuation total = ledger inventory after 200 random stock operations`, async () => {
    await runMethod(method, seed);
  });
}
