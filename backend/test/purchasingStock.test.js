// backend/test/purchasingStock.test.js
//
// What a goods receipt does to physical stock (stated and tested):
//  - physical stock today is the company's factory_inventory row of the
//    product (one row per product; there is no per-warehouse quantity until
//    Prompt 8's stock ledger — the receipt's warehouse_id is recorded only);
//  - a receipt adds the ACCEPTED qty (qty - rejected) to that EXISTING row,
//    in the same ledger.transaction as the Dr inventory / Cr GRNI entry;
//  - nothing else in the cycle touches the qty again: invoice posting and
//    landed cost change cost only, so there is no double counting; a debit
//    note with returned goods takes the qty back out;
//  - a failure before or after the entry leaves stock, cost, the receipt
//    and the entry exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-grstock-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const faults = require('../lib/faultInjection');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = 2026;
let listener;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const rows = (pid) => db.prepare('SELECT id, current_quantity q FROM factory_inventory WHERE product_id = ?').all(pid).map((r) => ({ ...r }));
const cost = (pid) => db.prepare('SELECT cost_price FROM products WHERE id = ?').get(pid).cost_price;

test.before(async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة مخزون الاستلام');
  const m = co.manager;
  await h.setupLedger(m);
  const prod = await h.mkProduct(m, { name: 'دقيق' });
  // Existing physical stock row, created on the inventory screen: 40 on hand.
  ok(await m.post('/api/factory-inventory', { product_id: prod, current_quantity: 40 }), 201);
  const approver = await createRep(base, m, { permissions: ['approve_purchase_orders', 'view_purchases'] });
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مطحنة', currencyCode: 'USD' }), 201);
  ctx = { co, m, prod, approver, supplier };
});
test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function approvedPo(qty, date) {
  const { m, approver, supplier, prod } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: date, lines: [{ productId: prod, qty, unitPrice: '10' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await approver.client.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  return s;
}
const snap = () => ({
  rows: rows(ctx.prod),
  cost: cost(ctx.prod),
  receipts: db.prepare('SELECT COUNT(*) c FROM goods_receipts').get().c,
  entries: db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?').get(ctx.co.companyId).c,
  received: db.prepare('SELECT COALESCE(SUM(received_qty), 0) s FROM purchase_order_lines').get().s,
});

test('a receipt adds the accepted qty to the EXISTING stock row (no second row); the inventory screen refuses a duplicate row', async () => {
  const { m, prod } = ctx;
  const [row] = rows(prod);
  assert.equal(row.q, 40);
  const po = await approvedPo(30, `${Y}-02-01`);
  const grn = ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-02-02`, lines: [{ poLineId: po.lines[0].id, qty: 30, rejectedQty: 5 }] }), 201);
  assert.deepEqual(rows(prod), [{ id: row.id, q: 65 }], '40 + 25 accepted, same row');
  assert.equal(ok(await m.get(`/api/purchasing/receipts/${grn.id}`)).journal_entry_id > 0, true, 'entry posted in the same call');
  const dup = await m.post('/api/factory-inventory', { product_id: prod, current_quantity: 1 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'product_already_in_inventory');
  assert.equal(rows(prod).length, 1);
  ctx.po1 = po;
});

test('no double counting: invoice posting and landed cost do not touch the qty; a debit note with returned goods takes it back', async () => {
  const { m, prod, supplier, po1 } = ctx;
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: po1.id, invoiceDate: `${Y}-02-03`, supplierInvoiceRef: 'M-1', lines: [{ poLineId: po1.lines[0].id, qty: 25, unitPrice: '10' }] }), 201);
  const posted = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  assert.equal(rows(prod)[0].q, 65, 'invoice posting: qty unchanged');
  const receipt = db.prepare('SELECT id FROM goods_receipts WHERE po_id = ?').get(po1.id);
  const freight = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: supplier.id, receiptId: receipt.id, landedMethod: 'value', invoiceDate: `${Y}-02-04`, lines: [{ description: 'شحن', qty: 1, unitPrice: '25' }] }), 201);
  const c0 = cost(prod);
  ok(await m.post(`/api/purchasing/invoices/${freight.id}/post`, {}));
  assert.equal(rows(prod)[0].q, 65, 'landed cost: qty unchanged');
  assert.ok(cost(prod) > c0, 'landed cost: cost up');
  ok(await m.post('/api/purchasing/debit-notes', { invoiceId: inv.id, returnGoods: true, reason: 'تالف', lines: [{ invoiceLineId: posted.lines[0].id, qty: 5 }] }), 201);
  assert.equal(rows(prod)[0].q, 60, 'returned 5');
});

test('failure injection: a failure after the stock update (before the entry) or after the entry rolls everything back', async () => {
  const { m } = ctx;
  const po = await approvedPo(10, `${Y}-03-01`);
  const body = { receiptDate: `${Y}-03-02`, lines: [{ poLineId: po.lines[0].id, qty: 10 }] };
  for (const point of ['purchasing.receipt.after_stock', 'purchasing.receipt.after_entry']) {
    const before = snap();
    faults.arm(point);
    assert.equal((await m.post(`/api/purchasing/orders/${po.id}/receive`, body)).status, 500, point);
    faults.disarmAll();
    assert.deepEqual(snap(), before, `${point}: stock, cost, receipt, entry and PO qty unchanged`);
  }
  const before = snap();
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, body), 201);
  const after = snap();
  assert.equal(after.rows[0].q, before.rows[0].q + 10, 'counted exactly once');
  assert.equal(after.entries, before.entries + 1);
  assert.deepEqual(ok(await m.get('/api/ledger/integrity-check')).violations, []);
});
