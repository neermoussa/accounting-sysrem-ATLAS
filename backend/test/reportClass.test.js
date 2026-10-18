// backend/test/reportClass.test.js
//
// After Prompt 4:
//  1. accounts.report_class drives every statement section (never the code):
//     a custom chart whose codes follow no template still lands in the right
//     sections; the class is editable and validated against the type.
//  2. Locking a period is refused with drafts in it or an AR reconciliation
//     difference (closing stays advisory).
//  3. IS / BS carry `inventory_opening_missing` until inventory has an
//     opening value.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rc-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');

const app = require('../server');
const db = require('../db/init');
const ledger = require('../lib/ledger');
const h = require('./salesHelpers');

const Y = 2026;
let listener;
let base;
let ctx;

const qs = (o) => new URLSearchParams(o).toString();

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  ctx = {};
});

test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function account(m, body) {
  const res = await m.post('/api/ledger/accounts', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('custom chart with non-template codes: statements follow report_class, not codes', async () => {
  const co = await h.createUsdCompany(base, 'شركة دليل مخصص');
  const m = co.manager;
  assert.equal((await m.post('/api/ledger/fiscal-years', { year: Y })).status, 201);
  // Codes deliberately contradict the template rules: "5..." is NOT cost of
  // sales, "12.." is NOT fixed, "22.." is NOT long term, "1120" is NOT cash.
  const A = await account(m, { code: 'Z-ASSETS', nameAr: 'أصول', type: 'asset' });
  const till = await account(m, { code: '9001', nameAr: 'خزنة', parentId: A.id, reportClass: 'cash' });
  const plant = await account(m, { code: '5000', nameAr: 'معدات', parentId: A.id, reportClass: 'fixed_asset' });
  const depr = await account(m, { code: '5001', nameAr: 'مجمع إهتلاك المعدات', parentId: A.id, normalBalance: 'credit' });
  const stockish = await account(m, { code: '1210', nameAr: 'سلف', parentId: A.id });
  const notCash = await account(m, { code: '1120', nameAr: 'ودائع غير نقدية', parentId: A.id, reportClass: 'current_asset' });
  const L = await account(m, { code: 'Q', nameAr: 'التزامات', type: 'liability' });
  const loan = await account(m, { code: '2110', nameAr: 'قرض', parentId: L.id, reportClass: 'long_term_liability' });
  const payable = await account(m, { code: '2210', nameAr: 'دائنون', parentId: L.id });
  const cap = await account(m, { code: '7', nameAr: 'رأس المال', type: 'equity' });
  const R = await account(m, { code: '6', nameAr: 'إيرادات', type: 'revenue' });
  const sales = await account(m, { code: '6100', nameAr: 'مبيعات', parentId: R.id });
  const interest = await account(m, { code: '6900', nameAr: 'فوائد دائنة', parentId: R.id, reportClass: 'other' });
  const E = await account(m, { code: '4', nameAr: 'مصاريف', type: 'expense' });
  const cogs = await account(m, { code: '4100', nameAr: 'تكلفة البضاعة', parentId: E.id, reportClass: 'cogs' });
  const rent = await account(m, { code: '5900', nameAr: 'إيجار', parentId: E.id });
  const fxLoss = await account(m, { code: '4999', nameAr: 'خسائر استثنائية', parentId: E.id, reportClass: 'other' });

  // Defaults: inherited / type default / credit-normal asset = contra.
  assert.equal(depr.report_class, 'contra_asset');
  assert.equal(stockish.report_class, 'current_asset');
  assert.equal(payable.report_class, 'current_liability');
  assert.equal(rent.report_class, 'opex');
  assert.equal(sales.report_class, 'revenue');
  // Class must fit the type.
  const bad = await m.post('/api/ledger/accounts', { code: 'X1', nameAr: 'خطأ', parentId: E.id, reportClass: 'fixed_asset' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_report_class');

  const post = async (date, lines) => {
    const r = await m.post('/api/ledger/entries', { date, description: 'اختبار', post: true, lines });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  await post(`${Y}-01-02`, [{ accountId: till.id, debit: '1000' }, { accountId: cap.id, credit: '1000' }]);
  await post(`${Y}-01-03`, [{ accountId: till.id, debit: '500' }, { accountId: loan.id, credit: '500' }]);
  await post(`${Y}-01-04`, [{ accountId: plant.id, debit: '600' }, { accountId: till.id, credit: '600' }]);
  await post(`${Y}-02-01`, [{ accountId: till.id, debit: '900' }, { accountId: sales.id, credit: '900' }]);
  await post(`${Y}-02-02`, [{ accountId: cogs.id, debit: '300' }, { accountId: stockish.id, credit: '300' }]);
  await post(`${Y}-02-03`, [{ accountId: rent.id, debit: '100' }, { accountId: payable.id, credit: '100' }]);
  await post(`${Y}-02-04`, [{ accountId: till.id, debit: '40' }, { accountId: interest.id, credit: '40' }]);
  await post(`${Y}-02-05`, [{ accountId: fxLoss.id, debit: '15' }, { accountId: till.id, credit: '15' }]);
  await post(`${Y}-03-31`, [{ accountId: rent.id, debit: '60' }, { accountId: depr.id, credit: '60' }]);
  await post(`${Y}-03-31`, [{ accountId: notCash.id, debit: '200' }, { accountId: till.id, credit: '200' }]);

  const q = { from: `${Y}-01-01`, to: `${Y}-12-31` };
  const is = (await m.get(`/api/financial-reports/income-statement?${qs(q)}`)).body;
  const ids = (sec) => is.sections[sec].map((r) => r.account_id).sort();
  assert.deepEqual(ids('cost_of_sales'), [cogs.id], 'cost of sales = cogs class, not code 5');
  assert.deepEqual(ids('expenses'), [rent.id]);
  assert.deepEqual(ids('other'), [interest.id, fxLoss.id].sort());
  assert.equal(is.totals.gross_profit[0], 90000 - 30000);
  assert.equal(is.totals.operating_income[0], 60000 - 16000);
  assert.equal(is.totals.other[0], 4000 - 1500);
  assert.equal(is.totals.net_income[0], 44000 + 2500);

  const bs = (await m.get(`/api/financial-reports/balance-sheet?asOf=${Y}-12-31`)).body;
  const bsIds = (sec) => bs.sections[sec].map((r) => r.account_id).sort((a, b) => a - b);
  assert.deepEqual(bsIds('fixed_assets'), [plant.id, depr.id].sort((a, b) => a - b), 'contra asset shown with fixed assets');
  assert.equal(bs.totals.fixed_assets[0], 60000 - 6000);
  assert.ok(bsIds('current_assets').includes(stockish.id) && bsIds('current_assets').includes(notCash.id));
  assert.deepEqual(bsIds('long_term_liabilities'), [loan.id]);
  assert.deepEqual(bsIds('current_liabilities'), [payable.id]);
  assert.deepEqual(bs.balanced, [true]);

  const cf = (await m.get(`/api/financial-reports/cash-flow?${qs(q)}`)).body;
  assert.deepEqual(cf.cash_accounts.map((a) => a.id), [till.id], 'cash = report_class cash only (1120 here is not cash)');
  assert.equal(cf.reconciles, true);
  assert.equal(cf.direct.totals.investing, -60000);
  assert.equal(cf.direct.totals.financing, 100000 + 50000);
  assert.ok(cf.indirect.sections.operating.some((r) => r.account_id === depr.id), 'depreciation add-back is operating');

  // Editable: moving the loan to current liabilities moves it in the BS.
  const upd = await m.put(`/api/ledger/accounts/${loan.id}`, { reportClass: 'current_liability' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const bs2 = (await m.get(`/api/financial-reports/balance-sheet?asOf=${Y}-12-31`)).body;
  assert.ok(bs2.sections.current_liabilities.some((r) => r.account_id === loan.id));
  assert.deepEqual(bs2.balanced, [true]);
  assert.equal((await m.put(`/api/ledger/accounts/${loan.id}`, { reportClass: 'cogs' })).status, 400);
  const audit = db.prepare("SELECT after_json FROM audit_log WHERE company_id = ? AND action = 'ledger.account.update' ORDER BY id DESC LIMIT 1").get(co.companyId);
  assert.match(audit.after_json, /current_liability/);
  ctx.custom = { co, till };
});

test('templates set report_class on every account', async () => {
  for (const key of ['trading', 'food_manufacturing']) {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'coaTemplates', `${key}.json`), 'utf8'));
    const { isValidFor } = require('../lib/reportClass');
    for (const a of t.accounts) assert.ok(isValidFor(a.type, a.report_class), `${key} ${a.code} ${a.report_class}`);
  }
  const co = await h.createUsdCompany(base, 'شركة قالب');
  const { accounts } = await h.setupLedger(co.manager);
  const cls = (code) => accounts.find((a) => a.code === code).report_class;
  assert.equal(cls('1110'), 'cash');
  assert.equal(cls('1290'), 'contra_asset');
  assert.equal(cls('2210'), 'long_term_liability');
  assert.equal(cls('5100'), 'cogs');
  assert.equal(cls('6200'), 'opex');
  ctx.tpl = { co, accounts };
});

// ---- locking ----

test('locking a period is refused with draft entries in it; closing is not', async () => {
  const { co, accounts } = ctx.tpl;
  const m = co.manager;
  const acc = (code) => accounts.find((a) => a.code === code).id;
  const periods = (await m.get('/api/ledger/periods')).body;
  const jan = periods.find((p) => p.start_date === `${Y}-01-01`);
  const draft = await m.post('/api/ledger/entries', { date: `${Y}-01-15`, description: 'مسودة', lines: [{ accountId: acc('6200'), debit: '1' }, { accountId: acc('1110'), credit: '1' }] });
  assert.equal(draft.status, 201);
  const close = await m.post(`/api/ledger/periods/${jan.id}/close`, {});
  assert.equal(close.status, 200, 'closing stays advisory');
  const lock = await m.post(`/api/ledger/periods/${jan.id}/lock`, {});
  assert.equal(lock.status, 409);
  assert.equal(lock.body.error, 'lock_blocked_drafts');
  assert.match(lock.body.message, /مسودة/);
  assert.equal(db.prepare('SELECT status FROM fiscal_periods WHERE id = ?').get(jan.id).status, 'closed');
  assert.equal((await m.post(`/api/ledger/periods/${jan.id}/reopen`, {})).status, 200);
  assert.equal((await m.del(`/api/ledger/entries/${draft.body.id}`)).status, 200);
  assert.equal((await m.post(`/api/ledger/periods/${jan.id}/lock`, {})).status, 200, 'no drafts -> lock allowed');
});

test('locking is refused while the AR control account disagrees with the customer sub-ledgers', async () => {
  const { co, accounts } = ctx.tpl;
  const m = co.manager;
  const ar = accounts.find((a) => a.system_key === 'ar_control').id;
  const cash = accounts.find((a) => a.code === '1110').id;
  // An AR line without a customer (posted through lib/ledger.js) creates a
  // control vs sub-ledger difference.
  let posted = true;
  try {
    ledger.postEntry(co.companyId, { date: `${Y}-02-10`, description: 'ذمم بلا زبون', lines: [{ accountId: ar, debitMinor: 500 }, { accountId: cash, creditMinor: 500 }] }, null);
  } catch (err) {
    posted = false;
    assert.fail(`could not create an AR difference: ${err.message}`);
  }
  assert.ok(posted);
  const feb = (await m.get('/api/ledger/periods')).body.find((p) => p.start_date === `${Y}-02-01`);
  const lock = await m.post(`/api/ledger/periods/${feb.id}/lock`, {});
  assert.equal(lock.status, 409);
  assert.equal(lock.body.error, 'lock_blocked_ar_reconciliation');
  assert.equal(lock.body.difference_minor, 500);
  assert.equal((await m.post(`/api/ledger/periods/${feb.id}/close`, {})).status, 200, 'closing still allowed');
});

// ---- inventory banner ----

test('IS and BS flag inventory without an opening value until opening balances include it', async () => {
  const co = await h.createUsdCompany(base, 'شركة مخزون');
  const { accounts, fy } = await h.setupLedger(co.manager);
  const m = co.manager;
  const acc = (code) => accounts.find((a) => a.code === code).id;
  const q = `from=${Y}-01-01&to=${Y}-12-31`;
  assert.equal((await m.get(`/api/financial-reports/income-statement?${q}`)).body.inventory_opening_missing, true);
  assert.equal((await m.get(`/api/financial-reports/balance-sheet?asOf=${Y}-12-31`)).body.inventory_opening_missing, true);
  // Excel export carries the banner text.
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: co.managerContact, password: co.managerPassword }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const xlsx = await fetch(`${base}/api/financial-reports/balance-sheet?asOf=${Y}-12-31&format=xlsx`, { headers: { Cookie: cookie } });
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
  const text = [];
  wb.worksheets[0].eachRow((r) => text.push(r.values.join('|')));
  assert.ok(text.some((t) => t.includes('المخزون بلا رصيد افتتاحي')));

  const ob = await m.post('/api/ledger/opening-balances', { fiscalYearId: fy.id, rows: [{ accountId: acc('1150'), debit: '700' }, { accountId: acc('3100'), credit: '700' }] });
  assert.equal(ob.status, 201, JSON.stringify(ob.body));
  assert.equal((await m.get(`/api/financial-reports/income-statement?${q}`)).body.inventory_opening_missing, false);
  assert.equal((await m.get(`/api/financial-reports/balance-sheet?asOf=${Y}-12-31`)).body.inventory_opening_missing, false);
});

test('lock reconciliation is computed as of the period END: a difference created after the period does not block it', async () => {
  const co = await h.createUsdCompany(base, 'شركة قفل حسب التاريخ');
  const { accounts } = await h.setupLedger(co.manager);
  const m = co.manager;
  const ar = accounts.find((a) => a.system_key === 'ar_control').id;
  const cash = accounts.find((a) => a.code === '1110').id;
  // AR line without a customer dated in April (after March).
  ledger.postEntry(co.companyId, { date: `${Y}-04-10`, description: 'فرق لاحق', lines: [{ accountId: ar, debitMinor: 700 }, { accountId: cash, creditMinor: 700 }] }, null);
  const periods = (await m.get('/api/ledger/periods')).body;
  const mar = periods.find((p) => p.start_date === `${Y}-03-01`);
  const apr = periods.find((p) => p.start_date === `${Y}-04-01`);
  const lockMar = await m.post(`/api/ledger/periods/${mar.id}/lock`, {});
  assert.equal(lockMar.status, 200, `March is clean as of 03-31: ${JSON.stringify(lockMar.body)}`);
  const lockApr = await m.post(`/api/ledger/periods/${apr.id}/lock`, {});
  assert.equal(lockApr.status, 409);
  assert.equal(lockApr.body.error, 'lock_blocked_ar_reconciliation');
  assert.equal(lockApr.body.difference_minor, 700);
  // The reconciliation endpoint answers as of a date too.
  assert.equal((await m.get(`/api/receivables/reconciliation?asOf=${Y}-03-31`)).body.current.difference_minor, 0);
  assert.equal((await m.get(`/api/receivables/reconciliation?asOf=${Y}-04-30`)).body.current.difference_minor, 700);
});
