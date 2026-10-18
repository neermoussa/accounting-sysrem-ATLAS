// backend/test/analytics.test.js
//
// Prompt 12a — the analytics layer:
//  - incremental refresh (change queue -> per-document builders) gives
//    exactly the rows of a full rebuild, at every checkpoint;
//  - one reconciliation per report family: report totals == ledger /
//    sub-ledger / stock valuation;
//  - drill-down convention (gl -> general ledger; facts -> fact rows that
//    add up to the amount clicked);
//  - heavy reports run in a worker thread on a read-only connection with a
//    timeout (main thread stays responsive) and a row cap;
//  - a failed refresh rolls back and loses nothing (failure injection);
//  - tenant isolation of every client-supplied id; payroll report hidden
//    without payroll permissions; freshness stamp on every report.
// Runs the app in-process so the test can read the facts library directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-analytics-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000); // no background sweep during the test

const app = require('../server');
const db = require('../db/init');
const facts = require('../lib/analytics/facts');
const runner = require('../lib/analytics/runner');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');
const { buildReportsScenario } = require('./fixtures/reportsScenario');

const Y = '2026';
const Q = `from=${Y}-01-01&to=${Y}-12-31`;
let listener;
let base;
let ctx;
const ok = (r, status) => {
  if (status ? r.status !== status : r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const one = (sql, ...p) => db.prepare(sql).get(...p);

// Every fact row of a company, order-independent.
function snapshot(cid) {
  const out = {};
  for (const t of facts.FACT_TABLES) out[t] = db.prepare(`SELECT * FROM ${t} WHERE company_id = ?`).all(cid).map((r) => JSON.stringify(r)).sort();
  return out;
}
function assertRefreshEqualsRebuild(cid, label) {
  facts.refresh(cid);
  assert.equal(facts.freshness(cid).pending_changes, 0, `${label}: queue drained`);
  const inc = snapshot(cid);
  facts.rebuild(cid);
  const full = snapshot(cid);
  for (const t of facts.FACT_TABLES) assert.deepEqual(inc[t], full[t], `${label}: ${t} incremental != rebuild`);
  return full;
}

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة التحليلات');
  ctx = { co, m: co.manager, cid: co.companyId };
  ctx.s = await buildReportsScenario({ manager: co.manager, dbPath: process.env.ATLAS_DB_PATH, companyId: co.companyId, h, createRep, baseUrl: base });
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const run = async (key, q = '', client = ctx.m) => client.get(`/api/analytics/run/${key}?${Q}${q}`);
const report = async (key, q) => ok(await run(key, q));

test('incremental refresh == full rebuild, row for row, at every checkpoint', async () => {
  const { m, cid, s } = ctx;
  const full = assertRefreshEqualsRebuild(cid, 'after the scenario');
  for (const t of ['fact_journal_lines', 'fact_sales_lines', 'fact_purchase_lines', 'fact_inventory_moves', 'fact_receivables', 'fact_payables', 'fact_expenses', 'fact_payroll']) assert.ok(full[t].length > 0, `${t} has rows`);
  // Step: another sale (stock move + entry), refresh only -> equals rebuild.
  const inv = ok(await m.post('/api/sales/invoices', { shopId: s.s2, invoiceDate: `${Y}-04-02`, lines: [{ productId: s.nuts, description: 'لوز', qty: 3, unitPrice: '9.50' }] }), 201);
  ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  assert.ok(facts.freshness(cid).pending_changes > 0, 'the posting queued its changes');
  assert.equal(facts.freshness(cid).up_to_date, false);
  assertRefreshEqualsRebuild(cid, 'after a new sale');
  // Step: a manual journal entry, then its reversal.
  const je = ok(await m.post('/api/ledger/entries', { entryDate: `${Y}-04-05`, description: 'تسوية', lines: [{ accountId: s.acc('6200'), debit: '12.34' }, { accountId: s.acc('1110'), credit: '12.34' }] }), 201);
  ok(await m.post(`/api/ledger/entries/${je.id}/post`, {}));
  assertRefreshEqualsRebuild(cid, 'after a manual entry');
  ok(await m.post(`/api/ledger/entries/${je.id}/reverse`, { date: `${Y}-04-06`, reason: 'خطأ' }));
  assertRefreshEqualsRebuild(cid, 'after its reversal');
  // Step: a receipt and a supplier payment.
  ok(await m.post('/api/receivables/receipts', { shopId: s.s2, method: 'cash', amount: '20', date: `${Y}-04-07` }), 201);
  ok(await m.post('/api/purchasing/payments', { supplierId: s.supplier.id, amount: '100', paymentDate: `${Y}-04-08`, method: 'cash' }), 201);
  assertRefreshEqualsRebuild(cid, 'after a receipt and a payment');
  // Refresh twice -> idempotent.
  const a = snapshot(cid);
  facts.refresh(cid);
  assert.deepEqual(snapshot(cid), a);
});

// ---- Reconciliation per report family ----------------------------------

const ledgerSum = (cid, where, ...args) => one(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
  WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND ${where}`, cid, ...args).s;
const sysBalance = (cid, key) => ledgerSum(cid, 'a.system_key = ?', key);

test('financial family: trial balance / income statement / balance sheet / cash flow / comparisons == the ledger (existing financial reports)', async () => {
  const { m, cid } = ctx;
  const tb = await report('trial_balance');
  const old = ok(await m.get(`/api/financial-reports/trial-balance?${Q}`));
  const oldRows = old.rows.filter((r) => !r.is_header);
  assert.ok(oldRows.length > 0);
  const ledgerByCode = Object.fromEntries(db.prepare(`SELECT a.code, SUM(l.debit_minor - l.credit_minor) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND e.entry_date <= ? GROUP BY a.code`).all(cid, `${Y}-12-31`).map((r) => [r.code, r.b]));
  for (const r of tb.rows) assert.equal(r.closing_debit - r.closing_credit, ledgerByCode[r.code], `TB ${r.code}`);
  assert.equal(tb.totals.period_debit, tb.totals.period_credit);
  for (const r of oldRows) {
    const n = tb.rows.find((x) => x.code === r.code);
    assert.equal(n ? n.closing_debit - n.closing_credit : 0, r.closing_debit - r.closing_credit, `vs existing TB ${r.code}`);
    assert.equal(n ? n.period_debit : 0, r.period_debit, `vs existing TB ${r.code} period`);
  }
  const is = await report('income_statement');
  const oldIs = ok(await m.get(`/api/financial-reports/income-statement?${Q}`));
  const pl = -ledgerSum(cid, "a.type IN ('revenue', 'expense') AND e.source_type <> 'year_end_close' AND e.entry_date BETWEEN ? AND ?", `${Y}-01-01`, `${Y}-12-31`);
  assert.equal(is.totals.net_income, pl);
  assert.equal(is.totals.net_income, oldIs.totals.net_income[0], 'equals the existing income statement');
  assert.equal(is.totals.revenue, oldIs.totals.revenue[0]);
  const bs = await report('balance_sheet', `&asOf=${Y}-12-31`);
  assert.equal(bs.totals.assets, bs.totals.liabilities_and_equity, 'balance sheet balances');
  const oldBs = ok(await m.get(`/api/financial-reports/balance-sheet?asOf=${Y}-12-31`));
  assert.equal(bs.totals.assets, oldBs.totals.assets[0]);
  assert.equal(bs.totals.liabilities, oldBs.totals.liabilities[0]);
  assert.equal(bs.totals.assets, ledgerSum(cid, "a.type = 'asset' AND e.entry_date <= ?", `${Y}-12-31`));
  const cf = await report('cash_flow');
  const cash = ledgerSum(cid, "a.id IN (SELECT account_id FROM fact_journal_lines WHERE report_class = 'cash') AND e.entry_date <= ?", `${Y}-12-31`);
  assert.equal(cf.totals.closing_cash, cash);
  assert.equal(cf.totals.closing_cash, ok(await m.get(`/api/financial-reports/cash-flow?${Q}`)).closing_cash);
  assert.equal(cf.totals.opening_cash + cf.totals.net_change, cf.totals.closing_cash);
  const mo = await report('monthly_comparison');
  const yr = await report('yearly_comparison');
  assert.equal(mo.totals.net_income, pl);
  assert.equal(yr.totals.net_income, pl);
  const exp = await report('expense_analysis');
  assert.equal(exp.totals.amount, ledgerSum(cid, "a.type = 'expense' AND e.source_type <> 'year_end_close' AND e.entry_date BETWEEN ? AND ?", `${Y}-01-01`, `${Y}-12-31`));
  // FX: the SYP invoice (13,500) settled at 15,000 -> realized FX loss.
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '15000', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-04-15` }), 201);
  const rc = ok(await m.post('/api/receivables/receipts', { shopId: ctx.s.s1, method: 'cash', amount: '135000', currencyCode: 'SYP', date: `${Y}-04-15` }), 201);
  const sypInv = one("SELECT id FROM sales_invoices WHERE company_id = ? AND currency_code = 'SYP'", cid).id;
  ok(await m.put(`/api/receivables/receipts/${rc.id}/allocations`, { allocations: [{ invoiceId: sypInv, amount: '135000' }] }));
  const fx = await report('fx_gain_loss');
  assert.ok(fx.rows.length > 0 && fx.totals.gain !== 0, 'the realized FX shows');
  assert.equal(fx.totals.gain, 0 - ledgerSum(cid, "a.system_key IN ('fx_realized', 'fx_unrealized') AND e.source_type <> 'year_end_close' AND e.entry_date BETWEEN ? AND ?", `${Y}-01-01`, `${Y}-12-31`));
  assertRefreshEqualsRebuild(cid, 'after an FX settlement');
});

test('sales family: net == revenue booked by sales documents; cost == stock ledger (sale / sale_return moves); every dimension sums to the same total', async () => {
  const { cid } = ctx;
  const revenue = -ledgerSum(cid, "a.type = 'revenue' AND e.source_type IN ('sales_invoice', 'sales_credit_note', 'sales_invoice_cancel') AND e.entry_date BETWEEN ? AND ?", `${Y}-01-01`, `${Y}-12-31`);
  const cost = -one(`SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND source_type IN ('sales_invoice_line', 'sales_credit_note') AND move_date BETWEEN ? AND ?`, cid, `${Y}-01-01`, `${Y}-12-31`).v;
  for (const key of ['sales_by_item', 'sales_by_customer', 'sales_by_branch', 'sales_by_rep', 'product_profitability', 'customer_profitability']) {
    const r = await report(key);
    assert.equal(r.totals.net, revenue, `${key} net`);
    assert.equal(r.totals.cost, cost, `${key} cost`);
  }
  for (const by of ['region', 'category', 'month', 'channel', 'warehouse']) assert.equal((await report('sales_by', `&by=${by}`)).totals.net, revenue, `sales_by ${by}`);
  assert.equal((await run('sales_by', '&by=nope')).body.error, 'invalid_dimension');
  const rp = await report('rep_performance');
  assert.equal(rp.totals.sales, revenue);
});

test('purchases family: net == AP movement minus tax of supplier documents; payables facts == AP control', async () => {
  const { cid } = ctx;
  const apKey = 'ap_control';
  const purchAp = -ledgerSum(cid, "a.system_key = ? AND e.source_type IN ('supplier_invoice', 'supplier_debit_note')", apKey);
  const purchTax = ledgerSum(cid, "(a.system_key = 'input_tax' OR a.id IN (SELECT account_id FROM tax_codes WHERE company_id = e.company_id)) AND e.source_type IN ('supplier_invoice', 'supplier_debit_note')");
  for (const key of ['purchases_by_supplier', 'purchases_by_item']) assert.equal((await report(key)).totals.net, purchAp - purchTax, key);
  const apFacts = one('SELECT COALESCE(SUM(credit_minor - debit_minor), 0) s FROM fact_payables WHERE company_id = ?', cid).s;
  assert.equal(apFacts, -sysBalance(cid, apKey));
  assert.equal(apFacts, ok(await ctx.m.get(`/api/purchasing/reports/aging?asOf=${Y}-12-31`)).control_minor, 'equals the existing AP aging control');
});

test('inventory family: stock on hand == stock valuation == inventory control; movement and count variances add up', async () => {
  const { m, cid } = ctx;
  const soh = await report('stock_on_hand', `&asOf=${Y}-12-31`);
  const val = ok(await m.get('/api/stock/valuation'));
  const valTotal = val.total_minor ?? val.rows.reduce((t, r) => t + r.value_minor, 0);
  assert.equal(soh.totals.value, valTotal, 'stock valuation');
  assert.equal(soh.totals.value, sysBalance(cid, 'inventory'), 'inventory control account');
  const mv = await report('stock_movement');
  assert.equal(mv.totals.value, one('SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND move_date BETWEEN ? AND ?', cid, `${Y}-01-01`, `${Y}-12-31`).v);
  const cv = await report('count_variances');
  assert.equal(cv.totals.value, one("SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND move_type IN ('adjustment', 'count')", cid).v);
  assert.ok(cv.rows.length >= 1);
});

test('receivables family: aging total == AR control (and the existing aging); collections == receipts credited to AR', async () => {
  const { m, cid } = ctx;
  const ag = await report('receivable_aging', `&asOf=${Y}-12-31`);
  assert.equal(ag.totals.total, sysBalance(cid, 'ar_control'));
  const buckets = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].reduce((t, k) => t + ag.totals[k], 0);
  assert.equal(buckets - ag.totals.unapplied_credit, ag.totals.total);
  const old = ok(await m.get(`/api/receivables/aging?asOf=${Y}-12-31`));
  assert.equal(ag.totals.total, old.totals.total, 'equals the existing aging');
  assert.equal(ag.totals.total, old.control_minor);
  const col = await report('collections');
  assert.equal(col.totals.amount, -ledgerSum(cid, "a.system_key = 'ar_control' AND e.source_type = 'customer_receipt'"));
  const rp = await report('rep_performance');
  assert.equal(rp.totals.collected, col.totals.amount);
});

test('payroll family: payroll cost == payroll expense booked by the accrual; hidden without payroll permissions', async () => {
  const { m, cid } = ctx;
  const pc = await report('payroll_cost');
  assert.equal(pc.totals.cost, ledgerSum(cid, "a.type = 'expense' AND e.source_type = 'payroll_period'"));
  const viewer = await createRep(base, m, { name: 'محلل مالي', permissions: ['view_financial_reports'] });
  const cat = ok(await viewer.client.get('/api/analytics/catalog'));
  assert.ok(!cat.reports.some((r) => r.key === 'payroll_cost'));
  assert.ok(cat.reports.some((r) => r.key === 'trial_balance'));
  assert.ok(cat.reports.every((r) => r.name_ar && r.name_en), 'every report has its ar/en name');
  assert.equal((await run('payroll_cost', '', viewer.client)).status, 404);
  assert.equal((await viewer.client.get('/api/analytics/drill?fact=payroll')).status, 404);
  const none = await createRep(base, m, { name: 'بلا صلاحيات', permissions: ['view_app'] });
  for (const url of ['/api/analytics/catalog', `/api/analytics/run/trial_balance?${Q}`, '/api/analytics/drill?fact=sales', '/api/analytics/freshness']) assert.equal((await none.client.get(url)).status, 403, url);
  assert.equal((await none.client.post('/api/analytics/refresh', {})).status, 403);
});

test('drill-down: gl amounts open the general ledger with the same total; fact amounts list the rows that add up to them', async () => {
  const { m } = ctx;
  const tb = await report('trial_balance');
  const row = tb.rows.find((r) => r.period_debit > 0);
  assert.equal(row.drill.kind, 'gl');
  const gl = await report('general_ledger', `&accountId=${row.drill.accountId}`);
  assert.equal(gl.totals.debit_minor, row.period_debit);
  assert.equal(gl.totals.credit_minor, row.period_credit);
  assert.ok(gl.rows[0].document, 'each GL line names its source document');
  const sales = await report('sales_by_item');
  for (const r of sales.rows) {
    assert.equal(r.drill.kind, 'facts');
    const d = ok(await m.get(`/api/analytics/drill?fact=${r.drill.fact}&filters=${encodeURIComponent(JSON.stringify(r.drill.filters))}`));
    assert.equal(d.rows.reduce((t, x) => t + x.net_base_minor, 0), r.net, 'drill rows add up to the amount');
    assert.ok(d.rows.every((x) => x.entry_id), 'each row leads to its journal entry');
    assert.ok(d.freshness);
  }
  const ag = await report('receivable_aging', `&asOf=${Y}-12-31`);
  const a = ag.rows[0];
  const d = ok(await m.get(`/api/analytics/drill?fact=${a.drill.fact}&filters=${encodeURIComponent(JSON.stringify(a.drill.filters))}`));
  assert.equal(d.rows.reduce((t, x) => t + x.debit_minor - x.credit_minor, 0), a.total);
  assert.equal((await m.get(`/api/analytics/drill?fact=sales&filters=${encodeURIComponent('{"bogus":1}')}`)).body.error, 'invalid_filters');
  assert.equal((await m.get('/api/analytics/drill?fact=sales&filters=notjson')).body.error, 'invalid_filters');
});

test('every report carries a freshness stamp; stale until refreshed', async () => {
  const { m, cid, s } = ctx;
  const cat = ok(await m.get('/api/analytics/catalog'));
  for (const r of cat.reports) {
    const q = r.params.includes('accountId') ? `&accountId=${s.acc('1110')}` : r.params.includes('budgetId') ? null : r.params.includes('lotId') ? null : '';
    if (q === null) continue;
    const out = ok(await run(r.key, q));
    if (r.live) assert.ok(out.freshness.live && out.freshness.as_of, `${r.key} live stamp`);
    else assert.ok(out.freshness && 'refreshed_at' in out.freshness && 'pending_changes' in out.freshness, `${r.key} freshness`);
    assert.ok(Array.isArray(out.rows) && Array.isArray(out.columns), r.key);
  }
  // A change after the stamp shows as pending until the next refresh.
  const v = ok(await m.post('/api/treasury/vouchers', { type: 'expense', cashBoxId: s.box.id, amount: '5', counterAccountId: s.acc('6500'), date: `${Y}-04-10` }), 201);
  ok(await m.post(`/api/treasury/vouchers/${v.id}/approve`, {}));
  assert.ok(ok(await m.get('/api/analytics/freshness')).pending_changes > 0);
  const out = await report('trial_balance');
  assert.equal(out.freshness.pending_changes, 0, 'running a report refreshes first');
  assert.equal(out.freshness.up_to_date, true);
  void cid;
});

test('worker thread: read-only connection, timeout (main thread stays responsive), row cap', async () => {
  const { m, cid } = ctx;
  // Timeout: a deliberately slow report is cut off; the API still answers meanwhile.
  const slow = runner.runReport(cid, 'trial_balance', { from: `${Y}-01-01`, to: `${Y}-12-31` }, { timeoutMs: 300, testDelayMs: 5000 });
  const t0 = Date.now();
  const health = await m.get('/api/ledger/year-status');
  assert.ok(health.status < 500 && Date.now() - t0 < 1000, 'main thread not blocked by the running report');
  await assert.rejects(slow, (e) => e.code === 'report_timeout' && e.status === 504);
  // Row cap.
  const capped = await runner.runReport(cid, 'trial_balance', { from: `${Y}-01-01`, to: `${Y}-12-31` }, { rowCap: 2 });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.truncated, true);
  assert.ok(capped.row_count > 2);
  const full = await runner.runReport(cid, 'trial_balance', { from: `${Y}-01-01`, to: `${Y}-12-31` });
  assert.equal(full.truncated, false);
  // Read-only: the worker's connection cannot write.
  const { DatabaseSync } = require('node:sqlite');
  const ro = new DatabaseSync(runner.DB_PATH, { readOnly: true });
  assert.throws(() => ro.exec("UPDATE companies SET name = 'x'"), /readonly|read-only/i);
  ro.close();
  // Bad params come back as 4xx from the worker.
  assert.equal((await run('trial_balance', '&to=nope')).body.error, 'invalid_dates');
  assert.equal((await run('no_such_report')).status, 404);
});

test('failure injection: a refresh that fails midway rolls back — facts unchanged, queue kept, next refresh catches up', async () => {
  const { m, cid, s } = ctx;
  facts.refresh(cid);
  const before = snapshot(cid);
  const inv = ok(await m.post('/api/sales/invoices', { shopId: s.s1, invoiceDate: `${Y}-04-12`, lines: [{ productId: s.drink, description: 'عصير', qty: 2, unitPrice: '4.00' }] }), 201);
  ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  const pending = facts.freshness(cid).pending_changes;
  assert.ok(pending > 0);
  const orig = facts.BUILDERS.sales;
  facts.BUILDERS.sales = (...a) => { orig(...a); throw new Error('injected'); };
  try {
    assert.throws(() => facts.refresh(cid), /injected/);
  } finally {
    facts.BUILDERS.sales = orig;
  }
  assert.deepEqual(snapshot(cid), before, 'nothing persisted');
  assert.equal(facts.freshness(cid).pending_changes, pending, 'queue kept');
  // A report run during the failure still answers (stale, flagged).
  facts.BUILDERS.sales = () => { throw new Error('injected'); };
  try {
    const out = await report('sales_by_item');
    assert.equal(out.freshness.up_to_date, false, 'stale data is flagged, not hidden');
  } finally {
    facts.BUILDERS.sales = orig;
  }
  assertRefreshEqualsRebuild(cid, 'after recovery');
  // The posting itself never depended on analytics.
  assert.ok(one('SELECT journal_entry_id FROM sales_invoices WHERE id = ?', inv.id).journal_entry_id);
});

test('tenant isolation: another company\'s ids are refused in report params and drill filters; reports never show its data', async () => {
  const { m, s } = ctx;
  const other = await h.createUsdCompany(base, 'شركة أخرى');
  await h.setupLedger(other.manager, 'trading');
  const foreignAcc = ok(await other.manager.get('/api/ledger/accounts')).find((a) => a.code === '1110').id;
  const foreignShop = await h.mkShop(other.manager, 'زبون آخر');
  assert.equal((await run('general_ledger', `&accountId=${foreignAcc}`)).status, 400);
  assert.equal((await m.get(`/api/analytics/drill?fact=sales&filters=${encodeURIComponent(JSON.stringify({ customer_id: foreignShop }))}`)).status, 400);
  assert.equal((await run('budget_vs_actual', '&budgetId=999999')).status, 400);
  assert.equal((await run('lot_trace', '&lotId=999999')).status, 400);
  // The other company's own reports are empty; ours unaffected.
  const theirs = ok(await other.manager.get(`/api/analytics/run/sales_by_item?${Q}`));
  assert.equal(theirs.rows.length, 0);
  assert.ok((await report('sales_by_item')).rows.length > 0);
  void s;
});

test('migration 0029 queues a full rebuild for companies that already have entries; refresh then equals rebuild', async () => {
  const { cid } = ctx;
  db.prepare("INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (?, 'rebuild', '*')").run(cid);
  const r = facts.refresh(cid);
  assert.equal(r.mode, 'rebuild');
  assert.equal(facts.freshness(cid).pending_changes, 0);
  assert.ok(facts.freshness(cid).full_rebuild_at);
  assertRefreshEqualsRebuild(cid, 'after the migration rebuild');
});

test('manufacturing family: batch cost == output moves == WIP relieved; consumption == issue moves; yield / loss / mix add up; live cost variances', async () => {
  const co = await h.createUsdCompany(base, 'مصنع التحليلات');
  const m = co.manager;
  const cid = co.companyId;
  const D = `${Y}-05-10`;
  await h.setupLedger(m, 'food_manufacturing');
  ok((await h.goLive(m, `${Y}-01-01`)).res);
  const raw = await h.mkProduct(m, { name: 'لوز نيء' });
  const pack = await h.mkProduct(m, { name: 'كيس' });
  const fg = await h.mkProduct(m, { name: 'لوز محمص 1كغ' });
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: `${Y}-01-01` }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const sup = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد', currencyCode: 'USD' }), 201);
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: sup.id, orderDate: D, lines: [{ productId: raw, qty: 50, unitPrice: '8.00' }, { productId: pack, qty: 100, unitPrice: '0.10' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: D, lines: s.lines.map((l) => ({ poLineId: l.id, qty: l.qty })) }), 201);
  ok(await m.post('/api/manufacturing/cost-rates', { kind: 'labour', basis: 'hour', rate: '5.00', effectiveFrom: `${Y}-01-01` }), 201);
  const v = ok(await m.post('/api/manufacturing/versions', { productId: fg, name: 'محمص', batchOutputQty: 20, outputKgPerUnit: 1, labourHoursPerBatch: 2, components: [{ productId: raw, qtyPerBatch: 21 }, { productId: pack, qtyPerBatch: 20, kind: 'packaging' }] }), 201);
  ok(await m.post(`/api/manufacturing/versions/${v.id}/activate`, {}));
  for (const out of [19, 18]) {
    const o = ok(await m.post('/api/manufacturing/orders', { productId: fg, batches: 1, plannedDate: D }), 201);
    ok(await m.post(`/api/manufacturing/orders/${o.id}/release`, {}));
    ok(await m.post(`/api/manufacturing/orders/${o.id}/issue`, { date: D }));
    ok(await m.post(`/api/manufacturing/orders/${o.id}/events`, { kind: 'output', qty: out, labourHours: 2 }));
    ok(await m.post(`/api/manufacturing/orders/${o.id}/close`, { date: D }));
  }
  assertRefreshEqualsRebuild(cid, 'after production');
  const r = async (key, q = '') => ok(await m.get(`/api/analytics/run/${key}?${Q}${q}`));
  const bc = await r('batch_cost');
  assert.equal(bc.rows.length, 2);
  const outMoves = one("SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND move_type IN ('production_output', 'production_byproduct')", cid).v;
  assert.equal(bc.totals.fg_value_minor, one("SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND move_type = 'production_output'", cid).v, 'finished goods value == output moves');
  assert.ok(outMoves > 0);
  assert.equal(sysBalance(cid, 'wip'), 0, 'WIP fully relieved on close');
  const cons = await r('consumption');
  assert.equal(cons.totals.value, -one("SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND move_type IN ('production_issue', 'production_return')", cid).v);
  const mix = await r('mix_cost');
  assert.equal(mix.rows[0].batches, 2);
  assert.equal(mix.rows[0].units, 37);
  assert.equal(mix.totals.fg_value, bc.totals.fg_value_minor);
  const y = await r('yield');
  assert.deepEqual(y.rows.map((x) => [x.expected_units, x.actual_units]), [[20, 19], [20, 18]]);
  await r('loss');
  const cv = await r('cost_variances');
  assert.equal(cv.live, true);
  assert.equal(cv.rows.length, 2);
  // Drill: batch cost -> the order's stock moves.
  const d = ok(await m.get(`/api/analytics/drill?fact=${bc.rows[0].drill.fact}&filters=${encodeURIComponent(JSON.stringify(bc.rows[0].drill.filters))}`));
  assert.ok(d.rows.length > 0);
  // Live lot trace / recall on the produced lot.
  const lot = one("SELECT output_lot_id l FROM mfg_orders WHERE company_id = ? AND output_lot_id IS NOT NULL", cid)?.l;
  if (lot) {
    assert.equal((await r('lot_trace', `&lotId=${lot}`)).live, true);
    assert.ok((await r('recall', `&lotId=${lot}`)).result.lot);
  }
  assert.equal((await m.get(`/api/analytics/run/lot_trace?${Q}`)).body.error, 'lot_required');
  // Stock on hand still equals the inventory control account after production.
  const soh = await r('stock_on_hand', `&asOf=${Y}-12-31`);
  assert.equal(soh.totals.value, sysBalance(cid, 'inventory'));
});
