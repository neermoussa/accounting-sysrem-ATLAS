// backend/test/payrollDeductions.test.js
//
// Payroll deduction types (before Prompt 12, item 2): several payable
// accounts per company (social insurance, income tax, other), the import's
// per-line split by type (must add up exactly), accrual and payment per
// type (foreign currency relieved at its accrual value, difference to
// realized FX), balance per type vs the ledger, and the migration of an
// existing single-account setup to one default type.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pded-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = '2026';
let listener;
let c;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const bal = (code) => db.prepare("SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND a.code = ?").get(c.companyId, code).b;
const credit = (entryId, code) => db.prepare('SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.code = ?').get(entryId, code).s;

test.before(async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة الاستقطاعات');
  const m = co.manager;
  await h.setupLedger(m, 'trading');
  ok((await h.goLive(m, `${Y}-01-01`)).res);
  const acc = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(co.companyId, code)?.id;
  const head = acc('21');
  for (const [code, name] of [['2135', 'استقطاعات عامة'], ['2136', 'تأمينات اجتماعية مستحقة'], ['2137', 'ضريبة دخل الرواتب المستحقة']]) ok(await m.post('/api/ledger/accounts', { code, nameAr: name, type: 'liability', parentId: head }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '13500', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-01-01` }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '15000', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-04-01` }), 201);
  const poster = await createRep(base, m, { permissions: ['view_app', 'approve_payroll_posting'] });
  const treasurer = await createRep(base, m, { permissions: ['view_app', 'view_treasury', 'approve_vouchers'] });
  const main = ok(await m.get('/api/treasury/boxes'))[0];
  const syp = ok(await m.post('/api/treasury/boxes', { name: 'صندوق الليرة', kind: 'cash', currencyCode: 'SYP' }), 201);
  for (const b of [main, syp]) ok(await m.put(`/api/treasury/boxes/${b.id}`, { userIds: [treasurer.userId, poster.userId] }));
  ok(await m.put('/api/payroll/settings', { expenseAccountId: acc('6100'), employerExpenseAccountId: acc('6500'), salariesPayableAccountId: acc('2130'), deductionsPayableAccountId: acc('2135'), advancesAccountId: acc('1160') }));
  c = { ...co, m, acc, poster: poster.client, treasurer: treasurer.client, main, syp };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('deduction types: the default type mirrors the settings account; new types need a liability account and a unique code', async () => {
  const types = ok(await c.m.get('/api/payroll/deduction-types'));
  assert.deepEqual(types.map((t) => [t.code, t.account_code, t.is_default]), [['default', '2135', 1]]);
  ok(await c.m.post('/api/payroll/deduction-types', { code: 'social_insurance', name: 'التأمينات الاجتماعية', accountId: c.acc('2136') }), 201);
  ok(await c.m.post('/api/payroll/deduction-types', { code: 'income_tax', name: 'ضريبة الرواتب', accountId: c.acc('2137') }), 201);
  assert.equal(ok(await c.m.post('/api/payroll/deduction-types', { code: 'income_tax', name: 'x', accountId: c.acc('2137') }), 409).error, 'code_exists');
  assert.equal(ok(await c.m.post('/api/payroll/deduction-types', { code: 'bad', name: 'x', accountId: c.acc('6100') }), 400).error, 'invalid_account_type');
  assert.equal(ok(await c.m.post('/api/payroll/deduction-types', { code: 'advance_recovery', name: 'x', accountId: c.acc('2137') }), 400).error, 'invalid_code');
});

test('import split by type must add up; accrual credits each type account; balances per type; payment per type (USD at par, SYP with realized FX)', async () => {
  // An advance to recover.
  const adv = ok(await c.m.post('/api/payroll/advances', { employeeRef: 'E-1', cashBoxId: c.main.id, amount: '50', date: `${Y}-03-01` }), 201);
  ok(await c.treasurer.post(`/api/treasury/vouchers/${adv.voucher_id}/approve`, {}));
  const body = {
    period: `${Y}-03`, externalId: 'HR-03',
    lines: [
      { department: 'المبيعات', currencyCode: 'USD', gross: '3000', deductions: '350', employerContributions: '200', net: '2650',
        deductionsByType: [{ type: 'social_insurance', amount: '150' }, { type: 'income_tax', amount: '100' }, { type: 'advance_recovery', amount: '50' }, { type: 'default', amount: '50' }],
        employerContributionsByType: [{ type: 'social_insurance', amount: '200' }] },
      { department: 'المعمل', currencyCode: 'SYP', gross: '13500000', deductions: '1350000', net: '12150000', deductionsByType: [{ type: 'income_tax', amount: '1350000' }] },
    ],
    advanceRecoveries: [{ employeeRef: 'E-1', currencyCode: 'USD', amount: '50' }],
  };
  const bad = JSON.parse(JSON.stringify(body));
  bad.lines[0].deductionsByType[0].amount = '151';
  assert.deepEqual(ok(await c.m.post('/api/payroll/periods/import', bad), 400).errors.map((e) => e.error), ['breakdown_mismatch']);
  const unknown = JSON.parse(JSON.stringify(body));
  unknown.lines[0].deductionsByType[0].type = 'pension';
  assert.deepEqual(ok(await c.m.post('/api/payroll/periods/import', unknown), 400).errors.map((e) => e.error), ['invalid_deduction_type']);
  const p = ok(await c.m.post('/api/payroll/periods/import', body), 201);
  const posted = ok(await c.poster.post(`/api/payroll/periods/${p.id}/post`, {}));
  const e = posted.journal_entry_id;
  assert.equal(credit(e, '2136'), 15000 + 20000, 'social insurance: employee 150 + employer 200');
  assert.equal(credit(e, '2137'), 10000 + 10000, 'income tax: USD 100.00 + SYP 1,350,000 / 13,500 = 100.00');
  assert.equal(credit(e, '2135'), 5000, 'default: 50 (the advance-recovery 50 went to the advance)');
  assert.equal(credit(e, '1160'), 5000);
  const rep = ok(await c.m.get('/api/payroll/reports/deductions'));
  const row = (code, cur) => rep.rows.find((r) => r.code === code && r.currency === cur);
  assert.deepEqual([row('social_insurance', 'USD').outstanding, row('income_tax', 'USD').outstanding, row('income_tax', 'SYP').outstanding, row('default', 'USD').outstanding], [35000, 10000, 1350000, 5000]);
  for (const a of rep.accounts) assert.equal(a.ledger_minor, bal(a.code), a.code);
  // Pay social insurance (USD) and the SYP income tax at 15,000.
  const si = ok(await c.poster.post('/api/payroll/deduction-payments', { typeCode: 'social_insurance', cashBoxId: c.main.id, date: `${Y}-04-10` }), 201);
  assert.equal(si.amount_minor, 35000);
  assert.equal(ok(await c.poster.post('/api/payroll/deduction-payments', { typeCode: 'social_insurance', cashBoxId: c.main.id }), 409).error, 'nothing_to_pay');
  ok(await c.treasurer.post(`/api/treasury/vouchers/${si.voucher_id}/approve`, {}));
  assert.equal(bal('2136'), 0);
  const tx = ok(await c.poster.post('/api/payroll/deduction-payments', { typeCode: 'income_tax', cashBoxId: c.syp.id, date: `${Y}-04-10` }), 201);
  assert.equal(tx.amount_minor, 1350000);
  const fxBefore = bal('6800');
  const v = ok(await c.treasurer.post(`/api/treasury/vouchers/${tx.voucher_id}/approve`, {}));
  assert.equal(db.prepare("SELECT COALESCE(SUM(l.debit_minor), 0) d FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.code = '2137'").get(v.journal_entry_id).d, 10000, 'relieved at accrual value 100.00');
  assert.equal(bal('6800') - fxBefore, 1000, 'paid 90.00 at 15,000 -> realized gain 10.00');
  assert.equal(bal('2137'), 10000, 'only the USD income tax remains');
  const after = ok(await c.m.get('/api/payroll/reports/deductions'));
  assert.equal(after.rows.find((r) => r.code === 'income_tax' && r.currency === 'SYP').outstanding_base, 0);
});

test('migration 0028: an existing single-account setup becomes one default type, and posted periods get their per-type balance', async () => {
  // Simulate a company configured and posted before 0028.
  db.prepare('DELETE FROM payroll_period_deductions WHERE company_id = ?').run(c.companyId);
  db.prepare('DELETE FROM payroll_line_deductions WHERE company_id = ?').run(c.companyId);
  db.prepare("DELETE FROM payroll_deduction_payments WHERE company_id = ?").run(c.companyId);
  db.prepare('DELETE FROM payroll_deduction_types WHERE company_id = ?').run(c.companyId);
  const p = ok(await c.m.post('/api/payroll/periods/import', { period: `${Y}-05`, externalId: 'HR-05', lines: [{ department: 'x', currencyCode: 'USD', gross: '100', deductions: '10', employerContributions: '5', net: '90' }] }), 201);
  // (no default type yet: posting needs the migration / settings)
  require('../db/migrations/0028_payroll_deduction_types').up(db);
  const types = db.prepare('SELECT code, is_default, account_id FROM payroll_deduction_types WHERE company_id = ?').all(c.companyId).map((r) => ({ ...r }));
  assert.deepEqual(types, [{ code: 'default', is_default: 1, account_id: c.acc('2135') }]);
  const posted = ok(await c.poster.post(`/api/payroll/periods/${p.id}/post`, {}));
  assert.equal(credit(posted.journal_entry_id, '2135'), 1500, 'deductions + employer contributions on the one account, as before');
  require('../db/migrations/0028_payroll_deduction_types').up(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payroll_deduction_types WHERE company_id = ?').get(c.companyId).n, 1, 'idempotent');
});
