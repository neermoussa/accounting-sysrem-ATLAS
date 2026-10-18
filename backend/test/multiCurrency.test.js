// backend/test/multiCurrency.test.js
//
// Prompt 5 "Done when":
//  - a USD invoice paid in SYP at a different rate settles fully and posts
//    the correct FX entry;
//  - revaluation preview and posting work and the reversal restores balances;
//  - every entry still balances in base currency to the minor unit;
//  - rounding edge cases.
// Plus: rate history + lookup, rate locked at posting, override permission,
// credit notes at the invoice rate, balances by currency, FX report, the
// USD/SYP fetch writing the history, aging = AR control throughout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mc-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createCompany, createRep } = require('./helpers');

const Y = 2026;
let listener;
let base;

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
  const co = kind === 'USD' ? await h.createUsdCompany(base, 'شركة دولار mc') : await createCompany(base, { name: 'شركة ليرة mc' });
  const m = co.manager;
  const { accounts } = await h.setupLedger(m);
  const shop = await h.mkShop(m, 'زبون العملات');
  return { ...co, m, accounts, shop, acc: (key) => accounts.find((a) => a.system_key === key || a.code === key).id };
}
const rate = async (c, body) => {
  const r = await c.m.post('/api/currency/rates', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
async function invoice(c, { currencyCode, date, price, qty = 1, post = true, postBody = {} }) {
  const inv = await c.m.post('/api/sales/invoices', { shopId: c.shop, currencyCode, invoiceDate: date, lines: [{ description: 'بضاعة', qty, unitPrice: price }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  if (!post) return inv.body;
  const p = await c.m.post(`/api/sales/invoices/${inv.body.id}/post`, postBody);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(inv.body.id);
}
async function receipt(c, body) {
  const r = await c.m.post('/api/receivables/receipts', { shopId: c.shop, method: 'cash', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const arBase = (c) => h.arSumMinor(process.env.ATLAS_DB_PATH, c.companyId, c.shop);
function assertAllEntriesBalance(companyId) {
  const bad = db
    .prepare(
      `SELECT e.id, SUM(l.debit_minor) d, SUM(l.credit_minor) c FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') GROUP BY e.id HAVING d <> c`
    )
    .all(companyId);
  assert.deepEqual(bad, [], 'every entry balances in base to the minor unit');
}
async function assertLedgerClean(c) {
  assertAllEntriesBalance(c.companyId);
  assert.deepEqual((await c.m.get('/api/ledger/integrity-check')).body.violations, []);
  const recon = (await c.m.post('/api/receivables/reconciliation/run', {})).body;
  assert.equal(recon.difference_minor, 0, JSON.stringify(recon));
  const aging = (await c.m.get('/api/receivables/aging')).body;
  assert.equal(aging.totals.total, aging.control_minor, 'aging total = AR control');
}

test('rate history: add, list, lookup by date; rate < 1 refused; permission needed', async () => {
  const c = await company('SYP');
  await rate(c, { currencyCode: 'USD', rate: '13000', effectiveAt: `${Y}-03-01` });
  await rate(c, { currencyCode: 'USD', rate: '14000.12345678', effectiveAt: `${Y}-04-01 09:30` });
  const list = (await c.m.get('/api/currency/rates?currencyCode=USD')).body;
  assert.equal(list.length, 2);
  assert.equal(list[0].rate, '14000.12345678');
  assert.equal((await c.m.get(`/api/currency/rates/current?currencyCode=USD&date=${Y}-03-31`)).body.rate, '13000');
  assert.equal((await c.m.get(`/api/currency/rates/current?currencyCode=USD&date=${Y}-04-01`)).body.rate, '14000.12345678');
  assert.equal((await c.m.get(`/api/currency/rates/current?currencyCode=USD&date=${Y}-02-01`)).body, null);
  const low = await c.m.post('/api/currency/rates', { currencyCode: 'USD', rate: '0.00007' });
  assert.equal(low.status, 400);
  assert.equal(low.body.error, 'rate_below_one');
  assert.equal((await c.m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '2' })).body.error, 'base_currency_rate');
  const rep = await createRep(base, c.m, { permissions: ['view_ledger'] });
  assert.equal((await rep.client.post('/api/currency/rates', { currencyCode: 'USD', rate: '1' })).status, 403);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE company_id = ? AND action = 'currency.rate.add'").get(c.companyId));
});

test('DONE (SYP-base company, base currency = SYP): a USD invoice of $100 at 13,000 SYP/USD paid with 1,400,000 SYP at 14,000 settles fully and posts a realized FX gain of 100,000 SYP', async () => {
  const c = await company('SYP');
  await rate(c, { currencyCode: 'USD', rate: '13000', effectiveAt: `${Y}-03-01` });
  await rate(c, { currencyCode: 'USD', rate: '14000', effectiveAt: `${Y}-04-01` });
  const inv = await invoice(c, { currencyCode: 'USD', date: `${Y}-03-05`, price: '100.00' });
  assert.equal(inv.rate_e8, 1300000000000);
  assert.equal(inv.total_minor, 10000); // USD cents
  assert.equal(inv.total_base_minor, 1300000); // SYP
  const arLine = db.prepare("SELECT l.* FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.system_key = 'ar_control'").get(inv.journal_entry_id);
  assert.equal(arLine.currency_code, 'USD');
  assert.equal(arLine.amount_original_minor, 10000);
  assert.equal(arLine.debit_minor, 1300000);
  // A newer rate does not touch the posted invoice (locked at posting).
  await rate(c, { currencyCode: 'USD', rate: '20000', effectiveAt: `${Y}-03-06` });
  assert.equal(db.prepare('SELECT rate_e8 FROM sales_invoices WHERE id = ?').get(inv.id).rate_e8, 1300000000000);
  await rate(c, { currencyCode: 'USD', rate: '14000', effectiveAt: `${Y}-04-01 00:00:01` });

  // Customer pays 1,400,000 SYP on April 5th (14,000 SYP per USD) = USD 100.
  const r = await receipt(c, { amount: '1400000', date: `${Y}-04-05` });
  assert.equal(r.currency_code, 'SYP');
  assert.equal(r.allocations.length, 1);
  assert.equal(r.allocations[0].amount_minor, 10000, 'settled USD 100.00');
  assert.equal(r.unallocated_minor, 0);
  const fx = db.prepare("SELECT * FROM fx_settlements WHERE receipt_id = ? AND status = 'posted'").get(r.id);
  assert.equal(fx.fx_minor, 100000, 'gain = 1,400,000 paid - 1,300,000 carried');
  const lines = db.prepare('SELECT l.*, a.system_key FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY line_no').all(fx.journal_entry_id);
  assert.deepEqual(lines.map((l) => [l.system_key, l.debit_minor, l.credit_minor]), [['ar_control', 100000, 0], ['fx_realized', 0, 100000]]);
  assert.equal(db.prepare('SELECT entry_date FROM journal_entries WHERE id = ?').get(fx.journal_entry_id).entry_date, `${Y}-04-05`, 'FX dated at the receipt (settlement) date');
  // Fully settled: invoice open 0 in USD, customer AR exactly 0 in base.
  const rec = require('../lib/receivables');
  assert.equal(rec.invoiceOpenMinor(db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(inv.id)), 0);
  assert.equal(arBase(c), 0);
  const aging = (await c.m.get(`/api/receivables/aging/customer/${c.shop}`)).body;
  assert.equal((aging.items || []).filter((i) => i.amount_minor !== 0).length, 0, 'nothing left open in aging');
  const rep = (await c.m.get(`/api/currency/fx-report?from=${Y}-01-01&to=${Y}-12-31`)).body;
  assert.equal(rep.totals.realized, 100000);
  assert.equal(rep.rows[0].document.invoice_id, inv.id);
  await assertLedgerClean(c);

  // Reversing the receipt reverses the FX entry and reopens the invoice.
  const rev = await c.m.post(`/api/receivables/receipts/${r.id}/reverse`, { reason: 'خطأ' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(fx.journal_entry_id).status, 'reversed');
  assert.equal(arBase(c), 1300000);
  assert.equal(rec.invoiceOpenMinor(db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(inv.id)), 10000);
  await assertLedgerClean(c);
});

test('USD-base company: a USD (base) invoice paid in SYP converts at the receipt-date rate and settles with no FX (base invoices have no FX)', async () => {
  const c = await company('USD');
  await rate(c, { currencyCode: 'SYP', rate: '13500.5', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-03-01` });
  const inv = await invoice(c, { date: `${Y}-03-02`, price: '100.00' });
  const r = await receipt(c, { currencyCode: 'SYP', amount: '1350050', date: `${Y}-03-10` });
  assert.equal(r.amount_minor, 10000, '1,350,050 SYP / 13,500.5 = USD 100.00');
  assert.equal(r.allocations[0].amount_minor, 10000);
  assert.equal(require('../lib/receivables').invoiceOpenMinor(db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(inv.id)), 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM fx_settlements WHERE receipt_id = ?').get(r.id).c, 0);
  const cash = db.prepare("SELECT l.* FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.system_key = 'cash_default'").get(r.journal_entry.id);
  assert.equal(cash.currency_code, 'SYP');
  assert.equal(cash.amount_original_minor, 1350050);
  assert.equal(arBase(c), 0);
  await assertLedgerClean(c);
});

test('EUR invoice paid in EUR at a lower rate: realized loss; partial payments at different rates leave no base dust', async () => {
  const c = await company('USD');
  await rate(c, { currencyCode: 'EUR', rate: '1.10123456', effectiveAt: `${Y}-01-01` });
  const inv = await invoice(c, { currencyCode: 'EUR', date: `${Y}-01-10`, price: '33.33', qty: 3 }); // 99.99 EUR
  assert.equal(inv.total_minor, 9999);
  const carried = inv.total_base_minor;
  await rate(c, { currencyCode: 'EUR', rate: '1.05', effectiveAt: `${Y}-02-01` });
  const r1 = await receipt(c, { currencyCode: 'EUR', amount: '33.34', date: `${Y}-02-02` });
  await rate(c, { currencyCode: 'EUR', rate: '1.2071', effectiveAt: `${Y}-03-01` });
  const r2 = await receipt(c, { currencyCode: 'EUR', amount: '33.33', date: `${Y}-03-02` });
  await rate(c, { currencyCode: 'EUR', rate: '0.99', effectiveAt: `${Y}-04-01` }).catch(() => null);
  await rate(c, { currencyCode: 'EUR', rate: '1.0001', effectiveAt: `${Y}-04-01` });
  const r3 = await receipt(c, { currencyCode: 'EUR', amount: '33.32', date: `${Y}-04-02` });
  const rec = require('../lib/receivables');
  assert.equal(rec.invoiceOpenMinor(db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(inv.id)), 0);
  assert.equal(arBase(c), 0, 'no base dust on a fully settled foreign invoice');
  const paid = [r1, r2, r3].reduce((s, r) => s + r.amount_minor, 0);
  const fxTotal = db.prepare("SELECT COALESCE(SUM(fx_minor), 0) s FROM fx_settlements WHERE invoice_id = ? AND status = 'posted'").get(inv.id).s;
  assert.equal(fxTotal, paid - carried, 'FX = base paid - base carried');
  const rep = (await c.m.get(`/api/currency/fx-report?from=${Y}-01-01&to=${Y}-12-31`)).body;
  assert.equal(rep.totals.realized, fxTotal);
  await assertLedgerClean(c);
});

test('credit note on a USD invoice uses the invoice rate (no FX) and closing it leaves no base dust', async () => {
  const c = await company('SYP');
  await rate(c, { currencyCode: 'USD', rate: '13333.3333', effectiveAt: `${Y}-01-01` });
  const inv = await invoice(c, { currencyCode: 'USD', date: `${Y}-01-05`, price: '10.01', qty: 3 });
  const full = await c.m.get(`/api/sales/invoices/${inv.id}`);
  const lineId = full.body.lines[0].id;
  const cn1 = await c.m.post('/api/sales/credit-notes', { invoiceId: inv.id, lines: [{ invoiceLineId: lineId, qty: 1 }] });
  assert.equal(cn1.status, 201, JSON.stringify(cn1.body));
  const cnRow = db.prepare('SELECT * FROM sales_credit_notes WHERE id = ?').get(cn1.body.id);
  assert.equal(cnRow.currency_code, 'USD');
  assert.equal(cnRow.rate_e8, inv.rate_e8);
  const cancel = await c.m.post(`/api/sales/invoices/${inv.id}/cancel`, { reason: 'إلغاء' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal(arBase(c), 0);
  await assertLedgerClean(c);
});

test('rate missing blocks posting; override needs override_exchange_rate and is audited', async () => {
  const c = await company('SYP');
  const draft = await invoice(c, { currencyCode: 'USD', date: `${Y}-02-01`, price: '5', post: false });
  const no = await c.m.post(`/api/sales/invoices/${draft.id}/post`, {});
  assert.equal(no.status, 409);
  assert.equal(no.body.error, 'rate_missing');
  const rep = await createRep(base, c.m, { permissions: ['post_sales_invoices', 'view_sales_invoices', 'create_sales_invoices'] });
  const forbidden = await rep.client.post(`/api/sales/invoices/${draft.id}/post`, { exchangeRate: '15000' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, 'rate_override_forbidden');
  const ok = await c.m.post(`/api/sales/invoices/${draft.id}/post`, { exchangeRate: '15000.75' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(draft.id);
  assert.equal(row.rate_e8, 1500075000000);
  assert.equal(row.total_base_minor, 75004); // 5 USD x 15,000.75 = 75,003.75 -> 75,004
});

test('DONE: revaluation preview, posting, and the day-one reversal restores balances (receivables + foreign cash)', async () => {
  const c = await company('SYP');
  await rate(c, { currencyCode: 'USD', rate: '13000', effectiveAt: `${Y}-04-01` });
  const inv = await invoice(c, { currencyCode: 'USD', date: `${Y}-04-02`, price: '200' });
  // USD cash received from another customer-less source: a manual entry.
  const cashUsd = await c.m.post('/api/ledger/entries', { date: `${Y}-04-03`, description: 'إيداع دولار', post: true, lines: [
    { accountId: c.acc('1120'), currencyCode: 'USD', exchangeRate: '13000', debit: '50' },
    { accountId: c.acc('3100'), credit: '650000' },
  ] });
  assert.equal(cashUsd.status, 201, JSON.stringify(cashUsd.body));
  await rate(c, { currencyCode: 'USD', rate: '15000', effectiveAt: `${Y}-04-30 18:00` });
  const asOf = `${Y}-04-30`;
  const before = { ar: arBase(c), bank: db.prepare("SELECT SUM(debit_minor - credit_minor) s FROM journal_lines WHERE account_id = ?").get(c.acc('1120')).s };

  const prev = await c.m.post('/api/currency/revaluations/preview', { asOf });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const invLine = prev.body.lines.find((l) => l.kind === 'invoice' && l.document_id === inv.id);
  assert.equal(invLine.carrying_base_minor, 2600000);
  assert.equal(invLine.revalued_base_minor, 3000000);
  assert.equal(invLine.difference_minor, 400000);
  const bankLine = prev.body.lines.find((l) => l.kind === 'account');
  assert.equal(bankLine.difference_minor, 100000);
  assert.equal(prev.body.total_minor, 500000);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM fx_revaluations').get().c, 0, 'preview stores nothing');

  const post = await c.m.post('/api/currency/revaluations', { asOf });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const e = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(post.body.journal_entry.id);
  const rv = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(post.body.reversal_entry.id);
  assert.equal(e.entry_date, asOf);
  assert.equal(rv.entry_date, `${Y}-05-01`, 'reversal on day one of the next period');
  // At the period end the balances are revalued...
  const atEnd = h.count(process.env.ATLAS_DB_PATH, `SELECT SUM(l.debit_minor - l.credit_minor) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE e.company_id = ${c.companyId} AND a.system_key = 'ar_control' AND l.party_id = ${c.shop} AND e.entry_date <= '${asOf}'`);
  assert.equal(atEnd, 3000000);
  // ...and the reversal restores them exactly.
  assert.equal(arBase(c), before.ar);
  assert.equal(db.prepare("SELECT SUM(debit_minor - credit_minor) s FROM journal_lines WHERE account_id = ?").get(c.acc('1120')).s, before.bank);
  const fxr = (await c.m.get(`/api/currency/fx-report?from=${Y}-04-01&to=${Y}-05-31`)).body;
  assert.equal(fxr.rows.filter((r) => r.kind === 'unrealized').reduce((s, r) => s + r.gain_minor, 0), 500000);
  assert.equal(fxr.totals.unrealized, 0, 'revaluation + reversal net to zero');
  const again = await c.m.post('/api/currency/revaluations', { asOf });
  assert.equal(again.status, 409);
  // Generic reverse of a revaluation entry is refused (source action only).
  assert.equal((await c.m.post(`/api/ledger/entries/${rv.id}/reverse`, {})).status, 409);
  const bal = (await c.m.get(`/api/currency/balances?asOf=${Y}-06-01`)).body;
  const usd = bal.customers.find((x) => x.currency_code === 'USD');
  assert.equal(usd.balance_minor, 20000);
  assert.equal(usd.base_minor, 2600000);
  assert.ok(bal.accounts.some((a) => a.currency_code === 'USD' && a.original_minor === 5000));
  const rep = await createRep(base, c.m, { permissions: ['view_ledger'] });
  assert.equal((await rep.client.post('/api/currency/revaluations', { asOf: `${Y}-05-31` })).status, 403);
  await assertLedgerClean(c);
});

test('DONE: property — random multi-currency invoices, receipts, allocations and credits: every entry balances, AR = sub-ledgers, settled invoices carry zero base', async () => {
  let seed = 424242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const kind of ['SYP', 'USD']) {
    const c = await company(kind);
    const foreign = kind === 'SYP' ? ['USD', 'EUR'] : ['SYP', 'EUR'];
    const day = (n) => `${Y}-0${1 + Math.floor(n / 28)}-${String(1 + (n % 28)).padStart(2, '0')}`;
    for (let d = 0; d < 6 * 28; d += 7) {
      for (const f of foreign) {
        const r = f === 'SYP' ? `${12000 + Math.floor(rnd() * 3000)}.${Math.floor(rnd() * 1e4)}` : f === 'EUR' && kind === 'USD' ? `1.${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}` : `${13000 + Math.floor(rnd() * 4000)}.${Math.floor(rnd() * 1e6)}`;
        await rate(c, { currencyCode: f, rate: r, rateQuote: f === 'SYP' && kind === 'USD' ? 'foreign_per_base' : 'base_per_foreign', effectiveAt: day(d) });
      }
    }
    const invs = [];
    for (let n = 0; n < 12; n++) {
      const curr = [kind, ...foreign][n % 3];
      const price = curr === 'SYP' ? String(1000 + Math.floor(rnd() * 900000)) : `${1 + Math.floor(rnd() * 500)}.${String(Math.floor(rnd() * 100)).padStart(2, '0')}`;
      invs.push(await invoice(c, { currencyCode: curr, date: day(1 + n * 3), price, qty: 1 + Math.floor(rnd() * 3) }));
    }
    for (let n = 0; n < 15; n++) {
      const curr = [kind, ...foreign][Math.floor(rnd() * 3)];
      const amount = curr === 'SYP' ? String(5000 + Math.floor(rnd() * 3000000)) : `${1 + Math.floor(rnd() * 400)}.${String(Math.floor(rnd() * 100)).padStart(2, '0')}`;
      await receipt(c, { currencyCode: curr, amount, date: day(60 + n * 5) });
    }
    // A couple of credit notes on still-open invoices.
    for (const inv of invs.slice(0, 4)) {
      const fresh = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(inv.id);
      if (fresh.status !== 'posted' || require('../lib/receivables').invoiceOpenMinor(fresh) <= 0) continue;
      const full = (await c.m.get(`/api/sales/invoices/${inv.id}`)).body;
      await c.m.post('/api/sales/credit-notes', { invoiceId: inv.id, lines: [{ invoiceLineId: full.lines[0].id, qty: 0.5 }] });
    }
    assertAllEntriesBalance(c.companyId);
    // The run must really exercise cross-currency settlement and FX.
    const cross = db.prepare(`SELECT COUNT(*) c FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id JOIN sales_invoices i ON i.id = a.invoice_id
      WHERE a.company_id = ? AND r.currency_code <> i.currency_code`).get(c.companyId).c;
    const fxCount = db.prepare("SELECT COUNT(*) c FROM fx_settlements WHERE company_id = ? AND status = 'posted'").get(c.companyId).c;
    const settled = db.prepare("SELECT * FROM sales_invoices WHERE company_id = ? AND status = 'posted' AND currency_code <> ?").all(c.companyId, kind)
      .filter((i) => require('../lib/receivables').invoiceOpenMinor(i) === 0).length;
    if (process.env.DBG) console.log(kind, { cross, fxCount, settled });
    assert.ok(cross > 0 && fxCount > 0 && settled > 0, `${kind}: cross=${cross} fx=${fxCount} settledForeign=${settled}`);
    // Settled invoices carry exactly zero base.
    const currency = require('../lib/currency');
    const rec = require('../lib/receivables');
    for (const inv of db.prepare("SELECT * FROM sales_invoices WHERE company_id = ? AND status <> 'draft'").all(c.companyId)) {
      if (rec.invoiceOpenMinor(inv) === 0) assert.equal(currency.invoiceBaseOpen(inv), 0, `invoice ${inv.invoice_number} settled with base dust`);
    }
    // AR control = Σ customer ledgers = aging total = documents' base.
    const docsBase = currency.openReceivables(c.companyId).reduce((s, it) => s + it.base_minor, 0);
    assert.equal(docsBase, arBase(c), `${kind}: open documents' base = customer AR`);
    await assertLedgerClean(c);
  }
});

test('the daily USD/SYP fetch also writes the rate history (direction per base)', async () => {
  const currency = require('../lib/currency');
  const syp = await company('SYP');
  const usd = await company('USD');
  const a = currency.recordApiUsdSyp(syp.companyId, 13502.25, 'api');
  assert.equal(a.currency_code, 'USD');
  assert.equal(a.rate_quote, 'base_per_foreign');
  assert.equal(a.rate, '13502.25');
  assert.equal(a.source, 'api');
  const b = currency.recordApiUsdSyp(usd.companyId, 13502.25, 'api');
  assert.equal(b.currency_code, 'SYP');
  assert.equal(b.rate_quote, 'foreign_per_base');
  assert.equal(b.rate, '13502.25');
});

test('migration-era rows (no currency columns) still behave as base currency', async () => {
  const c = await company('SYP');
  const inv = await invoice(c, { date: `${Y}-02-01`, price: '1000' });
  // Pre-Prompt-5 invoice/receipt rows have NULL rate/base columns.
  db.prepare('UPDATE sales_invoices SET rate_e8 = NULL, rate_quote = NULL, total_base_minor = NULL WHERE id = ?').run(inv.id);
  const r = await receipt(c, { amount: '400', date: `${Y}-02-02` });
  db.prepare('UPDATE customer_receipts SET currency_code = NULL, amount_original_minor = NULL, rate_e8 = NULL, rate_quote = NULL WHERE id = ?').run(r.id);
  db.prepare('UPDATE receipt_allocations SET receipt_amount_minor = NULL, base_paid_minor = NULL, base_relieved_minor = NULL WHERE receipt_id = ?').run(r.id);
  const currency = require('../lib/currency');
  assert.equal(currency.invoiceBaseOpen(db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(inv.id)), 600);
  const r2 = await receipt(c, { amount: '600', date: `${Y}-02-03` });
  assert.equal(r2.allocations[0].amount_minor, 600);
  assert.equal(arBase(c), 0);
  await assertLedgerClean(c);
});

test('atomicity: a failure after the realized-FX entry rolls back the receipt, allocation and FX entry', async () => {
  const faults = require('../lib/faultInjection');
  const c = await company('SYP');
  await rate(c, { currencyCode: 'USD', rate: '13000', effectiveAt: `${Y}-03-01` });
  await invoice(c, { currencyCode: 'USD', date: `${Y}-03-02`, price: '10' });
  await rate(c, { currencyCode: 'USD', rate: '13500', effectiveAt: `${Y}-03-10` });
  const snap = () => ({
    entries: db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?').get(c.companyId).c,
    receipts: db.prepare('SELECT COUNT(*) c FROM customer_receipts WHERE company_id = ?').get(c.companyId).c,
    allocs: db.prepare('SELECT COUNT(*) c FROM receipt_allocations WHERE company_id = ?').get(c.companyId).c,
    fx: db.prepare('SELECT COUNT(*) c FROM fx_settlements WHERE company_id = ?').get(c.companyId).c,
  });
  const before = snap();
  faults.arm('receivables.allocation.after_fx');
  const res = await c.m.post('/api/receivables/receipts', { shopId: c.shop, method: 'cash', amount: '135000', date: `${Y}-03-11` });
  faults.disarmAll();
  assert.equal(res.status, 500);
  assert.deepEqual(snap(), before);
  const ok = await receipt(c, { amount: '135000', date: `${Y}-03-11` });
  assert.equal(ok.fx_settlements.length, 1);
  assert.equal(ok.fx_settlements[0].fx_minor, 5000);
});

test('realized FX falls back to the allocation date when the receipt-date period is closed', async () => {
  const c = await company('SYP');
  await rate(c, { currencyCode: 'USD', rate: '13000', effectiveAt: `${Y}-01-01` });
  const inv = await invoice(c, { currencyCode: 'USD', date: `${Y}-01-05`, price: '10' });
  await rate(c, { currencyCode: 'USD', rate: '14000', effectiveAt: `${Y}-02-01` });
  const r = await receipt(c, { amount: '140000', date: `${Y}-02-10`, autoAllocate: false });
  const feb = (await c.m.get('/api/ledger/periods')).body.find((p) => p.start_date === `${Y}-02-01`);
  assert.equal((await c.m.post(`/api/ledger/periods/${feb.id}/close`, {})).status, 200);
  const set = await c.m.put(`/api/receivables/receipts/${r.id}/allocations`, { allocations: [{ invoiceId: inv.id, amount: '140000' }] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const fx = db.prepare("SELECT s.fx_minor, e.entry_date FROM fx_settlements s JOIN journal_entries e ON e.id = s.journal_entry_id WHERE s.receipt_id = ?").get(r.id);
  assert.equal(fx.fx_minor, 10000);
  assert.equal(fx.entry_date, new Date().toISOString().slice(0, 10));
  await assertLedgerClean(c);
});

// Item 3 (after Prompt 5): the same story in BOTH base currencies, showing
// exactly where realized and unrealized FX land. The original
// "$100 / 13,000 / 14,000" test above is the SYP-base case.
for (const scenario of [
  {
    base: 'SYP', foreign: 'USD', quote: 'base_per_foreign',
    // invoice $100 @ 13,000 SYP/USD = 1,300,000 SYP; paid 1,400,000 SYP @ 14,000 = $100 -> realized GAIN 100,000 SYP
    price: '100', paid: '1400000', paidCurrency: 'SYP', realized: 100000,
    // second invoice $200 open at 13,000 = 2,600,000; closing rate 15,000 -> 3,000,000: unrealized GAIN 400,000 SYP
    price2: '200', unrealized: 400000,
    // the SYP received is base currency: no cash revaluation
    cashUnrealized: 0,
  },
  {
    base: 'USD', foreign: 'SYP', quote: 'foreign_per_base',
    // invoice 1,300,000 SYP @ 13,000 SYP/USD = $100.00; paid 1,300,000 SYP @ 14,000 = $92.86 -> realized LOSS $7.14
    price: '1300000', paid: '1300000', paidCurrency: 'SYP', realized: -714,
    // second invoice 2,600,000 SYP open at 13,000 = $200.00; closing 15,000 -> $173.33: unrealized LOSS $26.67
    price2: '2600000', unrealized: -2667,
    // the 1,300,000 SYP received sits in the cash box as a FOREIGN balance:
    // carried $92.86 (at 14,000), revalued $86.67 (at 15,000) -> LOSS $6.19
    cashUnrealized: -619,
  },
]) {
  test(`${scenario.base}-base company: ${scenario.foreign} invoice, realized FX on fx_realized, revaluation on fx_unrealized`, async () => {
    const c = await company(scenario.base);
    await rate(c, { currencyCode: scenario.foreign, rate: '13000', rateQuote: scenario.quote, effectiveAt: `${Y}-03-01` });
    await rate(c, { currencyCode: scenario.foreign, rate: '14000', rateQuote: scenario.quote, effectiveAt: `${Y}-04-01` });
    const inv = await invoice(c, { currencyCode: scenario.foreign, date: `${Y}-03-05`, price: scenario.price });
    const open = await invoice(c, { currencyCode: scenario.foreign, date: `${Y}-03-06`, price: scenario.price2 });
    const r = await receipt(c, { currencyCode: scenario.paidCurrency, amount: scenario.paid, date: `${Y}-04-05`, allocations: [{ invoiceId: inv.id, amount: scenario.paid }] });
    assert.equal(r.fx_settlements.length, 1);
    assert.equal(r.fx_settlements[0].fx_minor, scenario.realized);
    await rate(c, { currencyCode: scenario.foreign, rate: '15000', rateQuote: scenario.quote, effectiveAt: `${Y}-04-30` });
    const rv = await c.m.post('/api/currency/revaluations', { asOf: `${Y}-04-30` });
    assert.equal(rv.status, 201, JSON.stringify(rv.body));
    assert.equal(rv.body.lines.find((l) => l.document_id === open.id).difference_minor, scenario.unrealized);
    const cashLine = rv.body.lines.find((l) => l.kind === 'account');
    assert.equal(cashLine ? cashLine.difference_minor : 0, scenario.cashUnrealized);
    const totalUnrealized = scenario.unrealized + scenario.cashUnrealized;
    assert.equal(rv.body.total_minor, totalUnrealized);

    // Where it lands: the realized FX entry hits fx_realized only; the
    // revaluation hits fx_unrealized only.
    const accOf = (entryId) => db.prepare("SELECT DISTINCT a.system_key FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.system_key LIKE 'fx_%'").all(entryId).map((x) => x.system_key);
    assert.deepEqual(accOf(r.fx_settlements[0].journal_entry_id), ['fx_realized']);
    assert.deepEqual(accOf(rv.body.journal_entry.id), ['fx_unrealized']);
    assert.deepEqual(accOf(rv.body.reversal_entry.id), ['fx_unrealized']);

    // Income statement for April (revaluation on 04-30, reversal on 05-01):
    // both accounts show in expenses (a gain is a negative expense).
    const is = (await c.m.get(`/api/financial-reports/income-statement?from=${Y}-04-01&to=${Y}-04-30`)).body;
    const row = (key) => is.sections.expenses.find((x) => x.account_id === c.acc(key));
    assert.equal(row('fx_realized').amounts[0], -scenario.realized);
    assert.equal(row('fx_unrealized').amounts[0], -totalUnrealized);
    // May: the reversal cancels the unrealized amount.
    const may = (await c.m.get(`/api/financial-reports/income-statement?from=${Y}-05-01&to=${Y}-05-31`)).body;
    assert.equal(may.sections.expenses.find((x) => x.account_id === c.acc('fx_unrealized')).amounts[0], totalUnrealized);
    // FX report: realized vs unrealized totals (April + May: unrealized nets to 0).
    const rep = (await c.m.get(`/api/currency/fx-report?from=${Y}-04-01&to=${Y}-04-30`)).body;
    assert.equal(rep.totals.realized, scenario.realized);
    assert.equal(rep.totals.unrealized, totalUnrealized);
    assert.equal((await c.m.get(`/api/currency/fx-report?from=${Y}-04-01&to=${Y}-05-31`)).body.totals.unrealized, 0);
    await assertLedgerClean(c);
  });
}
