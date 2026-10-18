// backend/test/stockLots.test.js
//
// Prompt 8b — lots, expiry, FEFO, counts, wastage, repack, reorder,
// trace / recall, reports, item card:
//  - receipts create lots (code, expiry, supplier lot); a tracked product
//    needs a lot on receipt;
//  - FEFO: a sale takes the EARLIEST expiry first (even when received
//    later) and splits across lots; quarantined / expired lots are skipped;
//  - the recall report lists every customer that received the lot (net of
//    returns) and what is still in stock; reverse trace customer -> lot;
//  - count approval posts the differences (Dr/Cr inventory vs
//    inventory_adjustments) with separation of duties (one-user OK,
//    two users enforced, owner break-glass);
//  - wastage posts Dr inventory_wastage / Cr inventory; repack keeps value;
//  - reorder suggestion + alert, expiry sweep (expired marked, near-expiry
//    alert), reports, item card; tenant refs; permissions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lots-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const S = require('../lib/stockLedger');
const O = require('../lib/stockOps');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const D = new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let listener;
let base;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const exactLines = (entryId) => db.prepare('SELECT a.code, a.system_key k, l.debit_minor d, l.credit_minor c FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId).map((x) => ({ ...x }));
const lines = (entryId) => db.prepare('SELECT a.system_key k, l.debit_minor d, l.credit_minor c FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId);
const net = (ls, key) => ls.filter((l) => l.k === key).reduce((s, l) => s + l.d - l.c, 0);
function assertReconciled(label) {
  const r = S.reconcile(ctx.co.companyId);
  assert.equal(r.difference_minor, 0, `${label}: ${JSON.stringify(r)}`);
  assert.deepEqual(r.qty_mismatches, [], label);
}
const lotBal = (lotId) => db.prepare('SELECT COALESCE(SUM(qty), 0) q FROM stock_lot_balances WHERE lot_id = ?').get(lotId).q;

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة الدفعات');
  const m = co.manager;
  await h.setupLedger(m);
  const mk = async (name, cost) => {
    const id = await h.mkProduct(m, { name });
    db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(cost, id);
    return id;
  };
  const pL = await mk('حليب بالدفعات', 2);
  const pA = await mk('مادة عادية', 1);
  const pU = await mk('عبوة مفردة', 1);
  const shop1 = await h.mkShop(m, 'زبون أول');
  const shop2 = await h.mkShop(m, 'زبون ثانٍ');
  const shop3 = await h.mkShop(m, 'زبون لم يشترِ');
  ok((await h.goLive(m, D)).res);
  ok(await m.post('/api/factory-inventory', { product_id: pA, current_quantity: 50 }), 201);
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد الدفعات', currencyCode: 'USD' }), 201);
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const wh = S.warehouseHolder(co.companyId, null);
  ctx = { co, m, pL, pA, pU, shop1, shop2, shop3, supplier, wh };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function receive(lns) {
  const { m, supplier } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: D, lines: lns.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice })) }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  return m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: D, lines: lns.map((l, i) => ({ poLineId: s.lines[i].id, qty: l.qty, ...l.lot })) });
}
async function sell(shopId, productId, qty) {
  const inv = ok(await ctx.m.post('/api/sales/invoices', { shopId, invoiceDate: D, lines: [{ productId, qty, unitPrice: '5' }] }), 201);
  return ok(await ctx.m.post(`/api/sales/invoices/${inv.id}/post`, {}));
}

test('lots on receipt: tracked product needs a lot; lot code, expiry and supplier lot stored', async () => {
  const { m, pL } = ctx;
  ok(await m.put(`/api/stock/products/${pL}/settings`, { trackLots: true, reorderPoint: 30, reorderQty: 40 }));
  const noLot = await receive([{ productId: pL, qty: 5, unitPrice: '2' }]);
  assert.equal(noLot.status, 400);
  assert.equal(noLot.body.error, 'lot_required');
  // Late lot received FIRST, early-expiry lot received second.
  ok(await receive([{ productId: pL, qty: 10, unitPrice: '2', lot: { lotCode: 'LATE', expiryDate: addDays(200), supplierLot: 'SUP-L' } }]), 201);
  ok(await receive([{ productId: pL, qty: 6, unitPrice: '2', lot: { lotCode: 'EARLY', expiryDate: addDays(20), supplierLot: 'SUP-E' } }]), 201);
  const lots = ok(await m.get(`/api/stock/lots?productId=${pL}`));
  const early = lots.find((l) => l.lot_code === 'EARLY');
  const late = lots.find((l) => l.lot_code === 'LATE');
  assert.equal(early.supplier_lot, 'SUP-E');
  assert.equal(early.qty, 6);
  assert.equal(late.qty, 10);
  assert.equal(lots[0].lot_code, 'EARLY', 'listed by expiry');
  ctx.early = early.id;
  ctx.late = late.id;
  assertReconciled('after receipts');
});

test('FEFO picks the earliest expiry first and splits across lots; quarantined lots skipped', async () => {
  const { pL, shop1, shop2 } = ctx;
  const s1 = await sell(shop1, pL, 4);
  const mv1 = db.prepare("SELECT lot_id, qty FROM stock_moves WHERE source_type = 'sales_invoice_line' AND source_id = ?").all(s1.lines[0].id).map((x) => ({ ...x }));
  assert.deepEqual(mv1, [{ lot_id: ctx.early, qty: -4 }], 'earliest expiry, although received later');
  const s2 = await sell(shop2, pL, 5);
  const mv2 = db.prepare("SELECT lot_id, qty FROM stock_moves WHERE source_type = 'sales_invoice_line' AND source_id = ? ORDER BY id").all(s2.lines[0].id).map((x) => ({ ...x }));
  assert.deepEqual(mv2, [{ lot_id: ctx.early, qty: -2 }, { lot_id: ctx.late, qty: -3 }], 'rest of EARLY, then LATE');
  assert.equal(net(lines(s2.journal_entry_id), 'cogs'), 1000, '5 x 2.00');
  assert.equal(lotBal(ctx.early), 0);
  assert.equal(lotBal(ctx.late), 7);
  // Quarantine LATE -> nothing pickable.
  ok(await ctx.m.put(`/api/stock/lots/${ctx.late}/status`, { status: 'quarantine', reason: 'فحص جودة' }));
  const inv = ok(await ctx.m.post('/api/sales/invoices', { shopId: shop1, invoiceDate: D, lines: [{ productId: pL, qty: 1, unitPrice: '5' }] }), 201);
  const r = await ctx.m.post(`/api/sales/invoices/${inv.id}/post`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  ok(await ctx.m.put(`/api/stock/lots/${ctx.late}/status`, { status: 'available' }));
  ok(await ctx.m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  assert.equal(lotBal(ctx.late), 6);
  assertReconciled('after FEFO sales');
});

test('recall lists every customer that received the lot (net of returns); reverse trace customer -> supplier lot', async () => {
  const { m, shop1, shop2, shop3 } = ctx;
  const rc = ok(await m.get(`/api/stock/lots/${ctx.early}/recall`));
  assert.deepEqual(rc.customers.map((c) => [c.shop_id, c.qty]).sort(), [[shop1, 4], [shop2, 2]].sort());
  assert.equal(rc.received_qty, 6);
  assert.equal(rc.sold_qty, 6);
  assert.equal(rc.supplier.supplier_lot, 'SUP-E');
  assert.ok(!rc.customers.some((c) => c.shop_id === shop3));
  const late = ok(await m.get(`/api/stock/lots/${ctx.late}/recall`));
  assert.deepEqual(late.customers.map((c) => [c.shop_id, c.qty]).sort(), [[shop1, 1], [shop2, 3]].sort());
  assert.equal(late.in_stock_qty, 6);
  const rev = ok(await m.get(`/api/stock/trace/reverse?shopId=${shop2}`));
  assert.deepEqual(rev.map((r) => [r.lot_code, r.qty, r.supplier_lot]).sort(), [['EARLY', 2, 'SUP-E'], ['LATE', 3, 'SUP-L']]);
  assert.equal(rev[0].supplier_name, 'مورد الدفعات');
  const fwd = ok(await m.get(`/api/stock/lots/${ctx.early}/trace`));
  assert.equal(fwd.receipts.length, 1);
});

test('count approval posts the differences; separation of duties: one user operates, two users enforced, owner break-glass', async () => {
  const { m, pA, pL, wh, co } = ctx;
  const mkCount = async (client = m) => ok(await client.post('/api/stock/counts', { holderId: wh.id, countDate: D, lines: [{ productId: pA, countedQty: 47, reasonCode: 'loss' }, { productId: pL, lotId: ctx.late, countedQty: 7, reasonCode: 'found' }] }), 201);
  // Reason required on a variance.
  assert.equal((await m.post('/api/stock/counts', { holderId: wh.id, lines: [{ productId: pA, countedQty: 40 }] })).body.error, 'reason_required');
  // Lot-tracked product counted per lot.
  assert.equal((await m.post('/api/stock/counts', { holderId: wh.id, lines: [{ productId: pL, countedQty: 1, reasonCode: 'loss' }] })).body.error, 'lot_required');
  // One user: the creator approves.
  const c1 = await mkCount();
  assert.deepEqual(c1.lines.map((l) => l.variance), [-3, 1]);
  const a1 = ok(await m.post(`/api/stock/counts/${c1.id}/approve`, {}));
  assert.equal(a1.status, 'approved');
  const e = lines(a1.journal_entry_id);
  // A: -3 x 1.00 = -3.00; L: +1 at the pool average 2.00.
  assert.equal(net(e, 'inventory'), -300 + 200);
  assert.equal(net(e, 'inventory_adjustments'), 300 - 200);
  assert.equal(S.poolRow(co.companyId, pA, wh.id).qty, 47);
  assert.equal(lotBal(ctx.late), 7);
  assertReconciled('after count');
  // Second user with the approve permission -> enforced for the creator.
  const approver = await createRep(base, m, { permissions: ['approve_stock_counts', 'view_stock_valuation'] });
  const clerk = await createRep(base, m, { permissions: ['manage_stock_counts', 'approve_stock_counts'] });
  ctx.approver = approver;
  const c2 = await mkCount(clerk.client);
  const sod = await clerk.client.post(`/api/stock/counts/${c2.id}/approve`, {});
  assert.equal(sod.status, 403);
  assert.equal(sod.body.error, 'sod_count_creator');
  assert.equal((await clerk.client.post(`/api/stock/counts/${c2.id}/approve`, { breakGlassReason: 'لا يوجد أحد غيري اليوم' })).body.error, 'break_glass_owner_only');
  ok(await approver.client.post(`/api/stock/counts/${c2.id}/approve`, {}));
  // Owner break-glass on their own count: reason mandatory, audited.
  const c3 = await mkCount();
  assert.equal((await m.post(`/api/stock/counts/${c3.id}/approve`, {})).status, 403);
  assert.equal((await m.post(`/api/stock/counts/${c3.id}/approve`, { breakGlassReason: 'قصير' })).body.error, 'break_glass_reason_too_short');
  ok(await m.post(`/api/stock/counts/${c3.id}/approve`, { breakGlassReason: 'جرد نهاية الشهر والمعتمد مسافر' }));
  const bg = db.prepare("SELECT after_json FROM audit_log WHERE company_id = ? AND action = 'sod.break_glass' AND entity_type = 'stock_count' AND entity_id = ?").get(co.companyId, c3.id);
  assert.ok(bg && JSON.parse(bg.after_json).reason.includes('مسافر'), 'break-glass audited with its reason');
  // Rejected count posts nothing.
  const c4 = await mkCount(clerk.client);
  ok(await approver.client.post(`/api/stock/counts/${c4.id}/reject`, { reason: 'إعادة العد' }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE source_type = ? AND source_id = ?').get('stock_count', c4.id).c, 0);
  const variances = ok(await m.get('/api/stock/reports/count-variances'));
  assert.ok(Array.isArray(variances.rows || variances));
  assertReconciled('after counts');
});

test('count variance, exact: gain posts Dr inventory / Cr inventory_adjustments, loss the reverse, at the pool cost; rejected count posts nothing', async () => {
  const { m, wh, co } = ctx;
  const cid = co.companyId;
  const pV = await h.mkProduct(m, { name: 'مادة الجرد الدقيق' });
  ok(await receive([{ productId: pV, qty: 10, unitPrice: '3' }]), 201);
  assert.deepEqual([S.poolRow(cid, pV, wh.id).qty, S.poolRow(cid, pV, wh.id).value_minor], [10, 3000]);
  const invCode = db.prepare("SELECT code FROM accounts WHERE company_id = ? AND system_key = 'inventory'").get(cid).code;
  const adjCode = db.prepare("SELECT code FROM accounts WHERE company_id = ? AND system_key = 'inventory_adjustments'").get(cid).code;
  assert.equal(adjCode, '5800');
  const approve = async (id) => ok(await ctx.approver.client.post(`/api/stock/counts/${id}/approve`, {}));
  const entries = () => db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?').get(cid).c;

  // Gain: counted 13 vs 10 -> +3 x 3.00 = 9.00.
  const g = ok(await m.post('/api/stock/counts', { holderId: wh.id, countDate: D, lines: [{ productId: pV, countedQty: 13, reasonCode: 'found' }] }), 201);
  assert.deepEqual(g.lines.map((l) => [l.expected_qty, l.counted_qty, l.variance, l.reason_code]), [[10, 13, 3, 'found']]);
  const ga = await approve(g.id);
  assert.deepEqual(exactLines(ga.journal_entry_id), [
    { code: invCode, k: 'inventory', d: 900, c: 0 },
    { code: adjCode, k: 'inventory_adjustments', d: 0, c: 900 },
  ]);
  const gm = db.prepare("SELECT move_type, qty, value_minor, reason_code, journal_entry_id FROM stock_moves WHERE source_type = 'stock_count' AND source_id = ?").all(g.id).map((x) => ({ ...x }));
  assert.deepEqual(gm, [{ move_type: 'count', qty: 3, value_minor: 900, reason_code: 'found', journal_entry_id: ga.journal_entry_id }]);
  assert.equal(ga.lines[0].value_minor, 900);
  assert.deepEqual([S.poolRow(cid, pV, wh.id).qty, S.poolRow(cid, pV, wh.id).value_minor], [13, 3900]);

  // Loss: counted 8 vs 13 -> -5 x 3.00 = 15.00.
  const l = ok(await m.post('/api/stock/counts', { holderId: wh.id, countDate: D, lines: [{ productId: pV, countedQty: 8, reasonCode: 'loss' }] }), 201);
  assert.deepEqual(l.lines.map((x) => [x.expected_qty, x.counted_qty, x.variance]), [[13, 8, -5]]);
  const la = await approve(l.id);
  assert.deepEqual(exactLines(la.journal_entry_id), [
    { code: invCode, k: 'inventory', d: 0, c: 1500 },
    { code: adjCode, k: 'inventory_adjustments', d: 1500, c: 0 },
  ]);
  const lm = db.prepare("SELECT move_type, qty, value_minor FROM stock_moves WHERE source_type = 'stock_count' AND source_id = ?").all(l.id).map((x) => ({ ...x }));
  assert.deepEqual(lm, [{ move_type: 'count', qty: -5, value_minor: -1500 }]);
  assert.equal(la.lines[0].value_minor, -1500);
  assert.deepEqual([S.poolRow(cid, pV, wh.id).qty, S.poolRow(cid, pV, wh.id).value_minor], [8, 2400]);
  assert.equal(db.prepare('SELECT current_quantity q FROM factory_inventory WHERE company_id = ? AND product_id = ?').get(cid, pV).q, 8, 'screen quantity follows');

  // A matching line posts nothing for that line.
  // Rejected: no move, no entry, balances untouched, not in the variance report.
  const before = entries();
  const r = ok(await m.post('/api/stock/counts', { holderId: wh.id, countDate: D, lines: [{ productId: pV, countedQty: 1, reasonCode: 'theft' }] }), 201);
  const rj = ok(await ctx.approver.client.post(`/api/stock/counts/${r.id}/reject`, { reason: 'إعادة العد' }));
  assert.deepEqual([rj.status, rj.journal_entry_id], ['rejected', null]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE source_type = 'stock_count' AND source_id = ?").get(r.id).c, 0);
  assert.equal(entries(), before);
  assert.deepEqual([S.poolRow(cid, pV, wh.id).qty, S.poolRow(cid, pV, wh.id).value_minor], [8, 2400]);
  assert.equal((await ctx.approver.client.post(`/api/stock/counts/${r.id}/approve`, {})).body.error, 'count_not_draft');

  const rep = ok(await m.get('/api/stock/reports/count-variances')).filter((x) => x.product_name === 'مادة الجرد الدقيق');
  assert.deepEqual(rep.map((x) => [x.count_number, x.variance, x.value_minor]), [[g.count_number, 3, 900], [l.count_number, -5, -1500]]);
  assertReconciled('after exact counts');
});

test('wastage posts Dr inventory_wastage / Cr inventory; repack keeps the value', async () => {
  const { m, pA, pU, pL, wh, co } = ctx;
  const w = ok(await m.post('/api/stock/wastage', { holderId: wh.id, reasonCode: 'damage', lines: [{ productId: pA, qty: 2 }, { productId: pL, qty: 1, lotId: ctx.late }] }), 201);
  const e = lines(w.journal_entry_id);
  assert.equal(net(e, 'inventory_wastage'), 200 + 200);
  assert.equal(net(e, 'inventory'), -400);
  assert.equal(w.lines.find((l) => l.product_id === pL).lot_id, ctx.late);
  assert.equal((await m.post('/api/stock/wastage', { holderId: wh.id, reasonCode: 'nonsense', lines: [{ productId: pA, qty: 1 }] })).body.error, 'invalid_reason');
  const rp = ok(await m.post('/api/stock/repack', { holderId: wh.id, from: { productId: pA, qty: 5 }, to: { productId: pU, qty: 20 } }), 201);
  assert.equal(rp.value_minor, 500);
  assert.equal(S.poolRow(co.companyId, pU, wh.id).value_minor, 500);
  assert.equal(net(lines(rp.journal_entry_id), 'inventory'), 0);
  assertReconciled('after wastage and repack');
});

test('reorder suggestion + alert; expiry sweep marks expired and alerts near-expiry; FEFO skips expired', async () => {
  const { m, pL, co } = ctx;
  const sug = ok(await m.get('/api/stock/reorder')).find((r) => r.product_id === pL);
  assert.equal(sug.on_hand, 6);
  assert.equal(sug.needed, true);
  assert.ok(sug.suggested_qty >= 40);
  // A lot that already expired, and one near expiry.
  ok(await receive([{ productId: pL, qty: 3, unitPrice: '2', lot: { lotCode: 'OLD', expiryDate: addDays(-1) } }, { productId: pL, qty: 2, unitPrice: '2', lot: { lotCode: 'SOON', expiryDate: addDays(5) } }]), 201);
  const n = O.sweepAlerts();
  assert.ok(n >= 3);
  const old = db.prepare("SELECT * FROM stock_lots WHERE lot_code = 'OLD'").get();
  assert.equal(old.status, 'expired');
  const types = db.prepare('SELECT type FROM notifications WHERE company_id = ?').all(co.companyId).map((x) => x.type);
  for (const t of ['lot_expired', 'lot_near_expiry', 'reorder_needed']) assert.ok(types.includes(t), t);
  assert.equal(O.sweepAlerts(), 0, 'one unread alert per subject');
  // Next sale skips OLD (expired) and takes SOON first.
  const s = await sell(ctx.shop1, pL, 2);
  const mv = db.prepare("SELECT l.lot_code FROM stock_moves m JOIN stock_lots l ON l.id = m.lot_id WHERE m.source_type = 'sales_invoice_line' AND m.source_id = ?").all(s.lines[0].id).map((x) => x.lot_code);
  assert.deepEqual(mv, ['SOON']);
  assert.equal((await m.put(`/api/stock/lots/${old.id}/status`, { status: 'available' })).body.error, 'lot_expired');
  const near = ok(await m.get('/api/stock/reports/near-expiry?days=30'));
  assert.ok(near.some((l) => l.lot_code === 'OLD'));
  assertReconciled('after expiry');
});

test('reports and item card', async () => {
  const { m, pL, pA } = ctx;
  for (const r of ['item-balance', 'ageing', 'slow-moving', 'near-expiry', 'count-variances', 'inventory-cost', 'turnover', 'profitability', 'wastage']) ok(await m.get(`/api/stock/reports/${r}`));
  assert.equal((await m.get('/api/stock/reports/nope')).status, 404);
  const bal = ok(await m.get('/api/stock/reports/item-balance'));
  const v = S.valuation(ctx.co.companyId);
  assert.equal(bal.total_minor, v.total_minor);
  const wst = ok(await m.get('/api/stock/reports/wastage'));
  assert.ok(JSON.stringify(wst).includes('damage'));
  const card = ok(await m.get(`/api/stock/items/${pL}`));
  assert.equal(card.settings.track_lots, 1);
  assert.equal(card.qty, card.holders.reduce((s, h2) => s + h2.qty, 0));
  assert.ok(card.lots.some((l) => l.lot_code === 'LATE'));
  assert.equal(card.suppliers[0].name, 'مورد الدفعات');
  assert.ok(card.sales_90d.qty > 0);
  assert.ok(ok(await m.get(`/api/stock/items/${pA}`)).moves.length > 0);
});

test('tenant refs and permissions', async () => {
  const other = await h.createUsdCompany(base, 'شركة أخرى للدفعات');
  const om = other.manager;
  await h.setupLedger(om);
  ok((await h.goLive(om, D)).res);
  const dry = ok(await om.post('/api/stock/activation/dry-run', { date: D }));
  ok(await om.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const ow = S.warehouseHolder(other.companyId, null);
  // Foreign lot / product / holder / count -> 400, nothing written.
  assert.equal((await om.get(`/api/stock/lots/${ctx.early}/recall`)).status, 400);
  assert.equal((await om.put(`/api/stock/lots/${ctx.early}/status`, { status: 'quarantine', reason: 'سرقة بيانات' })).status, 400);
  assert.equal((await om.get(`/api/stock/items/${ctx.pL}`)).status, 400);
  assert.equal((await om.post('/api/stock/wastage', { holderId: ctx.wh.id, reasonCode: 'damage', lines: [{ productId: ctx.pA, qty: 1 }] })).status, 400);
  assert.equal((await om.post('/api/stock/wastage', { holderId: ow.id, reasonCode: 'damage', lines: [{ productId: ctx.pA, qty: 1 }] })).status, 400);
  assert.equal((await om.post('/api/stock/counts', { holderId: ow.id, lines: [{ productId: ctx.pA, countedQty: 1, reasonCode: 'loss' }] })).status, 400);
  const c = db.prepare('SELECT id FROM stock_counts WHERE company_id = ? LIMIT 1').get(ctx.co.companyId);
  assert.equal((await om.post(`/api/stock/counts/${c.id}/approve`, {})).status, 400);
  assert.equal((await om.get(`/api/stock/trace/reverse?shopId=${ctx.shop1}`)).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE company_id = ?').get(other.companyId).c, 0);
  // Permissions.
  const nobody = await createRep(base, ctx.m, { permissions: ['view_app'] });
  assert.equal((await nobody.client.get('/api/stock/lots')).status, 403);
  assert.equal((await nobody.client.post('/api/stock/wastage', {})).status, 403);
  assert.equal((await nobody.client.post('/api/stock/counts', {})).status, 403);
  assert.equal((await nobody.client.get(`/api/stock/items/${ctx.pL}`)).status, 403);
});
