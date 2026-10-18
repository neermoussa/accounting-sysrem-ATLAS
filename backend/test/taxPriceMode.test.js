// backend/test/taxPriceMode.test.js
//
// After Prompt 10, item 2: the price mode (tax-inclusive / exclusive) is an
// explicit choice made with the first tax code; a company that has tax codes
// but no choice (codes created before migration 0025) cannot post any taxed
// document until it chooses; companies with no tax codes are unaffected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pm-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const D = '2026-11-20';
let listener;
let base;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
test.before(() => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function company(name) {
  const co = await h.createUsdCompany(base, name);
  const { accounts } = await h.setupLedger(co.manager, 'trading');
  ok((await h.goLive(co.manager, '2026-01-01')).res);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  const shop = await h.mkShop(co.manager, 'زبون');
  const supplier = ok(await co.manager.post('/api/purchasing/suppliers', { name: 'مورد', currencyCode: 'USD' }), 201);
  return { ...co, acc, shop, supplier };
}

test('company with no tax codes: no choice needed, taxed documents post as before', async () => {
  const c = await company('بلا رموز');
  const m = c.manager;
  assert.deepEqual(ok(await m.get('/api/accounting/price-mode')), { mode: null, chosen_by: null, chosen_at: null, has_tax_codes: false });
  const inv = ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '100', taxRate: '15' }] }), 201);
  ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
});

test('the first tax code requires an explicit choice; the choice is stored, mirrored and audited', async () => {
  const c = await company('الرمز الأول');
  const m = c.manager;
  const body = { code: 'VAT', name: 'ضريبة', type: 'sales', accountId: c.acc('2140'), rate: '10', effectiveFrom: '2026-01-01' };
  assert.equal(ok(await m.post('/api/accounting/tax-codes', body), 400).error, 'price_mode_required');
  assert.equal(ok(await m.post('/api/accounting/tax-codes', { ...body, priceMode: 'maybe' }), 400).error, 'price_mode_required');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tax_codes WHERE company_id = ?').get(c.companyId).c, 0, 'nothing created without the choice');
  ok(await m.post('/api/accounting/tax-codes', { ...body, priceMode: 'exclusive' }), 201);
  const pm = ok(await m.get('/api/accounting/price-mode'));
  assert.equal(pm.mode, 'exclusive');
  assert.equal(pm.has_tax_codes, true);
  assert.equal(db.prepare('SELECT price_display_mode m FROM companies WHERE id = ?').get(c.companyId).m, 'without_tax');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE company_id = ? AND action = 'tax.price_mode.set'").get(c.companyId));
  // A second code does not ask again; the mode applies to coded lines.
  ok(await m.post('/api/accounting/tax-codes', { ...body, code: 'VAT2', rate: '5' }), 201);
  const inv = ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '100', taxCodeId: pm.has_tax_codes && db.prepare("SELECT id FROM tax_codes WHERE company_id = ? AND code = 'VAT'").get(c.companyId).id }] }), 201);
  assert.deepEqual([inv.lines[0].net_minor, inv.lines[0].tax_minor], [10000, 1000], 'exclusive: tax on top');
  // Changing the mode later: manage_tax_codes only, applies to new lines.
  ok(await m.put('/api/accounting/price-mode', { mode: 'inclusive' }));
  const inv2 = ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '110', taxCodeId: db.prepare("SELECT id FROM tax_codes WHERE company_id = ? AND code = 'VAT'").get(c.companyId).id }] }), 201);
  assert.deepEqual([inv2.lines[0].net_minor, inv2.lines[0].tax_minor], [10000, 1000], 'inclusive: tax inside the price');
  const clerk = await createRep(base, m, { permissions: ['view_app', 'create_sales_invoices'] });
  assert.equal((await clerk.client.get('/api/accounting/price-mode')).status, 200, 'every invoice screen can show the mode');
  assert.equal((await clerk.client.put('/api/accounting/price-mode', { mode: 'exclusive' })).status, 403);
});

test('codes without a choice (created before migration 0025): every taxed document is blocked until chosen; untaxed ones post', async () => {
  const c = await company('رموز قديمة');
  const m = c.manager;
  const code = ok(await m.post('/api/accounting/tax-codes', { code: 'VAT', name: 'ضريبة', type: 'sales', accountId: c.acc('2140'), rate: '10', effectiveFrom: '2026-01-01', priceMode: 'exclusive' }), 201);
  // Drafts made while a mode existed, then the state of a pre-0025 company.
  const taxed = ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '100', taxRate: '15' }] }), 201);
  const coded = ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '100', taxCodeId: code.id }] }), 201);
  const untaxed = ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '100' }] }), 201);
  const exp = ok(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: c.supplier.id, invoiceDate: D, lines: [{ description: 'إيجار', qty: 1, unitPrice: '50', taxRate: '5', expenseAccountId: c.acc('6200') }] }), 201);
  db.prepare('DELETE FROM company_tax_settings WHERE company_id = ?').run(c.companyId);
  const entries = () => db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?').get(c.companyId).c;
  const n = entries();
  for (const [label, r] of [
    ['sales invoice, free rate', await m.post(`/api/sales/invoices/${taxed.id}/post`, {})],
    ['sales invoice, coded', await m.post(`/api/sales/invoices/${coded.id}/post`, {})],
    ['supplier invoice', await m.post(`/api/purchasing/invoices/${exp.id}/post`, {})],
    ['new coded line', await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: D, lines: [{ description: 'x', qty: 1, unitPrice: '1', taxCodeId: code.id }] })],
  ]) {
    assert.equal(r.status, 409, label);
    assert.equal(r.body.error, 'price_mode_not_chosen', label);
  }
  assert.equal(entries(), n, 'nothing posted');
  ok(await m.post(`/api/sales/invoices/${untaxed.id}/post`, {}), 200);
  ok(await m.put('/api/accounting/price-mode', { mode: 'exclusive' }));
  const posted = ok(await m.post(`/api/sales/invoices/${taxed.id}/post`, {}));
  ok(await m.post(`/api/purchasing/invoices/${exp.id}/post`, {}));
  // Credit note on a taxed invoice: blocked while unchosen, posts after.
  db.prepare('DELETE FROM company_tax_settings WHERE company_id = ?').run(c.companyId);
  assert.equal(ok(await m.post('/api/sales/credit-notes', { invoiceId: taxed.id, lines: [{ invoiceLineId: posted.lines[0].id, qty: 1 }] }), 409).error, 'price_mode_not_chosen');
  ok(await m.put('/api/accounting/price-mode', { mode: 'exclusive' }));
  ok(await m.post('/api/sales/credit-notes', { invoiceId: taxed.id, lines: [{ invoiceLineId: posted.lines[0].id, qty: 1 }] }), 201);
});
