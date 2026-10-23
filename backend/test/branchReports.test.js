// backend/test/branchReports.test.js
//
// NEXT ACTION item 3: ready reports by branch with two REAL branches
// (companies.branches_json -> branches_ref), then a rename and a disable.
//  - sales by branch, expenses by branch and the trial balance filtered by
//    branch split exactly per branch and add up to the company total;
//  - the ready trial balance by branch == the Prompt 4 trial balance with
//    the same branch filter;
//  - rename = the old branch keeps its history under its old name and id,
//    new documents go to the new one (nothing is merged or lost);
//  - disable = no new document can use the branch, its history stays in the
//    reports with the same totals;
//  - incremental facts == full rebuild after each step; drill rows add up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-branch-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000);

const app = require('../server');
const db = require('../db/init');
const facts = require('../lib/analytics/facts');
const h = require('./salesHelpers');

const Y = h.YEAR;
const D = (m, d) => `${Y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const RANGE = `from=${Y}-01-01&to=${Y}-12-31`;
let listener;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

test.before(async () => {
  listener = app.listen(0);
  const co = await h.createUsdCompany(`http://localhost:${listener.address().port}`, 'شركة الفرعين');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m);
  ok((await h.goLive(m, D(1, 1))).res);
  ok(await m.put('/api/companies/me', { branches: ['دمشق', 'حلب'] }));
  const shop = await h.mkShop(m, 'زبون الفروع');
  ctx = { co, m, cid: co.companyId, shop, acc: (code) => accounts.find((a) => a.code === code).id };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const meta = async () => Object.fromEntries(ok(await ctx.m.get('/api/ledger/meta')).branches.map((b) => [b.name, b]));
async function invoice(branchId, date, amount) {
  const inv = ok(await ctx.m.post('/api/sales/invoices', { shopId: ctx.shop, invoiceDate: date, branchId, lines: [{ description: 'بضاعة', qty: 1, unitPrice: amount }] }), 201);
  ok(await ctx.m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  return inv.id;
}
async function expense(branchId, date, amount) {
  return ok(await ctx.m.post('/api/ledger/entries', { date, description: 'مصروف فرع', post: true, branchId, lines: [{ accountId: ctx.acc('6100'), debit: amount }, { accountId: ctx.acc('1110'), credit: amount }] }), 201);
}
const run = async (key, q = '') => ok(await ctx.m.get(`/api/analytics/run/${key}?${RANGE}${q}`));
const byLabel = (rows, k) => Object.fromEntries(rows.map((r) => [r.label, r[k]]));
function factSnapshot() {
  const out = {};
  for (const t of facts.FACT_TABLES) out[t] = db.prepare(`SELECT * FROM ${t} WHERE company_id = ?`).all(ctx.cid).map((r) => JSON.stringify(r)).sort();
  return out;
}
function assertRebuildEqual(label) {
  facts.refresh(ctx.cid);
  const inc = factSnapshot();
  facts.rebuild(ctx.cid);
  assert.deepEqual(factSnapshot(), inc, `${label}: incremental == rebuild`);
}
async function assertDrillAddsUp(rows) {
  for (const r of rows.filter((x) => x.drill?.kind === 'facts')) {
    const d = ok(await ctx.m.get(`/api/analytics/drill?fact=${r.drill.fact}&filters=${encodeURIComponent(JSON.stringify(r.drill.filters))}`));
    const total = d.rows.reduce((s, x) => s + (x.net_base_minor ?? x.amount_minor ?? 0), 0);
    assert.equal(total, r.net ?? r.amount, `drill of ${r.label}`);
  }
}
// Ready TB by branch vs the Prompt 4 TB with the same filter (period columns).
async function assertTbMatchesPrompt4(branchId) {
  const ready = await run('trial_balance', `&branchId=${branchId}`);
  const p4 = ok(await ctx.m.get(`/api/financial-reports/trial-balance?${RANGE}&branchId=${branchId}`));
  const leaf = p4.rows.filter((r) => !r.is_header && (r.period_debit || r.period_credit));
  assert.equal(ready.totals.period_debit, p4.totals.period_debit);
  assert.equal(ready.totals.period_credit, p4.totals.period_credit);
  const map = (rows) => Object.fromEntries(rows.map((r) => [r.code, [r.period_debit, r.period_credit]]));
  assert.deepEqual(map(ready.rows), map(leaf), `TB branch ${branchId}`);
  return ready;
}

test('two branches: sales, expenses and trial balance split exactly per branch and add up to the company', async () => {
  const b = await meta();
  ctx.dam = b['دمشق'].id;
  ctx.alp = b['حلب'].id;
  await invoice(ctx.dam, D(3, 5), '100.00');
  await invoice(ctx.dam, D(3, 9), '50.00');
  await invoice(ctx.alp, D(3, 7), '70.00');
  await invoice(null, D(3, 8), '5.00');
  await expense(ctx.dam, D(3, 10), '20.00');
  await expense(ctx.alp, D(3, 11), '30.00');
  assertRebuildEqual('two branches');
  const sales = await run('sales_by_branch');
  assert.deepEqual(byLabel(sales.rows, 'net'), { دمشق: 15000, حلب: 7000, '—': 500 });
  assert.equal(sales.totals.net, 22500);
  await assertDrillAddsUp(sales.rows);
  const exp = await run('expense_analysis', '&by=branch');
  assert.deepEqual(byLabel(exp.rows, 'amount'), { دمشق: 2000, حلب: 3000 });
  await assertDrillAddsUp(exp.rows);
  const tbAll = await run('trial_balance');
  const tbDam = await assertTbMatchesPrompt4(ctx.dam);
  const tbAlp = await assertTbMatchesPrompt4(ctx.alp);
  assert.equal(tbDam.totals.period_debit, tbDam.totals.period_credit);
  assert.equal(tbAlp.totals.period_debit, tbAlp.totals.period_credit);
  assert.ok(tbDam.totals.period_debit + tbAlp.totals.period_debit < tbAll.totals.period_debit, 'unbranched entries (go-live, the 5.00 invoice) are only in the unfiltered TB');
  ctx.before = { sales: byLabel(sales.rows, 'net'), exp: byLabel(exp.rows, 'amount') };
});

test('rename حلب -> حلب الجديدة: history stays on the old branch (same id, name, totals); new documents use the new one', async () => {
  ok(await ctx.m.put('/api/companies/me', { branches: ['دمشق', 'حلب الجديدة'] }));
  const b = await meta();
  assert.equal(b['حلب'].id, ctx.alp, 'old branch keeps its id');
  assert.equal(b['حلب'].is_active, 0, 'old branch inactive');
  ctx.alpNew = b['حلب الجديدة'].id;
  assert.notEqual(ctx.alpNew, ctx.alp);
  assert.equal((await ctx.m.post('/api/sales/invoices', { shopId: ctx.shop, invoiceDate: D(4, 2), branchId: ctx.alp, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] })).body.error, 'invalid_branch', 'the renamed-away branch takes no new documents');
  await invoice(ctx.alpNew, D(4, 2), '40.00');
  await expense(ctx.alpNew, D(4, 3), '4.00');
  assertRebuildEqual('after rename');
  const sales = byLabel((await run('sales_by_branch')).rows, 'net');
  assert.deepEqual(sales, { ...ctx.before.sales, 'حلب الجديدة': 4000 });
  assert.deepEqual(byLabel((await run('expense_analysis', '&by=branch')).rows, 'amount'), { ...ctx.before.exp, 'حلب الجديدة': 400 });
  await assertTbMatchesPrompt4(ctx.alp);
  await assertTbMatchesPrompt4(ctx.alpNew);
});

test('disable دمشق: no new document can use it; its history stays in every report with the same totals', async () => {
  ok(await ctx.m.put('/api/companies/me', { branches: ['حلب الجديدة'] }));
  const b = await meta();
  assert.equal(b['دمشق'].is_active, 0);
  assert.equal((await ctx.m.post('/api/sales/invoices', { shopId: ctx.shop, invoiceDate: D(5, 2), branchId: ctx.dam, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] })).body.error, 'invalid_branch');
  assert.equal((await ctx.m.post('/api/ledger/entries', { date: D(5, 2), description: 'x', post: true, branchId: ctx.dam, lines: [{ accountId: ctx.acc('6100'), debit: '1' }, { accountId: ctx.acc('1110'), credit: '1' }] })).body.error, 'invalid_branch');
  assertRebuildEqual('after disable');
  const sales = byLabel((await run('sales_by_branch')).rows, 'net');
  assert.equal(sales['دمشق'], 15000);
  assert.equal(byLabel((await run('expense_analysis', '&by=branch')).rows, 'amount')['دمشق'], 2000);
  await assertTbMatchesPrompt4(ctx.dam);
  // Re-enabling the same name brings back the same id (history continues).
  ok(await ctx.m.put('/api/companies/me', { branches: ['حلب الجديدة', 'دمشق'] }));
  assert.equal((await meta())['دمشق'].id, ctx.dam);
  assert.equal((await meta())['دمشق'].is_active, 1);
});

test('tenant refs: another company\'s branch id is refused as a report filter', async () => {
  const other = await h.createUsdCompany(`http://localhost:${listener.address().port}`, 'شركة أخرى');
  await h.setupLedger(other.manager);
  ok(await other.manager.put('/api/companies/me', { branches: ['حمص'] }));
  const foreign = ok(await other.manager.get('/api/ledger/meta')).branches[0].id;
  const r = await ctx.m.get(`/api/analytics/run/trial_balance?${RANGE}&branchId=${foreign}`);
  assert.equal(r.status, 400, JSON.stringify(r.body));
});
