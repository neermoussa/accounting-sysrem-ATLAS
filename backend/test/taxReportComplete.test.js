// backend/test/taxReportComplete.test.js
//
// After Prompt 10, item 3: the tax report accounts for the TOTAL movement of
// every tax account. Each ledger line on a tax account is a row: coded
// documents (per code / rate / currency), free-rate documents (per kind:
// sales invoice, credit note, supplier goods / landed cost / expense,
// debit note) and other postings (manual journals ...). Foreign-currency
// documents are at the document rate (the ledger's base amounts) with the
// document-currency tax beside them. Nothing is excluded.
// Plus: goods invoices may use a purchase tax code (base currency only).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-trc-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createCompany } = require('./helpers');

const Y = '2026';
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

async function company(kind) {
  const co = kind === 'USD' ? await h.createUsdCompany(base, `ضرائب ${kind}`) : await createCompany(base, { name: `ضرائب ${kind}` });
  const m = co.manager;
  const { accounts } = await h.setupLedger(m, 'trading');
  ok((await h.goLive(m, `${Y}-01-01`)).res);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  const head = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(co.companyId, code).id;
  const vatOut = ok(await m.post('/api/ledger/accounts', { code: '2145', nameAr: 'ضريبة مخرجات مرمّزة', type: 'liability', parentId: head('21') }), 201).id;
  const vatIn = ok(await m.post('/api/ledger/accounts', { code: '1185', nameAr: 'ضريبة مدخلات مرمّزة', type: 'asset', parentId: head('11') }), 201).id;
  const shop = await h.mkShop(m, 'زبون');
  return { ...co, m, acc, vatOut, vatIn, shop };
}
const sumRows = (rep) => rep.rows.reduce((t, r) => t + r.tax_base_minor, 0);
const ledgerTax = (cid, ids) => db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
  WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND l.account_id IN (${ids.map(() => '?').join(',')})`).get(cid, ...ids).n;
async function goodsPo(c, supplierId, productId, qty, unitPrice) {
  const po = ok(await c.m.post('/api/purchasing/orders', { supplierId, orderDate: `${Y}-03-02`, lines: [{ productId, qty, unitPrice }] }), 201);
  const s = ok(await c.m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await c.m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  const grn = ok(await c.m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-03-03`, lines: [{ poLineId: s.lines[0].id, qty }] }), 201);
  return { po, line: s.lines[0], grn };
}

test('USD-base company: coded and free-rate sales (USD and SYP), goods (free + coded), landed cost, expense, manual journal — rows add up to the tax accounts exactly', async () => {
  const c = await company('USD');
  const { m } = c;
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '13500', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-03-01` }), 201);
  const vat = ok(await m.post('/api/accounting/tax-codes', { code: 'VAT', name: 'مبيعات', type: 'sales', accountId: c.vatOut, rate: '10', effectiveFrom: `${Y}-01-01`, priceMode: 'exclusive' }), 201);
  const vin = ok(await m.post('/api/accounting/tax-codes', { code: 'VIN', name: 'مشتريات', type: 'purchase', accountId: c.vatIn, rate: '5', effectiveFrom: `${Y}-01-01` }), 201);
  const sell = async (body) => ok(await m.post(`/api/sales/invoices/${ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: `${Y}-03-10`, ...body }), 201).id}/post`, {}));
  await sell({ lines: [{ description: 'مرمّز USD', qty: 1, unitPrice: '200.00', taxCodeId: vat.id }] });
  await sell({ lines: [{ description: 'حر USD', qty: 1, unitPrice: '100.00', taxRate: '15' }] });
  const sypFree = await sell({ currencyCode: 'SYP', lines: [{ description: 'حر SYP', qty: 1, unitPrice: '1350000', taxRate: '10' }] });
  await sell({ currencyCode: 'SYP', lines: [{ description: 'مرمّز SYP', qty: 1, unitPrice: '270000', taxCodeId: vat.id }] });
  // Purchases: goods free rate, goods coded, landed cost with tax, expense coded.
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد البضاعة', currencyCode: 'USD' }), 201);
  const p1 = await h.mkProduct(m, { name: 'لوز' });
  const p2 = await h.mkProduct(m, { name: 'كاجو' });
  const g1 = await goodsPo(c, supplier.id, p1, 10, '20.00');
  const gi1 = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: g1.po.id, invoiceDate: `${Y}-03-04`, lines: [{ poLineId: g1.line.id, qty: 10, taxRate: '5' }] }), 201);
  ok(await m.post(`/api/purchasing/invoices/${gi1.id}/post`, {}));
  const g2 = await goodsPo(c, supplier.id, p2, 4, '50.00');
  const gi2 = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: g2.po.id, invoiceDate: `${Y}-03-04`, lines: [{ poLineId: g2.line.id, qty: 4, taxCodeId: vin.id }] }), 201);
  assert.equal(gi2.tax_minor, 1000, 'coded goods line: 5% of 200.00');
  const pg2 = ok(await m.post(`/api/purchasing/invoices/${gi2.id}/post`, {}));
  const je2 = db.prepare('SELECT a.code, l.debit_minor d FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?').all(pg2.journal_entry_id);
  assert.ok(je2.some((l) => l.code === '1185' && l.d === 1000), 'coded goods tax on the code account');
  assert.ok(!je2.some((l) => l.code === '1180'), 'not on input_tax');
  const freight = ok(await m.post('/api/purchasing/suppliers', { name: 'شحن', currencyCode: 'USD' }), 201);
  const lc = ok(await m.post('/api/purchasing/invoices', { kind: 'landed_cost', supplierId: freight.id, receiptId: g1.grn.id, landedMethod: 'value', invoiceDate: `${Y}-03-05`, lines: [{ description: 'شحن', landedKind: 'shipping', qty: 1, unitPrice: '40.00', taxRate: '5' }] }), 201);
  ok(await m.post(`/api/purchasing/invoices/${lc.id}/post`, {}));
  const ex = ok(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: supplier.id, invoiceDate: `${Y}-03-06`, lines: [{ description: 'إيجار', qty: 1, unitPrice: '300', taxCodeId: vin.id, expenseAccountId: c.acc('6200') }] }), 201);
  ok(await m.post(`/api/purchasing/invoices/${ex.id}/post`, {}));
  // A manual journal on the coded output account.
  ok(await m.post('/api/ledger/entries', { date: `${Y}-03-20`, description: 'تسوية يدوية', post: true, lines: [{ accountId: c.vatOut, creditMinor: 123 }, { accountId: c.acc('1110'), debitMinor: 123 }] }), 201);

  const rep = ok(await m.get(`/api/accounting/tax-report?from=${Y}-01-01&to=${Y}-12-31`));
  const taxAccounts = [c.vatOut, c.vatIn, c.acc('2140'), c.acc('1180')];
  assert.equal(rep.totals.ledger_net_credit_minor, ledgerTax(c.companyId, taxAccounts));
  assert.equal(sumRows(rep), rep.totals.ledger_net_credit_minor, 'rows = total movement of the tax accounts');
  assert.equal(rep.totals.unexplained_minor, 0);
  assert.ok(rep.reconciled);
  for (const r of rep.reconciliation) assert.equal(r.unexplained_minor, 0, r.code);
  const row = (pred) => { const r = rep.rows.find(pred); assert.ok(r, 'row missing'); return r; };
  // (b) foreign currency at the document rate: 135,000 SYP of tax at 13,500 SYP/USD = 10.00 USD.
  const syp = row((r) => r.section === 'free_rate' && r.kind === 'sales_invoice' && r.currency === 'SYP');
  assert.equal(syp.tax_base_minor, 1000);
  assert.equal(syp.tax_original_minor, db.prepare('SELECT tax_minor FROM sales_invoices WHERE id = ?').get(sypFree.id).tax_minor);
  assert.equal(row((r) => r.section === 'coded' && r.code === 'VAT' && r.currency === 'SYP').tax_base_minor, 200, '27,000 SYP -> 2.00');
  assert.equal(row((r) => r.section === 'coded' && r.code === 'VAT' && r.currency === 'USD').tax_base_minor, 2000);
  assert.equal(row((r) => r.section === 'free_rate' && r.kind === 'sales_invoice' && r.currency === 'USD').tax_base_minor, 1500);
  // (a) goods and landed cost, free rate, each with its own row.
  assert.equal(row((r) => r.section === 'free_rate' && r.kind === 'supplier_goods').tax_base_minor, -1000, '5% of 200.00, input = debit');
  assert.equal(row((r) => r.section === 'free_rate' && r.kind === 'supplier_landed_cost').tax_base_minor, -200);
  assert.equal(row((r) => r.section === 'coded' && r.code === 'VIN').tax_base_minor, -(1000 + 1500), 'coded goods + coded expense');
  assert.equal(row((r) => r.section === 'other' && r.source_type === 'manual').tax_base_minor, 123, 'manual journal: explicit, never dropped');
  assert.equal(rep.output_tax_minor, 2000 + 1500 + 1000 + 200 + 123);
  assert.equal(rep.input_tax_minor, 1000 + 1000 + 200 + 1500);
  // A foreign-currency goods invoice keeps the free rate: a code is refused.
  const sypSup = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد بالليرة', currencyCode: 'SYP' }), 201);
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: sypSup.id, orderDate: `${Y}-03-02`, currencyCode: 'SYP', lines: [{ productId: p1, qty: 1, unitPrice: '100000' }] }), 201);
  const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-03-03`, lines: [{ poLineId: s.lines[0].id, qty: 1 }] }), 201);
  assert.equal(ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: sypSup.id, poId: po.id, invoiceDate: `${Y}-03-04`, lines: [{ poLineId: s.lines[0].id, qty: 1, taxCodeId: vin.id }] }), 400).error, 'tax_code_foreign_goods');
});

test('SYP-base company: a USD invoice with tax is reported at its document rate and the rows equal the tax accounts', async () => {
  const c = await company('SYP');
  const { m } = c;
  ok(await m.post('/api/currency/rates', { currencyCode: 'USD', rate: '13000', effectiveAt: `${Y}-03-01` }), 201);
  const inv = ok(await m.post('/api/sales/invoices', { shopId: c.shop, currencyCode: 'USD', invoiceDate: `${Y}-03-05`, lines: [{ description: 'بضاعة', qty: 1, unitPrice: '100.00', taxRate: '10' }] }), 201);
  ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  const local = ok(await m.post('/api/sales/invoices', { shopId: c.shop, invoiceDate: `${Y}-03-06`, lines: [{ description: 'محلي', qty: 1, unitPrice: '50000', taxRate: '10' }] }), 201);
  ok(await m.post(`/api/sales/invoices/${local.id}/post`, {}));
  const rep = ok(await m.get(`/api/accounting/tax-report?from=${Y}-01-01&to=${Y}-12-31`));
  const usd = rep.rows.find((r) => r.currency === 'USD');
  assert.deepEqual([usd.section, usd.kind, usd.tax_original_minor, usd.tax_base_minor], ['free_rate', 'sales_invoice', 1000, 130000], '$10.00 at 13,000 = 130,000 SYP');
  assert.equal(rep.rows.find((r) => r.currency === 'SYP').tax_base_minor, 5000);
  assert.equal(sumRows(rep), ledgerTax(c.companyId, [c.acc('2140'), c.acc('1180'), c.vatOut, c.vatIn]));
  assert.equal(rep.totals.unexplained_minor, 0);
  assert.ok(rep.reconciled);
  assert.equal(rep.foreign_currency_rows, 1);
});
