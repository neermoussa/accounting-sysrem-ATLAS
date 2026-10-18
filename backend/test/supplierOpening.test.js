// backend/test/supplierOpening.test.js
//
// Supplier opening balances:
//  - an undated lump opening balance (no bill date, no due date) ages in
//    the 'legacy' bucket — the same rule as customer_opening on receivables
//    — never in 'current'; the aging total still equals AP control;
//  - open-bills import (supplier, bill number, bill date, due date, amount)
//    posts one opening bill per row, aged by its own due date, after a
//    per-supplier sum check against the supplier's opening balance;
//    a mismatch, a duplicate bill or a missing date refuses the whole import.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-supopen-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');

const Y = 2026;
let listener;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const count = () => db.prepare("SELECT COUNT(*) c FROM supplier_invoices WHERE kind = 'opening'").get().c;

test.before(async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة افتتاحي الموردين');
  const m = co.manager;
  await h.setupLedger(m);
  const a = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد أ', currencyCode: 'USD' }), 201);
  const b = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد ب', currencyCode: 'USD' }), 201);
  const c = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد ج', currencyCode: 'USD' }), 201);
  ctx = { m, a, b, c };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('an undated opening balance ages as legacy, not current; aging = AP control', async () => {
  const { m, c } = ctx;
  ok(await m.post('/api/purchasing/opening-balances', { date: `${Y}-01-01`, mode: 'opening', rows: [{ supplierId: c.id, amount: '75' }] }), 201);
  const aging = ok(await m.get(`/api/purchasing/reports/aging?asOf=${Y}-01-01`));
  const row = aging.rows.find((r) => r.supplier_id === c.id);
  assert.equal(row.legacy, 7500);
  assert.equal(row.current, 0, 'never in current');
  assert.equal(row.items[0].bucket, 'legacy');
  assert.equal(row.items[0].due_date, null);
  assert.equal(aging.totals.legacy, 7500);
  assert.equal(aging.unassigned_minor, 0);
  assert.equal(aging.totals.total, aging.control_minor);
  // A dated opening row (due date given) ages normally.
  ok(await m.post('/api/purchasing/opening-balances', { date: `${Y}-01-01`, mode: 'opening', rows: [{ supplierId: c.id, amount: '5', dueDate: `${Y}-01-20` }] }), 201);
  const later = ok(await m.get(`/api/purchasing/reports/aging?asOf=${Y}-02-01`)).rows.find((r) => r.supplier_id === c.id);
  assert.equal(later.legacy, 7500);
  assert.equal(later.b1_30, 500);
});

test('open-bills import: per-supplier sum check refuses a mismatch, a duplicate or a missing date — nothing posted', async () => {
  const { m, a, b } = ctx;
  const rows = [
    { supplierId: a.id, billNumber: 'A-1', billDate: `${Y - 1}-11-01`, dueDate: `${Y - 1}-12-01`, amount: '100' },
    { supplierId: a.id, billNumber: 'A-2', billDate: `${Y - 1}-12-15`, dueDate: `${Y}-01-14`, amount: '50' },
    { supplierId: b.id, billNumber: 'B-1', billDate: `${Y - 1}-12-20`, dueDate: `${Y}-02-20`, amount: '30' },
  ];
  const before = count();
  const bad = await m.post('/api/purchasing/opening-balances/bills', { date: `${Y}-01-01`, mode: 'opening', rows, supplierTotals: [{ supplierId: a.id, amount: '140' }, { supplierId: b.id, amount: '30' }] });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, 'supplier_sum_mismatch');
  assert.match(bad.body.message, /مورد أ/);
  assert.equal(bad.body.mismatches[0].bills_minor, 15000);
  assert.equal(bad.body.mismatches[0].expected_minor, 14000);
  const missing = await m.post('/api/purchasing/opening-balances/bills', { date: `${Y}-01-01`, mode: 'opening', rows, supplierTotals: [{ supplierId: a.id, amount: '150' }] });
  assert.equal(missing.body.error, 'supplier_sum_mismatch', 'a supplier in the file with no opening total');
  const dup = await m.post('/api/purchasing/opening-balances/bills', { date: `${Y}-01-01`, mode: 'opening', rows: [rows[0], rows[0]], supplierTotals: [{ supplierId: a.id, amount: '200' }] });
  assert.equal(dup.body.error, 'duplicate_bill');
  const noDue = await m.post('/api/purchasing/opening-balances/bills', { date: `${Y}-01-01`, mode: 'opening', rows: [{ ...rows[2], dueDate: undefined }], supplierTotals: [{ supplierId: b.id, amount: '30' }] });
  assert.equal(noDue.body.error, 'invalid_due_date');
  assert.equal(count(), before, 'nothing posted');
  ctx.rows = rows;
});

test('open-bills import: matching sums post one bill per row, aged by its own due date', async () => {
  const { m, a, b, rows } = ctx;
  const res = ok(await m.post('/api/purchasing/opening-balances/bills', { date: `${Y}-01-01`, mode: 'opening', rows, supplierTotals: [{ supplierId: a.id, amount: '150' }, { supplierId: b.id, amount: '30' }] }), 201);
  assert.equal(res.invoices.length, 3);
  assert.deepEqual(res.invoices.map((i) => [i.supplier_invoice_ref, i.invoice_date, i.due_date]), rows.map((r) => [r.billNumber, r.billDate, r.dueDate]));
  // As of 31 Jan: A-1 due 1 Dec = 61 days, A-2 due 14 Jan = 17 days, B-1 not due.
  const aging = ok(await m.get(`/api/purchasing/reports/aging?asOf=${Y}-01-31`));
  const ra = aging.rows.find((r) => r.supplier_id === a.id);
  const rb = aging.rows.find((r) => r.supplier_id === b.id);
  assert.deepEqual([ra.b61_90, ra.b1_30, ra.legacy, ra.total], [10000, 5000, 0, 15000]);
  assert.deepEqual([rb.current, rb.total], [3000, 3000]);
  assert.equal(aging.unassigned_minor, 0);
  assert.equal(aging.totals.total, aging.control_minor, 'aging = AP control');
  assert.deepEqual(ok(await m.get('/api/ledger/integrity-check')).violations, []);
});
