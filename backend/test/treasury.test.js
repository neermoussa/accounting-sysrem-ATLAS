// backend/test/treasury.test.js
//
// Prompt 7 "Done when":
//  - every voucher / transfer / cheque event posts a balanced entry;
//  - bank reconciliation matches imported lines and leaves a correct
//    unmatched list;
//  - cheque bounce reverses correctly;
//  - a cross-currency transfer posts an FX line when needed.
// Plus the owner's extras: rep collections and cheques in a foreign
// currency (rate locked at confirmation), cash boxes per currency, rep cash
// handover per currency with over/short per currency, vouchers under the
// separation-of-duties setting, failure injection on every money path,
// per-user box access, permissions and the tenant-ref rule on every
// endpoint. Base currency: USD. The flag-off golden test
// (ledgerLiveFlag.test.js) is untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-treasury-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const faults = require('../lib/faultInjection');
const T = require('../lib/treasury');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);
let listener;
let base;
let ctx;

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const refused = (r, code, status) => {
  if (status) assert.equal(r.status, status, JSON.stringify(r.body));
  else assert.ok(r.status >= 400, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error, code, JSON.stringify(r.body));
  return r.body;
};
function lines(entryId) {
  return db.prepare('SELECT a.system_key, a.code, l.account_id, l.debit_minor d, l.credit_minor c, l.currency_code, l.amount_original_minor, l.party_type, l.party_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(entryId);
}
const net = (ls, pred) => ls.filter(pred).reduce((s, l) => s + l.d - l.c, 0);
const byKey = (k) => (l) => l.system_key === k;
const byAcc = (id) => (l) => l.account_id === id;
function balanced(entryId) {
  const ls = lines(entryId);
  assert.ok(ls.length >= 2, `entry ${entryId} has lines`);
  assert.equal(ls.reduce((s, l) => s + l.d, 0), ls.reduce((s, l) => s + l.c, 0), `entry ${entryId} balanced`);
  return ls;
}
function accountBalance(accountId) {
  return db.prepare("SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.status IN ('posted','reversed')").get(accountId).s;
}
function sysBalance(companyId, key, party) {
  return db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND a.system_key = ? AND e.status IN ('posted','reversed') ${party ? 'AND l.party_type = ? AND l.party_id = ?' : ''}`)
    .get(...[companyId, key, ...(party || [])]).s;
}
const snapshot = (companyId) => ({
  entries: db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?').get(companyId).c,
  lines: db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE company_id = ?').get(companyId).c,
  vouchers: db.prepare("SELECT status, COUNT(*) c FROM treasury_vouchers WHERE company_id = ? GROUP BY status ORDER BY status").all(companyId).map((r) => `${r.status}:${r.c}`).join(','),
  cheques: db.prepare("SELECT status, COUNT(*) c FROM cheques_issued WHERE company_id = ? GROUP BY status ORDER BY status").all(companyId).map((r) => `${r.status}:${r.c}`).join(','),
  received: db.prepare("SELECT status, COUNT(*) c FROM cheques_received WHERE company_id = ? GROUP BY status ORDER BY status").all(companyId).map((r) => `${r.status}:${r.c}`).join(','),
  payments: db.prepare("SELECT status, COUNT(*) c FROM supplier_payments WHERE company_id = ? GROUP BY status ORDER BY status").all(companyId).map((r) => `${r.status}:${r.c}`).join(','),
  handovers: db.prepare("SELECT status, COUNT(*) c FROM rep_cash_handovers WHERE company_id = ? GROUP BY status ORDER BY status").all(companyId).map((r) => `${r.status}:${r.c}`).join(','),
  collections: db.prepare("SELECT status, COUNT(*) c FROM collections WHERE company_id = ? GROUP BY status ORDER BY status").all(companyId).map((r) => `${r.status}:${r.c}`).join(','),
  fxLocked: db.prepare('SELECT COUNT(*) c FROM collection_fx WHERE company_id = ? AND locked_at IS NOT NULL').get(companyId).c,
});
async function assertClean() {
  assert.deepEqual(ok(await ctx.m.get('/api/ledger/integrity-check')).violations, []);
  const bad = db.prepare('SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.company_id = ? GROUP BY e.id HAVING SUM(l.debit_minor) <> SUM(l.credit_minor)').all(ctx.co.companyId);
  assert.deepEqual(bad, []);
}

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة الخزينة');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  ok(await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.10', effectiveAt: day(-20) }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.20', effectiveAt: TODAY }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.25', effectiveAt: day(1) }), 201);
  const shop = await h.mkShop(m, 'زبون الخزينة');
  // Before go-live, rep cash handover cannot be switched on; the dry run shows go-live will switch it on.
  const pre = await m.put('/api/treasury/settings', { repCashHandover: true });
  assert.equal(pre.status, 409, JSON.stringify(pre.body));
  const { dry, res } = await h.goLive(m, TODAY);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(dry.body.settings_changes.map((c) => [c.key, c.to]), [['rep_cash_handover', true]]);
  const approver = await createRep(base, m, { permissions: ['view_treasury', 'approve_vouchers', 'create_vouchers', 'manage_cheques', 'make_supplier_payments'] });
  const clerk = await createRep(base, m, { permissions: ['view_treasury', 'create_vouchers'] });
  const rep = await createRep(base, m, { permissions: ['view_app', 'record_collections'], name: 'مندوب الخزينة' });
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد الشيكات', currencyCode: 'USD' }), 201);
  const euSupplier = ok(await m.post('/api/purchasing/suppliers', { name: 'EU cheque supplier', currencyCode: 'EUR' }), 201);
  // Other company for tenant checks.
  const other = await h.createUsdCompany(base, 'شركة خزينة أخرى');
  const oAcc = await h.setupLedger(other.manager);
  const oBox = ok(await other.manager.post('/api/treasury/boxes', { name: 'بنك غريب', kind: 'bank', currencyCode: 'USD' }), 201);
  const oSupplier = ok(await other.manager.post('/api/purchasing/suppliers', { name: 'مورد غريب' }), 201);
  const oVoucher = ok(await other.manager.post('/api/treasury/vouchers', { type: 'bank_fee', cashBoxId: oBox.id, amount: '1' }), 201);
  const oCheque = ok(await other.manager.post('/api/treasury/cheques', { cashBoxId: oBox.id, chequeNumber: 'X1', amount: '1', counterAccountId: oAcc.accounts.find((a) => a.code === '6200').id }), 201);
  const oUser = await createRep(base, other.manager, { permissions: ['view_app'] });
  ctx = {
    co, m, acc, shop, approver, clerk, rep, supplier, euSupplier,
    other: { ...other, box: oBox, supplier: oSupplier, voucher: oVoucher, cheque: oCheque, user: oUser, acc: (code) => oAcc.accounts.find((a) => a.code === code).id, lineId: db.prepare('SELECT id FROM journal_lines WHERE company_id = ? LIMIT 1').get(other.companyId).id },
  };
});

test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('cash boxes per currency: main box on cash_default, new boxes get their own ledger account in their currency; per-user access', async () => {
  const { m, clerk, approver } = ctx;
  const boxes = ok(await m.get('/api/treasury/boxes'));
  const main = boxes.find((b) => b.is_main);
  assert.equal(main.currency_code, 'USD');
  assert.equal(main.account_code, '1110');
  const eurCash = ok(await m.post('/api/treasury/boxes', { name: 'صندوق اليورو', kind: 'cash', currencyCode: 'EUR', userIds: [approver.userId] }), 201);
  const eurBank = ok(await m.post('/api/treasury/boxes', { name: 'بنك اليورو', kind: 'bank', currencyCode: 'EUR', bankName: 'Bank A', iban: 'DE00', userIds: [approver.userId] }), 201);
  const usdBank = ok(await m.post('/api/treasury/boxes', { name: 'بنك الدولار', kind: 'bank', currencyCode: 'USD', userIds: [approver.userId] }), 201);
  for (const b of [eurCash, eurBank, usdBank]) {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(b.account_id);
    assert.equal(a.report_class, 'cash');
    assert.equal(a.currency_code, b.currency_code === 'USD' ? null : 'EUR', 'foreign box account is locked to its currency');
  }
  assert.equal(db.prepare('SELECT code FROM accounts WHERE id = ?').get(usdBank.account_id).code.slice(0, 3), '112', 'banks under 1120');
  refused(await m.post('/api/treasury/boxes', { name: 'صندوق اليورو', currencyCode: 'EUR' }), 'duplicate_name', 409);
  // A plain voucher clerk sees and uses only the boxes assigned to them.
  assert.equal(ok(await clerk.client.get('/api/treasury/boxes')).length, 0);
  refused(await clerk.client.post('/api/treasury/vouchers', { type: 'payment', cashBoxId: main.id, amount: '5', counterAccountId: ctx.acc('6200') }), 'cash_box_access_denied', 403);
  ok(await m.put(`/api/treasury/boxes/${main.id}`, { userIds: [clerk.userId, approver.userId] }));
  assert.equal(ok(await clerk.client.get('/api/treasury/boxes')).length, 1);
  // An account that already belongs to a box (or a control account) cannot be another box.
  refused(await m.post('/api/treasury/boxes', { name: 'تكرار', currencyCode: 'USD', accountId: main.account_id }), 'account_in_use', 409);
  refused(await m.post('/api/treasury/boxes', { name: 'ذمم', currencyCode: 'USD', accountId: ctx.acc('1130') }), 'invalid_box_account');
  Object.assign(ctx, { main, eurCash, eurBank, usdBank });
});

test('vouchers RV / PV / EV / BF post balanced entries on approval; separation of duties; control accounts refused; reversal', async () => {
  const { m, clerk, approver, main, usdBank } = ctx;
  // Fund the main box with a receipt voucher (other income).
  const rv = ok(await clerk.client.post('/api/treasury/vouchers', { type: 'receipt', cashBoxId: main.id, amount: '1000', counterAccountId: ctx.acc('4900'), payee: 'إيراد متفرق' }), 201);
  assert.equal(rv.status, 'draft');
  refused(await clerk.client.post(`/api/treasury/vouchers/${rv.id}/approve`, {}), null, 403);
  const own = refused(await approver.client.post(`/api/treasury/vouchers/${ok(await approver.client.post('/api/treasury/vouchers', { type: 'receipt', cashBoxId: main.id, amount: '1', counterAccountId: ctx.acc('4900') }), 201).id}/approve`, {}), 'sod_voucher_creator', 403);
  assert.match(own.message, /فصل المهام/);
  const posted = ok(await approver.client.post(`/api/treasury/vouchers/${rv.id}/approve`, {}));
  assert.equal(posted.status, 'posted');
  assert.match(posted.voucher_number, /^RV-/);
  let ls = balanced(posted.journal_entry_id);
  assert.equal(net(ls, byAcc(main.account_id)), 100000);
  assert.equal(net(ls, byAcc(ctx.acc('4900'))), -100000);
  // Payment voucher (rent) and expense voucher with input tax.
  const pv = ok(await approver.client.post(`/api/treasury/vouchers/${ok(await clerk.client.post('/api/treasury/vouchers', { type: 'payment', cashBoxId: main.id, amount: '200', counterAccountId: ctx.acc('6200') }), 201).id}/approve`, {}));
  ls = balanced(pv.journal_entry_id);
  assert.equal(net(ls, byAcc(ctx.acc('6200'))), 20000);
  assert.equal(net(ls, byAcc(main.account_id)), -20000);
  const ev = ok(await approver.client.post(`/api/treasury/vouchers/${ok(await clerk.client.post('/api/treasury/vouchers', { type: 'expense', cashBoxId: main.id, amount: '115', tax: '15', counterAccountId: ctx.acc('6300') }), 201).id}/approve`, {}));
  ls = balanced(ev.journal_entry_id);
  assert.equal(net(ls, byAcc(ctx.acc('6300'))), 10000);
  assert.equal(net(ls, byKey('input_tax')), 1500);
  assert.equal(net(ls, byAcc(main.account_id)), -11500);
  refused(await clerk.client.post('/api/treasury/vouchers', { type: 'expense', cashBoxId: main.id, amount: '5', counterAccountId: ctx.acc('4900') }), 'expense_account_required');
  // Control accounts need their own documents.
  for (const code of ['1130', '2110', '2160']) refused(await clerk.client.post('/api/treasury/vouchers', { type: 'payment', cashBoxId: main.id, amount: '5', counterAccountId: ctx.acc(code) }), 'control_account');
  refused(await clerk.client.post('/api/treasury/vouchers', { type: 'payment', cashBoxId: main.id, amount: '5', counterAccountId: usdBank.account_id }), 'use_transfer');
  // Bank fee: bank boxes only, posted to bank_charges.
  refused(await m.post('/api/treasury/vouchers', { type: 'bank_fee', cashBoxId: main.id, amount: '2' }), 'wrong_box_kind');
  const bfDraft = ok(await approver.client.post('/api/treasury/vouchers', { type: 'bank_fee', cashBoxId: usdBank.id, amount: '2.50', description: 'عمولة تحويل' }), 201);
  const bf = ok(await m.post(`/api/treasury/vouchers/${bfDraft.id}/approve`, {}));
  ls = balanced(bf.journal_entry_id);
  assert.equal(net(ls, byKey('bank_charges')), 250);
  assert.equal(net(ls, byAcc(usdBank.account_id)), -250);
  // Reverse a posted voucher: entry reversed, the box back.
  const before = accountBalance(main.account_id);
  const rev = ok(await approver.client.post(`/api/treasury/vouchers/${pv.id}/reverse`, { reason: 'خطأ' }));
  assert.equal(rev.status, 'reversed');
  assert.equal(accountBalance(main.account_id), before + 20000);
  refused(await m.post(`/api/ledger/entries/${pv.journal_entry_id}/reverse`, { reason: 'x' }), 'reverse_via_source', 409);
  // Separation of duties OFF: the creator may approve.
  ok(await m.put('/api/purchasing/settings', { enforcePurchasingSeparation: false }));
  const selfV = ok(await approver.client.post('/api/treasury/vouchers', { type: 'receipt', cashBoxId: main.id, amount: '3', counterAccountId: ctx.acc('4900') }), 201);
  ok(await approver.client.post(`/api/treasury/vouchers/${selfV.id}/approve`, {}));
  ok(await m.put('/api/purchasing/settings', { enforcePurchasingSeparation: true }));
  await assertClean();
});

test('transfers: same currency (no FX line) and cross-currency on the Prompt 5 rates with an FX line when needed', async () => {
  const { m, approver, main, usdBank, eurBank, eurCash } = ctx;
  const t1 = ok(await m.post(`/api/treasury/vouchers/${ok(await approver.client.post('/api/treasury/vouchers', { type: 'transfer', cashBoxId: main.id, toCashBoxId: usdBank.id, amount: '300' }), 201).id}/approve`, {}));
  let ls = balanced(t1.journal_entry_id);
  assert.equal(net(ls, byAcc(usdBank.account_id)), 30000);
  assert.equal(net(ls, byAcc(main.account_id)), -30000);
  assert.equal(ls.filter(byKey('fx_realized')).length, 0, 'same currency: no FX line');
  // USD bank -> EUR bank: USD 240 bought EUR 195 (book rate 1.20 = EUR 200): received less -> FX loss of 6.00.
  const t2 = ok(await m.post(`/api/treasury/vouchers/${ok(await approver.client.post('/api/treasury/vouchers', { type: 'transfer', cashBoxId: usdBank.id, toCashBoxId: eurBank.id, amount: '240', toAmount: '195' }), 201).id}/approve`, {}));
  ls = balanced(t2.journal_entry_id);
  const eurLine = ls.find(byAcc(eurBank.account_id));
  assert.deepEqual([eurLine.currency_code, eurLine.amount_original_minor, eurLine.d], ['EUR', 19500, 23400], 'EUR 195 @1.20');
  assert.equal(net(ls, byAcc(usdBank.account_id)), -24000);
  assert.equal(net(ls, byKey('fx_realized')), 600, 'FX line: 240.00 sent, 234.00 received at the book rate');
  assert.equal(t2.fx_minor, 600);
  // No received amount typed: converted through the rates -> no FX line.
  const t3 = ok(await m.post(`/api/treasury/vouchers/${ok(await approver.client.post('/api/treasury/vouchers', { type: 'transfer', cashBoxId: usdBank.id, toCashBoxId: eurCash.id, amount: '12' }), 201).id}/approve`, {}));
  ls = balanced(t3.journal_entry_id);
  assert.equal(ls.find(byAcc(eurCash.account_id)).amount_original_minor, 1000, 'USD 12 = EUR 10 at 1.20');
  assert.equal(ls.filter(byKey('fx_realized')).length, 0);
  // EUR box balances are kept in EUR.
  assert.equal(ok(await m.get(`/api/treasury/boxes/${eurBank.id}`)).balance_minor, 19500);
  await assertClean();
});

test('cheques issued: to a supplier (AP via a supplier payment, cheques_payable), clear, cancel, bounce reverses correctly; foreign cheque clears with an FX line', async () => {
  const { m, approver, usdBank, eurBank, supplier, euSupplier, co } = ctx;
  // A posted expense invoice gives the supplier something to pay.
  const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: supplier.id, invoiceDate: TODAY, lines: [{ description: 'خدمة', qty: 1, unitPrice: '500', expenseAccountId: ctx.acc('6500') }] }), 201);
  ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
  assert.equal(sysBalance(co.companyId, 'ap_control', ['supplier', supplier.id]), -50000);
  // Separation of duties: the manager posted the invoice, so the approver issues the cheque.
  const own = await m.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'C-0', amount: '1', supplierId: supplier.id, allocations: [{ invoiceId: inv.id, amount: '1' }] });
  refused(own, 'sod_invoice_poster', 403);
  const ch = ok(await approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'C-100', dueDate: day(5), amount: '200', supplierId: supplier.id }), 201);
  let ls = balanced(ch.issue_entry_id);
  assert.equal(net(ls, byKey('ap_control')), 20000);
  assert.equal(net(ls, byKey('cheques_payable')), -20000);
  assert.ok(ch.supplier_payment_id);
  assert.equal(ok(await m.get(`/api/purchasing/invoices/${inv.id}`)).open_minor, 30000, 'auto-allocated to the invoice');
  refused(await approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'C-100', amount: '1', supplierId: supplier.id }), 'duplicate_cheque', 409);
  ok(await approver.client.post(`/api/treasury/cheques/${ch.id}/hand-over`, {}));
  const bankBefore = accountBalance(usdBank.account_id);
  const cleared = ok(await approver.client.post(`/api/treasury/cheques/${ch.id}/clear`, { date: TODAY }));
  ls = balanced(cleared.clear_entry_id);
  assert.equal(net(ls, byKey('cheques_payable')), 20000);
  assert.equal(accountBalance(usdBank.account_id), bankBefore - 20000);
  refused(await approver.client.post(`/api/treasury/cheques/${ch.id}/bounce`, { reason: 'x' }), 'cheque_already_cleared', 409);
  // Bounce: the payment is reversed, AP owed again, the invoice open again.
  const b = ok(await approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'C-101', amount: '100', supplierId: supplier.id }), 201);
  assert.equal(ok(await m.get(`/api/purchasing/invoices/${inv.id}`)).open_minor, 20000);
  refused(await approver.client.post(`/api/treasury/cheques/${b.id}/bounce`, {}), 'reason_required');
  const bounced = ok(await approver.client.post(`/api/treasury/cheques/${b.id}/bounce`, { reason: 'رصيد غير كافٍ' }));
  assert.equal(bounced.status, 'bounced');
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(b.issue_entry_id).status, 'reversed');
  assert.equal(db.prepare('SELECT status FROM supplier_payments WHERE id = ?').get(b.supplier_payment_id).status, 'reversed');
  assert.equal(ok(await m.get(`/api/purchasing/invoices/${inv.id}`)).open_minor, 30000, 'invoice open again');
  assert.equal(sysBalance(co.companyId, 'ap_control', ['supplier', supplier.id]), -30000);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE company_id = ? AND type = 'cheque_issued_bounced' AND entity_id = ?").get(co.companyId, b.id));
  // Cancel a non-supplier cheque (rent): its entry is reversed.
  const c2 = ok(await approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'C-102', amount: '50', counterAccountId: ctx.acc('6200'), payee: 'المالك' }), 201);
  ls = balanced(c2.issue_entry_id);
  assert.equal(net(ls, byAcc(ctx.acc('6200'))), 5000);
  const cancelled = ok(await approver.client.post(`/api/treasury/cheques/${c2.id}/cancel`, { reason: 'استبدال' }));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(c2.issue_entry_id).status, 'reversed');
  // EUR cheque from the EUR bank issued at 1.20, cleared tomorrow at 1.25: FX loss 5.00 on EUR 100.
  const eu = ok(await approver.client.post('/api/treasury/cheques', { cashBoxId: eurBank.id, chequeNumber: 'E-1', amount: '100', supplierId: euSupplier.id }), 201);
  assert.equal(eu.amount_base_minor, 12000);
  const euClear = ok(await approver.client.post(`/api/treasury/cheques/${eu.id}/clear`, { date: day(1) }));
  ls = balanced(euClear.clear_entry_id);
  assert.equal(net(ls, byKey('cheques_payable')), 12000);
  assert.equal(net(ls, byAcc(eurBank.account_id)), -12500);
  assert.equal(net(ls, byKey('fx_realized')), 500);
  assert.equal(ls.find(byAcc(eurBank.account_id)).amount_original_minor, 10000);
  assert.equal(sysBalance(co.companyId, 'cheques_payable'), 0, 'every cheque cleared, cancelled or bounced');
  await assertClean();
});

test('received cheque in a foreign currency: rate locked at recording, clears into the EUR bank with an FX line; bounce reverses the receipt', async () => {
  const { m, shop, eurBank, usdBank, co } = ctx;
  const inv = ok(await m.post('/api/sales/invoices', { shopId: shop, invoiceDate: TODAY, currencyCode: 'EUR', lines: [{ description: 'بضاعة', qty: 1, unitPrice: '300' }] }), 201);
  ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  const ch = ok(await m.post('/api/receivables/cheques', { shopId: shop, chequeNumber: 'R-EUR-1', bankName: 'BK', receivedDate: TODAY, dueDate: day(3), amount: '200', currencyCode: 'EUR' }), 201);
  assert.deepEqual([ch.currency_code, ch.amount_original_minor, ch.amount_minor], ['EUR', 20000, 24000], 'EUR 200 locked at 1.20');
  assert.equal(ch.receipt.currency_code, 'EUR');
  refused(await m.post(`/api/receivables/cheques/${ch.id}/clear`, {}), 'cash_box_required');
  refused(await m.post(`/api/receivables/cheques/${ch.id}/clear`, { cashBoxId: usdBank.id }), 'currency_mismatch');
  const cleared = ok(await m.post(`/api/receivables/cheques/${ch.id}/clear`, { cashBoxId: eurBank.id, date: day(1) }));
  const ls = balanced(cleared.clear_entry_id);
  assert.equal(net(ls, byAcc(eurBank.account_id)), 25000, 'EUR 200 @1.25');
  assert.equal(net(ls, byKey('cheques_in_portfolio')), -24000, 'carried at the locked rate');
  assert.equal(net(ls, byKey('fx_realized')), -1000, 'gain 10.00');
  // A second one bounces: the receipt entry is reversed, the customer owes again.
  const arBefore = sysBalance(co.companyId, 'ar_control', ['customer', shop]);
  const ch2 = ok(await m.post('/api/receivables/cheques', { shopId: shop, chequeNumber: 'R-EUR-2', bankName: 'BK', receivedDate: TODAY, dueDate: day(2), amount: '50', currencyCode: 'EUR' }), 201);
  assert.equal(sysBalance(co.companyId, 'ar_control', ['customer', shop]), arBefore - 6000);
  ok(await m.post(`/api/receivables/cheques/${ch2.id}/bounce`, { reason: 'مرتجع' }));
  assert.equal(sysBalance(co.companyId, 'ar_control', ['customer', shop]), arBefore, 'bounce restores the receivable exactly');
  assert.equal(sysBalance(co.companyId, 'cheques_in_portfolio'), 0);
  await assertClean();
});

test('rep collections in a foreign currency: rate locked at confirmation; base collections unchanged', async () => {
  const { m, rep, shop, co } = ctx;
  // Go-live switched rep cash handover ON (audited); this test covers the OFF path, so switch it off.
  assert.equal(ok(await m.get('/api/treasury/settings')).rep_cash_handover, true, 'go-live turned it on');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE company_id = ? AND action = 'ledger.go_live.setting'").get(co.companyId));
  ok(await m.put('/api/treasury/settings', { repCashHandover: false }));
  const c = ok(await rep.client.post('/api/collections', { shopId: shop, method: 'cash', amount: 100, currencyCode: 'EUR' }), 201);
  assert.equal(c.fx.currency_code, 'EUR');
  assert.equal(c.amount, 120, 'base estimate at today\'s rate');
  assert.equal(db.prepare('SELECT locked_at FROM collection_fx WHERE collection_id = ?').get(c.id).locked_at, null);
  const conf = ok(await m.post(`/api/collections/${c.id}/confirm`, {}));
  assert.equal(conf.status, 'confirmed');
  const fx = db.prepare('SELECT * FROM collection_fx WHERE collection_id = ?').get(c.id);
  assert.ok(fx.locked_at);
  assert.equal(fx.base_minor, 12000);
  const e = db.prepare("SELECT id FROM journal_entries WHERE source_type = 'collection' AND source_id = ?").get(c.id);
  const ls = balanced(e.id);
  assert.equal(ls.find(byKey('ar_control')).currency_code, 'EUR');
  assert.equal(ls.find(byKey('ar_control')).amount_original_minor, 10000);
  const receipt = db.prepare('SELECT * FROM customer_receipts WHERE collection_id = ?').get(c.id);
  assert.deepEqual([receipt.currency_code, receipt.amount_original_minor, receipt.amount_minor], ['EUR', 10000, 12000]);
  // A base collection is exactly the old shape (no fx field).
  const usd = ok(await rep.client.post('/api/collections', { shopId: shop, method: 'cash', amount: 15 }), 201);
  assert.equal(usd.fx, undefined);
  ok(await m.post(`/api/collections/${usd.id}/confirm`, {}));
  assert.equal(net(lines(db.prepare("SELECT id FROM journal_entries WHERE source_type = 'collection' AND source_id = ?").get(usd.id).id), byKey('cash_default')), 1500, 'custody off: cash_default as before');
  ctx.preCustody = [c.id, usd.id];
  assert.equal(sysBalance(co.companyId, 'rep_cash_custody'), 0);
});

test('rep cash handover per currency: custody per rep, over/short per currency, rate difference -> fx_realized', async () => {
  const { m, rep, shop, main, eurCash, usdBank, co } = ctx;
  ok(await m.put('/api/treasury/settings', { repCashHandover: true }));
  const e1 = ok(await rep.client.post('/api/collections', { shopId: shop, method: 'cash', amount: 100, currencyCode: 'EUR' }), 201);
  const e2 = ok(await rep.client.post('/api/collections', { shopId: shop, method: 'cash', amount: 50, currencyCode: 'EUR' }), 201);
  const u1 = ok(await rep.client.post('/api/collections', { shopId: shop, method: 'cash', amount: 80 }), 201);
  for (const c of [e1, e2, u1]) ok(await m.post(`/api/collections/${c.id}/confirm`, {}));
  assert.equal(sysBalance(co.companyId, 'rep_cash_custody', ['employee', rep.userId]), 12000 + 6000 + 8000, 'custody per rep (base)');
  const sum = ok(await m.get('/api/treasury/rep-cash')).summary;
  const eurRow = sum.find((r) => r.currency_code === 'EUR');
  const usdRow = sum.find((r) => r.currency_code === 'USD');
  assert.deepEqual([eurRow.expected_original_minor, eurRow.carried_base_minor, eurRow.count], [15000, 18000, 2]);
  assert.deepEqual([usdRow.expected_original_minor, usdRow.count], [8000, 1]);
  // Wrong box currency / kind refused.
  refused(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'EUR', cashBoxId: main.id, counted: '150' }), 'currency_mismatch');
  refused(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'USD', cashBoxId: usdBank.id, counted: '80' }), 'wrong_box_kind');
  // EUR: counted 148 tomorrow at 1.25 -> short EUR 2 (2.50 base), FX gain 0.25 x 150 = 7.50.
  const hEur = ok(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'EUR', cashBoxId: eurCash.id, counted: '148', date: day(1) }), 201);
  let ls = balanced(hEur.journal_entry_id);
  assert.equal(hEur.over_short_original_minor, -200);
  assert.equal(net(ls, byAcc(eurCash.account_id)), 18500, 'EUR 148 @1.25');
  assert.equal(ls.find(byAcc(eurCash.account_id)).amount_original_minor, 14800);
  assert.equal(net(ls, byKey('rep_cash_custody')), -18000, 'custody released at the carried base');
  assert.equal(net(ls, byKey('cash_over_short')), 250, 'short EUR 2 at 1.25');
  assert.equal(net(ls, byKey('fx_realized')), -750, 'rate gain on EUR 150');
  assert.equal(hEur.items.length, 2);
  // USD: counted 81 -> over 1.00, no FX.
  const hUsd = ok(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'USD', cashBoxId: main.id, counted: '81' }), 201);
  ls = balanced(hUsd.journal_entry_id);
  assert.equal(net(ls, byKey('cash_over_short')), -100);
  assert.equal(ls.filter(byKey('fx_realized')).length, 0);
  assert.equal(sysBalance(co.companyId, 'rep_cash_custody', ['employee', rep.userId]), 0, 'custody empty');
  refused(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'USD', cashBoxId: main.id, counted: '1' }), 'nothing_to_hand_over', 409);
  // A handed-over collection cannot be reversed until its handover is.
  const rc = await m.post(`/api/collections/${u1.id}/reverse`, { reason: 'خطأ' });
  assert.equal(rc.status, 409);
  assert.equal(rc.body.error, 'collection_handed_over');
  ok(await m.post(`/api/treasury/handovers/${hUsd.id}/reverse`, { reason: 'عدّ خاطئ' }));
  assert.equal(sysBalance(co.companyId, 'rep_cash_custody', ['employee', rep.userId]), 8000, 'back in custody');
  assert.equal(ok(await m.get('/api/treasury/rep-cash')).summary.find((r) => r.currency_code === 'USD').count, 1);
  ok(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'USD', cashBoxId: main.id, counted: '80' }), 201);
  ok(await m.put('/api/treasury/settings', { repCashHandover: false }));
  await assertClean();
});

test('daily cash report per box: opening + in - out = closing = ledger, in the box currency', async () => {
  const { m, main, eurCash } = ctx;
  const r = ok(await m.get(`/api/treasury/reports/daily-cash?cashBoxId=${main.id}&from=${day(-1)}&to=${day(1)}`));
  for (const d of r.days) assert.equal(d.closing_minor, d.opening_minor + d.in_minor - d.out_minor);
  assert.equal(r.closing_minor, r.ledger_closing_minor);
  assert.equal(r.closing_minor, accountBalance(main.account_id));
  const e = ok(await m.get(`/api/treasury/reports/daily-cash?cashBoxId=${eurCash.id}&from=${TODAY}&to=${day(1)}`));
  assert.equal(e.closing_minor, 1000 + 14800, 'EUR: transfer EUR 10 + handover EUR 148');
});

test('foreign boxes are revalued by the existing period-end tool (Prompt 5) at the closing rate', async () => {
  const { m, eurBank } = ctx;
  const p = ok(await m.post('/api/currency/revaluations/preview', { asOf: day(1) }));
  const line = p.lines.find((l) => l.kind === 'account' && l.account_id === eurBank.account_id);
  assert.ok(line, 'EUR bank in the revaluation');
  const bal = T.boxBalance(ctx.co.companyId, db.prepare('SELECT * FROM cash_boxes WHERE id = ?').get(eurBank.id), day(1));
  assert.equal(line.open_minor, bal.balance_minor);
  assert.equal(line.difference_minor, Math.round(bal.balance_minor * 1.25) - bal.base_minor, 'to EUR x 1.25');
});

test('bank reconciliation: import CSV, auto-match with confidence, exceptions only for review, manual match / ignore, report book vs bank with reconciling items', async () => {
  const { m, approver, usdBank } = ctx;
  // Book side on the USD bank so far (signed): +300 (TR), -240 (TR), -12 (TR), -2.50 (fee), -200 (cheque C-100 cleared).
  const book = db.prepare("SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.status IN ('posted','reversed')").get(usdBank.account_id).s;
  assert.equal(book, 30000 - 24000 - 1200 - 250 - 20000);
  const csv = [
    'Date,Description,Reference,Debit,Credit,Balance',
    `${TODAY},Transfer in,,,300.00,300.00`,
    `${TODAY},FX purchase EUR,,240.00,,60.00`,
    `${TODAY},Bank fee,,2.50,,57.50`,
    `${TODAY},Cheque paid C-100,C-100,200.00,,-142.50`,
    `${TODAY},Monthly account fee,,4.00,,-146.50`,
    `${TODAY},Unknown deposit,,,10.00,-136.50`,
  ].join('\n');
  const prev = ok(await m.post('/api/treasury/bank/preview', { csv }));
  assert.deepEqual(prev.mapping, { date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5 });
  const st = ok(await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, fileName: 'jan.csv', mapping: prev.mapping, rows: prev.rows, openingBalance: '0' }), 201);
  assert.equal(st.lines.length, 6);
  const byDesc = (d) => st.lines.find((l) => l.description === d);
  assert.equal(byDesc('Transfer in').status, 'matched');
  assert.equal(byDesc('FX purchase EUR').status, 'matched');
  assert.equal(byDesc('Bank fee').status, 'matched');
  assert.equal(byDesc('Cheque paid C-100').status, 'matched');
  assert.equal(byDesc('Cheque paid C-100').confidence, 100, 'amount + same day + reference');
  // Exceptions only: the fee not yet booked and the unknown deposit.
  assert.deepEqual(st.exceptions.map((l) => l.description).sort(), ['Monthly account fee', 'Unknown deposit']);
  let rep = ok(await m.get(`/api/treasury/bank/reconciliation?cashBoxId=${usdBank.id}&asOf=${TODAY}`));
  assert.equal(rep.book_balance_minor, book);
  assert.equal(rep.bank_balance_minor, -13650);
  assert.deepEqual(rep.outstanding_book_lines.map((l) => l.amount_minor), [-1200], 'the USD 12 transfer is not on the statement yet');
  assert.deepEqual(rep.unmatched_bank_lines.map((l) => l.amount_minor).sort((a, b) => a - b), [-400, 1000]);
  assert.equal(rep.difference_minor, 0, 'bank = book - deposits in transit + unpresented payments + bank-only items');
  // Book the monthly fee, then match it by hand; ignore the unknown deposit.
  const fee = ok(await m.post(`/api/treasury/vouchers/${ok(await approver.client.post('/api/treasury/vouchers', { type: 'bank_fee', cashBoxId: usdBank.id, amount: '4' }), 201).id}/approve`, {}));
  const feeLine = db.prepare('SELECT id FROM journal_lines WHERE entry_id = ? AND account_id = ?').get(fee.journal_entry_id, usdBank.account_id).id;
  const feeSt = byDesc('Monthly account fee');
  const cands = ok(await m.get(`/api/treasury/bank/lines/${feeSt.id}/candidates`));
  assert.equal(cands[0].id, feeLine);
  refused(await m.post(`/api/treasury/bank/lines/${byDesc('Unknown deposit').id}/review`, { action: 'match', journalLineId: feeLine }), 'amount_mismatch', 409);
  ok(await m.post(`/api/treasury/bank/lines/${feeSt.id}/review`, { action: 'match', journalLineId: feeLine }));
  ok(await m.post(`/api/treasury/bank/lines/${byDesc('Unknown deposit').id}/review`, { action: 'ignore' }));
  // A matched line cannot be matched twice; a reconciled voucher cannot be reversed.
  refused(await m.post(`/api/treasury/bank/lines/${byDesc('Unknown deposit').id}/review`, { action: 'match', journalLineId: feeLine }), 'line_not_available', 409);
  refused(await approver.client.post(`/api/treasury/vouchers/${fee.id}/reverse`, { reason: 'x' }), 'voucher_reconciled', 409);
  rep = ok(await m.get(`/api/treasury/bank/reconciliation?cashBoxId=${usdBank.id}&asOf=${TODAY}`));
  assert.deepEqual(rep.unmatched_bank_lines, []);
  assert.equal(rep.ignored_bank_lines.length, 1);
  assert.deepEqual(rep.outstanding_book_lines.map((l) => l.amount_minor), [-1200]);
  // Ignored deposit is out of the bank movements -> difference = that 10.00 until it is booked.
  assert.equal(rep.difference_minor, 1000);
  ok(await m.post(`/api/treasury/bank/lines/${byDesc('Unknown deposit').id}/review`, { action: 'unignore' }));
  rep = ok(await m.get(`/api/treasury/bank/reconciliation?cashBoxId=${usdBank.id}&asOf=${TODAY}`));
  assert.equal(rep.difference_minor, 0);
  // Ambiguous: two equal book lines on the same day -> suggestion, not an auto match.
  for (let i = 0; i < 2; i++) ok(await m.post(`/api/treasury/vouchers/${ok(await approver.client.post('/api/treasury/vouchers', { type: 'bank_fee', cashBoxId: usdBank.id, amount: '7' }), 201).id}/approve`, {}));
  const st2 = ok(await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, mapping: { date: 0, description: 1, amount: 2 }, rows: [[TODAY, 'fee', '-7.00']] }), 201);
  assert.equal(st2.lines[0].status, 'suggested');
  ok(await m.post(`/api/treasury/bank/lines/${st2.lines[0].id}/review`, { action: 'confirm' }));
  assert.equal(ok(await m.get(`/api/treasury/bank/statements/${st2.id}`)).counts.matched, 1);
});

test('due-cheques alert: one unread notification per due cheque (received and issued), not repeated while unread', async () => {
  const { approver, usdBank, co } = ctx;
  ok(await approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'DUE-1', dueDate: day(2), amount: '5', counterAccountId: ctx.acc('6200') }), 201);
  const n1 = T.sweepDueCheques();
  assert.ok(n1 >= 1);
  const issuedAlerts = db.prepare("SELECT COUNT(*) c FROM notifications WHERE company_id = ? AND type = 'cheque_due' AND entity_type = 'cheque_issued'").get(co.companyId).c;
  assert.equal(issuedAlerts, 1);
  T.sweepDueCheques();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE company_id = ? AND type = 'cheque_due' AND entity_type = 'cheque_issued'").get(co.companyId).c, 1, 'not repeated while unread');
});

test('failure injection: every money path rolls back completely when it fails after (or between) its writes', async () => {
  const { m, approver, rep, shop, main, usdBank, eurBank, eurCash, supplier, co } = ctx;
  const cid = co.companyId;
  const expectRollback = async (point, call) => {
    const before = snapshot(cid);
    faults.arm(point);
    const r = await call();
    faults.disarmAll();
    assert.equal(r.status, 500, `${point}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(snapshot(cid), before, `${point}: nothing persisted`);
  };
  // Vouchers (approve + reverse) — RV, transfer cross-currency.
  const v = ok(await approver.client.post('/api/treasury/vouchers', { type: 'transfer', cashBoxId: usdBank.id, toCashBoxId: eurBank.id, amount: '24', toAmount: '19' }), 201);
  await expectRollback('treasury.voucher.after_entry', () => m.post(`/api/treasury/vouchers/${v.id}/approve`, {}));
  ok(await m.post(`/api/treasury/vouchers/${v.id}/approve`, {}));
  await expectRollback('treasury.voucher.after_reverse', () => approver.client.post(`/api/treasury/vouchers/${v.id}/reverse`, { reason: 'x' }));
  // Cheques issued: supplier path and account path, clear, bounce/cancel.
  await expectRollback('treasury.cheque_issue.after_entry', () => approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'F-1', amount: '10', supplierId: supplier.id }));
  await expectRollback('treasury.cheque_issue.after_entry', () => approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'F-2', amount: '10', counterAccountId: ctx.acc('6200') }));
  const c = ok(await approver.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'F-3', amount: '10', supplierId: supplier.id }), 201);
  await expectRollback('treasury.cheque_clear.after_entry', () => approver.client.post(`/api/treasury/cheques/${c.id}/clear`, {}));
  await expectRollback('treasury.cheque_undo.after_reverse', () => approver.client.post(`/api/treasury/cheques/${c.id}/bounce`, { reason: 'x' }));
  await expectRollback('treasury.cheque_undo.after_reverse', () => approver.client.post(`/api/treasury/cheques/${c.id}/cancel`, { reason: 'x' }));
  // Received cheque (foreign): record and clear into the box.
  await expectRollback('receivables.receipt.after_entry', () => m.post('/api/receivables/cheques', { shopId: shop, chequeNumber: 'F-R1', receivedDate: TODAY, dueDate: day(1), amount: '10', currencyCode: 'EUR' }));
  const rc = ok(await m.post('/api/receivables/cheques', { shopId: shop, chequeNumber: 'F-R2', receivedDate: TODAY, dueDate: day(1), amount: '10', currencyCode: 'EUR' }), 201);
  await expectRollback('receivables.cheque_clear.after_entry', () => m.post(`/api/receivables/cheques/${rc.id}/clear`, { cashBoxId: eurBank.id }));
  // Foreign rep collection confirmation (rate lock + entry + receipt).
  const col = ok(await rep.client.post('/api/collections', { shopId: shop, method: 'cash', amount: 20, currencyCode: 'EUR' }), 201);
  await expectRollback('collections.confirm.after_balance', () => m.post(`/api/collections/${col.id}/confirm`, {}));
  await expectRollback('receivables.receipt.after_entry', () => m.post(`/api/collections/${col.id}/confirm`, {}));
  // Handover (and its reversal).
  ok(await m.put('/api/treasury/settings', { repCashHandover: true }));
  const col2 = ok(await rep.client.post('/api/collections', { shopId: shop, method: 'cash', amount: 30, currencyCode: 'EUR' }), 201);
  ok(await m.post(`/api/collections/${col2.id}/confirm`, {}));
  await expectRollback('treasury.handover.after_entry', () => m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'EUR', cashBoxId: eurCash.id, counted: '30' }));
  const ho = ok(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'EUR', cashBoxId: eurCash.id, counted: '30' }), 201);
  await expectRollback('treasury.handover.after_reverse', () => m.post(`/api/treasury/handovers/${ho.id}/reverse`, { reason: 'x' }));
  ok(await m.put('/api/treasury/settings', { repCashHandover: false }));
  // Unarmed, each still works exactly once.
  ok(await approver.client.post(`/api/treasury/cheques/${c.id}/cancel`, { reason: 'x' }));
  ok(await m.post(`/api/collections/${col.id}/confirm`, {}));
  void main;
  await assertClean();
});

test('permissions: treasury endpoints are refused without the treasury permissions', async () => {
  const { m, usdBank } = ctx;
  const nobody = await createRep(base, m, { permissions: ['view_app'] });
  for (const [method, url, body] of [
    ['get', '/api/treasury/boxes'], ['post', '/api/treasury/boxes', { name: 'x' }], ['get', '/api/treasury/vouchers'], ['post', '/api/treasury/vouchers', {}],
    ['post', '/api/treasury/cheques', {}], ['post', '/api/treasury/handovers', {}], ['post', '/api/treasury/bank/statements', {}], ['get', `/api/treasury/bank/reconciliation?cashBoxId=${usdBank.id}`],
  ]) {
    assert.equal((await nobody.client[method](url, body)).status, 403, `${method} ${url}`);
  }
  assert.equal((await ctx.clerk.client.post('/api/treasury/boxes', { name: 'x' })).status, 403, 'manage_cash_boxes needed');
  assert.equal((await ctx.clerk.client.post('/api/treasury/cheques', { cashBoxId: usdBank.id })).status, 403, 'manage_cheques needed');
  assert.equal((await ctx.clerk.client.put('/api/treasury/settings', { repCashHandover: true })).status, 403);
});

test('tenant refs: every treasury endpoint rejects another company\'s ids', async () => {
  const { m, other, main, usdBank, rep } = ctx;
  const foreign = (r, what) => assert.ok([400, 404].includes(r.status) && /^invalid_|not_found/.test(r.body.error), `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  foreign(await m.get(`/api/treasury/boxes/${other.box.id}`), 'get box');
  foreign(await m.put(`/api/treasury/boxes/${other.box.id}`, { name: 'x' }), 'update box');
  foreign(await m.post('/api/treasury/boxes', { name: 'سرقة', currencyCode: 'USD', accountId: other.acc('1120') }), 'box account');
  foreign(await m.put(`/api/treasury/boxes/${main.id}`, { userIds: [other.user.userId] }), 'box user');
  foreign(await m.post('/api/treasury/vouchers', { type: 'payment', cashBoxId: other.box.id, amount: '1', counterAccountId: ctx.acc('6200') }), 'voucher box');
  foreign(await m.post('/api/treasury/vouchers', { type: 'payment', cashBoxId: main.id, amount: '1', counterAccountId: other.acc('6200') }), 'voucher counter account');
  foreign(await m.post('/api/treasury/vouchers', { type: 'transfer', cashBoxId: main.id, toCashBoxId: other.box.id, amount: '1' }), 'transfer target');
  foreign(await m.post('/api/treasury/vouchers', { type: 'payment', cashBoxId: main.id, amount: '1', counterAccountId: ctx.acc('1160'), partyType: 'employee', partyId: other.user.userId }), 'voucher employee');
  for (const a of ['approve', 'reject', 'reverse']) foreign(await m.post(`/api/treasury/vouchers/${other.voucher.id}/${a}`, { reason: 'x' }), `voucher ${a}`);
  foreign(await m.get(`/api/treasury/vouchers/${other.voucher.id}`), 'get voucher');
  foreign(await m.put(`/api/treasury/vouchers/${other.voucher.id}`, { amount: '2' }), 'update voucher');
  foreign(await m.del(`/api/treasury/vouchers/${other.voucher.id}`), 'delete voucher');
  foreign(await m.post('/api/treasury/cheques', { cashBoxId: other.box.id, chequeNumber: 'T1', amount: '1', counterAccountId: ctx.acc('6200') }), 'cheque box');
  foreign(await m.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'T2', amount: '1', supplierId: other.supplier.id }), 'cheque supplier');
  foreign(await m.post('/api/treasury/cheques', { cashBoxId: usdBank.id, chequeNumber: 'T3', amount: '1', counterAccountId: other.acc('6200') }), 'cheque account');
  for (const a of ['hand-over', 'clear', 'bounce', 'cancel']) foreign(await m.post(`/api/treasury/cheques/${other.cheque.id}/${a}`, { reason: 'x' }), `cheque ${a}`);
  foreign(await m.get(`/api/treasury/cheques/${other.cheque.id}`), 'get cheque');
  foreign(await m.post('/api/treasury/handovers', { repId: other.user.userId, currencyCode: 'USD', cashBoxId: main.id, counted: '1' }), 'handover rep');
  foreign(await m.post('/api/treasury/handovers', { repId: rep.userId, currencyCode: 'USD', cashBoxId: other.box.id, counted: '1' }), 'handover box');
  foreign(await m.get(`/api/treasury/rep-cash/items?repId=${other.user.userId}`), 'rep cash items');
  foreign(await m.get(`/api/treasury/reports/daily-cash?cashBoxId=${other.box.id}`), 'daily cash');
  foreign(await m.post('/api/treasury/bank/statements', { cashBoxId: other.box.id, mapping: { date: 0, amount: 1 }, rows: [[TODAY, '1']] }), 'statement box');
  foreign(await m.get(`/api/treasury/bank/reconciliation?cashBoxId=${other.box.id}`), 'reconciliation');
  const oSt = ok(await other.manager.post('/api/treasury/bank/statements', { cashBoxId: other.box.id, mapping: { date: 0, amount: 1 }, rows: [[TODAY, '-1']] }), 201);
  foreign(await m.get(`/api/treasury/bank/statements/${oSt.id}`), 'get statement');
  foreign(await m.post(`/api/treasury/bank/statements/${oSt.id}/auto-match`, {}), 'auto-match');
  foreign(await m.get(`/api/treasury/bank/lines/${oSt.lines[0].id}/candidates`), 'candidates');
  foreign(await m.post(`/api/treasury/bank/lines/${oSt.lines[0].id}/review`, { action: 'ignore' }), 'review line');
  const myLine = db.prepare("SELECT id FROM bank_statement_lines WHERE company_id = ? AND status = 'unmatched' LIMIT 1").get(ctx.co.companyId)
    || { id: ok(await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, mapping: { date: 0, amount: 1 }, rows: [[TODAY, '-999']] }), 201).lines[0].id };
  foreign(await m.post(`/api/treasury/bank/lines/${myLine.id}/review`, { action: 'match', journalLineId: other.lineId }), 'review journal line');
  foreign(await m.post(`/api/receivables/cheques/${db.prepare("SELECT id FROM cheques_received WHERE company_id = ? AND status = 'in_portfolio' LIMIT 1").get(ctx.co.companyId)?.id || 0}/clear`, { cashBoxId: other.box.id }), 'received cheque box');
});

test('collections in a foreign currency need the ledger: refused on a company that is not ledger-live', async () => {
  const co = await h.createUsdCompany(base, 'شركة غير مفعلة');
  await h.setupLedger(co.manager);
  const shop = await h.mkShop(co.manager, 'زبون');
  const r = await co.manager.post('/api/collections', { shopId: shop, method: 'cash', amount: 10, currencyCode: 'EUR' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'foreign_collection_requires_ledger');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM collections WHERE company_id = ?').get(co.companyId).c, 0);
});
