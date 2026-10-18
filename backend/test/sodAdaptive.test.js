// backend/test/sodAdaptive.test.js
//
// Separation of duties is enforced automatically only when the company has
// 2+ active users for the step (the actor + someone else holding the
// second-step permission): PO create/approve, invoice post/pay, voucher
// create/approve. A one-user company operates; the owner can break glass
// with a written reason (audited + notified); others cannot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sod2-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = new Date().getFullYear();
const D = new Date().toISOString().slice(0, 10);
let listener;
let base;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة مستخدم واحد');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m);
  const product = await h.mkProduct(m, { name: 'مادة' });
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد', currencyCode: 'USD' }), 201);
  const main = ok(await m.get('/api/treasury/boxes'))[0];
  ctx = { co, m, product, supplier, main, acc: (c) => accounts.find((a) => a.code === c).id };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function poCycle(client) {
  const { product, supplier } = ctx;
  const po = ok(await client.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: D, lines: [{ productId: product, qty: 2, unitPrice: '5' }] }), 201);
  return ok(await client.post(`/api/purchasing/orders/${po.id}/submit`, {}));
}
async function postedInvoice() {
  const inv = ok(await ctx.m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: ctx.supplier.id, invoiceDate: D, lines: [{ description: 'خدمة', qty: 1, unitPrice: '10', expenseAccountId: ctx.acc('6500') }] }), 201);
  return ok(await ctx.m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
}

test('one-user company: the owner creates and approves POs, posts and pays invoices, creates and approves vouchers', async () => {
  const { m, supplier, main } = ctx;
  const po = await poCycle(m);
  assert.equal(ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {})).status, 'approved');
  const inv = await postedInvoice();
  const p = ok(await m.post('/api/purchasing/payments', { supplierId: supplier.id, paymentDate: D, amount: '10', allocations: [{ invoiceId: inv.id, amount: '10' }] }), 201);
  assert.equal(p.allocations.length, 1);
  const v = ok(await m.post('/api/treasury/vouchers', { type: 'receipt', cashBoxId: main.id, amount: '50', counterAccountId: ctx.acc('4900') }), 201);
  assert.equal(ok(await m.post(`/api/treasury/vouchers/${v.id}/approve`, {})).status, 'posted');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE company_id = ? AND action = 'sod.break_glass'").get(ctx.co.companyId).c, 0, 'no break-glass needed');
});

test('two-user company is enforced per step; owner break-glass needs a written reason and is audited; a non-owner cannot break glass', async () => {
  const { m, supplier, main, co } = ctx;
  const second = await createRep(base, m, { permissions: ['view_purchases', 'create_purchase_requests', 'approve_purchase_orders', 'make_supplier_payments', 'view_treasury', 'create_vouchers', 'approve_vouchers'] });
  // PO
  const po = await poCycle(m);
  const r = await m.post(`/api/purchasing/orders/${po.id}/approve`, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'sod_po_creator');
  assert.equal(r.body.break_glass_available, true);
  assert.match(r.body.message, /التجاوز الطارئ/);
  assert.equal((await m.post(`/api/purchasing/orders/${po.id}/approve`, { breakGlassReason: 'قصير' })).body.error, 'break_glass_reason_too_short');
  assert.equal(ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, { breakGlassReason: 'المعتمد مسافر والمورد ينتظر اليوم' })).status, 'approved');
  const audit = db.prepare("SELECT * FROM audit_log WHERE company_id = ? AND action = 'sod.break_glass' ORDER BY id DESC LIMIT 1").get(co.companyId);
  assert.equal(audit.entity_type, 'purchase_order');
  assert.match(audit.after_json, /المعتمد مسافر/);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE company_id = ? AND type = 'sod_break_glass'").get(co.companyId));
  // The second user (not owner) is blocked on their own PO (the owner can approve it) and cannot break glass.
  const po2 = await poCycle(second.client);
  assert.equal((await second.client.post(`/api/purchasing/orders/${po2.id}/approve`, {})).body.error, 'sod_po_creator');
  const ng = await second.client.post(`/api/purchasing/orders/${po2.id}/approve`, { breakGlassReason: 'أريد الاعتماد بنفسي الآن' });
  assert.equal(ng.status, 403);
  assert.equal(ng.body.error, 'break_glass_owner_only');
  ok(await m.post(`/api/purchasing/orders/${po2.id}/approve`, {}));
  // Invoice post / pay
  const inv = await postedInvoice();
  assert.equal((await m.post('/api/purchasing/payments', { supplierId: supplier.id, paymentDate: D, amount: '10', allocations: [{ invoiceId: inv.id, amount: '10' }] })).body.error, 'sod_invoice_poster');
  ok(await m.post('/api/purchasing/payments', { supplierId: supplier.id, paymentDate: D, amount: '10', allocations: [{ invoiceId: inv.id, amount: '10' }], breakGlassReason: 'دفعة عاجلة بموافقة المالك' }), 201);
  // Voucher
  const v = ok(await m.post('/api/treasury/vouchers', { type: 'receipt', cashBoxId: main.id, amount: '5', counterAccountId: ctx.acc('4900') }), 201);
  assert.equal((await m.post(`/api/treasury/vouchers/${v.id}/approve`, {})).body.error, 'sod_voucher_creator');
  ok(await m.post(`/api/treasury/vouchers/${v.id}/approve`, { breakGlassReason: 'إقفال الصندوق قبل نهاية اليوم' }));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE company_id = ? AND action = 'sod.break_glass'").get(co.companyId).c, 3);
  // Setting off: no enforcement even with two users.
  ok(await m.put('/api/purchasing/settings', { enforcePurchasingSeparation: false }));
  const po3 = await poCycle(m);
  ok(await m.post(`/api/purchasing/orders/${po3.id}/approve`, {}));
  ok(await m.put('/api/purchasing/settings', { enforcePurchasingSeparation: true }));
  // A deactivated second user no longer counts.
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(second.userId);
  const po4 = await poCycle(m);
  ok(await m.post(`/api/purchasing/orders/${po4.id}/approve`, {}));
});
