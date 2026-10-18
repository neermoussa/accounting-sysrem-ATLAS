// backend/test/purchasing.test.js
//
// Prompt 6 "Done when":
//  - a full cycle (request -> approval -> quotations -> PO -> approval ->
//    goods receipt -> landed cost -> supplier invoice -> payment) works and
//    every step posts the right entries;
//  - payables control equals the supplier sub-ledger;
//  - three-way match blocks a mismatched invoice (until approved);
//  - landed cost changes item cost correctly (value / quantity / weight);
//  - payables aging matches the ledger.
// Plus: foreign-currency suppliers on the Prompt 5 engine (rates, PPV,
// realized FX), payables revaluation through the existing tool, debit
// notes, expense invoices, payment reversal, atomicity, permissions and the
// tenant-ref rule on every supplier-facing endpoint. Base currency here:
// USD (company created by createUsdCompany).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pur-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = 2026;
let listener;
let base;
let ctx;

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة المشتريات');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m);
  const acc = (key) => accounts.find((a) => a.system_key === key || a.code === key).id;
  const prodA = await h.mkProduct(m, { name: 'سكر خام' });
  const prodB = await h.mkProduct(m, { name: 'علب كرتون', box_weight_grams: 500 });
  const approver = await createRep(base, m, { permissions: ['approve_purchase_orders', 'view_purchases'] });
  // Separation of duties is ON by default: whoever posted an invoice cannot
  // pay it, so payments of manager-posted invoices go through this user.
  const payer = await createRep(base, m, { permissions: ['view_purchases', 'make_supplier_payments'] });
  const clerk = await createRep(base, m, { permissions: ['view_purchases', 'create_purchase_requests', 'post_supplier_invoices', 'receive_goods'] });
  const mk = async (body) => {
    const r = await m.post('/api/purchasing/suppliers', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const s1 = await mk({ name: 'مورد السكر', currencyCode: 'USD', paymentTermsDays: 30, phone: '0991' });
  const s2 = await mk({ name: 'Euro Supplies', currencyCode: 'EUR', paymentTermsDays: 45 });
  const freight = await mk({ name: 'شركة الشحن', currencyCode: 'USD', paymentTermsDays: 0 });
  await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.10', effectiveAt: `${Y}-01-01` });
  // Other company for tenant checks.
  const other = await h.createUsdCompany(base, 'شركة أخرى مشتريات');
  const oAcc = await h.setupLedger(other.manager);
  const oSupplier = (await other.manager.post('/api/purchasing/suppliers', { name: 'مورد غريب' })).body;
  const oProduct = await h.mkProduct(other.manager, { name: 'مادة غريبة' });
  const oPo = (await other.manager.post('/api/purchasing/orders', { supplierId: oSupplier.id, lines: [{ productId: oProduct, qty: 1, unitPrice: '1' }] })).body;
  const oReq = (await other.manager.post('/api/purchasing/requests', { lines: [{ description: 'x', qty: 1 }] })).body;
  ctx = { co, m, accounts, acc, prodA, prodB, approver, clerk, payer, s1, s2, freight, other: { ...other, supplier: oSupplier, product: oProduct, po: oPo, req: oReq, expense: oAcc.accounts.find((a) => a.code === '6200').id } };
});

test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
function entryLines(entryId) {
  return db.prepare('SELECT a.system_key, a.code, l.debit_minor d, l.credit_minor c, l.party_type, l.party_id, l.currency_code, l.amount_original_minor FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId);
}
const sumBy = (lines, key) => lines.filter((l) => l.system_key === key).reduce((s, l) => s + l.d - l.c, 0);
function ledgerBalance(companyId, key, { party } = {}) {
  return db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND a.system_key = ? ${party ? 'AND l.party_type = ? AND l.party_id = ?' : ''}`).get(...[companyId, key, ...(party ? ['supplier', party] : [])]).s;
}
async function assertPayablesClean(c = ctx) {
  const aging = ok(await c.m.get('/api/purchasing/reports/aging'));
  assert.equal(aging.unassigned_minor, 0, 'AP control = supplier sub-ledgers');
  assert.equal(aging.totals.total, aging.control_minor, 'payables aging total = AP control');
  assert.equal(aging.control_minor, 0 - ledgerBalance(c.co.companyId, 'ap_control') || 0);
  for (const r of aging.rows) assert.equal(r.total, 0 - ledgerBalance(c.co.companyId, 'ap_control', { party: r.supplier_id }) || 0, `aging row ${r.supplier_name} = ledger`);
  assert.equal(ok(await c.m.get('/api/purchasing/reports/reconciliation')).difference_minor, 0);
  assert.deepEqual(ok(await c.m.get('/api/ledger/integrity-check')).violations, []);
  const bad = db.prepare(`SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.company_id = ? GROUP BY e.id HAVING SUM(l.debit_minor) <> SUM(l.credit_minor)`).all(c.co.companyId);
  assert.deepEqual(bad, []);
}
const cost = (id) => db.prepare('SELECT cost_price FROM products WHERE id = ?').get(id).cost_price;
const stock = (id) => db.prepare('SELECT COALESCE(SUM(current_quantity), 0) q FROM factory_inventory WHERE product_id = ?').get(id).q;

test('DONE: full cycle request -> approval -> quotations -> PO -> approval -> receipt -> landed cost -> invoice -> payment, with the right entries', async () => {
  const { m, approver, prodA, prodB, s1, s2, freight } = ctx;
  // 1. Purchase request, submitted and approved.
  const pr = ok(await ctx.clerk.client.post('/api/purchasing/requests', { neededBy: `${Y}-03-31`, lines: [{ productId: prodA, qty: 100 }, { productId: prodB, qty: 50 }] }), 201);
  ok(await ctx.clerk.client.post(`/api/purchasing/requests/${pr.id}/submit`, {}));
  assert.equal((await ctx.clerk.client.post(`/api/purchasing/requests/${pr.id}/approve`, {})).status, 403, 'clerk cannot approve');
  const approved = ok(await approver.client.post(`/api/purchasing/requests/${pr.id}/approve`, {}));
  assert.equal(approved.status, 'approved');
  assert.ok(approved.request_number.startsWith('PR-'));

  // 2. Two quotations and the comparison (S2 in EUR at 1.10).
  const [la, lb] = approved.lines;
  const q1 = ok(await m.post('/api/purchasing/quotations', { requestId: pr.id, supplierId: s1.id, quotationDate: `${Y}-02-01`, lines: [{ requestLineId: la.id, productId: prodA, qty: 100, unitPrice: '10.00' }, { requestLineId: lb.id, productId: prodB, qty: 50, unitPrice: '4.00' }] }), 201);
  ok(await m.post('/api/purchasing/quotations', { requestId: pr.id, supplierId: s2.id, quotationDate: `${Y}-02-01`, currencyCode: 'EUR', lines: [{ requestLineId: la.id, productId: prodA, qty: 100, unitPrice: '9.50' }, { requestLineId: lb.id, productId: prodB, qty: 50, unitPrice: '3.50' }] }), 201);
  const cmp = ok(await m.get(`/api/purchasing/requests/${pr.id}/comparison`));
  const best = (i) => cmp.rows[i].offers.find((o) => o.best);
  assert.equal(best(0).supplier_id, s1.id, 'A: 10.00 USD beats 9.50 EUR = 10.45 USD');
  assert.equal(cmp.rows[0].offers.find((o) => o.supplier_id === s2.id).unit_base_minor, 1045);
  assert.equal(best(1).supplier_id, s2.id, 'B: 3.50 EUR = 3.85 USD beats 4.00');

  // 3. PO from quotation 1, named approver, approval threshold.
  ok(await m.put('/api/purchasing/settings', { poApprovalThreshold: '500' }));
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: s1.id, requestId: pr.id, quotationId: q1.id, orderDate: `${Y}-02-05`, expectedDate: `${Y}-02-20`, approverUserId: approver.userId }), 201);
  assert.equal(po.total_minor, 120000);
  const sub = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  assert.equal(sub.status, 'pending_approval', '1,200 > threshold 500');
  const notMe = await m.post(`/api/purchasing/orders/${po.id}/approve`, {});
  assert.equal(notMe.status, 403);
  assert.equal(notMe.body.error, 'not_the_approver');
  const appr = ok(await approver.client.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  assert.equal(appr.status, 'approved');
  assert.equal(db.prepare('SELECT status FROM purchase_requests WHERE id = ?').get(pr.id).status, 'ordered');
  assert.equal(db.prepare('SELECT status FROM supplier_quotations WHERE id = ?').get(q1.id).status, 'selected');

  // 4. Goods receipt (B: 40 delivered, 2 rejected): Dr inventory / Cr GRNI.
  const [pa, pb] = appr.lines;
  const grn = ok(await ctx.clerk.client.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-02-18`, lines: [{ poLineId: pa.id, qty: 100 }, { poLineId: pb.id, qty: 40, rejectedQty: 2 }] }), 201);
  assert.equal(grn.total_base_minor, 100000 + 15200);
  const gl = entryLines(grn.journal_entry.id);
  assert.equal(sumBy(gl, 'inventory'), 115200);
  assert.equal(sumBy(gl, 'grni'), -115200);
  assert.equal(stock(prodA), 100);
  assert.equal(stock(prodB), 38);
  assert.equal(cost(prodA), 10);
  assert.equal(cost(prodB), 4);
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po.id).status, 'partially_received');

  // 5. Landed cost by VALUE: 115.20 shipping over 1,000.00 / 152.00 -> 100.00 / 15.20.
  const lc = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: freight.id, receiptId: grn.id, landedMethod: 'value', invoiceDate: `${Y}-02-19`, supplierInvoiceRef: 'FR-1', lines: [{ description: 'شحن', landedKind: 'shipping', qty: 1, unitPrice: '115.20' }] }), 201);
  const lcPosted = ok(await m.post(`/api/purchasing/invoices/${lc.id}/post`, {}));
  assert.deepEqual(lcPosted.landed_allocations.map((a) => a.amount_base_minor).sort((x, y) => y - x), [10000, 1520]);
  assert.equal(cost(prodA), 11, 'A: (100 x 10 + 100) / 100');
  assert.equal(cost(prodB), 4.4, 'B: (38 x 4 + 15.20) / 38');
  const ll = entryLines(lcPosted.journal_entry.id);
  assert.equal(sumBy(ll, 'inventory'), 11520);
  assert.equal(sumBy(ll, 'ap_control'), -11520);
  assert.ok(ll.some((l) => l.system_key === 'ap_control' && l.party_type === 'supplier' && l.party_id === freight.id));

  // 6. Supplier invoice (three-way matched): Dr GRNI / Dr input tax / Cr AP.
  const inv = ok(await ctx.clerk.client.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s1.id, poId: po.id, invoiceDate: `${Y}-02-25`, supplierInvoiceRef: 'S1-777', lines: [{ poLineId: pa.id, qty: 100, unitPrice: '10.00' }, { poLineId: pb.id, qty: 38, unitPrice: '4.00', taxRate: '10' }] }), 201);
  assert.equal(inv.match_status, 'matched');
  assert.equal(inv.due_date, `${Y}-03-27`, 'due = invoice date + 30 days of terms');
  const posted = ok(await ctx.clerk.client.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  const il = entryLines(posted.journal_entry.id);
  assert.equal(sumBy(il, 'grni'), 115200);
  assert.equal(sumBy(il, 'input_tax'), 1520);
  assert.equal(sumBy(il, 'ap_control'), -116720);
  assert.equal(sumBy(il, 'purchase_price_variance'), 0);
  assert.equal(ledgerBalance(ctx.co.companyId, 'grni'), 0, 'GRNI fully cleared');
  const dup = await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s1.id, poId: po.id, supplierInvoiceRef: 'S1-777', lines: [{ poLineId: pa.id, qty: 1 }] });
  assert.equal(dup.status, 409, 'same supplier invoice number twice');

  // 7. Payment, auto-allocated: Dr AP / Cr bank-in-transit.
  const payRes = ok(await m.post('/api/purchasing/payments', { supplierId: s1.id, paymentDate: `${Y}-03-10`, method: 'transfer', amount: '1167.20' }), 201);
  assert.equal(payRes.allocations.length, 1);
  assert.equal(payRes.unallocated_minor, 0);
  const pl = entryLines(payRes.journal_entry.id);
  assert.equal(sumBy(pl, 'ap_control'), 116720);
  assert.equal(sumBy(pl, 'bank_in_transit'), -116720);
  assert.equal(ledgerBalance(ctx.co.companyId, 'ap_control', { party: s1.id }), 0, 'supplier settled');
  assert.equal(ok(await m.get(`/api/purchasing/invoices/${inv.id}`)).open_minor, 0);
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po.id).status, 'partially_received', 'B still 12 short');

  const st = ok(await m.get(`/api/purchasing/suppliers/${s1.id}/statement?from=${Y}-01-01&to=${Y}-12-31`));
  assert.equal(st.closing_minor, 0);
  assert.equal(st.lines.length, 2);
  const rating = ok(await m.get(`/api/purchasing/suppliers/${s1.id}`)).ratings;
  assert.equal(rating.on_time_pct, 100);
  assert.equal(rating.quality_rejection_pct, Math.round((2 / 140) * 1000) / 10);
  assert.equal(rating.price_consistency_pct, 100);
  const audit = db.prepare("SELECT DISTINCT action FROM audit_log WHERE company_id = ? AND (action LIKE 'purchasing.%' OR action LIKE 'payables.%')").all(ctx.co.companyId).map((r) => r.action);
  for (const a of ['purchasing.request.create', 'purchasing.request.approve', 'purchasing.quotation.create', 'purchasing.po.create', 'purchasing.po.submit', 'purchasing.po.approve', 'purchasing.receipt.create', 'payables.invoice.create', 'payables.invoice.post', 'payables.payment.create', 'purchasing.supplier.create', 'purchasing.settings.update']) assert.ok(audit.includes(a), a);
  ctx.cycle = { po, pa, pb, grn, inv };
  await assertPayablesClean();
});

test('DONE: three-way match blocks a mismatched invoice until approve_purchase_mismatch; tolerance setting respected', async () => {
  const { m, s1, prodA } = ctx;
  ok(await m.put('/api/purchasing/settings', { poApprovalThreshold: '100000' }));
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: s1.id, orderDate: `${Y}-04-01`, lines: [{ productId: prodA, qty: 10, unitPrice: '10.00' }] }), 201);
  const sub = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  assert.equal(sub.status, 'approved', 'under threshold: auto-approved');
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-04-03`, lines: [{ poLineId: sub.lines[0].id, qty: 8 }] }), 201);
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s1.id, poId: po.id, invoiceDate: `${Y}-04-05`, supplierInvoiceRef: 'MM-1', lines: [{ poLineId: sub.lines[0].id, qty: 10, unitPrice: '10.50' }] }), 201);
  assert.equal(inv.match_status, 'mismatch');
  const kinds = inv.match.lines[0].issues.map((i) => i.type).sort();
  assert.deepEqual(kinds, ['price', 'qty']);
  const blocked = await m.post(`/api/purchasing/invoices/${inv.id}/post`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'three_way_mismatch');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE source_type = 'supplier_invoice' AND source_id = ?").get(inv.id).c, 0, 'nothing posted');
  assert.equal((await ctx.clerk.client.post(`/api/purchasing/invoices/${inv.id}/approve-mismatch`, { reason: 'x' })).status, 403);
  assert.equal((await m.post(`/api/purchasing/invoices/${inv.id}/approve-mismatch`, {})).body.error, 'reason_required');
  ok(await m.post(`/api/purchasing/invoices/${inv.id}/approve-mismatch`, { reason: 'اتفاق هاتفي على سعر جديد وشحنة لاحقة' }));
  const posted = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  const il = entryLines(posted.journal_entry.id);
  assert.equal(sumBy(il, 'grni'), 8000, 'only the received 8 clear GRNI');
  assert.equal(sumBy(il, 'purchase_price_variance'), 2500, '105.00 invoiced - 80.00 received value');
  assert.equal(sumBy(il, 'ap_control'), -10500);
  const ppv = ok(await m.get(`/api/purchasing/reports/ppv?from=${Y}-01-01&to=${Y}-12-31`));
  assert.equal(ppv.total_minor, ppv.ledger_total_minor, 'PPV report = PPV account');
  assert.ok(ppv.rows.some((r) => r.invoice_id === inv.id && r.ppv_base_minor === 2500));

  // Tolerance: 25% qty tolerance makes 10 invoiced vs 8 received acceptable.
  const po2 = ok(await m.post('/api/purchasing/orders', { supplierId: s1.id, orderDate: `${Y}-04-01`, lines: [{ productId: prodA, qty: 10, unitPrice: '10.00' }] }), 201);
  const s2 = ok(await m.post(`/api/purchasing/orders/${po2.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po2.id}/receive`, { receiptDate: `${Y}-04-03`, lines: [{ poLineId: s2.lines[0].id, qty: 8 }] }), 201);
  ok(await m.put('/api/purchasing/settings', { qtyTolerance: '25', priceTolerance: '5' }));
  const inv2 = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s1.id, poId: po2.id, invoiceDate: `${Y}-04-05`, lines: [{ poLineId: s2.lines[0].id, qty: 10, unitPrice: '10.40' }] }), 201);
  assert.equal(inv2.match_status, 'matched');
  ok(await m.put('/api/purchasing/settings', { qtyTolerance: '0', priceTolerance: '2' }));
  ok(await m.del(`/api/purchasing/invoices/${inv2.id}`));
  // Over-receipt is refused.
  const over = await m.post(`/api/purchasing/orders/${po2.id}/receive`, { receiptDate: `${Y}-04-04`, lines: [{ poLineId: s2.lines[0].id, qty: 3 }] });
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'over_receipt');
  await assertPayablesClean();
});

test('DONE: landed cost by quantity and by weight changes item cost correctly', async () => {
  const { m, s1, freight, prodA, prodB } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: s1.id, orderDate: `${Y}-05-01`, lines: [{ productId: prodA, qty: 20, unitPrice: '12.00' }, { productId: prodB, qty: 30, unitPrice: '5.00' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  const before = { a: cost(prodA), qa: stock(prodA), b: cost(prodB), qb: stock(prodB) };
  const grn = ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-05-03`, lines: [{ poLineId: s.lines[0].id, qty: 20, weightKg: 100 }, { poLineId: s.lines[1].id, qty: 30 }] }), 201);
  // Moving average after the receipt.
  const avgA = Math.round(((before.qa * before.a * 100 + 24000) / (before.qa + 20))) / 100;
  assert.equal(cost(prodA), avgA);
  const afterReceipt = { a: cost(prodA), qa: stock(prodA), b: cost(prodB), qb: stock(prodB) };
  // By quantity: 50.00 over 20 + 30 units -> 20.00 / 30.00.
  const q = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: freight.id, receiptId: grn.id, landedMethod: 'quantity', invoiceDate: `${Y}-05-04`, lines: [{ description: 'نقل', landedKind: 'transport', qty: 1, unitPrice: '50.00' }] }), 201);
  const qp = ok(await m.post(`/api/purchasing/invoices/${q.id}/post`, {}));
  const share = (inv, product) => inv.landed_allocations.find((x) => db.prepare('SELECT product_id FROM goods_receipt_lines WHERE id = ?').get(x.receipt_line_id).product_id === product).amount_base_minor;
  assert.equal(share(qp, prodA), 2000);
  assert.equal(share(qp, prodB), 3000);
  assert.equal(cost(prodA), Math.round((afterReceipt.qa * afterReceipt.a * 100 + 2000) / afterReceipt.qa) / 100);
  assert.equal(cost(prodB), Math.round((afterReceipt.qb * afterReceipt.b * 100 + 3000) / afterReceipt.qb) / 100);
  // By weight: A 100 kg (typed), B 30 x 0.5 kg = 15 kg (product weight): 23.00 -> 20.00 / 3.00.
  const w = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: freight.id, receiptId: grn.id, landedMethod: 'weight', invoiceDate: `${Y}-05-05`, lines: [{ description: 'جمارك', landedKind: 'customs', qty: 1, unitPrice: '23.00' }] }), 201);
  const wp = ok(await m.post(`/api/purchasing/invoices/${w.id}/post`, {}));
  assert.equal(share(wp, prodA), 2000);
  assert.equal(share(wp, prodB), 300);
  assert.equal(ok(await m.get(`/api/purchasing/receipts/${grn.id}`)).landed_base_minor, 5000 + 2300);
  await assertPayablesClean();
});

test('foreign-currency supplier (EUR, USD base): receipt rate -> GRNI, invoice rate -> AP, rate difference -> FX (not PPV), payment rate -> realized FX', async () => {
  const { m, s2, prodA } = ctx;
  await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.10', effectiveAt: `${Y}-06-01` });
  await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.15', effectiveAt: `${Y}-06-10` });
  await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.20', effectiveAt: `${Y}-06-20` });
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: s2.id, orderDate: `${Y}-06-01`, lines: [{ productId: prodA, qty: 100, unitPrice: '2.00' }] }), 201);
  assert.equal(po.currency_code, 'EUR', 'supplier currency by default');
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  const grn = ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-06-05`, lines: [{ poLineId: s.lines[0].id, qty: 100 }] }), 201);
  assert.equal(grn.total_base_minor, 22000, 'EUR 200 @1.10');
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s2.id, poId: po.id, invoiceDate: `${Y}-06-12`, supplierInvoiceRef: 'EU-1', lines: [{ poLineId: s.lines[0].id, qty: 100, unitPrice: '2.00' }] }), 201);
  const posted = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  assert.equal(posted.total_base_minor, 23000, 'EUR 200 @1.15');
  const il = entryLines(posted.journal_entry.id);
  const apLine = il.find((l) => l.system_key === 'ap_control');
  assert.equal(apLine.currency_code, 'EUR');
  assert.equal(apLine.amount_original_minor, 20000);
  assert.equal(sumBy(il, 'grni'), 22000);
  assert.equal(sumBy(il, 'purchase_price_variance'), 0, 'same EUR price: no purchase price variance');
  assert.equal(sumBy(il, 'fx_realized'), 1000, 'rate moved 1.10 -> 1.15 on the same quantity: exchange difference, not PPV');
  // Pay EUR 200 at 1.20 = 240.00: paid 10.00 more than carried -> loss.
  const p = ok(await ctx.payer.client.post('/api/purchasing/payments', { supplierId: s2.id, paymentDate: `${Y}-06-25`, method: 'transfer', currencyCode: 'EUR', amount: '200' }), 201);
  assert.equal(p.amount_minor, 24000);
  assert.equal(p.fx_settlements.length, 1);
  assert.equal(p.fx_settlements[0].fx_minor, -1000);
  const fl = entryLines(p.fx_settlements[0].journal_entry_id);
  assert.equal(sumBy(fl, 'fx_realized'), 1000, 'loss on fx_realized');
  assert.equal(sumBy(fl, 'ap_control'), -1000);
  assert.equal(ledgerBalance(ctx.co.companyId, 'ap_control', { party: s2.id }), 0, 'supplier settled exactly in base');
  const rep = ok(await m.get(`/api/currency/fx-report?from=${Y}-06-01&to=${Y}-06-30`));
  assert.ok(rep.rows.some((r) => r.document?.payment_id === p.id && r.kind === 'realized' && r.gain_minor === -1000));
  // Reversing the payment reverses the FX entry and reopens the invoice.
  ok(await m.post(`/api/purchasing/payments/${p.id}/reverse`, { reason: 'خطأ بنكي' }));
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(p.fx_settlements[0].journal_entry_id).status, 'reversed');
  assert.equal(ok(await m.get(`/api/purchasing/invoices/${inv.id}`)).open_minor, 20000);
  assert.equal(ledgerBalance(ctx.co.companyId, 'ap_control', { party: s2.id }), -23000);
  ctx.eurInvoice = inv;
  await assertPayablesClean();
});

test('payables revaluation uses the existing tool: open EUR invoice revalued on AP (fx_unrealized), reversed next day', async () => {
  const { m, s2 } = ctx;
  await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.25', effectiveAt: `${Y}-06-30` });
  const prev = ok(await m.post('/api/currency/revaluations/preview', { asOf: `${Y}-06-30` }));
  const line = prev.lines.find((l) => l.kind === 'supplier_invoice' && l.document_id === ctx.eurInvoice.id);
  assert.equal(line.side, 'payable');
  assert.equal(line.carrying_base_minor, 23000);
  assert.equal(line.revalued_base_minor, 25000);
  assert.equal(line.difference_minor, 2000, 'we owe 20.00 more');
  const before = ledgerBalance(ctx.co.companyId, 'ap_control', { party: s2.id });
  const post = ok(await m.post('/api/currency/revaluations', { asOf: `${Y}-06-30` }), 201);
  const rl = entryLines(post.journal_entry.id);
  assert.equal(rl.filter((l) => l.system_key === 'ap_control' && l.party_id === s2.id).reduce((s, l) => s + l.d - l.c, 0), -2000);
  assert.equal(sumBy(rl, 'fx_unrealized'), -post.total_minor);
  assert.ok(post.total_minor <= -2000, 'a payable increase is a loss');
  assert.equal(ledgerBalance(ctx.co.companyId, 'ap_control', { party: s2.id }), before, 'reversal restores AP');
  const bal = ok(await m.get(`/api/currency/balances?asOf=${Y}-07-01`));
  assert.ok(bal.suppliers.some((x) => x.supplier_id === s2.id && x.currency_code === 'EUR' && x.balance_minor === 20000 && x.base_minor === 23000));
  await assertPayablesClean();
});

test('debit note (purchase return): Dr AP / Cr inventory / Cr input tax, stock down, closing note leaves no base dust', async () => {
  const { m, s1, prodB } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: s1.id, orderDate: `${Y}-07-01`, lines: [{ productId: prodB, qty: 7, unitPrice: '3.33', taxRate: '10' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-07-02`, lines: [{ poLineId: s.lines[0].id, qty: 7 }] }), 201);
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s1.id, poId: po.id, invoiceDate: `${Y}-07-03`, lines: [{ poLineId: s.lines[0].id, qty: 7, unitPrice: '3.33', taxRate: '10' }] }), 201);
  const posted = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  const qBefore = stock(prodB);
  const dn = ok(await m.post('/api/purchasing/debit-notes', { invoiceId: inv.id, reason: 'تالف', lines: [{ invoiceLineId: posted.lines[0].id, qty: 3 }] }), 201);
  assert.equal(stock(prodB), qBefore - 3);
  const dl = entryLines(dn.journal_entry_id);
  assert.equal(sumBy(dl, 'ap_control'), dn.total_base_minor);
  assert.equal(sumBy(dl, 'input_tax'), -100, '3 x 3.33 = 9.99, tax 1.00');
  assert.equal(sumBy(dl, 'inventory'), -999);
  const dn2 = ok(await m.post('/api/purchasing/debit-notes', { invoiceId: inv.id, lines: [{ invoiceLineId: posted.lines[0].id, qty: 4 }] }), 201);
  assert.ok(dn2.id);
  const after = ok(await m.get(`/api/purchasing/invoices/${inv.id}`));
  assert.equal(after.open_minor, 0);
  assert.equal(after.base_open_minor, 0, 'no base dust');
  const too = await m.post('/api/purchasing/debit-notes', { invoiceId: inv.id, lines: [{ invoiceLineId: posted.lines[0].id, qty: 1 }] });
  assert.equal(too.status, 400);
  await assertPayablesClean();
});

test('expense invoice (no PO) posts to the chosen expense account with input tax', async () => {
  const { m, freight } = ctx;
  const rent = ctx.acc('6200');
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: freight.id, invoiceDate: `${Y}-07-10`, lines: [{ description: 'إيجار مستودع', qty: 1, unitPrice: '300', taxRate: '5', expenseAccountId: rent }] }), 201);
  assert.equal(inv.match_status, 'not_required');
  const posted = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  const l = entryLines(posted.journal_entry.id);
  assert.equal(l.find((x) => x.code === '6200').d, 30000);
  assert.equal(sumBy(l, 'input_tax'), 1500);
  assert.equal(sumBy(l, 'ap_control'), -31500);
  const bad = await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: freight.id, lines: [{ description: 'x', qty: 1, unitPrice: '1', expenseAccountId: ctx.acc('4100') }] });
  assert.equal(bad.body.error, 'invalid_expense_account');
  const purch = ok(await m.get(`/api/purchasing/reports/purchases?from=${Y}-01-01&to=${Y}-12-31&by=supplier`));
  assert.ok(purch.rows.some((r) => r.supplier_id === freight.id && r.base_minor === 30000));
  const byItem = ok(await m.get(`/api/purchasing/reports/purchases?from=${Y}-01-01&to=${Y}-12-31&by=item`));
  assert.ok(byItem.rows.some((r) => r.product_id === ctx.prodA));
  await assertPayablesClean();
});

test('DONE: payables aging matches the ledger, by bucket and as of a date; Excel export opens', async () => {
  const { m } = ctx;
  const aging = ok(await m.get('/api/purchasing/reports/aging'));
  const buckets = ['current', 'b1_30', 'b31_60', 'b61_90', 'b90_plus', 'advances'];
  for (const r of aging.rows) assert.equal(buckets.reduce((s, k) => s + r[k], 0), r.total);
  const past = ok(await m.get(`/api/purchasing/reports/aging?asOf=${Y}-03-01`));
  const ap = db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND a.system_key = 'ap_control' AND e.entry_date <= ?`).get(ctx.co.companyId, `${Y}-03-01`).s;
  assert.equal(past.totals.total, ap);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: ctx.co.managerContact, password: ctx.co.managerPassword }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const x = await fetch(`${base}/api/purchasing/reports/aging?format=xlsx`, { headers: { Cookie: cookie } });
  assert.equal(x.status, 200);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
  const text = [];
  wb.worksheets[0].eachRow((r) => text.push(r.values.join('|')));
  assert.ok(text.some((t) => t.includes('أعمار الذمم الدائنة')));
  // Vendors dashboard reads the same numbers.
  const ven = ok(await m.get('/api/departments/vendors'));
  const field = (k) => ven.fields.find((f) => f.key === k);
  assert.equal(Math.round(field('payables').value * 100), aging.control_minor);
  assert.equal(field('activeVendors').value, 3);
  assert.equal(field('payables').tracked, true);
  const dash = ok(await m.get('/api/purchasing/dashboard'));
  assert.equal(dash.payables_minor, aging.control_minor);
});

test('atomicity: failures after the entry roll back receipt, invoice and payment completely', async () => {
  const faults = require('../lib/faultInjection');
  const { m, s1, prodA } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: s1.id, orderDate: `${Y}-08-01`, lines: [{ productId: prodA, qty: 5, unitPrice: '10' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  const snap = () => ({
    e: db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?').get(ctx.co.companyId).c,
    r: db.prepare('SELECT COUNT(*) c FROM goods_receipts').get().c,
    st: stock(prodA), cost: cost(prodA),
    rq: db.prepare('SELECT received_qty FROM purchase_order_lines WHERE id = ?').get(s.lines[0].id).received_qty,
    p: db.prepare('SELECT COUNT(*) c FROM supplier_payments').get().c,
    i: db.prepare("SELECT COUNT(*) c FROM supplier_invoices WHERE status = 'posted'").get().c,
  });
  let before = snap();
  faults.arm('purchasing.receipt.after_entry');
  assert.equal((await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-08-02`, lines: [{ poLineId: s.lines[0].id, qty: 5 }] })).status, 500);
  assert.deepEqual(snap(), before);
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-08-02`, lines: [{ poLineId: s.lines[0].id, qty: 5 }] }), 201);
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s1.id, poId: po.id, invoiceDate: `${Y}-08-03`, lines: [{ poLineId: s.lines[0].id, qty: 5, unitPrice: '10' }] }), 201);
  before = snap();
  faults.arm('payables.invoice.after_entry');
  assert.equal((await m.post(`/api/purchasing/invoices/${inv.id}/post`, {})).status, 500);
  assert.deepEqual(snap(), before);
  assert.equal(db.prepare('SELECT invoiced_qty FROM goods_receipt_lines WHERE po_line_id = ?').get(s.lines[0].id).invoiced_qty, 0);
  ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  before = snap();
  faults.arm('payables.payment.after_entry');
  assert.equal((await m.post('/api/purchasing/payments', { supplierId: s1.id, paymentDate: `${Y}-08-04`, amount: '50' })).status, 500);
  assert.deepEqual(snap(), before);
  faults.disarmAll();
  ok(await m.post('/api/purchasing/payments', { supplierId: s1.id, paymentDate: `${Y}-08-04`, amount: '50' }), 201);
  await assertPayablesClean();
});

test('permissions: purchasing endpoints are refused without the purchasing permissions', async () => {
  const none = await createRep(base, ctx.m, { permissions: [] });
  for (const [method, url] of [['get', '/api/purchasing/suppliers'], ['post', '/api/purchasing/suppliers'], ['post', '/api/purchasing/requests'], ['post', '/api/purchasing/orders'], ['post', '/api/purchasing/payments'], ['post', '/api/purchasing/invoices'], ['get', '/api/purchasing/reports/aging']]) {
    assert.equal((await none.client[method](url, {})).status, 403, `${method} ${url}`);
  }
  const clerk = ctx.clerk.client;
  assert.equal((await clerk.post('/api/purchasing/suppliers', { name: 'x' })).status, 403, 'manage_suppliers needed');
  assert.equal((await clerk.post('/api/purchasing/payments', { supplierId: ctx.s1.id, amount: '1' })).status, 403, 'make_supplier_payments needed');
});

test('tenant refs: every supplier-facing endpoint rejects another company\'s ids', async () => {
  const { m, other, s1, prodA, cycle } = ctx;
  const expectRefused = async (res, label) => {
    assert.ok([400, 404].includes(res.status), `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(String(res.body.error), /^invalid_/, label);
  };
  await expectRefused(await m.get(`/api/purchasing/suppliers/${other.supplier.id}`), 'GET supplier');
  await expectRefused(await m.put(`/api/purchasing/suppliers/${other.supplier.id}`, { name: 'x' }), 'PUT supplier');
  await expectRefused(await m.get(`/api/purchasing/suppliers/${other.supplier.id}/statement`), 'statement');
  await expectRefused(await m.get(`/api/purchasing/suppliers/${other.supplier.id}/open-invoices`), 'open invoices');
  await expectRefused(await m.get(`/api/purchasing/price-history?productId=${other.product}`), 'price history product');
  await expectRefused(await m.get(`/api/purchasing/orders?supplierId=${other.supplier.id}`), 'orders filter');
  await expectRefused(await m.post('/api/purchasing/requests', { lines: [{ productId: other.product, qty: 1 }] }), 'request product');
  await expectRefused(await m.post(`/api/purchasing/requests/${other.req.id}/submit`, {}), 'request submit');
  await expectRefused(await m.get(`/api/purchasing/requests/${other.req.id}/comparison`), 'comparison');
  await expectRefused(await m.post('/api/purchasing/quotations', { supplierId: other.supplier.id, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'quotation supplier');
  await expectRefused(await m.post('/api/purchasing/quotations', { supplierId: s1.id, requestId: other.req.id, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'quotation request');
  await expectRefused(await m.post('/api/purchasing/orders', { supplierId: other.supplier.id, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'PO supplier');
  await expectRefused(await m.post('/api/purchasing/orders', { supplierId: s1.id, lines: [{ productId: other.product, qty: 1, unitPrice: '1' }] }), 'PO product');
  await expectRefused(await m.post('/api/purchasing/orders', { supplierId: s1.id, approverUserId: other.supplier.created_by || 999999, lines: [{ productId: prodA, qty: 1, unitPrice: '1' }] }), 'PO approver');
  await expectRefused(await m.post('/api/purchasing/orders', { supplierId: s1.id, warehouseId: 999999, lines: [{ productId: prodA, qty: 1, unitPrice: '1' }] }), 'PO warehouse');
  await expectRefused(await m.post(`/api/purchasing/orders/${other.po.id}/submit`, {}), 'PO submit');
  await expectRefused(await m.post(`/api/purchasing/orders/${other.po.id}/approve`, {}), 'PO approve');
  await expectRefused(await m.post(`/api/purchasing/orders/${other.po.id}/receive`, { lines: [] }), 'receive');
  await expectRefused(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: s1.id, poId: other.po.id, lines: [] }), 'invoice PO');
  await expectRefused(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: other.supplier.id, poId: cycle.po.id, lines: [] }), 'invoice supplier');
  await expectRefused(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: s1.id, receiptId: 999999, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'landed receipt');
  await expectRefused(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: s1.id, lines: [{ description: 'x', qty: 1, unitPrice: '1', expenseAccountId: other.expense }] }), 'expense account');
  await expectRefused(await m.post('/api/purchasing/payments', { supplierId: other.supplier.id, amount: '1' }), 'payment supplier');
  const p = ok(await m.post('/api/purchasing/payments', { supplierId: s1.id, paymentDate: `${Y}-09-01`, amount: '1', autoAllocate: false }), 201);
  const oInv = Number(db.prepare('SELECT id FROM supplier_invoices WHERE company_id = ? LIMIT 1').get(other.companyId)?.id || 999999);
  await expectRefused(await m.put(`/api/purchasing/payments/${p.id}/allocations`, { allocations: [{ invoiceId: oInv, amount: '1' }] }), 'allocation invoice');
  await expectRefused(await m.post('/api/purchasing/debit-notes', { invoiceId: oInv, lines: [] }), 'debit note invoice');
  await expectRefused(await m.get(`/api/purchasing/invoices/${oInv}`), 'GET invoice');
  await expectRefused(await m.post(`/api/purchasing/payments/999999/reverse`, { reason: 'x' }), 'reverse payment');
  // And the ledger: a supplier party of another company.
  const e = await m.post('/api/ledger/entries', { date: `${Y}-09-01`, lines: [{ accountId: ctx.acc('ap_control'), debit: '1', partyType: 'supplier', partyId: other.supplier.id }, { accountId: ctx.acc('1110'), credit: '1' }] });
  assert.equal(e.body.error, 'invalid_supplier');
});

test('supplier opening balances: a lump AP opening balance is reclassed onto suppliers, so AP control = sub-ledger again, and the opening item can be paid', async () => {
  const co = await h.createUsdCompany(base, 'شركة أرصدة موردين');
  const m = co.manager;
  const { accounts, fy } = await h.setupLedger(m);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  // The ledger opening balances screen has no supplier field: AP lands unassigned.
  ok(await m.post('/api/ledger/opening-balances', { fiscalYearId: fy.id, rows: [{ accountId: acc('1110'), debit: '500' }, { accountId: acc('2110'), credit: '500' }] }), 201);
  const before = ok(await m.get('/api/purchasing/reports/aging'));
  assert.equal(before.unassigned_minor, 50000, 'lump AP opening balance has no supplier');
  const a = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد قديم أ' }), 201);
  const b = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد قديم ب' }), 201);
  const tooMuch = await m.post('/api/purchasing/opening-balances', { date: `${Y}-01-01`, rows: [{ supplierId: a.id, amount: '600' }] });
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.error, 'exceeds_unassigned_ap');
  const res = ok(await m.post('/api/purchasing/opening-balances', { date: `${Y}-01-01`, rows: [{ supplierId: a.id, amount: '320', dueDate: `${Y}-02-15`, ref: 'OLD-1' }, { supplierId: b.id, amount: '180' }] }), 201);
  assert.equal(res.unassigned_minor, 0);
  const after = ok(await m.get('/api/purchasing/reports/aging'));
  assert.equal(after.unassigned_minor, 0, 'AP control = supplier sub-ledgers');
  assert.equal(after.rows.find((r) => r.supplier_id === a.id).total, 32000);
  assert.equal(ledgerBalance(co.companyId, 'ap_control'), -50000, 'reclass moves AP between parties, not its total');
  const payer = await createRep(base, m, { permissions: ['view_purchases', 'make_supplier_payments'] });
  const p = ok(await payer.client.post('/api/purchasing/payments', { supplierId: a.id, paymentDate: `${Y}-02-01`, amount: '320' }), 201);
  assert.equal(p.allocations.length, 1);
  assert.equal(p.unallocated_minor, 0);
  const opening = await m.post('/api/purchasing/opening-balances', { date: `${Y}-01-01`, mode: 'opening', rows: [{ supplierId: b.id, amount: '20' }] });
  assert.equal(opening.status, 201, 'opening mode posts against opening balance equity');
  const dn = await m.post('/api/purchasing/debit-notes', { invoiceId: res.invoices[1].id, lines: [{ invoiceLineId: res.invoices[1].lines[0].id, qty: 1 }] });
  assert.equal(dn.body.error, 'opening_debit_note');
  await assertPayablesClean({ co, m });
});
