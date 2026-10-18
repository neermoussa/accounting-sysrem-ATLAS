// backend/test/purchasingSeparation.test.js
//
// Purchasing separation of duties (company setting
// enforce_purchasing_separation, default ON):
//  - the creator of a PO cannot approve it;
//  - the user who posted a supplier invoice cannot pay it (explicit
//    allocation refused; auto-allocation skips that invoice).
// With the setting OFF both are allowed again. Only manage_settings may
// change it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sod-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = 2026;
let listener;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

test.before(async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة فصل المهام');
  const m = co.manager;
  await h.setupLedger(m);
  const product = await h.mkProduct(m, { name: 'مادة' });
  const approver = await createRep(base, m, { permissions: ['approve_purchase_orders', 'view_purchases'] });
  const payer = await createRep(base, m, { permissions: ['view_purchases', 'make_supplier_payments'] });
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد', currencyCode: 'USD' }), 201);
  ctx = { m, product, approver, payer, supplier };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

// manager creates + submits a PO (threshold 0 -> pending approval).
async function pendingPo(date) {
  const { m, supplier, product } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: date, lines: [{ productId: product, qty: 10, unitPrice: '5' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  assert.equal(s.status, 'pending_approval');
  return s;
}
// receive + invoice + post, all by the manager.
async function postedInvoice(po, date) {
  const { m, supplier } = ctx;
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: date, lines: [{ poLineId: po.lines[0].id, qty: 10 }] }), 201);
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: po.id, invoiceDate: date, supplierInvoiceRef: `S-${po.id}`, lines: [{ poLineId: po.lines[0].id, qty: 10, unitPrice: '5' }] }), 201);
  return ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
}

test('ON by default: PO creator cannot approve; another approver can', async () => {
  const { m, approver } = ctx;
  assert.equal(ok(await m.get('/api/purchasing/settings')).enforce_purchasing_separation, true);
  const po = await pendingPo(`${Y}-03-01`);
  const r = await m.post(`/api/purchasing/orders/${po.id}/approve`, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'sod_po_creator');
  assert.match(r.body.message, /فصل المهام/);
  assert.equal(ok(await m.get(`/api/purchasing/orders/${po.id}`)).status, 'pending_approval', 'nothing changed');
  // Rejecting your own PO is still allowed (it only sends it back to draft).
  const approved = ok(await approver.client.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  assert.equal(approved.status, 'approved');
  ctx.po1 = approved;
});

test('ON: the poster of an invoice cannot pay it; auto-allocation skips it; another user can pay', async () => {
  const { m, payer, supplier } = ctx;
  const inv = await postedInvoice(ctx.po1, `${Y}-03-05`);
  const before = db.prepare('SELECT COUNT(*) c FROM supplier_payments').get().c;
  const r = await m.post('/api/purchasing/payments', { supplierId: supplier.id, paymentDate: `${Y}-03-10`, amount: '50', allocations: [{ invoiceId: inv.id, amount: '50' }] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'sod_invoice_poster');
  assert.match(r.body.message, /فصل المهام/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM supplier_payments').get().c, before, 'refused payment rolled back entirely (no payment, no entry)');
  // Auto-allocation: the payment is recorded as an advance, the invoice stays open.
  const adv = ok(await m.post('/api/purchasing/payments', { supplierId: supplier.id, paymentDate: `${Y}-03-10`, amount: '1' }), 201);
  assert.equal(adv.allocations.length, 0);
  ok(await m.post(`/api/purchasing/payments/${adv.id}/reverse`, { reason: 'اختبار' }));
  const p = ok(await payer.client.post('/api/purchasing/payments', { supplierId: supplier.id, paymentDate: `${Y}-03-10`, amount: '50' }), 201);
  assert.equal(p.allocations.length, 1);
  assert.equal(ok(await m.get(`/api/purchasing/invoices/${inv.id}`)).open_minor, 0);
});

test('only manage_settings may switch it off; OFF allows both again', async () => {
  const { m, approver } = ctx;
  const denied = await approver.client.put('/api/purchasing/settings', { enforcePurchasingSeparation: false });
  assert.equal(denied.status, 403);
  assert.equal(ok(await m.get('/api/purchasing/settings')).enforce_purchasing_separation, true);
  assert.equal(ok(await m.put('/api/purchasing/settings', { enforcePurchasingSeparation: false })).enforce_purchasing_separation, false);
  const audit = db.prepare("SELECT after_json FROM audit_log WHERE action = 'purchasing.settings.update' ORDER BY id DESC LIMIT 1").get();
  assert.ok(audit, 'audited');
  const po = await pendingPo(`${Y}-04-01`);
  const approved = ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  assert.equal(approved.status, 'approved');
  const inv = await postedInvoice(approved, `${Y}-04-02`);
  const p = ok(await m.post('/api/purchasing/payments', { supplierId: ctx.supplier.id, paymentDate: `${Y}-04-03`, amount: '50', allocations: [{ invoiceId: inv.id, amount: '50' }] }), 201);
  assert.equal(p.allocations.length, 1);
});
