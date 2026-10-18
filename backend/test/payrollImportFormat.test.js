// backend/test/payrollImportFormat.test.js
//
// Payroll import format (before Prompt 12, item 4): the documented CSV
// template (docs/payroll-import-template.csv) imports as-is; the JSON
// schema (docs/payroll-import.schema.json) matches what the import takes;
// a file with bad rows is rejected ENTIRELY (nothing written) with every
// row's error and its row number — CSV and JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pimp-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const TEMPLATE = fs.readFileSync(path.join(DOCS, 'payroll-import-template.csv'), 'utf8');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(DOCS, 'payroll-import.schema.json'), 'utf8'));
let listener;
let c;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const counts = () => ['payroll_periods', 'payroll_lines', 'payroll_advance_recoveries', 'payroll_line_deductions'].map((t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE company_id = ?`).get(c.companyId).n);

test.before(async () => {
  listener = app.listen(0);
  const co = await h.createUsdCompany(`http://localhost:${listener.address().port}`, 'استيراد الرواتب');
  const m = co.manager;
  await h.setupLedger(m, 'trading');
  ok((await h.goLive(m, '2026-01-01')).res);
  const acc = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(co.companyId, code)?.id;
  for (const [code, name] of [['2135', 'استقطاعات'], ['2136', 'تأمينات'], ['2137', 'ضريبة']]) ok(await m.post('/api/ledger/accounts', { code, nameAr: name, type: 'liability', parentId: acc('21') }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '13500', rateQuote: 'foreign_per_base', effectiveAt: '2026-01-01' }), 201);
  for (const [code, name] of [['S', 'المبيعات'], ['P', 'المعمل']]) ok(await m.post('/api/ledger/cost-centers', { code, name }), 201);
  ok(await m.put('/api/payroll/settings', { expenseAccountId: acc('6100'), employerExpenseAccountId: acc('6500'), salariesPayableAccountId: acc('2130'), deductionsPayableAccountId: acc('2135'), advancesAccountId: acc('1160') }));
  ok(await m.post('/api/payroll/deduction-types', { code: 'social_insurance', name: 'تأمينات', accountId: acc('2136') }), 201);
  ok(await m.post('/api/payroll/deduction-types', { code: 'income_tax', name: 'ضريبة', accountId: acc('2137') }), 201);
  // The template recovers an advance of E-1: pay it first.
  const main = ok(await m.get('/api/treasury/boxes'))[0];
  const adv = ok(await m.post('/api/payroll/advances', { employeeRef: 'E-1', cashBoxId: main.id, amount: '50', date: '2026-02-01' }), 201);
  ok(await m.post(`/api/treasury/vouchers/${adv.voucher_id}/approve`, {}));
  c = { ...co, m };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('the documented CSV template imports as-is and posts', async () => {
  const p = ok(await c.m.post('/api/payroll/periods/import-csv', { period: '2026-03', externalId: 'TEMPLATE', csv: TEMPLATE }), 201);
  assert.equal(p.lines.length, 2);
  assert.equal(p.recoveries.length, 1);
  assert.deepEqual(p.totals.USD, { gross_minor: 300000, deductions_minor: 35000, employer_contrib_minor: 20000, net_minor: 265000, paid_minor: 0 });
  assert.equal(p.lines[0].cost_center_code, 'S');
  // Same file again: a replay, nothing new.
  assert.equal(ok(await c.m.post('/api/payroll/periods/import-csv', { period: '2026-03', externalId: 'TEMPLATE', csv: TEMPLATE }), 200).replay, true);
  ok(await c.m.post(`/api/payroll/periods/${p.id}/post`, { breakGlassReason: undefined }));
});

test('CSV with bad rows: rejected entirely, nothing written, every bad row reported with its CSV row number', async () => {
  const bad = [
    'record_type,department,cost_center_code,currency,gross,deductions,employer_contributions,net,ded:income_tax,employee_ref,amount',
    'line,المبيعات,S,USD,1000,100,0,900,100,,',          // row 2: good
    'line,المعمل,P,USD,1000,100,0,800,100,,',            // row 3: net != gross - deductions
    'line,المخزن,ZZ,USD,10,0,0,10,,,',                   // row 4: unknown cost center
    'line,الإدارة,,XYZ,10,0,0,10,,,',                    // row 5: unknown currency
    'line,التوزيع,,USD,10,5,0,5,4,,',                     // row 6: split 4 != deductions 5
    'recovery,,,USD,,,,,,,10',                            // row 7: employee_ref missing
    'bonus,,,USD,,,,,,,',                                 // row 8: unknown record type
  ].join('\n');
  const before = counts();
  const r = ok(await c.m.post('/api/payroll/periods/import-csv', { period: '2026-04', externalId: 'BAD', csv: bad }), 400);
  assert.equal(r.error, 'import_invalid');
  assert.deepEqual(r.errors.map((e) => [e.row, e.error]), [[3, 'net_mismatch'], [4, 'invalid_cost_center'], [5, 'invalid_currency'], [6, 'breakdown_mismatch'], [7, 'employee_ref_required'], [8, 'invalid_record_type']]);
  assert.deepEqual(counts(), before, 'nothing written — not even the good row');
  const header = ok(await c.m.post('/api/payroll/periods/import-csv', { period: '2026-04', externalId: 'BAD2', csv: 'department,currency,salary\nx,USD,1' }), 400);
  assert.deepEqual(header.errors.map((e) => [e.row, e.error]), [[1, 'unknown_column']]);
});

test('JSON with bad rows: rejected entirely with every row error', async () => {
  const before = counts();
  const r = ok(await c.m.post('/api/payroll/periods/import', { period: '2026-05', externalId: 'J', lines: [
    { department: 'a', currencyCode: 'USD', gross: '10', deductions: '0', net: '10' },
    { department: '', currencyCode: 'USD', gross: '10', deductions: '0', net: '10' },
    { department: 'c', currencyCode: 'USD', gross: '10.001', deductions: '0', net: '10' },
  ], advanceRecoveries: [{ employeeRef: 'E-1', currencyCode: 'USD', amount: '0' }] }), 400);
  assert.deepEqual(r.errors.map((e) => [e.section, e.row, e.error]), [['lines', 2, 'department_required'], ['lines', 3, 'invalid_amount'], ['advanceRecoveries', 1, 'invalid_amount']]);
  assert.deepEqual(counts(), before);
});

test('the JSON schema and the template describe what the import accepts', () => {
  assert.deepEqual(SCHEMA.required, ['period', 'externalId', 'lines']);
  const lineProps = Object.keys(SCHEMA.properties.lines.items.properties).sort();
  for (const k of ['department', 'costCenterId', 'currencyCode', 'gross', 'deductions', 'employerContributions', 'net', 'headcount', 'deductionsByType', 'employerContributionsByType']) assert.ok(lineProps.includes(k), k);
  assert.deepEqual(Object.keys(SCHEMA.properties.advanceRecoveries.items.properties).sort(), ['amount', 'amountMinor', 'currencyCode', 'employeeRef']);
  const header = TEMPLATE.split('\n')[0].split(',');
  for (const col of header) assert.ok(/^(record_type|department|cost_center_code|currency|gross|deductions|employer_contributions|net|headcount|employee_ref|amount)$/.test(col) || /^(ded|emp):[a-z0-9_]+$/.test(col), col);
});
