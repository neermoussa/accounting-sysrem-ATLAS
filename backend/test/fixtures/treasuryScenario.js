// backend/test/fixtures/treasuryScenario.js
//
// Golden scenario of the EXISTING treasury voucher behaviour, recorded
// BEFORE Prompt 11-lite (payroll) touched any code: receipt, payment,
// expense with input tax, a payment on the salaries-payable account (2130)
// from a SYP box (foreign currency, rate at the voucher date), a transfer
// USD -> SYP, a bank fee, a reversal, the separation-of-duties refusal,
// their entries and the trial balance. A company that does not use payroll
// must keep exactly this.

const { openLiveDb } = require('../liveDb');
const { normalize: baseNormalize } = require('./legacyScenario');

const normalize = (v) => JSON.parse(JSON.stringify(baseNormalize(v)), (k, x) => (k === 'public_token' ? '<TOKEN>' : k === 'backup_path' ? '<BACKUP_PATH>' : typeof x === 'string' ? x.replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>') : x));

async function runTreasuryScenario({ manager, approver, dbPath, companyId, h, D }) {
  const steps = {};
  const s = (name, r) => { steps[name] = { status: r.status, body: r.body }; return r.body; };
  const { accounts } = await h.setupLedger(manager, 'trading');
  const acc = (code) => accounts.find((a) => a.code === code).id;
  s('go_live', (await h.goLive(manager, `${D.slice(0, 4)}-01-01`)).res);
  s('rate_syp', await manager.post('/api/currency/rates', { currencyCode: 'SYP', rate: '13500', rateQuote: 'foreign_per_base', effectiveAt: `${D.slice(0, 4)}-01-01` }));
  const boxes = s('boxes', await manager.get('/api/treasury/boxes'));
  const main = boxes[0];
  const syp = s('box_syp', await manager.post('/api/treasury/boxes', { name: 'صندوق الليرة', kind: 'cash', currencyCode: 'SYP', userIds: [approver.userId] }));
  const bank = s('box_bank', await manager.post('/api/treasury/boxes', { name: 'بنك', kind: 'bank', currencyCode: 'USD', userIds: [approver.userId] }));
  ok(await manager.put(`/api/treasury/boxes/${main.id}`, { userIds: [approver.userId] }));
  const mk = async (name, body) => s(`create_${name}`, await manager.post('/api/treasury/vouchers', { date: D, ...body }));
  const post = async (name, v) => s(`approve_${name}`, await approver.client.post(`/api/treasury/vouchers/${v.id}/approve`, {}));
  const receipt = await mk('receipt', { type: 'receipt', cashBoxId: main.id, amount: '1000', counterAccountId: acc('4900'), payee: 'إيراد متفرق' });
  await post('receipt', receipt);
  await post('payment', await mk('payment', { type: 'payment', cashBoxId: main.id, amount: '200', counterAccountId: acc('6200') }));
  await post('expense', await mk('expense', { type: 'expense', cashBoxId: main.id, amount: '115', tax: '15', counterAccountId: acc('6500') }));
  await post('transfer', await mk('transfer', { type: 'transfer', cashBoxId: main.id, toCashBoxId: syp.id, amount: '300' }));
  await post('salaries_syp', await mk('salaries_syp', { type: 'payment', cashBoxId: syp.id, amount: '1350000', counterAccountId: acc('2130'), description: 'رواتب' }));
  await post('bank_fee', await mk('bank_fee', { type: 'bank_fee', cashBoxId: bank.id, amount: '2.50' }));
  s('sod_own', await manager.post(`/api/treasury/vouchers/${(await manager.post('/api/treasury/vouchers', { date: D, type: 'payment', cashBoxId: main.id, amount: '1', counterAccountId: acc('6200') })).body.id}/approve`, {}));
  s('reverse_payment', await approver.client.post(`/api/treasury/vouchers/${steps.create_payment.body.id}/reverse`, { reason: 'خطأ', date: D }));
  s('trial_balance', await manager.get(`/api/financial-reports/trial-balance?asOf=${D}`));
  const db = openLiveDb(dbPath);
  const q = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
  const tables = {
    vouchers: q('SELECT type, status, voucher_number, currency_code, amount_original_minor, tax_original_minor, amount_base_minor, to_amount_original_minor, to_amount_base_minor, fx_minor, rate_e8, rate_quote FROM treasury_vouchers WHERE company_id = ? ORDER BY id', companyId),
    journal_lines: q(`SELECT e.source_type, e.status, a.code, l.debit_minor, l.credit_minor, l.currency_code, l.amount_original_minor FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = ? AND e.source_type IN ('treasury_voucher', 'reversal') ORDER BY e.id, l.line_no`, companyId),
  };
  db.close();
  return normalize({ steps, tables });
}
function ok(r) {
  if (r.status >= 400) throw new Error(JSON.stringify(r.body));
  return r.body;
}

module.exports = { runTreasuryScenario };
