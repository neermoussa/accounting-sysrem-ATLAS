// backend/test/accountingExtras.test.js
//
// Prompt 10 "Done when":
//  - depreciation posts once per period (idempotent, catch-up, parallel runs);
//  - disposal posts the correct gain / loss;
//  - the tax report reconciles to the tax accounts;
//  - recurring templates generate entries on schedule and never twice.
// Plus: straight line (cumulative rounding) and declining balance to
// salvage, asset from a supplier invoice line, effective-dated tax rates,
// tax-inclusive / exclusive price modes, accrual auto-reversal, prepayment
// amortisation, month-end checklist items, failure injection on every
// money path, tenant refs, permissions.
// (A company with no tax codes / assets / templates: test/taxGolden.test.js.)
//
// Hand calculations
//  Laptop: 12,000.00, salvage 0, 36 months, straight line from January:
//    accumulated after k months = round(1,200,000 * k / 36) minor
//    -> Jan 333.33, Feb 333.34, Mar 333.33; 6 months = 2,000.00
//    sold 10 July for 11,000.00: NBV 10,000.00 -> gain 1,000.00
//  Van: 10,000.00, salvage 1,000.00, 6 months, declining balance (default
//    rate 2/life capped at 100%/year -> NBV / 12 per month):
//    833.33, 763.89, 700.23, 641.88, 588.39, last month to salvage 4,472.28
//    total 9,000.00 = cost - salvage
//  Printer: 600.00, 12 months from March, scrapped 15 May (no proceeds):
//    Mar 50.00, Apr 50.00 -> NBV 500.00 -> loss 500.00

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-acx-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
// Fixed clock: this file is pinned to 20 Nov 2026 whatever the real date
// (lib/clock.js; npm test pins the same instant for every file).
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const faults = require('../lib/faultInjection');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const Y = '2026';
const D = `${Y}-11-20`;
assert.equal(new Date().toISOString().slice(0, 10), D, 'clock pinned (ATLAS_TEST_NOW)');
const ym = (m) => `${Y}-${String(m).padStart(2, '0')}`;
let listener;
let base;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const verb = (m) => (m === 'delete' ? 'del' : m);
const lines = (entryId) => db.prepare('SELECT a.code, l.debit_minor d, l.credit_minor c FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId).map((x) => ({ ...x }));
const count = (sql, ...p) => db.prepare(sql).get(...p).c;
const bal = (cid, code) => db.prepare("SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND a.code = ?").get(cid, code).b;

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة الأصول والضرائب');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m, 'trading');
  ok((await h.goLive(m, `${Y}-01-01`)).res);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  const head = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(co.companyId, code).id;
  const vatOut = ok(await m.post('/api/ledger/accounts', { code: '2145', nameAr: 'ضريبة القيمة المضافة — مخرجات', type: 'liability', parentId: head('21') }), 201);
  const vatIn = ok(await m.post('/api/ledger/accounts', { code: '1185', nameAr: 'ضريبة القيمة المضافة — مدخلات', type: 'asset', parentId: head('11') }), 201);
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد الأصول', currencyCode: 'USD' }), 201);
  const shop = await h.mkShop(m, 'زبون الضريبة');
  ctx = { co, m, acc, vatOut: vatOut.id, vatIn: vatIn.id, supplier, shop };
});
test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const api = (method, url, body) => ctx.m[verb(method)](`/api/accounting${url}`, body);

test('fixed assets: straight line with cumulative rounding, posted once per period (re-run, catch-up, parallel runs)', async () => {
  const { acc, co } = ctx;
  const cat = ok(await api('post', '/asset-categories', { name: 'أجهزة وأثاث', assetAccountId: acc('1230'), accumulatedAccountId: acc('1290'), expenseAccountId: acc('6600'), disposalAccountId: acc('4900'), defaultLifeMonths: 36 }), 201);
  ctx.cat = cat;
  const laptop = ok(await api('post', '/assets', { categoryId: cat.id, name: 'حاسب محمول', cost: '12000', purchaseDate: `${Y}-01-15`, fundingAccountId: acc('1110') }), 201);
  ctx.laptop = laptop;
  assert.equal(laptop.cost_minor, 1200000);
  assert.equal(laptop.depreciation_start, `${Y}-01-01`);
  assert.deepEqual(lines(db.prepare("SELECT id FROM journal_entries WHERE source_type = 'fixed_asset' AND source_id = ?").get(laptop.id).id), [{ code: '1230', d: 1200000, c: 0 }, { code: '1110', d: 0, c: 1200000 }]);
  const r1 = ok(await api('post', '/depreciation/run', { period: ym(3) }));
  assert.deepEqual(r1.posted.map((p) => [p.period, p.amount_minor]), [[ym(1), 33333], [ym(2), 33334], [ym(3), 33333]]);
  const je = count("SELECT COUNT(*) c FROM journal_entries WHERE company_id = ? AND source_type = 'fa_depreciation'", co.companyId);
  // Same period again, an earlier one, and two parallel runs: nothing new.
  assert.equal(ok(await api('post', '/depreciation/run', { period: ym(3) })).entries, 0);
  assert.equal(ok(await api('post', '/depreciation/run', { period: ym(2) })).entries, 0);
  const par = await Promise.all([api('post', '/depreciation/run', { period: ym(3) }), api('post', '/depreciation/run', { period: ym(3) })]);
  assert.deepEqual(par.map((r) => r.body.entries), [0, 0]);
  assert.equal(count("SELECT COUNT(*) c FROM journal_entries WHERE company_id = ? AND source_type = 'fa_depreciation'", co.companyId), je);
  assert.equal(bal(co.companyId, '1290'), -100000);
  assert.equal(bal(co.companyId, '6600'), 100000);
  const sched = ok(await api('get', `/assets/${laptop.id}/schedule`));
  assert.equal(sched.rows.length, 36);
  assert.equal(sched.rows.reduce((s, r) => s + r.amount_minor, 0), 1200000, 'the schedule depreciates exactly the cost');
  assert.deepEqual(sched.rows.slice(0, 4).map((r) => r.posted), [true, true, true, false]);
  assert.equal(ok(await api('post', '/depreciation/run', { period: 'March' }), 400).error, 'invalid_period');
});

test('fixed assets: declining balance ends exactly at salvage, then the asset is fully depreciated', async () => {
  const { acc } = ctx;
  const van = ok(await api('post', '/assets', { categoryId: ctx.cat.id, name: 'سيارة توزيع', cost: '10000', salvage: '1000', purchaseDate: `${Y}-01-03`, usefulLifeMonths: 6, method: 'declining_balance' }), 201);
  assert.equal(van.declining_rate_bp, 10000);
  assert.equal(count("SELECT COUNT(*) c FROM journal_entries WHERE source_type = 'fixed_asset' AND source_id = ?", van.id), 0, 'registered without a funding account: no entry');
  ok(await api('post', '/depreciation/run', { period: ym(6) }));
  const got = ok(await api('get', `/assets/${van.id}`));
  assert.deepEqual(got.depreciation.map((d) => d.amount_minor), [83333, 76389, 70023, 64188, 58839, 547228]);
  assert.equal(got.accumulated_minor, 900000);
  assert.equal(got.nbv_minor, 100000);
  assert.equal(got.status, 'fully_depreciated');
  assert.equal(ok(await api('post', '/depreciation/run', { period: ym(6) })).entries, 0);
  void acc;
});

test('disposal: sale posts the gain, scrapping posts the loss, a second disposal is refused', async () => {
  const { acc, co } = ctx;
  // Laptop: catch-up to June (6 months = 2,000.00), sold 10 July for 11,000.00.
  const sold = ok(await api('post', `/assets/${ctx.laptop.id}/dispose`, { date: `${Y}-07-10`, proceeds: '11000', proceedsAccountId: acc('1120') }));
  assert.equal(sold.status, 'disposed');
  assert.equal(sold.nbv_at_disposal_minor, 1000000);
  assert.equal(sold.gain_loss_minor, 100000);
  assert.deepEqual(sold.depreciation.map((d) => d.period), [1, 2, 3, 4, 5, 6].map(ym), 'no depreciation in the disposal month');
  assert.deepEqual(lines(sold.disposal_entry_id), [
    { code: '1290', d: 200000, c: 0 },
    { code: '1120', d: 1100000, c: 0 },
    { code: '1230', d: 0, c: 1200000 },
    { code: '4900', d: 0, c: 100000 },
  ]);
  assert.equal(ok(await api('post', `/assets/${ctx.laptop.id}/dispose`, { date: `${Y}-07-11` }), 409).error, 'already_disposed');
  assert.equal(ok(await api('post', '/depreciation/run', { period: ym(9) })).posted.filter((p) => p.asset_id === ctx.laptop.id).length, 0, 'a disposed asset no longer depreciates');
  // Printer: scrapped with no proceeds -> loss = NBV.
  const printer = ok(await api('post', '/assets', { categoryId: ctx.cat.id, name: 'طابعة', cost: '600', purchaseDate: `${Y}-03-20`, usefulLifeMonths: 12, fundingAccountId: acc('1110') }), 201);
  const scrapped = ok(await api('post', `/assets/${printer.id}/dispose`, { date: `${Y}-05-15`, reason: 'تلف' }));
  assert.equal(scrapped.gain_loss_minor, -50000);
  assert.deepEqual(lines(scrapped.disposal_entry_id), [{ code: '1290', d: 10000, c: 0 }, { code: '1230', d: 0, c: 60000 }, { code: '4900', d: 50000, c: 0 }]);
  // Disposal date before an already-posted month is refused.
  const desk = ok(await api('post', '/assets', { categoryId: ctx.cat.id, name: 'مكتب', cost: '120', purchaseDate: `${Y}-01-05`, usefulLifeMonths: 12 }), 201);
  ok(await api('post', '/depreciation/run', { period: ym(4) }));
  assert.equal(ok(await api('post', `/assets/${desk.id}/dispose`, { date: `${Y}-03-01` }), 409).error, 'depreciated_after_disposal');
  // Asset schedule report: the sold laptop shows its period depreciation, no cost / NBV.
  const rep = ok(await api('get', `/asset-schedule?from=${Y}-01-01&to=${D}`));
  const lap = rep.rows.find((r) => r.id === ctx.laptop.id);
  assert.deepEqual([lap.status, lap.cost_minor, lap.nbv_minor, lap.depreciation_in_period_minor, lap.disposal_gain_loss_minor], ['disposed', 0, 0, 200000, 100000]);
  assert.equal(rep.totals.nbv_minor, rep.rows.reduce((s, r) => s + r.nbv_minor, 0));
  // Ledger: the fixed-asset account equals the register's cost of assets still held.
  const held = db.prepare("SELECT COALESCE(SUM(cost_minor), 0) s FROM fixed_assets WHERE company_id = ? AND status <> 'disposed' AND (id IN (SELECT source_id FROM journal_entries WHERE source_type = 'fixed_asset') OR supplier_invoice_id IS NOT NULL)").get(co.companyId).s;
  assert.equal(bal(co.companyId, '1230'), held);
});

test('tax codes: effective-dated rates, inclusive / exclusive price modes, asset from a supplier invoice line, tax report reconciles to the tax accounts', async () => {
  const { m, co, acc } = ctx;
  const vat = ok(await api('post', '/tax-codes', { code: 'VAT', name: 'ضريبة مبيعات', type: 'sales', accountId: ctx.vatOut, rate: '15', effectiveFrom: `${Y}-01-01`, priceMode: 'exclusive' }), 201);
  ok(await api('post', `/tax-codes/${vat.id}/rates`, { rate: '10', effectiveFrom: `${Y}-06-01` }), 201);
  const vin = ok(await api('post', '/tax-codes', { code: 'VIN', name: 'ضريبة مشتريات', type: 'purchase', accountId: ctx.vatIn, rate: '5', effectiveFrom: `${Y}-01-01` }), 201);
  // Exclusive (without_tax): March -> 15% on top.
  const i1 = ok(await m.post('/api/sales/invoices', { shopId: ctx.shop, invoiceDate: `${Y}-03-10`, lines: [{ description: 'خدمة', qty: 2, unitPrice: '100.00', taxCodeId: vat.id }] }), 201);
  assert.deepEqual([i1.lines[0].tax_rate_bp, i1.lines[0].net_minor, i1.lines[0].tax_minor], [1500, 20000, 3000]);
  ok(await m.post(`/api/sales/invoices/${i1.id}/post`, {}));
  // Inclusive (with_tax): July -> 10% inside the price: 110.00 = 100.00 + 10.00.
  ok(await api('put', '/price-mode', { mode: 'inclusive' }));
  const i2 = ok(await m.post('/api/sales/invoices', { shopId: ctx.shop, invoiceDate: `${Y}-07-01`, lines: [{ description: 'خدمة', qty: 1, unitPrice: '110.00', taxCodeId: vat.id }, { description: 'بدون رمز', qty: 1, unitPrice: '50.00', taxRate: '15' }] }), 201);
  assert.deepEqual([i2.lines[0].tax_rate_bp, i2.lines[0].net_minor, i2.lines[0].tax_minor, i2.total_minor], [1000, 10000, 1000, 11000 + 5750]);
  const p2 = ok(await m.post(`/api/sales/invoices/${i2.id}/post`, {}));
  ok(await m.post('/api/sales/credit-notes', { invoiceId: i2.id, lines: [{ invoiceLineId: p2.lines[0].id, qty: 1 }] }), 201);
  // A purchase code on a sales line is refused.
  assert.equal(ok(await m.post('/api/sales/invoices', { shopId: ctx.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '1', taxCodeId: vin.id }] }), 400).error, 'tax_code_type');
  // Supplier expense invoice: a coded expense line and an asset line.
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: ctx.supplier.id, invoiceDate: `${Y}-04-02`, lines: [
    { description: 'إيجار نيسان', qty: 1, unitPrice: '1000', taxCodeId: vin.id, expenseAccountId: acc('6200') },
    { description: 'خادم', qty: 1, unitPrice: '2400', taxCodeId: vin.id, asset: { categoryId: ctx.cat.id, usefulLifeMonths: 24, name: 'خادم الشبكة' } },
  ] }), 201);
  assert.equal(inv.tax_minor, 5000 + 12000);
  const before = count('SELECT COUNT(*) c FROM fixed_assets WHERE company_id = ?', co.companyId);
  const pinv = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  const je = lines(pinv.journal_entry_id);
  assert.deepEqual(je.filter((l) => ['6200', '1230', '1185', '1180'].includes(l.code)), [{ code: '6200', d: 100000, c: 0 }, { code: '1230', d: 240000, c: 0 }, { code: '1185', d: 17000, c: 0 }]);
  const server = db.prepare('SELECT * FROM fixed_assets WHERE supplier_invoice_id = ?').get(inv.id);
  assert.equal(count('SELECT COUNT(*) c FROM fixed_assets WHERE company_id = ?', co.companyId), before + 1);
  assert.deepEqual([server.name, server.cost_minor, server.useful_life_months, server.purchase_date], ['خادم الشبكة', 240000, 24, `${Y}-04-02`]);
  // The asset line cannot be returned by a debit note; the rent line can (tax back to its code account).
  assert.equal(ok(await m.post('/api/purchasing/debit-notes', { invoiceId: inv.id, lines: [{ invoiceLineId: pinv.lines[1].id, qty: 1 }] }), 409).error, 'asset_line_debit_note');
  const dn = ok(await m.post('/api/purchasing/debit-notes', { invoiceId: inv.id, date: `${Y}-04-20`, lines: [{ invoiceLineId: pinv.lines[0].id, qty: 0.5 }] }), 201);
  assert.ok(lines(dn.journal_entry_id).some((l) => l.code === '1185' && l.c === 2500));
  // Report: output on 2145 = 30.00 + 10.00 - 10.00; input on 1185 = 170.00 - 25.00.
  const rep = ok(await api('get', `/tax-report?from=${Y}-01-01&to=${D}`));
  const a2145 = rep.accounts.find((a) => a.code === '2145');
  const a1185 = rep.accounts.find((a) => a.code === '1185');
  assert.equal(a2145.net_credit_minor, 3000);
  assert.equal(a1185.net_credit_minor, -14500);
  assert.equal(a2145.net_credit_minor, bal(co.companyId, '2145') * -1, 'report = ledger balance of the tax account');
  assert.ok(rep.reconciled, JSON.stringify(rep.reconciliation));
  assert.deepEqual(rep.reconciliation.map((r) => [r.code, r.difference_minor]).sort(), [['1180', 0], ['1185', 0], ['2140', 0], ['2145', 0]], 'every tax account (code accounts and output / input tax)');
  const byCode = Object.fromEntries(rep.codes.map((c) => [`${c.code}@${c.rate}`, [c.base_minor, c.tax_minor]]));
  assert.deepEqual(byCode, { 'VAT@15': [20000, 3000], 'VAT@10': [0, 0], 'VIN@5': [290000, 14500] });
  // The free-rate line still posts to output_tax and shows in the report's output total.
  assert.equal(rep.output_tax_minor, 3000 + 750);
  // A manual journal on a code account is a difference between documents and ledger ...
  ok(await m.post('/api/ledger/entries', { date: D, description: 'تسوية يدوية', post: true, lines: [{ accountId: ctx.vatOut, creditMinor: 100 }, { accountId: acc('1110'), debitMinor: 100 }] }), 201);
  const rep2 = ok(await api('get', `/tax-report?from=${Y}-01-01&to=${D}`));
  // ... and is reported as its own 'other' row: the report still adds up to the ledger.
  assert.equal(rep2.reconciled, true);
  assert.equal(rep2.reconciliation.find((r) => r.code === '2145').difference_minor, 100, 'ledger vs documents');
  assert.equal(rep2.reconciliation.find((r) => r.code === '2145').other_net_credit_minor, 100);
  assert.equal(rep2.rows.find((r) => r.section === 'other' && r.source_type === 'manual').tax_base_minor, 100);
  // No rate in effect before the first effective date.
  assert.equal(ok(await m.post('/api/sales/invoices', { shopId: ctx.shop, invoiceDate: `${Number(Y) - 1}-12-31`, lines: [{ description: 'x', qty: 1, unitPrice: '1', taxCodeId: vat.id }] }), 400).error, 'tax_rate_not_effective');
});

test('recurring templates: on schedule, never twice; accrual reversed on the 1st of next month; prepayment amortised to the exact total', async () => {
  const { acc, co } = ctx;
  const rent = ok(await api('post', '/recurring', { name: 'إيجار المستودع', kind: 'recurring', startDate: `${Y}-01-01`, dayOfMonth: 1, lines: [{ accountId: acc('6200'), debitMinor: 50000 }, { accountId: acc('2130'), creditMinor: 50000 }] }), 201);
  const accrual = ok(await api('post', '/recurring', { name: 'كهرباء مستحقة', kind: 'accrual', startDate: `${Y}-01-31`, dayOfMonth: 31, occurrences: 3, lines: [{ accountId: acc('6300'), debitMinor: 12000 }, { accountId: acc('2130'), creditMinor: 12000 }] }), 201);
  const prepaid = ok(await api('post', '/recurring', { name: 'تأمين مدفوع مقدمًا', kind: 'prepayment', startDate: `${Y}-01-31`, dayOfMonth: 31, occurrences: 3, total: '1000', debitAccountId: acc('6500'), creditAccountId: acc('1170') }), 201);
  const r1 = ok(await api('post', '/recurring/run', { asOf: `${Y}-03-15` }));
  assert.deepEqual(r1.posted.filter((p) => p.template_id === rent.id).map((p) => p.run_date), [`${Y}-01-01`, `${Y}-02-01`, `${Y}-03-01`]);
  assert.deepEqual(r1.posted.filter((p) => p.template_id === accrual.id).map((p) => p.run_date), [`${Y}-01-31`, `${Y}-02-${Number(Y) % 4 === 0 ? 29 : 28}`]);
  assert.deepEqual(r1.reversed.map((x) => x.date), [`${Y}-02-01`, `${Y}-03-01`]);
  const n = count("SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?", co.companyId);
  // Again, and two at once: nothing new.
  assert.deepEqual(ok(await api('post', '/recurring/run', { asOf: `${Y}-03-15` })).posted, []);
  const par = await Promise.all([api('post', '/recurring/run', { asOf: `${Y}-03-15` }), api('post', '/recurring/run', { asOf: `${Y}-03-15` })]);
  assert.deepEqual(par.map((r) => [r.status, r.body.posted.length, r.body.reversed.length]), [[200, 0, 0], [200, 0, 0]]);
  assert.equal(count("SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?", co.companyId), n);
  // To the end of the schedule.
  ok(await api('post', '/recurring/run', { asOf: `${Y}-06-30` }));
  assert.deepEqual(db.prepare('SELECT amount_minor FROM recurring_runs WHERE template_id = ? ORDER BY run_date').all(prepaid.id).map((r) => r.amount_minor), [33333, 33334, 33333]);
  assert.equal(bal(co.companyId, '6500'), 100000);
  assert.equal(count('SELECT COUNT(*) c FROM recurring_runs WHERE template_id = ?', accrual.id), 3);
  assert.equal(count('SELECT COUNT(*) c FROM recurring_runs WHERE template_id = ? AND reversal_entry_id IS NOT NULL', accrual.id), 3, 'every accrual reversed');
  assert.equal(bal(co.companyId, '6300'), 0, 'accrued then reversed: nets to zero until the bill is booked');
  assert.equal(count('SELECT COUNT(*) c FROM recurring_runs WHERE template_id = ?', rent.id), 6);
  // A schedule change that would move posted dates is refused.
  assert.equal(ok(await api('put', `/recurring/${rent.id}`, { dayOfMonth: 5 }), 409).error, 'template_has_runs');
  assert.equal(ok(await api('post', '/recurring', { name: 'x', kind: 'recurring', startDate: D, lines: [{ accountId: acc('6200'), debitMinor: 1 }, { accountId: acc('2130'), creditMinor: 2 }] }), 400).error, 'unbalanced');
  assert.equal(ok(await api('get', `/recurring/${rent.id}`)).next_date, `${Y}-07-01`);
});

test('month-end checklist: missing depreciation and due templates block, only for a company that uses them', async () => {
  const { co } = ctx;
  const period = db.prepare('SELECT id FROM fiscal_periods WHERE company_id = ? AND start_date <= ? AND end_date >= ?').get(co.companyId, `${Y}-09-15`, `${Y}-09-15`);
  const items = async () => Object.fromEntries(ok(await ctx.m.get(`/api/financial-reports/month-end/${period.id}`)).items.map((i) => [i.key, i.count]));
  const before = await items();
  assert.ok(before.depreciation_not_posted > 0);
  assert.ok(before.recurring_entries_due > 0);
  ok(await api('post', '/depreciation/run', { period: ym(9) }));
  ok(await api('post', '/recurring/run', { asOf: `${Y}-09-30` }));
  const after = await items();
  assert.equal(after.depreciation_not_posted, 0);
  assert.equal(after.recurring_entries_due, 0);
  // Another company with neither feature: no such items.
  const other = await h.createUsdCompany(base, 'شركة بلا أصول');
  await h.setupLedger(other.manager);
  const op = db.prepare('SELECT id FROM fiscal_periods WHERE company_id = ? LIMIT 1').get(other.companyId);
  const keys = ok(await other.manager.get(`/api/financial-reports/month-end/${op.id}`)).items.map((i) => i.key);
  assert.ok(!keys.includes('depreciation_not_posted') && !keys.includes('recurring_entries_due'));
});

test('failure injection: every money path rolls back completely', async () => {
  const { acc, co, m } = ctx;
  const cid = co.companyId;
  const snapshot = () => [
    count('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?', cid),
    count('SELECT COUNT(*) c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ?', cid),
    count('SELECT COUNT(*) c FROM fixed_assets WHERE company_id = ?', cid),
    count('SELECT COUNT(*) c FROM fa_depreciation WHERE company_id = ?', cid),
    count('SELECT COUNT(*) c FROM recurring_runs WHERE company_id = ?', cid),
    count("SELECT COUNT(*) c FROM fixed_assets WHERE company_id = ? AND status = 'disposed'", cid),
    count("SELECT COUNT(*) c FROM supplier_invoices WHERE company_id = ? AND status = 'posted'", cid),
  ];
  const asset = ok(await api('post', '/assets', { categoryId: ctx.cat.id, name: 'جهاز للاختبار', cost: '360', purchaseDate: `${Y}-10-01`, usefulLifeMonths: 12 }), 201);
  ok(await api('post', '/recurring', { name: 'اشتراك', kind: 'accrual', startDate: `${Y}-10-01`, dayOfMonth: 1, lines: [{ accountId: acc('6500'), debitMinor: 100 }, { accountId: acc('2130'), creditMinor: 100 }] }), 201);
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: ctx.supplier.id, invoiceDate: D, lines: [{ description: 'رف', qty: 1, unitPrice: '50', asset: { categoryId: ctx.cat.id, usefulLifeMonths: 12 } }] }), 201);
  for (const [point, call] of [
    ['fixed_assets.create.after_entry', () => api('post', '/assets', { categoryId: ctx.cat.id, name: 'x', cost: '10', purchaseDate: D, usefulLifeMonths: 12, fundingAccountId: acc('1110') })],
    ['fixed_assets.depreciation.after_entry', () => api('post', '/depreciation/run', { period: ym(Number(D.slice(5, 7))) })],
    ['fixed_assets.dispose.after_entry', () => api('post', `/assets/${asset.id}/dispose`, { date: D, proceeds: '100', proceedsAccountId: acc('1110') })],
    ['recurring.run.after_entry', () => api('post', '/recurring/run', { asOf: `${Y}-10-15` })],
    ['payables.invoice.after_entry', () => m.post(`/api/purchasing/invoices/${inv.id}/post`, {})],
  ]) {
    const before = snapshot();
    faults.arm(point);
    assert.equal((await call()).status, 500, point);
    faults.disarmAll();
    assert.deepEqual(snapshot(), before, `${point}: rolled back`);
  }
  // Accrual reversal: post the 1 October accrual first, then fail its 1 November reversal.
  ok(await api('post', '/recurring/run', { asOf: `${Y}-10-15` }));
  const before = snapshot();
  faults.arm('recurring.reversal.after_entry');
  assert.equal((await api('post', '/recurring/run', { asOf: `${Y}-11-01` })).status, 500);
  faults.disarmAll();
  assert.deepEqual(snapshot(), before, 'reversal rolled back');
  assert.ok(require('../lib/ledger').ledgerIntegrityCheck(cid).violations.length === 0);
});

test('tenant refs and permissions', async () => {
  const other = await h.createUsdCompany(base, 'شركة أخرى');
  const om = other.manager;
  const { accounts } = await h.setupLedger(om);
  ok((await h.goLive(om, `${Y}-01-01`)).res);
  const oacc = (code) => accounts.find((a) => a.code === code).id;
  const { acc } = ctx;
  const code = db.prepare('SELECT id FROM tax_codes WHERE company_id = ? LIMIT 1').get(ctx.co.companyId).id;
  const tpl = db.prepare('SELECT id FROM recurring_templates WHERE company_id = ? LIMIT 1').get(ctx.co.companyId).id;
  const asset = db.prepare("SELECT id FROM fixed_assets WHERE company_id = ? AND status = 'active' LIMIT 1").get(ctx.co.companyId).id;
  const osup = ok(await om.post('/api/purchasing/suppliers', { name: 'مورد آخر', currencyCode: 'USD' }), 201);
  const oapi = (method, url, body) => om[verb(method)](`/api/accounting${url}`, body);
  for (const [method, url, body] of [
    ['post', '/asset-categories', { name: 'x', assetAccountId: acc('1230'), accumulatedAccountId: oacc('1290'), expenseAccountId: oacc('6600'), disposalAccountId: oacc('4900') }],
    ['put', `/asset-categories/${ctx.cat.id}`, { name: 'y' }],
    ['post', '/assets', { categoryId: ctx.cat.id, name: 'x', cost: '1', purchaseDate: D, usefulLifeMonths: 1 }],
    ['get', `/assets/${asset}`],
    ['get', `/assets/${asset}/schedule`],
    ['post', `/assets/${asset}/dispose`, { date: D }],
    ['post', '/tax-codes', { code: 'X', name: 'x', type: 'sales', accountId: ctx.vatOut, rate: '1', effectiveFrom: D }],
    ['put', `/tax-codes/${code}`, { name: 'z' }],
    ['post', `/tax-codes/${code}/rates`, { rate: '1', effectiveFrom: D }],
    ['post', '/recurring', { name: 'x', kind: 'recurring', startDate: D, lines: [{ accountId: acc('6200'), debitMinor: 1 }, { accountId: oacc('2130'), creditMinor: 1 }] }],
    ['post', '/recurring', { name: 'x', kind: 'prepayment', startDate: D, occurrences: 2, total: '1', debitAccountId: oacc('6500'), creditAccountId: acc('1170') }],
    ['get', `/recurring/${tpl}`],
    ['put', `/recurring/${tpl}`, { name: 'z' }],
  ]) {
    const r = await oapi(method, url, body);
    assert.equal(r.status, 400, `${method} ${url}: ${JSON.stringify(r.body)}`);
  }
  // Foreign tax code / asset category on the other company's documents.
  const oshop = await h.mkShop(om, 'زبون آخر');
  assert.equal((await om.post('/api/sales/invoices', { shopId: oshop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '1', taxCodeId: code }] })).status, 400);
  assert.equal((await om.post('/api/purchasing/invoices', { kind: 'expense', supplierId: osup.id, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '1', asset: { categoryId: ctx.cat.id, usefulLifeMonths: 12 } }] })).status, 400);
  assert.equal(count('SELECT COUNT(*) c FROM fixed_assets WHERE company_id = ?', other.companyId), 0);
  assert.equal(count('SELECT COUNT(*) c FROM recurring_templates WHERE company_id = ?', other.companyId), 0);
  // Permissions.
  const nobody = await createRep(base, ctx.m, { permissions: ['view_app'] });
  for (const [method, url] of [['get', '/assets'], ['post', '/assets'], ['post', '/depreciation/run'], ['post', '/tax-codes'], ['get', '/tax-report'], ['post', '/recurring'], ['post', '/recurring/run']]) {
    assert.equal((await nobody.client[method](`/api/accounting${url}`, {})).status, 403, url);
  }
  const taxOnly = await createRep(base, ctx.m, { permissions: ['view_app', 'manage_tax_codes'] });
  assert.equal((await taxOnly.client.get(`/api/accounting/tax-report?from=${Y}-01-01&to=${D}`)).status, 200);
  assert.equal((await taxOnly.client.post('/api/accounting/depreciation/run', { period: ym(1) })).status, 403);
  assert.equal((await taxOnly.client.post('/api/accounting/recurring/run', {})).status, 403);
});
