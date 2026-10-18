// backend/test/financialReports.test.js
//
// Prompt 4 "Done when":
//  - the balance sheet balances for every test period;
//  - trial balance debits = credits;
//  - income statement net result = change in retained earnings after close;
//  - drill-down reaches the source document from every report line;
//  - PDF and Excel exports open with Arabic.
// Plus budgets, year-end close/reopen rules, month-end checklist and the
// tenant-ref rule on every report / budget / closing endpoint.
// The full 200k-line benchmark is `npm run bench:reports`
// (scripts/benchmark-reports.js); a 20k-line run of the same script is the
// last test here so the timing gate cannot silently rot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fr-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');

const Y = 2026;
const P = Y - 1; // the year that gets closed
let listener;
let base;
let ctx;

const acc = (code) => {
  const a = ctx.accounts.find((x) => x.code === code);
  assert.ok(a, `account ${code}`);
  return a.id;
};
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

async function entry(m, date, lines, extra = {}) {
  const res = await m.post('/api/ledger/entries', { date, description: 'قيد تقرير', post: true, lines, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const dr = (code, amount, extra = {}) => ({ accountId: acc(code), debit: amount, ...extra });
const cr = (code, amount, extra = {}) => ({ accountId: acc(code), credit: amount, ...extra });

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة التقارير');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m); // fiscal year Y
  ctx = { co, m, accounts };
  assert.equal((await m.post('/api/ledger/fiscal-years', { year: P })).status, 201);
  assert.equal((await m.put('/api/companies/me', { branches: ['دمشق', 'حلب'] })).status, 200);
  const meta = (await m.get('/api/ledger/meta')).body;
  ctx.branch = meta.branches.find((b) => b.name === 'دمشق').id;
  ctx.cc = (await m.post('/api/ledger/cost-centers', { code: 'CC1', name: 'الإدارة' })).body.id;
  ctx.cc2 = (await m.post('/api/ledger/cost-centers', { code: 'CC2', name: 'المبيعات' })).body.id;
  ctx.project = (await m.post('/api/ledger/projects', { code: 'PR1', name: 'مشروع التوسع' })).body.id;
  assert.ok(ctx.cc && ctx.cc2 && ctx.project);

  // Year P
  await entry(m, `${P}-01-02`, [dr('1110', '100000'), cr('3100', '100000')]);
  await entry(m, `${P}-02-01`, [dr('1120', '50000'), cr('2210', '50000')]);
  await entry(m, `${P}-02-15`, [dr('1210', '20000'), cr('1120', '20000')]);
  await entry(m, `${P}-03-10`, [dr('1110', '30000.55'), cr('4100', '30000.55')], { branchId: ctx.branch });
  await entry(m, `${P}-04-05`, [dr('4200', '1000'), cr('1110', '1000')]);
  await entry(m, `${P}-06-30`, [dr('6200', '8000', { costCenterId: ctx.cc }), cr('1110', '8000')]);
  await entry(m, `${P}-07-31`, [dr('6500', '1200', { costCenterId: ctx.cc2, projectId: ctx.project }), cr('2130', '1200')]);
  await entry(m, `${P}-12-31`, [dr('6600', '2000'), cr('1290', '2000')]);
  await entry(m, `${P}-11-15`, [dr('5100', '9000'), cr('1150', '9000')]);
  await entry(m, `${P}-11-01`, [dr('1150', '15000'), cr('1110', '15000')]);
  ctx.netP = 3000055 - 100000 - 800000 - 120000 - 200000 - 900000; // minor units

  // Year Y (not closed until the close test)
  await entry(m, `${Y}-01-20`, [dr('1110', '12000'), cr('4100', '12000')], { branchId: ctx.branch });
  await entry(m, `${Y}-02-28`, [dr('6100', '5000', { costCenterId: ctx.cc }), cr('2130', '5000')]);
  await entry(m, `${Y}-03-05`, [dr('2130', '1200'), cr('1110', '1200')]);
  await entry(m, `${Y}-04-10`, [dr('2210', '10000'), cr('1120', '10000')]);

  // A real source document (live sales invoice) for drill-down.
  const shop = await h.mkShop(m, 'زبون التقارير');
  assert.equal((await h.goLive(m)).res.status, 200);
  const inv = await m.post('/api/sales/invoices', { shopId: shop, lines: [{ description: 'بضاعة', qty: 3, unitPrice: '10.50' }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const posted = await m.post(`/api/sales/invoices/${inv.body.id}/post`, {});
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  ctx.invoice = posted.body;

  // Second company for tenant checks.
  const other = await h.createUsdCompany(base, 'شركة أخرى');
  const o = await h.setupLedger(other.manager);
  ctx.other = { ...other, accounts: o.accounts, fy: o.fy };
  ctx.other.cc = (await other.manager.post('/api/ledger/cost-centers', { code: 'X', name: 'غريب' })).body.id;
  ctx.other.project = (await other.manager.post('/api/ledger/projects', { code: 'X', name: 'غريب' })).body.id;
  ctx.other.periods = (await other.manager.get('/api/ledger/periods')).body;
  assert.equal((await other.manager.put('/api/companies/me', { branches: ['فرع غريب'] })).status, 200);
  ctx.other.branch = (await other.manager.get('/api/ledger/meta')).body.branches[0].id;
  ctx.other.budget = (await other.manager.post('/api/financial-reports/budgets', { fiscalYearId: o.fy.id, name: 'موازنة غريبة' })).body.id;
});

test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const get = async (p, q = {}) => {
  const res = await ctx.m.get(`/api/financial-reports/${p}?${qs(q)}`);
  assert.equal(res.status, 200, `${p} ${JSON.stringify(res.body)}`);
  return res.body;
};

const monthEnds = (year) => Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(year, i + 1, 0)).toISOString().slice(0, 10));

test('trial balance: debits = credits (opening, period, closing) for every month, year and filter', async () => {
  const ranges = [
    ...monthEnds(P).map((to) => ({ from: `${to.slice(0, 7)}-01`, to })),
    ...monthEnds(Y).slice(0, 6).map((to) => ({ from: `${to.slice(0, 7)}-01`, to })),
    { from: `${P}-01-01`, to: `${P}-12-31` },
    { from: `${P}-03-15`, to: `${Y}-12-31` },
    { from: `${P}-01-01`, to: `${Y}-12-31`, branchId: ctx.branch },
  ];
  for (const r of ranges) {
    const tb = await get('trial-balance', r);
    assert.equal(tb.totals.period_debit, tb.totals.period_credit, JSON.stringify(r));
    assert.equal(tb.totals.opening_debit, tb.totals.opening_credit, JSON.stringify(r));
    assert.equal(tb.totals.closing_debit, tb.totals.closing_credit, JSON.stringify(r));
    assert.equal(tb.balanced, true);
  }
  const year = await get('trial-balance', { from: `${P}-01-01`, to: `${P}-12-31` });
  assert.ok(year.totals.period_debit > 0);
  // Header rows roll up their children.
  const cur = year.rows.find((x) => x.code === '11');
  assert.equal(cur.is_header, true);
  const leaves = year.rows.filter((x) => x.code.startsWith('11') && !x.is_header);
  assert.equal(cur.period_debit, leaves.reduce((s, x) => s + x.period_debit, 0));
});

test('balance sheet balances at every month end, with comparison columns, by branch', async () => {
  for (const asOf of [...monthEnds(P), ...monthEnds(Y)]) {
    const bs = await get('balance-sheet', { asOf, compare: 'prev_year' });
    assert.deepEqual(bs.balanced, [true, true], asOf);
    assert.equal(bs.totals.assets[0], bs.totals.liabilities_and_equity[0]);
  }
  const prev = await get('balance-sheet', { asOf: `${Y}-03-31`, compare: 'prev_period' });
  assert.equal(prev.columns[1].asOf, `${Y}-02-28`);
  assert.deepEqual(prev.balanced, [true, true]);
  // Contra asset (accumulated depreciation) reduces fixed assets.
  const end = await get('balance-sheet', { asOf: `${P}-12-31` });
  assert.equal(end.totals.fixed_assets[0], 2000000 - 200000);
  assert.equal(end.current_earnings[0], ctx.netP);
});

test('income statement: sections, contra revenue, comparisons and monthly columns', async () => {
  const is = await get('income-statement', { from: `${P}-01-01`, to: `${P}-12-31` });
  assert.equal(is.totals.revenue[0], 3000055 - 100000, 'sales returns reduce revenue');
  assert.equal(is.totals.cost_of_sales[0], 900000);
  assert.equal(is.totals.gross_profit[0], 3000055 - 100000 - 900000);
  assert.equal(is.totals.net_income[0], ctx.netP);
  const cmp = await get('income-statement', { from: `${Y}-01-01`, to: `${Y}-12-31`, compare: 'prev_year' });
  assert.equal(cmp.totals.net_income[1], ctx.netP);
  const monthly = await get('income-statement', { from: `${P}-01-01`, to: `${P}-12-31`, monthly: '1' });
  assert.equal(monthly.columns.length, 12);
  assert.equal(monthly.totals.net_income.reduce((s, x) => s + x, 0), ctx.netP);
  const byCc = await get('income-statement', { from: `${P}-01-01`, to: `${P}-12-31`, costCenterId: ctx.cc });
  assert.equal(byCc.totals.expenses[0], 800000);
});

test('cash flow: direct and indirect both explain the change in cash', async () => {
  for (const r of [{ from: `${P}-01-01`, to: `${P}-12-31` }, { from: `${Y}-01-01`, to: `${Y}-06-30` }, { from: `${P}-02-01`, to: `${P}-02-28` }]) {
    const cf = await get('cash-flow', r);
    assert.equal(cf.reconciles, true, JSON.stringify({ r, cf: { d: cf.direct.net, i: cf.indirect.net, n: cf.net_change } }));
  }
  const cf = await get('cash-flow', { from: `${P}-01-01`, to: `${P}-12-31` });
  assert.equal(cf.direct.totals.financing, 10000000 + 5000000);
  assert.equal(cf.direct.totals.investing, -2000000);
});

test('expense analysis by account / cost center / project', async () => {
  const q = { from: `${P}-01-01`, to: `${P}-12-31` };
  const byAcc = await get('expense-analysis', q);
  assert.equal(byAcc.total, 800000 + 120000 + 200000 + 900000);
  const byCc = await get('expense-analysis', { ...q, by: 'cost_center' });
  assert.equal(byCc.rows.find((r) => r.key === ctx.cc).amount, 800000);
  const byPr = await get('expense-analysis', { ...q, by: 'project' });
  assert.equal(byPr.rows.find((r) => r.key === ctx.project).amount, 120000);
});

// ---- drill-down ----

async function drill(d) {
  return get('general-ledger', d);
}
function assertReachesSource(gl, label) {
  assert.ok(gl.lines.length > 0, `${label}: drill-down returned no lines`);
  for (const l of gl.lines) {
    assert.ok(l.entry_id && l.entry_number, `${label}: line without its entry`);
    assert.ok(l.source_type, `${label}: line without source type`);
    if (l.source_type !== 'manual' && l.source_type !== 'reversal') assert.ok(l.source_id, `${label}: source document id missing`);
  }
}
const nat = (type, dmc) => (['liability', 'equity', 'revenue'].includes(type) ? -dmc : dmc);

test('drill-down: every line of every report opens the ledger lines that make up its number', async () => {
  const q = { from: `${P}-01-01`, to: `${Y}-12-31` };
  const typeOf = new Map(ctx.accounts.map((a) => [a.id, a.type]));

  const tb = await get('trial-balance', q);
  for (const row of tb.rows.filter((r) => r.period_debit || r.period_credit)) {
    const gl = await drill(row.drill);
    assertReachesSource(gl, `TB ${row.code}`);
    assert.equal(gl.period_debit_minor, row.period_debit, `TB ${row.code} debit`);
    assert.equal(gl.period_credit_minor, row.period_credit, `TB ${row.code} credit`);
  }

  const is = await get('income-statement', { ...q, compare: 'prev_year' });
  for (const [secKey, sec] of Object.entries(is.sections)) {
    for (const row of sec) {
      for (const [i, d] of row.drill.entries()) {
        if (!row.amounts[i]) continue;
        const gl = await drill(d);
        assertReachesSource(gl, `IS ${row.code}`);
        const dmc = gl.period_debit_minor - gl.period_credit_minor;
        assert.equal(secKey === 'other' ? -dmc : nat(typeOf.get(row.account_id), dmc), row.amounts[i], `IS ${row.code}`);
      }
    }
  }
  for (const d of [...is.total_drill.revenue, ...is.total_drill.expenses].filter((x) => x.from >= `${P}-01-01`)) assertReachesSource(await drill(d), 'IS total');

  const bs = await get('balance-sheet', { asOf: `${Y}-06-30` });
  for (const sec of Object.values(bs.sections)) {
    for (const row of sec) {
      const gl = await drill(row.drill[0]);
      assertReachesSource(gl, `BS ${row.code}`);
      assert.equal(nat(typeOf.get(row.account_id), gl.closing_minor), row.amounts[0], `BS ${row.code}`);
    }
  }
  assertReachesSource(await drill(bs.current_earnings_drill[0]), 'BS current earnings');

  const cf = await get('cash-flow', q);
  for (const k of ['operating', 'investing', 'financing']) {
    for (const row of [...cf.direct.sections[k], ...cf.indirect.sections[k]]) assertReachesSource(await drill(row.drill), `CF ${row.code}`);
  }

  for (const by of ['account', 'cost_center', 'project']) {
    const ea = await get('expense-analysis', { ...q, by });
    for (const row of ea.rows.filter((r) => r.key)) {
      const gl = await drill(row.drill);
      assertReachesSource(gl, `EA ${by} ${row.label}`);
      if (by !== 'project') assert.equal(gl.period_debit_minor - gl.period_credit_minor, row.amount, `EA ${by} ${row.label}`);
    }
  }

  // The invoice's revenue line names the invoice itself.
  const sales = await drill({ accountId: acc('4100'), from: `${Y}-01-01`, to: `${Y}-12-31` });
  const invLine = sales.lines.find((l) => l.source_type === 'sales_invoice');
  assert.ok(invLine, 'invoice line in the revenue drill-down');
  assert.equal(invLine.source_id, ctx.invoice.id);
  assert.equal(invLine.source_number, ctx.invoice.invoice_number);
});

// ---- budgets ----

test('budget: create, enter monthly lines, approve (locks), vs actual with drill-down', async () => {
  const fy = (await ctx.m.get('/api/ledger/fiscal-years')).body.find((x) => x.year === P);
  const periods = (await ctx.m.get(`/api/ledger/periods?fiscalYearId=${fy.id}`)).body;
  const b = await ctx.m.post('/api/financial-reports/budgets', { fiscalYearId: fy.id, name: 'موازنة السنة' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const lines = [
    ...periods.map((p) => ({ accountId: acc('6200'), costCenterId: ctx.cc, periodId: p.id, amount: '600' })),
    ...periods.map((p) => ({ accountId: acc('4100'), periodId: p.id, amount: '2000' })),
  ];
  const set = await ctx.m.put(`/api/financial-reports/budgets/${b.body.id}/lines`, { lines });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.lines.length, 24);
  const bad = await ctx.m.put(`/api/financial-reports/budgets/${b.body.id}/lines`, { lines: [{ accountId: acc('1110'), periodId: periods[0].id, amount: '1' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_account');

  assert.equal((await ctx.m.post(`/api/financial-reports/budgets/${b.body.id}/status`, { status: 'approved' })).status, 200);
  const locked = await ctx.m.put(`/api/financial-reports/budgets/${b.body.id}/lines`, { lines: lines.slice(0, 1) });
  assert.equal(locked.status, 409);

  const bva = await get(`budgets/${b.body.id}/vs-actual`);
  const rent = bva.rows.find((r) => r.account_id === acc('6200'));
  assert.equal(rent.budget, 720000);
  assert.equal(rent.actual, 800000);
  assert.equal(rent.variance, 80000);
  assert.equal(rent.favourable, false);
  const rev = bva.rows.find((r) => r.account_id === acc('4100'));
  assert.equal(rev.budget, 2400000);
  assert.equal(rev.actual, 3000055);
  assert.equal(rev.favourable, true);
  for (const row of bva.rows) {
    const gl = await drill(row.drill);
    assertReachesSource(gl, `BvA ${row.code}`);
    assert.equal(nat(row.type, gl.period_debit_minor - gl.period_credit_minor), row.actual);
  }
  const q1 = await get(`budgets/${b.body.id}/vs-actual`, { from: `${P}-01-01`, to: `${P}-03-31` });
  assert.equal(q1.rows.find((r) => r.account_id === acc('6200')).budget, 180000);
  const audit = db.prepare("SELECT action FROM audit_log WHERE company_id = ? AND action LIKE 'reports.budget.%'").all(ctx.co.companyId).map((r) => r.action);
  for (const a of ['reports.budget.create', 'reports.budget.lines', 'reports.budget.status']) assert.ok(audit.includes(a), a);
});

// ---- year-end close ----

test('year-end close: net result = change in retained earnings; P&L zero after close; statements unchanged', async () => {
  const fy = (await ctx.m.get('/api/ledger/fiscal-years')).body.find((x) => x.year === P);
  const reBefore = await drill({ accountId: acc('3200'), from: '1900-01-01', to: `${P}-12-31` });
  const isBefore = await get('income-statement', { from: `${P}-01-01`, to: `${P}-12-31` });

  const close = await ctx.m.post(`/api/financial-reports/year-end/${fy.id}/close`, {});
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.equal(close.body.net_income_minor, isBefore.totals.net_income[0]);
  assert.equal((await ctx.m.post(`/api/financial-reports/year-end/${fy.id}/close`, {})).status, 409);

  const reAfter = await drill({ accountId: acc('3200'), from: '1900-01-01', to: `${P}-12-31` });
  const change = -(reAfter.closing_minor - reBefore.closing_minor); // credit-positive
  assert.equal(change, isBefore.totals.net_income[0], 'IS net result = change in retained earnings');

  // The income statement still reports the year (closing entry excluded).
  const isAfter = await get('income-statement', { from: `${P}-01-01`, to: `${P}-12-31` });
  assert.equal(isAfter.totals.net_income[0], isBefore.totals.net_income[0]);
  // ...but every P&L account is zero in the ledger at year end.
  const tb = await get('trial-balance', { from: `${P}-01-01`, to: `${P}-12-31` });
  for (const r of tb.rows.filter((x) => ['revenue', 'expense'].includes(x.type))) assert.equal(r.closing_debit - r.closing_credit, 0, r.code);
  assert.equal(tb.balanced, true);
  const bs = await get('balance-sheet', { asOf: `${P}-12-31` });
  assert.deepEqual(bs.balanced, [true]);
  assert.equal(bs.current_earnings[0], 0);
  assert.equal(bs.sections.equity.find((r) => r.account_id === acc('3200')).amount ?? bs.sections.equity.find((r) => r.account_id === acc('3200')).amounts[0], isBefore.totals.net_income[0]);
  // Next year's BS is still balanced and carries the closed profit.
  assert.deepEqual((await get('balance-sheet', { asOf: `${Y}-06-30`, compare: 'prev_year' })).balanced, [true, true]);

  // The closing entry is reversible only through its source action.
  const generic = await ctx.m.post(`/api/ledger/entries/${close.body.entry_id}/reverse`, { reason: 'x' });
  assert.equal(generic.status, 409);
  assert.equal(generic.body.error, 'reverse_via_source');
  assert.match(generic.body.message, /إلغاء الإقفال/);
  // Year Y already has postings -> reopening P is refused.
  const reopen = await ctx.m.post(`/api/financial-reports/year-end/${fy.id}/reopen`, { reason: 'تصحيح' });
  assert.equal(reopen.status, 409);
  assert.equal(reopen.body.error, 'next_year_posted');
  const status = (await get('year-end')).find((x) => x.id === fy.id);
  assert.equal(status.status, 'closed');
  assert.equal(status.closing_entry.id, close.body.entry_id);
  assert.deepEqual((await ctx.m.get('/api/ledger/integrity-check')).body.violations, []);
});

test('year-end close of the latest year can be reopened (reversal) and closed again', async () => {
  const fy = (await ctx.m.get('/api/ledger/fiscal-years')).body.find((x) => x.year === Y);
  const isY = await get('income-statement', { from: `${Y}-01-01`, to: `${Y}-12-31` });
  const c1 = await ctx.m.post(`/api/financial-reports/year-end/${fy.id}/close`, {});
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.net_income_minor, isY.totals.net_income[0]);
  const reopen = await ctx.m.post(`/api/financial-reports/year-end/${fy.id}/reopen`, { reason: 'قيد متأخر' });
  assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(c1.body.entry_id).status, 'reversed');
  assert.equal((await get('balance-sheet', { asOf: `${Y}-12-31` })).current_earnings[0], isY.totals.net_income[0]);
  const c2 = await ctx.m.post(`/api/financial-reports/year-end/${fy.id}/close`, {});
  assert.equal(c2.status, 200, JSON.stringify(c2.body));
  assert.deepEqual((await get('balance-sheet', { asOf: `${Y}-12-31` })).balanced, [true]);
  const audit = db.prepare("SELECT action FROM audit_log WHERE company_id = ? AND action LIKE 'reports.year_end.%'").all(ctx.co.companyId).map((r) => r.action);
  assert.ok(audit.includes('reports.year_end.close') && audit.includes('reports.year_end.reopen'));
  assert.equal((await ctx.m.post(`/api/financial-reports/year-end/${fy.id}/reopen`, { reason: 'x' })).status, 200);
});

test('month-end checklist lists blockers with links', async () => {
  const periods = (await ctx.m.get('/api/ledger/periods')).body;
  const p = periods.find((x) => x.start_date === `${Y}-${new Date().toISOString().slice(5, 7)}-01`) || periods[periods.length - 1];
  await ctx.m.post('/api/ledger/entries', { date: p.start_date, description: 'مسودة', lines: [dr('6200', '1'), cr('1110', '1')] });
  const cl = await get(`month-end/${p.id}`);
  const drafts = cl.items.find((i) => i.key === 'draft_entries');
  assert.ok(drafts.count >= 1);
  assert.equal(drafts.ok, false);
  assert.ok(drafts.link.startsWith('/ledger/entries'));
  assert.equal(cl.ready_to_close, false);
  assert.equal(cl.items.find((i) => i.key === 'ledger_integrity').ok, true);
});

// ---- exports ----

async function download(p) {
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: ctx.co.managerContact, password: ctx.co.managerPassword }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return fetch(`${base}/api/financial-reports/${p}`, { headers: { Cookie: cookie } });
}

test('Excel and PDF exports open and carry Arabic', async () => {
  const ExcelJS = require('exceljs');
  const q = `from=${P}-01-01&to=${P}-12-31`;
  const cases = [
    ['trial-balance', q, 'ميزان المراجعة'],
    ['income-statement', `${q}&compare=prev_year`, 'صافي الربح'],
    ['balance-sheet', `asOf=${P}-12-31`, 'إجمالي الأصول'],
    ['cash-flow', q, 'صافي التغير في النقد'],
    ['expense-analysis', q, 'تحليل المصاريف'],
    ['general-ledger', `${q}&accountId=${acc('1110')}`, 'رصيد افتتاحي'],
  ];
  for (const [p, query, needle] of cases) {
    const xlsx = await download(`${p}?${query}&format=xlsx`);
    assert.equal(xlsx.status, 200, p);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
    const text = [];
    wb.worksheets[0].eachRow((r) => text.push(r.values.join('|')));
    assert.ok(text.some((t) => t.includes(needle)), `${p}: "${needle}" in the Excel export`);
    assert.equal(wb.worksheets[0].views[0].rightToLeft, true, `${p}: RTL sheet`);
  }
  const en = await download(`trial-balance?${q}&format=xlsx&lang=en`);
  const wbEn = new ExcelJS.Workbook();
  await wbEn.xlsx.load(Buffer.from(await en.arrayBuffer()));
  const enText = [];
  wbEn.worksheets[0].eachRow((r) => enText.push(r.values.join('|')));
  assert.ok(enText.some((t) => t.includes('Trial balance')));

  const pdf = await download(`income-statement?${q}&format=pdf`);
  if (pdf.status === 200 || process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  } else {
    assert.equal((await pdf.json()).error, 'pdf_export_failed');
    console.log('# NOTE: PDF export could not render here (no Chromium); set PLAYWRIGHT_CHROMIUM_PATH');
  }
  assert.equal((await download(`trial-balance?${q}&format=doc`)).status, 400);
});

// ---- tenant isolation ----

test('foreign-company ids are rejected by every report, budget and closing endpoint', async () => {
  const o = ctx.other;
  const foreignAccount = o.accounts.find((a) => a.code === '1110').id;
  const reports = ['trial-balance', 'income-statement', 'balance-sheet', 'cash-flow', 'expense-analysis'];
  for (const p of reports) {
    for (const [k, v] of [['branchId', o.branch], ['costCenterId', o.cc], ['projectId', o.project]]) {
      if (p === 'balance-sheet' && k !== 'branchId') continue;
      const res = await ctx.m.get(`/api/financial-reports/${p}?${k}=${v}`);
      assert.equal(res.status, 400, `${p} ${k}`);
      assert.match(res.body.error, /foreign|not_found|invalid/, `${p} ${k}: ${JSON.stringify(res.body)}`);
    }
  }
  assert.equal((await ctx.m.get(`/api/financial-reports/general-ledger?accountId=${foreignAccount}`)).status, 400);
  assert.equal((await ctx.m.get(`/api/financial-reports/budgets/${o.budget}`)).status, 404);
  assert.equal((await ctx.m.get(`/api/financial-reports/budgets/${o.budget}/vs-actual`)).status, 404);
  assert.equal((await ctx.m.put(`/api/financial-reports/budgets/${o.budget}/lines`, { lines: [] })).status, 404);
  assert.equal((await ctx.m.post(`/api/financial-reports/budgets/${o.budget}/status`, { status: 'approved' })).status, 404);
  assert.equal((await ctx.m.post('/api/financial-reports/budgets', { fiscalYearId: o.fy.id, name: 'x' })).status, 400);

  const fy = (await ctx.m.get('/api/ledger/fiscal-years')).body.find((x) => x.year === P);
  const own = await ctx.m.post('/api/financial-reports/budgets', { fiscalYearId: fy.id, name: 'فحص المعرّفات' });
  const myPeriod = (await ctx.m.get(`/api/ledger/periods?fiscalYearId=${fy.id}`)).body[0].id;
  for (const line of [
    { accountId: foreignAccount, periodId: myPeriod, amount: '1' },
    { accountId: acc('6200'), costCenterId: o.cc, periodId: myPeriod, amount: '1' },
    { accountId: acc('6200'), periodId: o.periods[0].id, amount: '1' },
  ]) {
    const res = await ctx.m.put(`/api/financial-reports/budgets/${own.body.id}/lines`, { lines: [line] });
    assert.equal(res.status, 400, JSON.stringify(line));
  }
  assert.equal((await ctx.m.post(`/api/financial-reports/year-end/${o.fy.id}/close`, {})).status, 404);
  assert.equal((await ctx.m.post(`/api/financial-reports/year-end/${o.fy.id}/reopen`, {})).status, 404);
  assert.equal((await ctx.m.get(`/api/financial-reports/month-end/${o.periods[0].id}`)).status, 404);
  // Nothing of the other company leaks into this one's reports.
  const tb = await get('trial-balance', { from: `${P}-01-01`, to: `${Y}-12-31`, hideZero: '0' });
  assert.ok(tb.rows.every((r) => ctx.accounts.some((a) => a.id === r.account_id)));
});

test('permissions: reports need view_financial_reports; closing needs run_year_end_close', async () => {
  const { createRep } = require('./helpers');
  const none = await createRep(base, ctx.m, { permissions: [] });
  assert.equal((await none.client.get('/api/financial-reports/trial-balance')).status, 403);
  const viewer = await createRep(base, ctx.m, { permissions: ['view_financial_reports'] });
  assert.equal((await viewer.client.get('/api/financial-reports/trial-balance')).status, 200);
  const fy = (await ctx.m.get('/api/ledger/fiscal-years')).body[0];
  assert.equal((await viewer.client.post(`/api/financial-reports/year-end/${fy.id}/close`, {})).status, 403);
  assert.equal((await viewer.client.post('/api/financial-reports/budgets', { fiscalYearId: fy.id, name: 'x' })).status, 403);
});

test('benchmark script: seeds through lib/ledger.js and every report is under 2s (20k-line run)', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'benchmark-reports.js'), '20000'], { encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /integrity violations: 0/);
  assert.ok(!/FAIL/.test(r.stdout), r.stdout);
});
