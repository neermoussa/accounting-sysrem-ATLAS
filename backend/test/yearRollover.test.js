// backend/test/yearRollover.test.js
//
// Year rollover protection, driven by the injected clock (lib/clock.js
// setNow) crossing 31 Dec 2026 -> 1 Jan 2027 inside one process:
//  (a) the next fiscal year and its 12 periods are created automatically
//      from 1 Dec (idempotent, audited, skipped when it exists);
//  (b) the banner status warns 60 days before year end while the next year
//      is missing;
//  (c) a posting whose date has no fiscal period is kept in the visible
//      failed-posting queue with a retry action (never lost); the refusal
//      itself is unchanged;
//  (d) across the year end: posting, document numbering, depreciation,
//      recurring entries and accrual reversal, receipts against last
//      year's invoices, balances carried into the new year (year-end
//      close: P&L restarts, retained earnings take the result).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rollover-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = '2026-11-20';
const clock = require('../lib/clock');
clock.install();
clock.setNow('2026-11-20T09:00:00Z');

const app = require('../server');
const db = require('../db/init');
const YR = require('../lib/yearRollover');
const RE = require('../lib/recurringEntries');
const h = require('./salesHelpers');

let listener;
let base;
let c;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const today = () => new Date().toISOString().slice(0, 10);
// Sessions last 30 days: after moving the clock far ahead, log in again.
const relogin = (x) => x.m.login(x.managerContact, x.managerPassword);
const years = (cid) => db.prepare('SELECT year FROM fiscal_years WHERE company_id = ? ORDER BY year').all(cid).map((r) => r.year);
const bal = (cid, code, to) => db.prepare("SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND a.code = ? AND e.entry_date <= ?").get(cid, code, to).b;

async function company(name) {
  const co = await h.createUsdCompany(base, name);
  const { accounts } = await h.setupLedger(co.manager, 'trading');
  ok((await h.goLive(co.manager, '2026-01-01')).res);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  const shop = await h.mkShop(co.manager, 'زبون آخر السنة');
  return { ...co, m: co.manager, acc, shop };
}

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  c = await company('شركة نهاية السنة');
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('(b) banner: 41 days before year end with 2027 missing -> warn; (a) nothing is created before 1 Dec', async () => {
  const s = ok(await c.m.get('/api/ledger/year-status'));
  assert.deepEqual([s.year, s.end_date, s.days_left, s.next_year_missing, s.warn, s.today_covered], [2026, '2026-12-31', 41, true, true, true]);
  assert.deepEqual(YR.autoCreateNextYears(today()).created.filter((x) => x.company_id === c.companyId), []);
  assert.deepEqual(years(c.companyId), [2026]);
  clock.setNow('2026-10-01T09:00:00Z');
  assert.equal(ok(await c.m.get('/api/ledger/year-status')).warn, false, '91 days before: no banner');
  clock.setNow('2026-11-20T09:00:00Z');
});

test('(a) from 1 Dec the next year and 12 periods are created once, audited; a second run and a manual create are no-ops / refused', async () => {
  clock.setNow('2026-12-01T00:05:00Z');
  const r = YR.autoCreateNextYears(today());
  assert.ok(r.created.some((x) => x.company_id === c.companyId && x.year === 2027));
  assert.deepEqual(years(c.companyId), [2026, 2027]);
  const periods = db.prepare("SELECT p.number, p.start_date, p.end_date FROM fiscal_periods p JOIN fiscal_years y ON y.id = p.fiscal_year_id WHERE y.company_id = ? AND y.year = 2027 ORDER BY p.number").all(c.companyId);
  assert.equal(periods.length, 12);
  assert.deepEqual([periods[0].start_date, periods[11].end_date], ['2027-01-01', '2027-12-31']);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE company_id = ? AND action = 'ledger.fiscal_year.auto_create'").get(c.companyId));
  assert.deepEqual(YR.autoCreateNextYears(today()).created.filter((x) => x.company_id === c.companyId), [], 'idempotent');
  assert.equal(ok(await c.m.post('/api/ledger/fiscal-years', { year: 2027 }), 409).error, 'duplicate_year');
  assert.equal(ok(await c.m.get('/api/ledger/year-status')).warn, false);
});

test('(c) a posting with no fiscal period is queued (refusal unchanged), retried after the year exists, never lost — documents and the recurring sweep', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n;
  const inv = ok(await c.m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: '2028-01-05', lines: [{ description: 'بعيد', qty: 1, unitPrice: '10' }] }), 201);
  const refused = await c.m.post(`/api/sales/invoices/${inv.id}/post`, {});
  assert.equal(refused.status, 400, 'no_period keeps its existing status (400)');
  assert.deepEqual(Object.keys(refused.body).sort(), ['error', 'message'], 'the refusal body is unchanged');
  assert.equal(refused.body.error, 'no_period');
  // Refusing again counts an attempt on the same queue entry.
  assert.equal((await c.m.post(`/api/sales/invoices/${inv.id}/post`, {})).status, 400);
  const q = ok(await c.m.get('/api/ledger/posting-failures'));
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].kind, q[0].source_id, q[0].attempts, q[0].status], ['sales_invoice.post', String(inv.id), 2, 'open']);
  assert.equal(ok(await c.m.get('/api/ledger/year-status')).open_posting_failures, 1);
  // The recurring sweep for a date in 2028 is queued too.
  ok(await c.m.post('/api/accounting/recurring', { name: 'إيجار 2028', kind: 'recurring', startDate: '2028-01-01', dayOfMonth: 1, occurrences: 1, lines: [{ accountId: c.acc('6200'), debitMinor: 100 }, { accountId: c.acc('2130'), creditMinor: 100 }] }), 201);
  const sw = RE.sweep('2028-01-02').find((x) => x.company_id === c.companyId);
  assert.equal(sw.error, 'no_period');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n, before, 'nothing posted');
  assert.equal(ok(await c.m.get('/api/ledger/posting-failures')).length, 2);
  // Retry while still missing: refused again, still queued.
  assert.equal((await c.m.post(`/api/ledger/posting-failures/${q[0].id}/retry`, {})).status, 400);
  // Create 2028 (manually here) and retry both.
  ok(await c.m.post('/api/ledger/fiscal-years', { year: 2028 }), 201);
  for (const f of ok(await c.m.get('/api/ledger/posting-failures'))) ok(await c.m.post(`/api/ledger/posting-failures/${f.id}/retry`, {}));
  assert.deepEqual(ok(await c.m.get('/api/ledger/posting-failures')), []);
  assert.equal(db.prepare('SELECT status FROM sales_invoices WHERE id = ?').get(inv.id).status, 'posted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recurring_runs r JOIN recurring_templates t ON t.id = r.template_id WHERE t.company_id = ? AND t.name = 'إيجار 2028'").get(c.companyId).n, 1);
  assert.equal(ok(await c.m.get('/api/ledger/posting-failures?status=resolved')).length, 2);
  assert.equal(ok(await c.m.post(`/api/ledger/posting-failures/${q[0].id}/retry`, {}), 409).error, 'already_resolved');
});

test('(d) crossing 31 Dec -> 1 Jan: posting, numbering, depreciation, recurring + accrual reversal, receipts, balances carried, year-end close', async () => {
  const d = await company('شركة العبور');
  const m = d.m;
  clock.setNow('2026-12-01T06:00:00Z');
  YR.autoCreateNextYears(today());
  assert.deepEqual(years(d.companyId), [2026, 2027]);
  // Set-up in December.
  const cat = ok(await m.post('/api/accounting/asset-categories', { name: 'أجهزة', assetAccountId: d.acc('1230'), accumulatedAccountId: d.acc('1290'), expenseAccountId: d.acc('6600'), disposalAccountId: d.acc('4900'), defaultLifeMonths: 12 }), 201);
  ok(await m.post('/api/accounting/assets', { categoryId: cat.id, name: 'حاسب', cost: '1200', purchaseDate: '2026-12-01', fundingAccountId: d.acc('1110') }), 201);
  ok(await m.post('/api/accounting/recurring', { name: 'إيجار', kind: 'recurring', startDate: '2026-12-01', dayOfMonth: 1, lines: [{ accountId: d.acc('6200'), debitMinor: 50000 }, { accountId: d.acc('2130'), creditMinor: 50000 }] }), 201);
  ok(await m.post('/api/accounting/recurring', { name: 'كهرباء مستحقة', kind: 'accrual', startDate: '2026-12-31', dayOfMonth: 31, occurrences: 1, lines: [{ accountId: d.acc('6300'), debitMinor: 7000 }, { accountId: d.acc('2130'), creditMinor: 7000 }] }), 201);

  // 31 December, late evening.
  clock.setNow('2026-12-31T21:30:00Z');
  await relogin(d);
  assert.equal(today(), '2026-12-31');
  const i1 = ok(await m.post('/api/sales/invoices', { shopId: d.shop, invoiceDate: today(), lines: [{ description: 'ديسمبر', qty: 1, unitPrice: '300' }] }), 201);
  const p1 = ok(await m.post(`/api/sales/invoices/${i1.id}/post`, {}));
  ok(await m.post('/api/accounting/depreciation/run', { period: '2026-12' }));
  const r1 = ok(await m.post('/api/accounting/recurring/run', { asOf: today() }));
  assert.deepEqual(r1.posted.map((x) => x.run_date).sort(), ['2026-12-01', '2026-12-31']);
  assert.deepEqual(r1.reversed, [], 'the accrual reverses on 1 Jan, not before');
  const rcDec = ok(await m.post('/api/receivables/receipts', { shopId: d.shop, method: 'cash', amount: '100', date: today() }), 201);

  // 1 January 2027, morning.
  clock.setNow('2027-01-01T07:00:00Z');
  assert.equal(today(), '2027-01-01');
  const i2 = ok(await m.post('/api/sales/invoices', { shopId: d.shop, invoiceDate: today(), lines: [{ description: 'يناير', qty: 1, unitPrice: '200' }] }), 201);
  const p2 = ok(await m.post(`/api/sales/invoices/${i2.id}/post`, {}));
  const n1 = Number(p1.invoice_number.replace(/\D/g, ''));
  const n2 = Number(p2.invoice_number.replace(/\D/g, ''));
  assert.equal(n2, n1 + 1, 'numbering continues across the year end (no reset, no gap)');
  const e2 = db.prepare('SELECT e.entry_date, y.year FROM journal_entries e JOIN fiscal_periods p ON p.id = e.period_id JOIN fiscal_years y ON y.id = p.fiscal_year_id WHERE e.id = ?').get(p2.journal_entry_id);
  assert.deepEqual([e2.entry_date, e2.year], ['2027-01-01', 2027]);
  // Depreciation for January lands in 2027; December is not posted twice.
  const dep = ok(await m.post('/api/accounting/depreciation/run', { period: '2027-01' }));
  assert.deepEqual(dep.posted.map((x) => x.period), ['2027-01']);
  // Recurring: the 1 Jan rent posts in 2027, the 31 Dec accrual reverses on 1 Jan.
  const r2 = ok(await m.post('/api/accounting/recurring/run', { asOf: today() }));
  assert.deepEqual(r2.posted.map((x) => x.run_date), ['2027-01-01']);
  assert.deepEqual(r2.reversed.map((x) => x.date), ['2027-01-01']);
  assert.equal(bal(d.companyId, '6300', '2026-12-31'), 7000, 'December carries the accrual');
  assert.equal(bal(d.companyId, '6300', '2027-01-31'), 0, 'reversed in January');
  // A receipt on 1 Jan settles the rest of December's invoice.
  ok(await m.post('/api/receivables/receipts', { shopId: d.shop, method: 'cash', amount: '200', date: today() }), 201);
  const allocated = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) s FROM receipt_allocations WHERE invoice_id = ?').get(i1.id).s;
  assert.equal(allocated, p1.total_minor, 'December invoice fully settled by the December + January receipts');
  assert.equal(db.prepare('SELECT receipt_date FROM customer_receipts WHERE id = ?').get(rcDec.id).receipt_date, '2026-12-31');
  // Balances carried: balance-sheet accounts continue; year-end close moves the 2026 result.
  const fy26 = db.prepare('SELECT id FROM fiscal_years WHERE company_id = ? AND year = 2026').get(d.companyId).id;
  const isBefore = ok(await m.get('/api/financial-reports/income-statement?from=2026-01-01&to=2026-12-31'));
  const close = ok(await m.post(`/api/financial-reports/year-end/${fy26}/close`, {}));
  assert.equal(close.net_income_minor, isBefore.totals.net_income[0]);
  const tb = ok(await m.get('/api/financial-reports/trial-balance?from=2027-01-01&to=2027-01-31'));
  for (const r of tb.rows.filter((x) => ['revenue', 'expense'].includes(x.type))) assert.equal(r.opening_debit - r.opening_credit, 0, `P&L account ${r.code} restarts at zero in 2027`);
  for (const code of ['1110', '1130', '1230', '1290', '2130']) {
    const row = tb.rows.find((r) => r.code === code);
    assert.ok(row, `${code} in the 2027 trial balance`);
    assert.equal(row.opening_debit - row.opening_credit, bal(d.companyId, code, '2026-12-31'), `${code}: 2027 opening = 2026 closing`);
  }
  const re = tb.rows.find((r) => r.code === '3200');
  assert.equal(re.opening_credit - re.opening_debit, -bal(d.companyId, '3200', '2026-12-31'));
  const bs = ok(await m.get('/api/financial-reports/balance-sheet?asOf=2027-01-01'));
  assert.ok(Array.isArray(bs.totals.assets) && Array.isArray(bs.totals.liabilities_and_equity));
  assert.equal(bs.totals.assets[0], bs.totals.liabilities_and_equity[0], 'balance sheet balances on 1 Jan');
  assert.equal(require('../lib/ledger').ledgerIntegrityCheck(d.companyId).violations.length, 0);
});
