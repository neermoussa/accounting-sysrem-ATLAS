// backend/test/costVarianceStable.test.js
//
// NEXT ACTION item 1: the cost-variance report of a CLOSED period must not
// move when something is posted later. The theoretical cost is fixed on the
// production order when it closes (all three price bases), and the report
// reads that snapshot instead of today's prices.
//
// The case that moved before: a material with no goods receipt on or before
// the production date (it came in as opening stock) falls back from
// "latest purchase" to the CURRENT stock average, so a purchase posted in
// the next month changed last month's theoretical cost. basis=average moved
// the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cvs-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const faults = require('../lib/faultInjection');
const h = require('./salesHelpers');

const YEAR = h.YEAR;
const OCT = (d) => `${YEAR}-10-${String(d).padStart(2, '0')}`;
const NOV = (d) => `${YEAR}-11-${String(d).padStart(2, '0')}`;
let listener;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const mf = (method, url, body) => ctx.m[method === 'delete' ? 'del' : method](`/api/manufacturing${url}`, body);

test.before(async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'مصنع الانحرافات');
  const m = co.manager;
  await h.setupLedger(m, 'food_manufacturing');
  ok((await h.goLive(m, OCT(1))).res);
  const p = {};
  for (const [k, n] of [['a', 'مادة افتتاحية'], ['b', 'مادة مشتراة'], ['mix', 'خلطة اختبار']]) p[k] = await h.mkProduct(m, { name: n });
  // Material A exists only as opening stock (100 @ 2.00): no goods receipt.
  db.prepare('UPDATE products SET cost_price = 2 WHERE id = ?').run(p.a);
  ok(await m.post('/api/factory-inventory', { product_id: p.a, current_quantity: 100 }), 201);
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: OCT(1) }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد', currencyCode: 'USD' }), 201);
  ctx = { co, m, p, supplier };
  await receive(OCT(2), [{ productId: p.b, qty: 50, unitPrice: '3.00' }]);
  ok(await mf('post', '/cost-rates', { kind: 'labour', basis: 'hour', rate: '4.00', effectiveFrom: OCT(1) }), 201);
  const v = ok(await mf('post', '/versions', { productId: p.mix, batchOutputQty: 10, outputKgPerUnit: 1, labourHoursPerBatch: 2, components: [{ productId: p.a, qtyPerBatch: 5 }, { productId: p.b, qtyPerBatch: 3 }] }), 201);
  ok(await mf('post', `/versions/${v.id}/activate`, {}));
});
test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function receive(date, lns) {
  const { m, supplier } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: date, lines: lns }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  return ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: date, lines: lns.map((l, i) => ({ poLineId: s.lines[i].id, qty: l.qty })) }), 201);
}
async function produce(date) {
  const o = ok(await mf('post', '/orders', { productId: ctx.p.mix, batches: 1, plannedDate: date }), 201);
  ok(await mf('post', `/orders/${o.id}/release`, {}));
  ok(await mf('post', `/orders/${o.id}/issue`, { date }));
  ok(await mf('post', `/orders/${o.id}/events`, { kind: 'output', qty: 10 }));
  return o.id;
}
const octReport = async (basis) => ok(await mf('get', `/reports/variances?from=${OCT(1)}&to=${OCT(31)}${basis ? `&basis=${basis}` : ''}`));
const octAnalytics = async () => ok(await ctx.m.get(`/api/analytics/run/cost_variances?from=${OCT(1)}&to=${OCT(31)}`));
const snapshots = (orderId) => db.prepare('SELECT basis, source FROM mfg_order_theoretical_costs WHERE order_id = ? ORDER BY basis').all(orderId).map((r) => ({ ...r }));

test('failure injection: a close that fails after its moves stores no theoretical snapshot (and nothing else)', async () => {
  const id = await produce(OCT(15));
  faults.arm('mfg.close.after_moves');
  const r = await mf('post', `/orders/${id}/close`, { date: OCT(15) });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.deepEqual(snapshots(id), []);
  assert.equal(db.prepare('SELECT status FROM mfg_orders WHERE id = ?').get(id).status, 'in_progress');
  ctx.orderId = id;
});

test('closing stores the theoretical cost for every basis; the closed period report is identical after a later purchase', async () => {
  const { m, p, co } = ctx;
  ok(await mf('post', `/orders/${ctx.orderId}/close`, { date: OCT(15) }));
  assert.deepEqual(snapshots(ctx.orderId), [{ basis: 'average', source: 'close' }, { basis: 'latest', source: 'close' }, { basis: 'standard', source: 'close' }]);
  const before = { latest: await octReport(), average: await octReport('average'), analytics: (await octAnalytics()).rows };
  const row = before.latest[0];
  // A: no receipt by 15 Oct -> stock average 2.00 x 5 = 10.00; B: latest receipt 3.00 x 3 = 9.00.
  assert.equal(row.theoretical_materials_minor, 1900);
  assert.equal(row.actual_materials_minor, 1900);
  assert.equal(row.theoretical_labour_minor, 800);
  assert.equal(row.theoretical_source, 'snapshot');
  // Close October, then buy both materials in November at other prices.
  const oct = db.prepare('SELECT id FROM fiscal_periods WHERE company_id = ? AND start_date = ?').get(co.companyId, OCT(1)).id;
  ok(await m.post(`/api/ledger/periods/${oct}/close`, {}));
  await receive(NOV(5), [{ productId: p.a, qty: 100, unitPrice: '5.00' }, { productId: p.b, qty: 50, unitPrice: '4.00' }]);
  ok(await mf('post', '/cost-rates', { kind: 'labour', basis: 'hour', rate: '9.00', effectiveFrom: NOV(1) }), 201);
  // The live calculation for 15 Oct has moved (that is what the report used to show) ...
  const live = ok(await mf('get', `/versions/${db.prepare('SELECT version_id v FROM mfg_orders WHERE id = ?').get(ctx.orderId).v}/cost?basis=latest&date=${OCT(15)}`));
  assert.notEqual(live.materials_minor, 1900, 'precondition: today the live theoretical cost for 15 Oct differs');
  // ... the closed period's report has not.
  assert.deepEqual(await octReport(), before.latest);
  assert.deepEqual(await octReport('average'), before.average);
  assert.deepEqual((await octAnalytics()).rows, before.analytics);
});

test('an order closed before the snapshot existed falls back to the live calculation, marked as such', async () => {
  const id = await produce(NOV(10));
  ok(await mf('post', `/orders/${id}/close`, { date: NOV(10) }));
  db.prepare('DELETE FROM mfg_order_theoretical_costs WHERE order_id = ?').run(id);
  const rows = ok(await mf('get', `/reports/variances?from=${NOV(1)}&to=${NOV(30)}`));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].theoretical_source, 'live');
});

test('tenant isolation: a snapshot row belongs to the order\'s company', () => {
  const r = db.prepare('SELECT t.company_id, o.company_id oc FROM mfg_order_theoretical_costs t JOIN mfg_orders o ON o.id = t.order_id').all();
  assert.ok(r.length > 0);
  for (const x of r) assert.equal(x.company_id, x.oc);
});
