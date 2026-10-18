// backend/test/manufacturing.test.js
//
// Prompt 9 "Done when":
//  - the premium-mix example reproduces the hand calculation to the minor
//    unit (theoretical and actual cost, cost per kilo, margin, entries);
//  - a version used in an order cannot be edited (copy -> new version);
//  - MRP flags shortages (multi-level: an intermediate is produced, its
//    components purchased) and raises a purchase request;
//  - wastage (abnormal loss, rejected batch) and by-products post to the
//    correct accounts;
//  - lot trace works both ways (supplier lot -> mix lot -> customers;
//    customer -> mix lot -> component lots -> supplier);
//  - allergen sequencing warns on violation (override needs a reason).
// Plus: FEFO issue, effective-dated rates, QC (pass / fail / quarantine),
// returns, offline sync from the workshop tablet (idempotent), COA,
// failure injection on every money path, tenant refs, permissions.
//
// Hand calculation (1 batch = 100 bags of 1 kg; gross = net / (1 - loss)):
//   almonds    30 kg, loss 1.5% + 2.5% = 4%  -> 31.250 kg x 9.40  = 293.75
//   cashews    25 kg, loss 1% + 1%     = 2%  -> 25.510 kg x 11.20 = 285.71 (285.712)
//   pistachios 20 kg, loss 2% + 1%     = 3%  -> 20.619 kg x 14.75 = 304.13 (304.13025)
//   hazelnuts  15 kg, loss 1%+3%+1%    = 5%  -> 15.789 kg x 8.60  = 135.79 (135.7854)
//   raisins    10 kg, loss 1%                -> 10.101 kg x 3.30  =  33.33 (33.3333)
//   materials 1,052.71; packs 100 x 0.18 = 18.00; labels 100 x 0.04 = 4.00
//   labour 6 h x 4.50 = 27.00; energy 100 kg x 0.12 = 12.00; overhead 6 h x 3.00 = 18.00
//   by-product broken nuts 1.2 kg x 2.00 = -2.40
//   theoretical total 1,129.31 -> 11.29 per kg; at 18.00 margin 6.71 (37.28%)
// Actual: same issue cost (stock average = purchase price) 1,074.71,
//   output 98 bags, 6.5 h -> labour 29.25, energy 98 x 0.12 = 11.76, overhead 19.50
//   total 1,135.22, by-product -2.40 -> 1,132.82; abnormal loss 2 of 100 -> 22.66 (22.6564)
//   finished goods 1,110.16 -> 11.33 per kg; margin at 18.00: 6.67 (37.06%)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mfg-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const S = require('../lib/stockLedger');
const faults = require('../lib/faultInjection');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const D = new Date().toISOString().slice(0, 10);
const YEAR_START = `${D.slice(0, 4)}-01-01`;
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let listener;
let base;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const lines = (entryId) => db.prepare('SELECT a.code, a.system_key k, l.debit_minor d, l.credit_minor c, l.memo FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId).map((x) => ({ ...x }));
const net = (ls, key) => ls.filter((l) => l.k === key).reduce((s, l) => s + l.d - l.c, 0);
const accBalance = (cid, key) => db.prepare('SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND a.system_key = ?').get(cid, key).b;
function assertReconciled(label) {
  const r = S.reconcile(ctx.co.companyId);
  assert.equal(r.difference_minor, 0, `${label}: ${JSON.stringify(r)}`);
  assert.deepEqual(r.qty_mismatches, [], label);
}

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'مصنع المكسرات');
  const m = co.manager;
  await h.setupLedger(m, 'food_manufacturing');
  ok((await h.goLive(m, D)).res);
  const mk = (name) => h.mkProduct(m, { name });
  const p = {};
  for (const [k, n] of [['almonds', 'لوز نيء'], ['cashews', 'كاجو نيء'], ['pistachios', 'فستق حلبي'], ['hazelnuts', 'بندق'], ['raisins', 'زبيب'], ['pack', 'كيس 1كغ'], ['label', 'ملصق'], ['mix', 'خلطة مكسرات فاخرة 1كغ'], ['broken', 'مكسرات مكسورة'], ['peanutMix', 'خلطة فول سوداني بالشوكولا'], ['base', 'قاعدة مكسرات محمصة'], ['family', 'خلطة العائلة']]) p[k] = await mk(n);
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  for (const k of ['almonds', 'cashews', 'pistachios', 'hazelnuts', 'raisins']) ok(await m.put(`/api/stock/products/${p[k]}/settings`, { trackLots: true }));
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد المكسرات', currencyCode: 'USD' }), 201);
  const shop1 = await h.mkShop(m, 'سوبرماركت النور');
  const shop2 = await h.mkShop(m, 'بقالة الأمل');
  const shop3 = await h.mkShop(m, 'زبون لم يشترِ الخلطة');
  ctx = { co, m, p, supplier, shop1, shop2, shop3, wh: S.warehouseHolder(co.companyId, null) };
});
test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function receive(lns) {
  const { m, supplier } = ctx;
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: D, lines: lns.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice })) }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  return ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: D, lines: lns.map((l, i) => ({ poLineId: s.lines[i].id, qty: l.qty, ...(l.lot || {}) })) }), 201);
}
const verb = (m) => (m === 'delete' ? 'del' : m);
const mf = (method, url, body) => ctx.m[verb(method)](`/api/manufacturing${url}`, body);

test('setup: purchases with supplier lots, cost rates (effective-dated), allergens, food template accounts adopted', async () => {
  const { p, m } = ctx;
  await receive([
    { productId: p.almonds, qty: 20, unitPrice: '9.40', lot: { lotCode: 'ALM-LATE', expiryDate: addDays(200), supplierLot: 'SUP-ALM-1' } },
    { productId: p.almonds, qty: 20, unitPrice: '9.40', lot: { lotCode: 'ALM-EARLY', expiryDate: addDays(90), supplierLot: 'SUP-ALM-2' } },
    { productId: p.cashews, qty: 30, unitPrice: '11.20', lot: { lotCode: 'CSH-1', expiryDate: addDays(150), supplierLot: 'SUP-CSH' } },
    { productId: p.pistachios, qty: 25, unitPrice: '14.75', lot: { lotCode: 'PST-1', expiryDate: addDays(150), supplierLot: 'SUP-PST' } },
    { productId: p.hazelnuts, qty: 20, unitPrice: '8.60', lot: { lotCode: 'HZL-1', expiryDate: addDays(120), supplierLot: 'SUP-HZL' } },
    { productId: p.raisins, qty: 15, unitPrice: '3.30', lot: { lotCode: 'RSN-1', expiryDate: addDays(100), supplierLot: 'SUP-RSN' } },
    { productId: p.pack, qty: 120, unitPrice: '0.18' },
    { productId: p.label, qty: 120, unitPrice: '0.04' },
  ]);
  for (const b of [
    { kind: 'labour', basis: 'hour', rate: '4.50', effectiveFrom: YEAR_START },
    { kind: 'labour', basis: 'hour', rate: '5.00', effectiveFrom: addDays(1) }, // future: not used today
    { kind: 'energy', basis: 'kg', rate: '0.12', effectiveFrom: YEAR_START },
    { kind: 'overhead', basis: 'hour', rate: '3.00', effectiveFrom: YEAR_START },
    { kind: 'byproduct', productId: p.broken, rate: '2.00', effectiveFrom: YEAR_START },
  ]) ok(await mf('post', '/cost-rates', b), 201);
  assert.equal((await mf('post', '/cost-rates', { kind: 'labour', basis: 'hour', rate: '4.60', effectiveFrom: YEAR_START })).body.error, 'rate_exists');
  assert.equal((await mf('post', '/cost-rates', { kind: 'overhead', basis: 'unit', rate: '1', effectiveFrom: YEAR_START })).body.error, 'invalid_basis');
  for (const k of ['almonds', 'cashews', 'pistachios', 'hazelnuts']) ok(await mf('put', `/products/${p[k]}/allergens`, { contains: ['tree_nuts'] }));
  ok(await mf('put', `/products/${p.peanutMix}/allergens`, { contains: ['peanuts', 'milk', 'tree_nuts'] }));
  assert.equal((await mf('put', `/products/${p.raisins}/allergens`, { contains: ['nuts'] })).body.error, 'invalid_allergen');
  // Food template: WIP 1152, labour 5300, overhead 5400 tagged; energy 5450.
  const codes = Object.fromEntries(db.prepare("SELECT system_key, code FROM accounts WHERE company_id = ? AND system_key IN ('wip', 'production_labour', 'production_overhead', 'production_energy')").all(ctx.co.companyId).map((r) => [r.system_key, r.code]));
  assert.deepEqual(codes, { wip: '1152', production_labour: '5300', production_overhead: '5400', production_energy: '5450' });
  void m;
});

test('premium nuts mix: theoretical cost reproduces the hand calculation to the minor unit', async () => {
  const { p } = ctx;
  const v = ok(await mf('post', '/versions', {
    productId: p.mix, name: 'خلطة فاخرة', batchOutputQty: 100, outputKgPerUnit: 1, labourHoursPerBatch: 6, shelfLifeDays: 180,
    components: [
      { productId: p.almonds, qtyPerBatch: 30, losses: [{ stage: 'sorting', lossPct: 1.5 }, { stage: 'roasting', lossPct: 2.5 }] },
      { productId: p.cashews, qtyPerBatch: 25, losses: [{ stage: 'sorting', lossPct: 1 }, { stage: 'roasting', lossPct: 1 }] },
      { productId: p.pistachios, qtyPerBatch: 20, losses: [{ stage: 'sorting', lossPct: 2 }, { stage: 'roasting', lossPct: 1 }] },
      { productId: p.hazelnuts, qtyPerBatch: 15, losses: [{ stage: 'sorting', lossPct: 1 }, { stage: 'roasting', lossPct: 3 }, { stage: 'mixing', lossPct: 1 }] },
      { productId: p.raisins, qtyPerBatch: 10, losses: [{ stage: 'sorting', lossPct: 1 }] },
      { productId: p.pack, qtyPerBatch: 100, kind: 'packaging' },
      { productId: p.label, qtyPerBatch: 100, kind: 'label' },
    ],
    outputs: [{ productId: p.broken, qtyPerBatch: 1.2, kind: 'byproduct' }],
  }), 201);
  ok(await mf('post', `/versions/${v.id}/activate`, {}));
  ctx.v1 = v.id;
  const c = ok(await mf('get', `/versions/${v.id}/cost?basis=latest&sellingPrice=18&date=${D}`));
  assert.deepEqual(c.lines.map((l) => [l.gross_qty, l.loss_pct, l.unit_minor, l.amount_minor]), [
    [31.25, 4, 940, 29375], [25.51, 2, 1120, 28571], [20.619, 3, 1475, 30413], [15.789, 5, 860, 13579], [10.101, 1, 330, 3333], [100, 0, 18, 1800], [100, 0, 4, 400],
  ]);
  assert.equal(c.materials_minor, 105271);
  assert.equal(c.packaging_minor, 2200);
  assert.deepEqual([c.labour.amount_minor, c.energy.amount_minor, c.overhead.amount_minor, c.byproduct_credit_minor], [2700, 1200, 1800, 240]);
  assert.equal(c.labour.rate_minor, 450, 'the future 5.00 rate is not in effect yet');
  assert.equal(c.total_minor, 112931);
  assert.deepEqual([c.cost_per_unit_minor, c.cost_per_kg_minor, c.margin_minor, c.margin_pct], [1129, 1129, 671, 37.28]);
  // Before the rates' effective date: labour / energy / overhead missing.
  const early = ok(await mf('get', `/versions/${v.id}/cost?date=${Number(D.slice(0, 4)) - 1}-12-31`));
  assert.equal(early.labour.missing, true);
  // Label declaration from the components' allergens.
  const label = ok(await mf('get', `/products/${p.mix}/label`));
  assert.deepEqual(label.contains, ['tree_nuts']);
  assert.match(label.declaration_ar, /يحتوي على: المكسرات/);
  assert.equal(label.barcode_path, `/api/products/${p.mix}/barcode`);
});

test('production order: version locked, FEFO issue (Dr WIP / Cr inventory), output, wastage, by-product, QC, close posts exactly the hand-calculated entry', async () => {
  const { p, co } = ctx;
  const cid = co.companyId;
  ok(await ctx.m.post('/api/manufacturing/qc-checks', { productId: p.mix, name: 'الرطوبة', kind: 'range', minValue: 0, maxValue: 5, unit: '%' }), 201);
  const o = ok(await mf('post', '/orders', { productId: p.mix, batches: 1, plannedDate: D }), 201);
  ctx.order = o.id;
  assert.deepEqual(o.materials.map((x) => x.required_qty), [31.25, 25.51, 20.619, 15.789, 10.101, 100, 100]);
  // Used in an order -> immutable; a copy is a new editable version.
  const edit = await mf('put', `/versions/${ctx.v1}`, { batchOutputQty: 50, components: [{ productId: p.almonds, qtyPerBatch: 1 }] });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.error, 'version_locked');
  const v2 = ok(await mf('post', `/versions/${ctx.v1}/copy`, {}), 201);
  assert.equal(v2.version_no, 2);
  assert.equal(v2.locked_at, null);
  ok(await mf('put', `/versions/${v2.id}`, { batchOutputQty: 100, components: v2.components.map((x) => ({ productId: x.product_id, kind: x.kind, qtyPerBatch: x.qty_per_batch, losses: x.losses.map((l) => ({ stage: l.stage, lossPct: l.loss_bp / 100 })) })), outputs: [{ productId: p.broken, qtyPerBatch: 1 }] }));
  ok(await mf('post', `/orders/${o.id}/release`, {}));
  // Issue everything: almonds FEFO -> the earlier-expiry lot first.
  const issued = ok(await mf('post', `/orders/${o.id}/issue`, { date: D }));
  const alm = issued.events.filter((e) => e.kind === 'issue' && e.product_id === p.almonds).map((e) => [e.lot_code, e.qty, e.value_minor]);
  assert.deepEqual(alm, [['ALM-EARLY', 20, 18800], ['ALM-LATE', 11.25, 10575]]);
  const issueEntry = db.prepare("SELECT journal_entry_id j FROM stock_moves WHERE source_type = 'mfg_order' AND source_id = ? AND move_type = 'production_issue' LIMIT 1").get(o.id).j;
  const ie = lines(issueEntry);
  assert.deepEqual([net(ie, 'wip'), net(ie, 'inventory')], [107471, -107471]);
  // Output, wastage per stage, by-product, labour hours (some from the tablet path below).
  ok(await mf('post', `/orders/${o.id}/events`, { kind: 'output', qty: 60 }));
  ok(await mf('post', `/orders/${o.id}/events`, { kind: 'output', qty: 38, labourHours: 6.5 }));
  ok(await mf('post', `/orders/${o.id}/events`, { kind: 'wastage', qty: 1.5, stage: 'sorting', productId: p.almonds }));
  assert.equal((await mf('post', `/orders/${o.id}/events`, { kind: 'wastage', qty: 1 })).body.error, 'stage_required');
  ok(await mf('post', `/orders/${o.id}/events`, { kind: 'byproduct', qty: 1.2, productId: p.broken }));
  // QC pending -> close refused; record -> passed.
  assert.equal((await mf('post', `/orders/${o.id}/close`, { date: D })).body.error, 'qc_pending');
  const chk = db.prepare('SELECT id FROM mfg_qc_checks WHERE product_id = ?').get(p.mix).id;
  const qc = ok(await mf('post', `/orders/${o.id}/qc`, { results: [{ checkId: chk, value: 3.2 }] }));
  assert.equal(qc.qc_status, 'passed');
  const closed = ok(await mf('post', `/orders/${o.id}/close`, { date: D }));
  const c = closed.cost;
  assert.deepEqual([c.materials_minor, c.labour.amount_minor, c.energy.amount_minor, c.overhead.amount_minor, c.total_minor, c.byproduct_credit_minor, c.net_minor], [107471, 2925, 1176, 1950, 113522, 240, 113282]);
  assert.deepEqual([c.abnormal_loss_qty, c.abnormal_loss_minor, c.fg_value_minor, c.cost_per_unit_minor, c.cost_per_kg_minor, c.yield_pct], [2, 2266, 111016, 1133, 1133, 98]);
  // The one closing entry, line by line.
  const e = lines(closed.journal_entry_id);
  assert.deepEqual(e.map((l) => [l.code, l.d, l.c]), [
    ['1153', 111016, 0], // finished goods (inventory) at cost
    ['1153', 240, 0], // by-product into stock at its value
    ['5500', 2266, 0], // abnormal loss -> wastage
    ['1152', 0, 107471], // WIP cleared
    ['5300', 0, 2925], // labour absorbed
    ['5450', 0, 1176], // energy absorbed
    ['5400', 0, 1950], // overhead absorbed
  ]);
  // The 2.40 between (actual 1,135.22 - abnormal loss 22.66) = 1,112.56 and
  // finished goods 1,110.16 is the by-product credit (1.2 kg broken nuts x
  // 2.00), received into stock as its own line — not a residue.
  assert.equal(c.total_minor - c.abnormal_loss_minor - c.fg_value_minor, 240);
  assert.equal(c.byproduct_credit_minor, 240);
  assert.deepEqual(c.byproducts.map((b) => [b.product_id, b.qty, b.rate_minor, b.amount_minor]), [[p.broken, 1.2, 200, 240]]);
  assert.deepEqual(e[1], { code: '1153', k: 'inventory', d: 240, c: 0, memo: 'منتج ثانوي' });
  assert.equal(e.reduce((s, l) => s + l.d, 0), e.reduce((s, l) => s + l.c, 0));
  assert.equal(accBalance(cid, 'wip'), 0, 'WIP cleared');
  // Output lot: order number, production date, expiry = date + 180 days.
  assert.equal(closed.output_lot.lot_code, closed.order_number);
  assert.equal(closed.output_lot.expiry_date, new Date(Date.parse(`${D}T00:00:00Z`) + 180 * 86400000).toISOString().slice(0, 10));
  assert.deepEqual([S.poolRow(cid, p.mix, ctx.wh.id).qty, S.poolRow(cid, p.mix, ctx.wh.id).value_minor], [98, 111016]);
  assert.deepEqual([S.poolRow(cid, p.broken, ctx.wh.id).qty, S.poolRow(cid, p.broken, ctx.wh.id).value_minor], [1.2, 240]);
  // Cost lines record the effective rate rows used (Prompt 16).
  const rates = db.prepare("SELECT kind, rate_minor, rate_id FROM mfg_order_costs WHERE order_id = ? AND kind IN ('labour', 'energy', 'overhead') ORDER BY kind").all(o.id).map((x) => [x.kind, x.rate_minor, Boolean(x.rate_id)]);
  assert.deepEqual(rates, [['energy', 12, true], ['labour', 450, true], ['overhead', 300, true]]);
  // A used rate cannot be deleted.
  const usedRate = db.prepare("SELECT rate_id FROM mfg_order_costs WHERE order_id = ? AND kind = 'labour'").get(o.id).rate_id;
  assert.equal((await mf('delete', `/cost-rates/${usedRate}`)).body.error, 'rate_used');
  // Margin at a selling price of 18.00 per bag.
  assert.equal(1800 - c.cost_per_unit_minor, 667);
  assert.equal(Math.round(((1800 - c.cost_per_unit_minor) / 1800) * 10000) / 100, 37.06);
  // COA from the document template system.
  const coa = await ctx.m.get(`/api/manufacturing/orders/${o.id}/coa?format=json`);
  assert.equal(coa.status, 200);
  assert.equal(coa.body.lotCode, closed.order_number);
  assert.deepEqual(coa.body.checks.map((x) => [x.name, x.result, x.passed]), [['الرطوبة', '3.2 %', 1]]);
  assertReconciled('after close');
});

test('lot trace both ways: supplier almond lot -> mix lot -> every customer; customer -> mix lot -> component lots -> suppliers', async () => {
  const { p, shop1, shop2, shop3, m } = ctx;
  for (const [shop, qty] of [[shop1, 10], [shop2, 5]]) {
    const inv = ok(await m.post('/api/sales/invoices', { shopId: shop, invoiceDate: D, lines: [{ productId: p.mix, qty, unitPrice: '18' }] }), 201);
    ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  }
  const almEarly = db.prepare("SELECT id FROM stock_lots WHERE lot_code = 'ALM-EARLY'").get().id;
  const recall = ok(await m.get(`/api/stock/lots/${almEarly}/recall`));
  const got = recall.customers.map((c) => c.shop_id).sort();
  assert.deepEqual(got, [shop1, shop2].sort(), 'both customers of the mix are recalled through the almond lot');
  assert.ok(!got.includes(shop3));
  const mixLot = db.prepare('SELECT output_lot_id l FROM mfg_orders WHERE id = ?').get(ctx.order).l;
  assert.equal(recall.productions[0].output_lot_id, mixLot);
  assert.deepEqual(recall.customers.find((c) => c.shop_id === shop1).via_lots, [db.prepare('SELECT lot_code FROM stock_lots WHERE id = ?').get(mixLot).lot_code]);
  // Reverse: the customer's mix lot -> the component lots and their suppliers.
  const rev = ok(await m.get(`/api/stock/trace/reverse?shopId=${shop1}`));
  assert.equal(rev.length, 1);
  assert.equal(rev[0].lot_id, mixLot);
  const comps = rev[0].made_from.components.map((x) => [x.lot_code, x.supplier_lot]).sort();
  assert.deepEqual(comps, [['ALM-EARLY', 'SUP-ALM-2'], ['ALM-LATE', 'SUP-ALM-1'], ['CSH-1', 'SUP-CSH'], ['HZL-1', 'SUP-HZL'], ['PST-1', 'SUP-PST'], ['RSN-1', 'SUP-RSN']]);
  assert.ok(rev[0].made_from.components.every((x) => x.supplier_name === 'مورد المكسرات'));
  const made = ok(await m.get(`/api/manufacturing/lots/${mixLot}/made-from`));
  assert.equal(made.order_id, ctx.order);
});

test('allergen sequencing warns on violation; sanitation step or reordering fixes it; override needs a reason (audited)', async () => {
  const { p } = ctx;
  ok(await mf('post', '/versions', { productId: p.peanutMix, batchOutputQty: 50, components: [{ productId: p.raisins, qtyPerBatch: 5 }] }), 201).id;
  const pv = db.prepare('SELECT v.id FROM mfg_recipe_versions v JOIN mfg_recipes r ON r.id = v.recipe_id WHERE r.product_id = ?').get(p.peanutMix).id;
  ok(await mf('post', `/versions/${pv}/activate`, {}));
  // Peanut/milk mix, then the tree-nut mix with no sanitation in between.
  const bad = ok(await mf('post', '/plans', { planDate: D, lines: [{ productId: p.peanutMix, qty: 50 }, { productId: p.mix, qty: 100 }] }), 201);
  assert.equal(bad.sequence.ok, false);
  assert.deepEqual(bad.sequence.warnings.map((w) => [w.product_id, w.carried.sort()]), [[p.mix, ['milk', 'peanuts']]]);
  assert.deepEqual(bad.sequence.suggested_order, ['خلطة مكسرات فاخرة 1كغ', 'خلطة فول سوداني بالشوكولا']);
  const refused = await mf('post', `/plans/${bad.id}/confirm`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'allergen_sequence_violation');
  const over = ok(await mf('post', `/plans/${bad.id}/confirm`, { overrideReason: 'خط منفصل مخصص للفول السوداني اليوم' }));
  assert.equal(over.status, 'confirmed');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'mfg.plan.confirm_override' AND entity_id = ?").get(bad.id));
  // With a sanitation step: no warning. Reordered (allergen-free first): no warning.
  const san = ok(await mf('post', '/plans', { planDate: D, lines: [{ productId: p.peanutMix, qty: 50 }, { kind: 'sanitation' }, { productId: p.mix, qty: 100 }] }), 201);
  assert.equal(san.sequence.ok, true);
  const good = ok(await mf('post', '/plans', { planDate: D, lines: [{ productId: p.mix, qty: 100 }, { productId: p.peanutMix, qty: 50 }] }), 201);
  assert.equal(good.sequence.ok, true);
  ok(await mf('post', `/plans/${good.id}/confirm`, {}));
});

test('MRP flags shortages over several levels (intermediate produced, its components purchased) and raises a purchase request', async () => {
  const { p } = ctx;
  // Intermediate nut base (almonds + cashews), used by the family mix with raisins.
  const vb = ok(await mf('post', '/versions', { productId: p.base, batchOutputQty: 50, components: [{ productId: p.almonds, qtyPerBatch: 30 }, { productId: p.cashews, qtyPerBatch: 20 }] }), 201);
  ok(await mf('post', `/versions/${vb.id}/activate`, {}));
  const vf = ok(await mf('post', '/versions', { productId: p.family, batchOutputQty: 100, components: [{ productId: p.base, qtyPerBatch: 80 }, { productId: p.raisins, qtyPerBatch: 20 }] }), 201);
  ok(await mf('post', `/versions/${vf.id}/activate`, {}));
  const plan = ok(await mf('post', '/plans', { planDate: D, lines: [{ productId: p.family, qty: 100 }] }), 201);
  const r = ok(await mf('get', `/plans/${plan.id}/mrp`));
  const row = (pid) => r.rows.find((x) => x.product_id === pid);
  // Level 1: 80 kg base (none in stock -> produce), 20 kg raisins (4.899 left -> purchase 15.101).
  assert.deepEqual([row(p.base).required, row(p.base).available, row(p.base).shortfall, row(p.base).source, row(p.base).level], [80, 0, 80, 'produce', 1]);
  assert.deepEqual([row(p.raisins).required, row(p.raisins).available, row(p.raisins).shortfall, row(p.raisins).source], [20, 4.899, 15.101, 'purchase']);
  // Level 2: 80 kg base = 1.6 batches -> almonds 48, cashews 32 (stock 8.75 / 4.49).
  assert.deepEqual([row(p.almonds).required, row(p.almonds).available, row(p.almonds).shortfall, row(p.almonds).source, row(p.almonds).level], [48, 8.75, 39.25, 'purchase', 2]);
  assert.deepEqual([row(p.cashews).required, row(p.cashews).shortfall], [32, 27.51]);
  assert.equal(r.shortages, 4);
  const pr = ok(await mf('post', `/plans/${plan.id}/purchase-request`, {}), 201);
  assert.deepEqual(pr.lines.map((l) => [l.product_id, l.qty]).sort((a, b) => a[0] - b[0]), [[p.almonds, 39.25], [p.cashews, 27.51], [p.raisins, 15.101]].sort((a, b) => a[0] - b[0]));
  // Releasing an order the stock cannot cover is refused.
  const o = ok(await mf('post', '/orders', { productId: p.base, batches: 2 }), 201);
  const rel = await mf('post', `/orders/${o.id}/release`, {});
  assert.equal(rel.status, 409);
  assert.equal(rel.body.error, 'materials_short');
  ok(await mf('post', `/orders/${o.id}/cancel`, { reason: 'نقص مواد' }));
});

test('MRP nets open purchase orders (by expected date) and open requests; no duplicate request; optional sales reservations; multi-level intact', async () => {
  const { p, m, supplier } = ctx;
  const plan = db.prepare("SELECT p.id, p.plan_date FROM mfg_plans p JOIN mfg_plan_lines l ON l.plan_id = p.id WHERE l.product_id = ? ORDER BY p.id DESC LIMIT 1").get(p.family);
  const row = (r, pid) => r.rows.find((x) => x.product_id === pid);
  // Run twice: the request from the previous test already covers every purchase shortfall.
  const again = ok(await mf('get', `/plans/${plan.id}/mrp`));
  assert.deepEqual([row(again, p.raisins).shortfall, row(again, p.raisins).requested, row(again, p.raisins).to_request], [15.101, 15.101, 0]);
  assert.equal(again.purchase_lines.length, 0);
  const dup = await mf('post', `/plans/${plan.id}/purchase-request`, {});
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'no_shortage');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM purchase_requests WHERE company_id = ? AND notes LIKE '%' || ? || '%'").get(ctx.co.companyId, db.prepare('SELECT plan_number FROM mfg_plans WHERE id = ?').get(plan.id).plan_number).c, 1, 'one request per shortage');
  // A PO in transit due by the plan date reduces the shortage; one due later does not.
  const po = async (productId, qty, expectedDate) => {
    const x = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: D, expectedDate, lines: [{ productId, qty, unitPrice: '1' }] }), 201);
    ok(await m.post(`/api/purchasing/orders/${x.id}/submit`, {}));
    ok(await m.post(`/api/purchasing/orders/${x.id}/approve`, {}));
  };
  await po(p.raisins, 10, plan.plan_date);
  await po(p.raisins, 3, addDays(30));
  await po(p.almonds, 20, plan.plan_date);
  const r = ok(await mf('get', `/plans/${plan.id}/mrp`));
  assert.deepEqual([row(r, p.raisins).on_order_due, row(r, p.raisins).on_order_late, row(r, p.raisins).shortfall], [10, 3, 5.101]);
  // Multi-level still correct: base produced (80), almonds 48 - 8.75 stock - 20 on order = 19.25.
  assert.deepEqual([row(r, p.base).shortfall, row(r, p.base).source, row(r, p.base).level], [80, 'produce', 1]);
  assert.deepEqual([row(r, p.almonds).required, row(r, p.almonds).on_order_due, row(r, p.almonds).shortfall, row(r, p.almonds).level], [48, 20, 19.25, 2]);
  assert.equal(r.purchase_lines.length, 0, 'open requests (39.25 almonds, 15.101 raisins) exceed the remaining shortfalls');
  // Sales reservations as demand: off by default, per company.
  assert.equal(ok(await mf('get', '/settings')).include_sales_reservations, false);
  ok(await m.post(`/api/shops/${ctx.shop3}/orders`, { order_date: D, total_value: 50, items: [{ product_id: p.raisins, product_name: 'زبيب', qty: 30 }] }), 201);
  assert.equal(row(ok(await mf('get', `/plans/${plan.id}/mrp`)), p.raisins).sales_reserved, 0);
  ok(await mf('put', '/settings', { includeSalesReservations: true }));
  const withSales = ok(await mf('get', `/plans/${plan.id}/mrp`));
  const rs = row(withSales, p.raisins);
  assert.deepEqual([rs.sales_reserved, rs.available, rs.shortfall], [30, 0, 10]);
  assert.deepEqual(withSales.purchase_lines.map((l) => [l.product_id, l.to_request]), [], 'still within the open request (15.101)');
  ok(await mf('put', '/settings', { includeSalesReservations: false }));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'mfg.mrp.settings'").get());
});

test('rejected batch writes everything off to inventory_wastage; returns go back at issued cost; QC failure needs reject or quarantine', async () => {
  const { p, co } = ctx;
  const cid = co.companyId;
  await receive([{ productId: p.raisins, qty: 30, unitPrice: '3.30', lot: { lotCode: 'RSN-2', expiryDate: addDays(300) } }]);
  const vb = db.prepare('SELECT v.id FROM mfg_recipe_versions v JOIN mfg_recipes r ON r.id = v.recipe_id WHERE r.product_id = ? AND v.status = \'active\'').get(p.peanutMix).id;
  void vb;
  // Peanut mix order: 1 batch needs 5.051 kg raisins (5 / 0.99? no loss -> 5).
  const o = ok(await mf('post', '/orders', { productId: p.peanutMix, batches: 2 }), 201);
  ok(await mf('post', `/orders/${o.id}/release`, {}));
  const iss = ok(await mf('post', `/orders/${o.id}/issue`, { date: D }));
  const issuedValue = iss.materials[0].issued_value_minor;
  assert.equal(iss.materials[0].issued_qty, 10);
  // Return 2 kg at issued cost (Dr inventory / Cr WIP).
  const ret = ok(await mf('post', `/orders/${o.id}/return`, { date: D, lines: [{ productId: p.raisins, qty: 2 }] }));
  assert.equal(ret.materials[0].returned_value_minor, Math.round((issuedValue * 2) / 10));
  assert.equal((await mf('post', `/orders/${o.id}/return`, { lines: [{ productId: p.raisins, qty: 50 }] })).body.error, 'invalid_qty');
  ok(await mf('post', `/orders/${o.id}/events`, { kind: 'output', qty: 90, labourHours: 1 }));
  ok(await mf('post', '/qc-checks', { productId: p.peanutMix, name: 'خلو من الأجسام الغريبة', kind: 'pass_fail' }), 201);
  // A check defined AFTER the order was released still applies: QC pending, close refused.
  assert.equal(ok(await mf('get', `/orders/${o.id}`)).qc_status, 'pending');
  assert.equal((await mf('post', `/orders/${o.id}/close`, { date: D })).body.error, 'qc_pending');
  const chk = db.prepare('SELECT id FROM mfg_qc_checks WHERE product_id = ?').get(p.peanutMix).id;
  const qc = ok(await mf('post', `/orders/${o.id}/qc`, { results: [{ checkId: chk, passed: false, notes: 'شوائب' }] }));
  assert.equal(qc.qc_status, 'failed');
  assert.equal((await mf('post', `/orders/${o.id}/close`, { date: D })).body.error, 'qc_failed');
  const wipBefore = accBalance(cid, 'wip');
  const rej = ok(await mf('post', `/orders/${o.id}/reject`, { reason: 'شوائب في الدفعة', date: D }));
  assert.equal(rej.status, 'rejected');
  const e = lines(rej.journal_entry_id);
  const materials = issuedValue - ret.materials[0].returned_value_minor;
  assert.equal(net(e, 'wip'), -materials);
  assert.equal(net(e, 'production_labour'), -450, '1 h x 4.50');
  assert.equal(net(e, 'inventory_wastage'), materials + 450 + rej.cost.energy.amount_minor + rej.cost.overhead.amount_minor);
  assert.equal(accBalance(cid, 'wip'), wipBefore - materials);
  assert.equal(S.poolRow(cid, p.peanutMix, ctx.wh.id).qty, 0, 'nothing received');
  assertReconciled('after reject');
});

test('workshop tablet: issue / output / wastage through offline sync, idempotent on replay', async () => {
  const { p, co } = ctx;
  const worker = await createRep(base, ctx.m, { name: 'عامل الورشة', permissions: ['view_app', 'record_production', 'view_manufacturing'] });
  const o = ok(await mf('post', '/orders', { productId: p.peanutMix, batches: 1 }), 201);
  ok(await mf('post', `/orders/${o.id}/release`, {}));
  const ops = [
    { clientId: 'tab1', idempotencyKey: 'tab-issue-1', entityType: 'production_issue', operation: 'create', payload: { orderId: o.id, productId: p.raisins, qty: 5, clientKey: 'tab-issue-1' } },
    { clientId: 'tab1', idempotencyKey: 'tab-out-1', entityType: 'production_output', operation: 'create', payload: { orderId: o.id, qty: 48, clientKey: 'tab-out-1' } },
    { clientId: 'tab1', idempotencyKey: 'tab-waste-1', entityType: 'production_wastage', operation: 'create', payload: { orderId: o.id, qty: 0.3, stage: 'mixing', clientKey: 'tab-waste-1' } },
  ];
  const r1 = ok(await worker.client.post('/api/sync/batch', { operations: ops }), 201);
  assert.ok(JSON.stringify(r1).includes('applied'), JSON.stringify(r1));
  ok(await worker.client.post('/api/sync/batch', { operations: ops }), 201); // replay
  const after = ok(await mf('get', `/orders/${o.id}`));
  assert.deepEqual([after.materials[0].issued_qty, after.output_qty, after.wastage_qty, after.status], [5, 48, 0.3, 'in_progress']);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE source_type = 'mfg_order' AND source_id = ? AND move_type = 'production_issue'").get(o.id).c, 1);
  // Without record_production the tablet operations are refused.
  const viewer = await createRep(base, ctx.m, { permissions: ['view_app'] });
  const r2 = ok(await viewer.client.post('/api/sync/batch', { operations: [{ ...ops[1], idempotencyKey: 'v-out', payload: { orderId: o.id, qty: 1 } }] }), 201);
  assert.ok(JSON.stringify(r2).includes('forbidden'));
  ctx.tabletOrder = o.id;
  void co;
});

test('failure injection: issue, return, close and reject roll back completely', async () => {
  const { p, co } = ctx;
  const cid = co.companyId;
  const snapshot = () => [
    db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE company_id = ?').get(cid).c,
    db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?').get(cid).c,
    db.prepare('SELECT COUNT(*) c FROM mfg_order_events WHERE company_id = ?').get(cid).c,
    accBalance(cid, 'wip'),
  ];
  const o = ok(await mf('post', '/orders', { productId: p.peanutMix, batches: 1 }), 201);
  ok(await mf('post', `/orders/${o.id}/release`, {}));
  for (const [point, call] of [
    ['mfg.issue.after_moves', () => mf('post', `/orders/${o.id}/issue`, { date: D })],
  ]) {
    const before = snapshot();
    faults.arm(point);
    assert.equal((await call()).status, 500, point);
    faults.disarmAll();
    assert.deepEqual(snapshot(), before, `${point}: rolled back`);
  }
  ok(await mf('post', `/orders/${o.id}/issue`, { date: D }));
  ok(await mf('post', `/orders/${o.id}/events`, { kind: 'output', qty: 50 }));
  const chk = db.prepare('SELECT id FROM mfg_qc_checks WHERE product_id = ?').get(p.peanutMix).id;
  assert.equal(ok(await mf('post', `/orders/${o.id}/qc`, { results: [{ checkId: chk, passed: true }] })).qc_status, 'passed');
  for (const [point, call] of [
    ['mfg.return.after_moves', () => mf('post', `/orders/${o.id}/return`, { lines: [{ productId: p.raisins, qty: 1 }] })],
    ['mfg.close.after_moves', () => mf('post', `/orders/${o.id}/close`, { date: D })],
    ['mfg.reject.after_entry', () => mf('post', `/orders/${o.id}/reject`, { reason: 'اختبار الفشل', date: D })],
  ]) {
    const before = snapshot();
    const order = db.prepare('SELECT status, output_lot_id FROM mfg_orders WHERE id = ?').get(o.id);
    faults.arm(point);
    assert.equal((await call()).status, 500, point);
    faults.disarmAll();
    assert.deepEqual(snapshot(), before, `${point}: rolled back`);
    assert.deepEqual({ ...db.prepare('SELECT status, output_lot_id FROM mfg_orders WHERE id = ?').get(o.id) }, { ...order });
  }
  ok(await mf('post', `/orders/${o.id}/close`, { date: D, lotCode: 'PNT-001' }));
  assertReconciled('after failure injection');
});

test('reports: batch cost, yield, wastage, consumption, variances, profitability incl. production cost', async () => {
  const { p } = ctx;
  const bc = ok(await mf('get', '/reports/batch-cost'));
  const mixRow = bc.find((r) => r.order_id === ctx.order);
  assert.deepEqual([mixRow.fg_value_minor, mixRow.cost_per_kg_minor, mixRow.abnormal_loss_minor], [111016, 1133, 2266]);
  const y = ok(await mf('get', '/reports/yield'));
  assert.deepEqual(y.find((r) => r.order_number === mixRow.order_number) && [y.find((r) => r.order_number === mixRow.order_number).yield_pct, y.find((r) => r.order_number === mixRow.order_number).wastage_qty], [98, 1.5]);
  const w = ok(await mf('get', '/reports/wastage'));
  assert.ok(w.some((r) => r.stage === 'sorting' && r.qty === 1.5));
  const cons = ok(await mf('get', '/reports/consumption'));
  assert.ok(cons.find((r) => r.product_name === 'لوز نيء').qty >= 31.25);
  const v = ok(await mf('get', '/reports/variances'));
  const mv = v.find((r) => r.order_number === mixRow.order_number);
  assert.deepEqual([mv.theoretical_materials_minor, mv.actual_materials_minor, mv.materials_variance_minor, mv.actual_labour_minor - mv.theoretical_labour_minor], [107471, 107471, 0, 225]);
  const prof = ok(await mf('get', '/reports/profitability'));
  const mixProf = prof.by_product.find((r) => r.product_id === p.mix);
  assert.equal(mixProf.produced, true);
  assert.equal(mixProf.revenue_minor, 15 * 1800);
  assert.equal(mixProf.cost_minor, Math.round((111016 * 10) / 98) + Math.round(((111016 - Math.round((111016 * 10) / 98)) * 5) / 88));
  assert.ok(prof.by_customer.some((r) => r.shop_id === ctx.shop1 && r.margin_minor > 0));
  assert.equal((await mf('get', '/reports/nope')).status, 404);
});

test('production order from a production request: linked one-to-one, second order refused, cancel frees the request, closed request refused', async () => {
  const { p, m, shop3 } = ctx;
  const before = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM production_requests').get().m;
  // A sales order larger than the mix in stock raises a production request (existing behaviour).
  ok(await m.post(`/api/shops/${shop3}/orders`, { order_date: D, total_value: 100, items: [{ product_id: p.mix, product_name: 'خلطة', qty: 200 }] }), 201);
  const pr = db.prepare('SELECT * FROM production_requests WHERE id > ? AND product_id = ?').get(before, p.mix);
  assert.ok(pr, 'production request raised');
  const short = pr.shortage_qty;
  const o = ok(await mf('post', `/orders/from-request/${pr.id}`, {}), 201);
  assert.equal(o.production_request_id, pr.id);
  assert.equal(o.batches, Math.ceil((short / 100) * 1000) / 1000);
  assert.equal(o.product_id, p.mix);
  assert.equal(db.prepare('SELECT status FROM production_requests WHERE id = ?').get(pr.id).status, 'in_production');
  const second = await mf('post', `/orders/from-request/${pr.id}`, {});
  assert.equal(second.status, 409);
  assert.deepEqual([second.body.error, second.body.order_id], ['request_already_ordered', o.id]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mfg_order_requests WHERE production_request_id = ?').get(pr.id).c, 1);
  // Cancelling the order frees the request; a new order can then be raised.
  ok(await mf('post', `/orders/${o.id}/cancel`, { reason: 'تغيير الخطة' }));
  assert.equal(db.prepare('SELECT status FROM production_requests WHERE id = ?').get(pr.id).status, 'pending_processing');
  const o2 = ok(await mf('post', `/orders/from-request/${pr.id}`, { batches: 0.5 }), 201);
  assert.equal(o2.batches, 0.5);
  assert.equal(o2.production_request_id, pr.id);
  ctx.prodReq = pr.id;
  // Unknown / closed requests.
  assert.equal((await mf('post', '/orders/from-request/999999', {})).body.error, 'invalid_production_request');
  ok(await m.put(`/api/production/requests/${pr.id}/status`, { status: 'cancelled' }));
  ok(await mf('post', `/orders/${o2.id}/cancel`, { reason: 'إلغاء الطلب' }));
  assert.equal((await mf('post', `/orders/from-request/${pr.id}`, {})).body.error, 'request_closed');
});

test('tenant refs and permissions', async () => {
  const other = await h.createUsdCompany(base, 'شركة أخرى للتصنيع');
  const om = other.manager;
  await h.setupLedger(om);
  ok((await h.goLive(om, D)).res);
  const dry = ok(await om.post('/api/stock/activation/dry-run', { date: D }));
  ok(await om.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const { p } = ctx;
  const omf = (method, url, body) => om[verb(method)](`/api/manufacturing${url}`, body);
  const rateId = db.prepare('SELECT id FROM mfg_cost_rates WHERE company_id = ? LIMIT 1').get(ctx.co.companyId).id;
  const planId = db.prepare('SELECT id FROM mfg_plans WHERE company_id = ? LIMIT 1').get(ctx.co.companyId).id;
  const chk = db.prepare('SELECT id FROM mfg_qc_checks WHERE company_id = ? LIMIT 1').get(ctx.co.companyId).id;
  const mixLot = db.prepare('SELECT output_lot_id l FROM mfg_orders WHERE id = ?').get(ctx.order).l;
  for (const [method, url, body] of [
    ['post', '/versions', { productId: p.mix, batchOutputQty: 1, components: [{ productId: p.almonds, qtyPerBatch: 1 }] }],
    ['get', `/versions/${ctx.v1}`],
    ['put', `/versions/${ctx.v1}`, { batchOutputQty: 1, components: [] }],
    ['post', `/versions/${ctx.v1}/copy`, {}],
    ['get', `/versions/${ctx.v1}/cost`],
    ['put', `/products/${p.mix}/allergens`, { contains: ['milk'] }],
    ['get', `/products/${p.mix}/label`],
    ['post', '/cost-rates', { kind: 'material', productId: p.almonds, rate: '1', effectiveFrom: D }],
    ['delete', `/cost-rates/${rateId}`],
    ['put', `/qc-checks/${chk}`, { name: 'x' }],
    ['get', `/plans/${planId}`],
    ['get', `/plans/${planId}/mrp`],
    ['post', '/orders', { productId: p.mix, batches: 1 }],
    ['get', `/orders/${ctx.order}`],
    ['post', `/orders/${ctx.order}/issue`, {}],
    ['post', `/orders/${ctx.tabletOrder}/events`, { kind: 'output', qty: 1 }],
    ['post', `/orders/${ctx.tabletOrder}/close`, {}],
    ['get', `/orders/${ctx.order}/coa?format=json`],
    ['get', `/lots/${mixLot}/made-from`],
    ['post', `/orders/from-request/${ctx.prodReq}`, {}],
  ]) {
    const r = await omf(method, url, body);
    assert.equal(r.status, 400, `${method} ${url}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mfg_orders WHERE company_id = ?').get(other.companyId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE company_id = ?').get(other.companyId).c, 0);
  // Permissions.
  const nobody = await createRep(base, ctx.m, { permissions: ['view_app'] });
  for (const [method, url] of [['get', '/recipes'], ['post', '/versions'], ['post', '/orders'], ['post', `/orders/${ctx.tabletOrder}/issue`], ['post', '/cost-rates'], ['post', '/plans']]) {
    assert.equal((await nobody.client[method](`/api/manufacturing${url}`, {})).status, 403, url);
  }
  const worker = await createRep(base, ctx.m, { permissions: ['view_app', 'record_production', 'view_manufacturing'] });
  assert.equal((await worker.client.post(`/api/manufacturing/orders/${ctx.tabletOrder}/close`, {})).status, 403, 'a workshop user cannot close / cost an order');
  assert.equal((await worker.client.post('/api/manufacturing/cost-rates', {})).status, 403);
});
