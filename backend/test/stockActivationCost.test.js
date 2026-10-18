// backend/test/stockActivationCost.test.js
//
// Activation dry run lists every product with stock and a missing / zero
// cost (warehouse + car stock summed) and blocks activation until each is
// fixed or acknowledged with a written reason (audited, >= 10 chars);
// products without stock are not listed; tenant refs; permission.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-stockcost-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
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

test('missing / zero cost blocks activation until fixed or acknowledged with a reason (audited)', async () => {
  const co = await h.createUsdCompany(base, 'شركة تكلفة الافتتاح');
  const m = co.manager;
  await h.setupLedger(m);
  ok((await h.goLive(m, D)).res);
  const mk = async (name, cost) => {
    const id = await h.mkProduct(m, { name });
    db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(cost, id);
    return id;
  };
  const pNone = await mk('بلا تكلفة', null);
  const pZero = await mk('تكلفة صفر', 0);
  const pOk = await mk('تكلفة سليمة', 2);
  const pEmpty = await mk('بلا رصيد وبلا تكلفة', null);
  ok(await m.post('/api/factory-inventory', { product_id: pNone, current_quantity: 5 }), 201);
  ok(await m.post('/api/inventory', { product_id: pNone, current_quantity: 2 }), 201);
  ok(await m.post('/api/factory-inventory', { product_id: pZero, current_quantity: 4 }), 201);
  ok(await m.post('/api/factory-inventory', { product_id: pOk, current_quantity: 10 }), 201);
  ok(await m.post('/api/factory-inventory', { product_id: pEmpty, current_quantity: 0 }), 201);

  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  assert.equal(dry.ok, false);
  assert.deepEqual(dry.cost_issues.map((c) => [c.product_id, c.issue, c.qty, c.acknowledged]), [[pNone, 'missing', 7, null], [pZero, 'zero', 4, null]]);
  assert.deepEqual(dry.problems.filter((p) => p.code === 'cost_missing').map((p) => p.product_id), [pNone, pZero]);
  const refused = await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'cost_missing');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE company_id = ?').get(co.companyId).c, 0);

  // Acknowledgement needs a reason of 10+ characters.
  assert.equal((await m.post('/api/stock/activation/cost-acknowledgements', { productId: pNone, reason: 'عينة' })).body.error, 'reason_required');
  ok(await m.post('/api/stock/activation/cost-acknowledgements', { productId: pNone, reason: 'عينات مجانية من المورد بلا قيمة' }), 201);
  const audit = db.prepare("SELECT actor_id, after_json FROM audit_log WHERE company_id = ? AND action = 'stock.activation.zero_cost_ack' AND entity_id = ?").get(co.companyId, pNone);
  assert.equal(JSON.parse(audit.after_json).reason, 'عينات مجانية من المورد بلا قيمة');
  assert.ok(audit.actor_id);

  // Still blocked by the zero-cost product.
  const dry2 = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  assert.equal(dry2.ok, false);
  assert.equal(dry2.cost_issues.find((c) => c.product_id === pNone).acknowledged.reason, 'عينات مجانية من المورد بلا قيمة');
  assert.equal((await m.post('/api/stock/activation', { dryRunId: dry2.dry_run_id })).body.error, 'cost_missing');

  // Fix the other one by entering its cost.
  db.prepare('UPDATE products SET cost_price = 1.5 WHERE id = ?').run(pZero);
  const dry3 = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  assert.equal(dry3.ok, true, JSON.stringify(dry3.problems));
  assert.deepEqual(dry3.cost_issues.map((c) => c.product_id), [pNone]);
  assert.ok(dry3.warnings.some((w) => w.code === 'cost_acknowledged'));
  const act = ok(await m.post('/api/stock/activation', { dryRunId: dry3.dry_run_id }));
  assert.equal(act.valuation_minor, 600 + 2000);
  const zero = db.prepare("SELECT SUM(qty) q, SUM(value_minor) v FROM stock_moves WHERE company_id = ? AND product_id = ? AND move_type = 'opening'").get(co.companyId, pNone);
  assert.deepEqual([zero.q, zero.v], [7, 0]);
  // After activation no more acknowledgements.
  assert.equal((await m.post('/api/stock/activation/cost-acknowledgements', { productId: pNone, reason: 'سبب طويل بما يكفي' })).status, 409);

  // Tenant refs and permission.
  const other = await h.createUsdCompany(base, 'شركة أخرى للتكلفة');
  assert.equal((await other.manager.post('/api/stock/activation/cost-acknowledgements', { productId: pZero, reason: 'محاولة على مادة شركة أخرى' })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_cost_acknowledgements WHERE company_id = ?').get(other.companyId).c, 0);
  const nobody = await createRep(base, m, { permissions: ['view_app'] });
  assert.equal((await nobody.client.post('/api/stock/activation/cost-acknowledgements', { productId: pOk, reason: 'لا صلاحية لهذا المستخدم' })).status, 403);
});

test('go-live dry run shows the stock mode: legacy, or stock ledger (custody transfers reduce the warehouse)', async () => {
  const co = await h.createUsdCompany(base, 'شركة وضع المخزون');
  const m = co.manager;
  await h.setupLedger(m);
  const legacy = ok(await m.post('/api/sales/go-live/dry-run', { date: D }));
  assert.deepEqual([legacy.stock_mode.mode, legacy.stock_mode.custody_transfer_decrements_warehouse], ['legacy', false]);
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const live = ok(await m.post('/api/sales/go-live/dry-run', { date: D }));
  assert.deepEqual([live.stock_mode.mode, live.stock_mode.custody_transfer_decrements_warehouse], ['stock_ledger', true]);
});
