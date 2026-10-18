// backend/test/purchasingFxSplit.test.js
//
// Goods invoice in a foreign currency where BOTH the price and the rate
// moved since the receipt. The difference is split:
//   price: invoice EUR amount @ receipt rate - GRNI      -> purchase_price_variance
//   rate:  invoice EUR amount @ invoice rate - @ receipt -> fx_realized
// PO 100 x EUR 2.00, received @1.10 (GRNI 220.00); invoiced 100 x EUR 2.10
// @1.15 (AP 241.50): PPV = 210 x 1.10 - 220 = 11.00, FX = 210 x 0.05 = 10.50.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fxsplit-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = 2026;
let listener;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const sumBy = (entryId, key) => db.prepare('SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.system_key = ?').get(entryId, key).s;

test('price difference -> PPV, exchange-rate difference on the same quantity -> fx_realized', async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة فصل فرق السعر');
  const m = co.manager;
  await h.setupLedger(m);
  const prod = await h.mkProduct(m, { name: 'مادة مستوردة' });
  const approver = await createRep(base, m, { permissions: ['approve_purchase_orders', 'view_purchases'] });
  const eu = ok(await m.post('/api/purchasing/suppliers', { name: 'EU Supplier', currencyCode: 'EUR' }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.10', effectiveAt: `${Y}-05-01` }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.15', effectiveAt: `${Y}-05-10` }), 201);

  const po = ok(await m.post('/api/purchasing/orders', { supplierId: eu.id, orderDate: `${Y}-05-02`, lines: [{ productId: prod, qty: 100, unitPrice: '2.00' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await approver.client.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  const grn = ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-05-05`, lines: [{ poLineId: s.lines[0].id, qty: 100 }] }), 201);
  assert.equal(grn.total_base_minor, 22000);
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: eu.id, poId: po.id, invoiceDate: `${Y}-05-12`, supplierInvoiceRef: 'EU-77', lines: [{ poLineId: s.lines[0].id, qty: 100, unitPrice: '2.10' }] }), 201);
  assert.equal((await m.post(`/api/purchasing/invoices/${inv.id}/post`, {})).status, 409, 'price 5% over: three-way mismatch');
  ok(await m.post(`/api/purchasing/invoices/${inv.id}/approve-mismatch`, { reason: 'زيادة سعر متفق عليها' }));
  const posted = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  const e = posted.journal_entry.id;
  assert.equal(sumBy(e, 'ap_control'), -24150, 'EUR 210 @1.15');
  assert.equal(sumBy(e, 'grni'), 22000, 'GRNI cleared at receipt value');
  assert.equal(sumBy(e, 'purchase_price_variance'), 1100, 'price: EUR 10 @ receipt rate 1.10');
  assert.equal(sumBy(e, 'fx_realized'), 1050, 'rate: EUR 210 x (1.15 - 1.10)');
  assert.equal(sumBy(e, 'rounding_difference'), 0);
  const line = db.prepare('SELECT ppv_base_minor, fx_base_minor FROM supplier_invoice_lines WHERE invoice_id = ?').get(inv.id);
  assert.deepEqual({ ...line }, { ppv_base_minor: 1100, fx_base_minor: 1050 });
  // PPV report still equals the PPV account (the FX part is not in it).
  const ppv = ok(await m.get(`/api/purchasing/reports/ppv?from=${Y}-01-01&to=${Y}-12-31`));
  assert.equal(ppv.total_minor, 1100);
  assert.equal(ppv.ledger_total_minor, 1100);
  // FX report shows the receipt->invoice rate difference as realized.
  const fx = ok(await m.get(`/api/currency/fx-report?from=${Y}-05-01&to=${Y}-05-31`));
  assert.equal(fx.rows.filter((r) => r.kind === 'realized').reduce((t, r) => t + r.gain_minor, 0), -1050, 'a loss of 10.50');
  assert.deepEqual(ok(await m.get('/api/ledger/integrity-check')).violations, []);
});
