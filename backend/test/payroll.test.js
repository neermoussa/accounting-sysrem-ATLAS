// backend/test/payroll.test.js
//
// Prompt 11-lite "Done when" (accounting side of payroll only):
//  - import per period / department / cost center / currency (USD, SYP);
//    idempotent by (company, period, external id); a changed re-import is
//    refused unless the period is reopened with a reason;
//  - accrual: ONE entry per period (source payroll_period), expense per
//    cost center, salaries / deductions payable per currency at the
//    posting-date rate; reversal-only corrections; locked periods refused;
//  - payment through a treasury voucher (one entry, linked to the period);
//    a foreign-currency payment relieves the payable at its accrual value
//    and posts the rate difference to realized FX;
//  - employee advances paid through treasury, recovered through the
//    payroll deduction lines, balance report;
//  - labour cost rates per cost center / product line, effective-dated,
//    read by production orders;
//  - reports (cost by department and period, payables, advances),
//    separation of duties, permissions, tenant refs, failure injection.
//
// Hand calculation (USD base; SYP at 13,500 per USD on 31 March, 15,000
// from 1 April):
//   March: Sales  (CC S) USD gross 3,000.00 ded 300.00 employer 200.00 net 2,700.00
//          Plant  (CC P) SYP gross 13,500,000 ded 1,350,000 net 12,150,000
//   Entry: Dr 6100 3,000.00 (S) + 1,000.00 (P); Dr 6500 200.00 (S)
//          Cr 2130 2,700.00 (USD) + 900.00 (SYP 12,150,000)
//          Cr 2135 500.00 (USD 300 + 200) + 100.00 (SYP 1,350,000)
//   SYP salaries paid on 10 April at 15,000: box -810.00, payable -900.00,
//   realized FX gain 90.00.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-payroll-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const faults = require('../lib/faultInjection');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = '2026';
let listener;
let base;
let c;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const lines = (entryId) => db.prepare('SELECT a.code, l.debit_minor d, l.credit_minor c, l.currency_code cur, l.amount_original_minor o, l.cost_center_id cc FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId).map((x) => ({ ...x }));
const bal = (code) => db.prepare("SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND a.code = ?").get(c.companyId, code).b;
const sum = (ls, code, side) => ls.filter((l) => l.code === code).reduce((t, l) => t + l[side], 0);
const march = (extra = {}) => ({
  period: `${Y}-03`, externalId: 'HR-2026-03',
  lines: [
    { department: 'المبيعات', costCenterId: c.ccS, currencyCode: 'USD', gross: '3000', deductions: '300', employerContributions: '200', net: '2700', headcount: 4 },
    { department: 'المعمل', costCenterId: c.ccP, currencyCode: 'SYP', gross: '13500000', deductions: '1350000', net: '12150000', headcount: 9 },
  ],
  ...extra,
});

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة الرواتب');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m, 'trading');
  ok((await h.goLive(m, `${Y}-01-01`)).res);
  const acc = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(co.companyId, code).id;
  void accounts;
  const head = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(co.companyId, code).id;
  ok(await m.post('/api/ledger/accounts', { code: '2135', nameAr: 'استقطاعات رواتب مستحقة', type: 'liability', parentId: head('21') }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '13500', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-01-01` }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '15000', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-04-01` }), 201);
  const ccS = ok(await m.post('/api/ledger/cost-centers', { code: 'S', name: 'مركز المبيعات' }), 201).id;
  const ccP = ok(await m.post('/api/ledger/cost-centers', { code: 'P', name: 'مركز المعمل' }), 201).id;
  const clerk = await createRep(base, m, { name: 'موظف الرواتب', permissions: ['view_app', 'manage_payroll_intake'] });
  const poster = await createRep(base, m, { name: 'معتمد الرواتب', permissions: ['view_app', 'approve_payroll_posting'] });
  const treasurer = await createRep(base, m, { name: 'أمين الخزينة', permissions: ['view_app', 'view_treasury', 'approve_vouchers', 'create_vouchers'] });
  const boxes = ok(await m.get('/api/treasury/boxes'));
  const main = boxes[0];
  const syp = ok(await m.post('/api/treasury/boxes', { name: 'صندوق الليرة', kind: 'cash', currencyCode: 'SYP' }), 201);
  for (const b of [main, syp]) ok(await m.put(`/api/treasury/boxes/${b.id}`, { userIds: [treasurer.userId, poster.userId, clerk.userId] }));
  c = { ...co, m, acc, ccS, ccP, clerk: clerk.client, poster: poster.client, treasurer: treasurer.client, main, syp };
  c.settings = { expenseAccountId: acc('6100'), employerExpenseAccountId: acc('6500'), salariesPayableAccountId: acc('2130'), deductionsPayableAccountId: acc('2135'), advancesAccountId: acc('1160') };
});
test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('settings: accounts are required and type-checked', async () => {
  assert.equal(ok(await c.clerk.post('/api/payroll/advances', { employeeRef: 'E1', cashBoxId: c.main.id, amount: '1' }), 409).error, 'payroll_accounts_not_set');
  assert.equal(ok(await c.clerk.put('/api/payroll/settings', { ...c.settings, expenseAccountId: c.acc('2130') }), 400).error, 'invalid_account_type');
  assert.equal(ok(await c.clerk.put('/api/payroll/settings', { ...c.settings, deductionsPayableAccountId: c.acc('2130') }), 400).error, 'same_accounts');
  ok(await c.clerk.put('/api/payroll/settings', c.settings));
});

test('import: net must equal gross - deductions; same batch again is a replay; a changed re-import is refused until reopened with a reason', async () => {
  const bad = march();
  bad.lines[0].net = '2701';
  assert.deepEqual(ok(await c.clerk.post('/api/payroll/periods/import', bad), 400).errors.map((e) => e.error), ['net_mismatch']);
  const p = ok(await c.clerk.post('/api/payroll/periods/import', march()), 201);
  assert.equal(p.status, 'imported');
  assert.equal(p.posting_date, `${Y}-03-31`);
  assert.deepEqual(p.totals.USD, { gross_minor: 300000, deductions_minor: 30000, employer_contrib_minor: 20000, net_minor: 270000, paid_minor: 0 });
  assert.equal(p.totals.SYP.net_minor, 12150000);
  const again = ok(await c.clerk.post('/api/payroll/periods/import', march()), 200);
  assert.equal(again.replay, true);
  assert.equal(again.id, p.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_periods WHERE company_id = ?').get(c.companyId).n, 1);
  const changed = march();
  changed.lines[0].gross = '3100';
  changed.lines[0].net = '2800';
  assert.equal(ok(await c.clerk.post('/api/payroll/periods/import', changed), 409).error, 'payroll_changed_reimport');
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${p.id}/reopen`, {}), 400).error, 'reason_required');
  ok(await c.poster.post(`/api/payroll/periods/${p.id}/reopen`, { reason: 'تصحيح من برنامج الموارد البشرية' }));
  const re = ok(await c.clerk.post('/api/payroll/periods/import', changed), 200);
  assert.equal(re.import_count, 2);
  assert.equal(re.totals.USD.gross_minor, 310000);
  // Back to the original figures for the rest of the scenario.
  ok(await c.poster.post(`/api/payroll/periods/${p.id}/reopen`, { reason: 'العودة للأرقام المعتمدة' }));
  ok(await c.clerk.post('/api/payroll/periods/import', march()), 200);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE company_id = ? AND action LIKE 'payroll.period.%'").get(c.companyId).n >= 5);
  c.march = p.id;
});

test('accrual: separation of duties, one entry per period with cost centers and per-currency payables at the posting-date rate; posting twice refused', async () => {
  assert.equal((await c.clerk.post(`/api/payroll/periods/${c.march}/post`, {})).status, 403, 'intake cannot post');
  const posted = ok(await c.poster.post(`/api/payroll/periods/${c.march}/post`, {}));
  assert.equal(posted.status, 'posted');
  const e = lines(posted.journal_entry_id);
  assert.equal(sum(e, '6100', 'd'), 300000 + 100000);
  assert.ok(e.some((l) => l.code === '6100' && l.d === 300000 && l.cc === c.ccS));
  assert.ok(e.some((l) => l.code === '6100' && l.d === 100000 && l.cc === c.ccP && l.cur === 'SYP' && l.o === 13500000));
  assert.equal(sum(e, '6500', 'd'), 20000);
  assert.equal(sum(e, '2130', 'c'), 270000 + 90000);
  assert.ok(e.some((l) => l.code === '2130' && l.cur === 'SYP' && l.o === 12150000 && l.c === 90000));
  assert.equal(sum(e, '2135', 'c'), 50000 + 10000);
  assert.equal(e.reduce((t, l) => t + l.d - l.c, 0), 0);
  assert.equal(db.prepare('SELECT source_type FROM journal_entries WHERE id = ?').get(posted.journal_entry_id).source_type, 'payroll_period');
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${c.march}/post`, {}), 409).error, 'payroll_not_importable_state');
  // The importer cannot post what they imported (another holder exists).
  const apr = ok(await c.m.post('/api/payroll/periods/import', { period: `${Y}-04`, externalId: 'HR-2026-04', lines: [{ department: 'المبيعات', currencyCode: 'USD', gross: '100', deductions: '0', net: '100' }] }), 201);
  assert.equal(ok(await c.m.post(`/api/payroll/periods/${apr.id}/post`, {}), 403).error, 'sod_payroll_importer');
  c.april = apr.id;
});

test('payments through treasury: USD at par; SYP at the payment-date rate relieves the payable at accrual value and posts realized FX', async () => {
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${c.april}/payments`, { cashBoxId: c.main.id }), 409).error, 'payroll_not_posted');
  const usd = ok(await c.poster.post(`/api/payroll/periods/${c.march}/payments`, { cashBoxId: c.main.id, date: `${Y}-04-05` }), 201);
  assert.equal(usd.amount_minor, 270000, 'default = the remaining net');
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${c.march}/payments`, { cashBoxId: c.main.id, amount: '1' }), 409).error, 'payment_exceeds_net');
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${c.march}/payments`, { cashBoxId: c.syp.id, currencyCode: 'USD' }), 400).error, 'currency_mismatch');
  assert.equal(ok(await c.m.put(`/api/treasury/vouchers/${usd.voucher_id}`, { amount: '1' }), 409).error, 'payroll_linked_voucher');
  const uv = ok(await c.treasurer.post(`/api/treasury/vouchers/${usd.voucher_id}/approve`, {}));
  assert.deepEqual(lines(uv.journal_entry_id).map((l) => [l.code, l.d, l.c]), [['2130', 270000, 0], ['1110', 0, 270000]]);
  // SYP in two parts at 15,000 (accrued at 13,500).
  const s1 = ok(await c.poster.post(`/api/payroll/periods/${c.march}/payments`, { cashBoxId: c.syp.id, amount: '4050000', date: `${Y}-04-10` }), 201);
  const s2 = ok(await c.poster.post(`/api/payroll/periods/${c.march}/payments`, { cashBoxId: c.syp.id, date: `${Y}-04-10` }), 201);
  assert.equal(s2.amount_minor, 8100000);
  const v1 = ok(await c.treasurer.post(`/api/treasury/vouchers/${s1.voucher_id}/approve`, {}));
  const v2 = ok(await c.treasurer.post(`/api/treasury/vouchers/${s2.voucher_id}/approve`, {}));
  const l1 = lines(v1.journal_entry_id);
  assert.equal(sum(l1, '2130', 'd'), 30000, '4,050,000 / 12,150,000 of 900.00');
  assert.equal(sum(l1, '6800', 'c'), 3000, 'realized gain 30.00');
  const l2 = lines(v2.journal_entry_id);
  assert.equal(sum(l2, '2130', 'd'), 60000, 'last payment takes the rest of the accrued base');
  assert.equal(bal('2130'), 0, 'salaries payable fully settled in base');
  assert.equal(bal('6800'), 9000, 'total realized FX gain 90.00');
  const pay = ok(await c.poster.get('/api/payroll/reports/payables'));
  assert.deepEqual(pay.rows.filter((r) => r.period_id === c.march).map((r) => [r.currency, r.outstanding_minor]).sort(), [['SYP', 0], ['USD', 0]]);
  assert.equal(pay.salaries_payable_ledger_minor, 0);
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${c.march}/payments`, { cashBoxId: c.main.id }), 409).error, 'nothing_to_pay');
});

test('advances: paid through treasury, recovered through the deduction lines (FX at the advance value), balance report; over-recovery refused', async () => {
  const a1 = ok(await c.clerk.post('/api/payroll/advances', { employeeRef: 'E-7', employeeName: 'سامر', cashBoxId: c.main.id, amount: '500', date: `${Y}-04-02` }), 201);
  ok(await c.treasurer.post(`/api/treasury/vouchers/${a1.voucher_id}/approve`, {}));
  const a2 = ok(await c.clerk.post('/api/payroll/advances', { employeeRef: 'E-9', cashBoxId: c.syp.id, amount: '1500000', date: `${Y}-03-15` }), 201);
  ok(await c.treasurer.post(`/api/treasury/vouchers/${a2.voucher_id}/approve`, {}));
  assert.equal(bal('1160'), -(50000 + 11111), '500.00 + 1,500,000 / 13,500 = 111.11');
  const may = ok(await c.clerk.post('/api/payroll/periods/import', {
    period: `${Y}-05`, externalId: 'HR-2026-05',
    lines: [
      { department: 'المبيعات', currencyCode: 'USD', gross: '1000', deductions: '250', net: '750' },
      { department: 'المعمل', currencyCode: 'SYP', gross: '3000000', deductions: '1500000', net: '1500000' },
    ],
    advanceRecoveries: [{ employeeRef: 'E-7', currencyCode: 'USD', amount: '200' }, { employeeRef: 'E-9', currencyCode: 'SYP', amount: '1500000' }],
  }), 201);
  const posted = ok(await c.poster.post(`/api/payroll/periods/${may.id}/post`, {}));
  const e = lines(posted.journal_entry_id);
  assert.equal(sum(e, '1160', 'c'), 20000 + 11111, 'advances relieved at their own base value');
  // SYP recovery at 15,000 = 100.00 vs advance 111.11 -> realized loss 11.11.
  assert.equal(sum(e, '6800', 'd'), 1111);
  assert.equal(sum(e, '2135', 'c'), 5000, 'USD deductions 250 - recovery 200 = 50.00; SYP deductions all recovery');
  const rep = ok(await c.poster.get('/api/payroll/reports/advances'));
  const row = (ref) => rep.rows.find((r) => r.employee_ref === ref);
  assert.deepEqual([row('E-7').advanced, row('E-7').recovered, row('E-7').outstanding], [50000, 20000, 30000]);
  assert.deepEqual([row('E-9').outstanding, row('E-9').outstanding_base], [0, 0]);
  assert.equal(rep.outstanding_base_minor, 30000);
  assert.equal(-bal('1160'), 30000, 'ledger advances = report');
  // Recovering more than is outstanding is refused at posting, nothing posted.
  const jun = ok(await c.clerk.post('/api/payroll/periods/import', { period: `${Y}-06`, externalId: 'HR-2026-06', lines: [{ department: 'المبيعات', currencyCode: 'USD', gross: '1000', deductions: '400', net: '600' }], advanceRecoveries: [{ employeeRef: 'E-7', currencyCode: 'USD', amount: '400' }] }), 201);
  const n = db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n;
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${jun.id}/post`, {}), 409).error, 'recovery_exceeds_advance');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n, n);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_advance_recoveries WHERE period_id = ? AND posted = 1').get(jun.id).n, 0);
  c.may = may.id;
});

test('reversal-only corrections: a paid period cannot be reopened; reopening reverses the entry, re-import and post replace the figures', async () => {
  assert.equal(ok(await c.poster.post(`/api/payroll/periods/${c.march}/reopen`, { reason: 'تصحيح بعد الدفع' }), 409).error, 'payroll_has_payments');
  const before = db.prepare('SELECT journal_entry_id FROM payroll_periods WHERE id = ?').get(c.may).journal_entry_id;
  const r = ok(await c.poster.post(`/api/payroll/periods/${c.may}/reopen`, { reason: 'خطأ في قسم المعمل' }));
  assert.equal(r.status, 'reopened');
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(before).status, 'reversed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_advance_recoveries WHERE period_id = ? AND posted = 1').get(c.may).n, 0, 'recoveries released');
  assert.equal(-bal('1160'), 30000 + 20000 + 11111, 'advances back to outstanding');
  ok(await c.clerk.post('/api/payroll/periods/import', { period: `${Y}-05`, externalId: 'HR-2026-05', lines: [{ department: 'المبيعات', currencyCode: 'USD', gross: '1000', deductions: '250', net: '750' }], advanceRecoveries: [{ employeeRef: 'E-7', currencyCode: 'USD', amount: '200' }] }), 200);
  const again = ok(await c.poster.post(`/api/payroll/periods/${c.may}/post`, {}));
  assert.notEqual(again.journal_entry_id, before);
  assert.equal(-bal('1160'), 30000 + 11111);
  const cost = ok(await c.poster.get(`/api/payroll/reports/cost?from=${Y}-05&to=${Y}-05`));
  assert.deepEqual(cost.rows.map((x) => [x.department, x.currency, x.cost_base_minor]), [['المبيعات', 'USD', 100000]], 'only the corrected figures count');
});

test('locked period: posting the accrual refuses and posts nothing', async () => {
  const pid = db.prepare('SELECT id FROM fiscal_periods WHERE company_id = ? AND start_date = ?').get(c.companyId, `${Y}-02-01`).id;
  ok(await c.m.post(`/api/ledger/periods/${pid}/close`, {}));
  ok(await c.m.post(`/api/ledger/periods/${pid}/lock`, {}));
  const feb = ok(await c.clerk.post('/api/payroll/periods/import', { period: `${Y}-02`, externalId: 'HR-2026-02', lines: [{ department: 'المبيعات', currencyCode: 'USD', gross: '10', deductions: '0', net: '10' }] }), 201);
  const n = db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n;
  const r = ok(await c.poster.post(`/api/payroll/periods/${feb.id}/post`, {}), 409);
  assert.equal(r.error, 'period_locked');
  assert.match(r.message, /لم يُرحَّل شيء/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n, n);
  assert.equal(db.prepare('SELECT status FROM payroll_periods WHERE id = ?').get(feb.id).status, 'imported');
});

test('reports: payroll cost by department and period (base, posting-date rates)', async () => {
  const r = ok(await c.poster.get(`/api/payroll/reports/cost?from=${Y}-03&to=${Y}-03`));
  const m = Object.fromEntries(r.rows.map((x) => [x.department, x]));
  assert.equal(m['المبيعات'].cost_base_minor, 300000 + 20000);
  assert.equal(m['المعمل'].cost_base_minor, 100000);
  assert.equal(m['المعمل'].headcount, 9);
  assert.equal(r.total_cost_base_minor, 420000);
});

test('labour cost rates: effective-dated, most specific match; production orders read them', async () => {
  const add = (body) => c.clerk.post('/api/payroll/labor-rates', body);
  ok(await add({ ratePerHour: '4', effectiveFrom: `${Y}-01-01` }), 201);
  ok(await add({ ratePerHour: '5', effectiveFrom: `${Y}-06-01` }), 201);
  ok(await add({ costCenterId: c.ccP, ratePerHour: '6', effectiveFrom: `${Y}-01-01` }), 201);
  ok(await add({ productLine: 'مكسرات', ratePerHour: '7', effectiveFrom: `${Y}-01-01` }), 201);
  ok(await add({ costCenterId: c.ccP, productLine: 'مكسرات', ratePerHour: '8', effectiveFrom: `${Y}-03-01` }), 201);
  assert.equal(ok(await add({ ratePerHour: '9', effectiveFrom: `${Y}-06-01` }), 409).error, 'rate_exists');
  const PR = require('../lib/payroll');
  const r = (q) => { const x = PR.laborRateFor(c.companyId, q); return x && [x.rate_per_hour_minor, x.matched]; };
  assert.deepEqual(r({ date: `${Y}-05-31` }), [400, 'company']);
  assert.deepEqual(r({ date: `${Y}-06-01` }), [500, 'company'], 'the change date takes the new rate');
  assert.deepEqual(r({ costCenterId: c.ccP, date: `${Y}-05-01` }), [600, 'cost_center']);
  assert.deepEqual(r({ productLine: 'مكسرات', date: `${Y}-05-01` }), [700, 'product_line']);
  assert.deepEqual(r({ costCenterId: c.ccP, productLine: 'مكسرات', date: `${Y}-02-28` }), [600, 'cost_center'], 'combined rate not yet effective');
  assert.deepEqual(r({ costCenterId: c.ccP, productLine: 'مكسرات', date: `${Y}-03-01` }), [800, 'cost_center_and_product_line']);
  assert.equal(PR.laborRateFor(c.companyId, { date: `${Number(Y) - 1}-12-31` }), null);
  // A production order reads the rate for its product line.
  const dry = ok(await c.m.post('/api/stock/activation/dry-run', { date: `${Y}-05-01` }));
  ok(await c.m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const pid = await h.mkProduct(c.m, { name: 'خلطة', category: 'مكسرات' });
  const comp = await h.mkProduct(c.m, { name: 'لوز' });
  const v = ok(await c.m.post('/api/manufacturing/versions', { productId: pid, batchOutputQty: 10, components: [{ productId: comp, qtyPerBatch: 10 }] }), 201);
  ok(await c.m.post(`/api/manufacturing/versions/${v.id}/activate`, {}));
  const o = ok(await c.m.post('/api/manufacturing/orders', { productId: pid, batches: 1, plannedDate: `${Y}-05-10` }), 201);
  const lr = ok(await c.m.get(`/api/manufacturing/orders/${o.id}/labor-rate?costCenterId=${c.ccP}`));
  assert.equal(lr.product_line, 'مكسرات');
  assert.deepEqual([lr.rate.rate_per_hour_minor, lr.rate.matched], [800, 'cost_center_and_product_line']);
});

test('failure injection: accrual, reopen, payroll payment (FX path) and advance roll back completely', async () => {
  const snap = () => [
    db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n,
    db.prepare('SELECT COUNT(*) n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ?').get(c.companyId).n,
    db.prepare("SELECT GROUP_CONCAT(status) s FROM (SELECT status FROM payroll_periods WHERE company_id = ? ORDER BY id)").get(c.companyId).s,
    db.prepare("SELECT GROUP_CONCAT(status) s FROM (SELECT status FROM treasury_vouchers WHERE company_id = ? ORDER BY id)").get(c.companyId).s,
    db.prepare('SELECT COUNT(*) n FROM payroll_advance_recoveries WHERE company_id = ? AND posted = 1').get(c.companyId).n,
    db.prepare('SELECT COALESCE(SUM(payable_base_minor), 0) s FROM payroll_payments WHERE company_id = ?').get(c.companyId).s,
  ];
  const jul = ok(await c.clerk.post('/api/payroll/periods/import', { period: `${Y}-07`, externalId: 'HR-2026-07', lines: [{ department: 'المعمل', currencyCode: 'SYP', gross: '1500000', deductions: '150000', net: '1350000' }], advanceRecoveries: [] }), 201);
  for (const [point, call] of [
    ['payroll.post.after_entry', () => c.poster.post(`/api/payroll/periods/${jul.id}/post`, {})],
  ]) {
    const before = snap();
    faults.arm(point);
    assert.equal((await call()).status, 500, point);
    faults.disarmAll();
    assert.deepEqual(snap(), before, point);
  }
  ok(await c.poster.post(`/api/payroll/periods/${jul.id}/post`, {}));
  const pay = ok(await c.poster.post(`/api/payroll/periods/${jul.id}/payments`, { cashBoxId: c.syp.id, date: `${Y}-07-31` }), 201);
  const adv = ok(await c.clerk.post('/api/payroll/advances', { employeeRef: 'E-1', cashBoxId: c.main.id, amount: '10' }), 201);
  const aug = ok(await c.clerk.post('/api/payroll/periods/import', { period: `${Y}-08`, externalId: 'HR-2026-08', lines: [{ department: 'المبيعات', currencyCode: 'USD', gross: '10', deductions: '0', net: '10' }] }), 201);
  ok(await c.poster.post(`/api/payroll/periods/${aug.id}/post`, {}));
  for (const [point, call] of [
    ['treasury.voucher.after_entry', () => c.treasurer.post(`/api/treasury/vouchers/${pay.voucher_id}/approve`, {})],
    ['treasury.voucher.after_entry', () => c.treasurer.post(`/api/treasury/vouchers/${adv.voucher_id}/approve`, {})],
    ['payroll.reopen.after_reversal', () => c.poster.post(`/api/payroll/periods/${aug.id}/reopen`, { reason: 'اختبار الفشل' })],
  ]) {
    const before = snap();
    faults.arm(point);
    assert.equal((await call()).status, 500, point);
    faults.disarmAll();
    assert.deepEqual(snap(), before, point);
  }
  ok(await c.treasurer.post(`/api/treasury/vouchers/${pay.voucher_id}/approve`, {}));
  assert.equal(require('../lib/ledger').ledgerIntegrityCheck(c.companyId).violations.length, 0);
});

test('tenant refs and permissions', async () => {
  const other = await h.createUsdCompany(base, 'شركة أخرى للرواتب');
  const om = other.manager;
  const { accounts } = await h.setupLedger(om, 'trading');
  ok((await h.goLive(om, `${Y}-01-01`)).res);
  const oacc = (code) => accounts.find((a) => a.code === code).id;
  for (const [method, url, body] of [
    ['put', '/settings', { ...c.settings }],
    ['put', '/settings', { expenseAccountId: oacc('6100'), employerExpenseAccountId: oacc('6500'), salariesPayableAccountId: c.acc('2130'), deductionsPayableAccountId: oacc('2120'), advancesAccountId: oacc('1160') }],
    ['get', `/periods/${c.march}`],
    ['post', `/periods/${c.march}/post`, {}],
    ['post', `/periods/${c.march}/reopen`, { reason: 'محاولة غريبة' }],
    ['post', `/periods/${c.march}/payments`, { cashBoxId: c.main.id }],
    ['post', '/labor-rates', { costCenterId: c.ccP, ratePerHour: '1', effectiveFrom: `${Y}-01-01` }],
  ]) {
    const r = await om[method](`/api/payroll${url}`, body);
    assert.equal(r.status, 400, `${method} ${url}: ${JSON.stringify(r.body)}`);
  }
  ok(await om.put('/api/payroll/settings', { expenseAccountId: oacc('6100'), employerExpenseAccountId: oacc('6500'), salariesPayableAccountId: oacc('2130'), deductionsPayableAccountId: oacc('2120'), advancesAccountId: oacc('1160') }));
  for (const [url, body] of [
    ['/periods/import', { period: `${Y}-03`, externalId: 'X', lines: [{ department: 'x', costCenterId: c.ccS, currencyCode: 'USD', gross: '1', deductions: '0', net: '1' }] }],
    ['/advances', { employeeRef: 'E', cashBoxId: c.main.id, amount: '1' }],
  ]) {
    assert.equal((await om.post(`/api/payroll${url}`, body)).status, 400, url);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_periods WHERE company_id = ?').get(other.companyId).n, 0);
  // Permissions: intake cannot post / pay / reopen; posting cannot import; nobody else gets in.
  for (const [client, method, url, body] of [
    [c.clerk, 'post', `/periods/${c.april}/post`, {}],
    [c.clerk, 'post', `/periods/${c.march}/reopen`, { reason: 'xxxxxx' }],
    [c.clerk, 'post', `/periods/${c.march}/payments`, {}],
    [c.poster, 'post', '/periods/import', march()],
    [c.poster, 'post', '/advances', {}],
    [c.poster, 'post', '/labor-rates', {}],
    [c.treasurer, 'get', '/periods', undefined],
  ]) {
    assert.equal((await client[method](`/api/payroll${url}`, body)).status, 403, `${method} ${url}`);
  }
});
