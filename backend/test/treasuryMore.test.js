// backend/test/treasuryMore.test.js
//
// Prompt 7 follow-ups:
//  - re-importing the same bank statement creates no duplicate lines;
//  - several same-amount bank lines on one day match one-to-one (by
//    reference when there is one; as suggestions to confirm when not);
//  - property test: across random treasury operations (vouchers of every
//    kind, cross-currency transfers, issued and received cheques with
//    clear / bounce / cancel, reversals) the sum of the cash box balances
//    equals the ledger cash accounts, every box balance equals its account
//    in its own currency, and every entry balances.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tr2-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const T = require('../lib/treasury');
const h = require('./salesHelpers');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);
let listener;
let ctx;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

test.before(async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة خزينة 2');
  const m = co.manager;
  const { accounts } = await h.setupLedger(m);
  ok(await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.10', effectiveAt: day(-30) }), 201);
  ok(await m.post('/api/currency/rates', { currencyCode: 'EUR', rate: '1.17', effectiveAt: TODAY }), 201);
  const shop = await h.mkShop(m, 'زبون الشيكات');
  ok((await h.goLive(m, TODAY)).res);
  const main = ok(await m.get('/api/treasury/boxes'))[0];
  const usdBank = ok(await m.post('/api/treasury/boxes', { name: 'بنك 1', kind: 'bank', currencyCode: 'USD' }), 201);
  const eurBank = ok(await m.post('/api/treasury/boxes', { name: 'بنك يورو', kind: 'bank', currencyCode: 'EUR' }), 201);
  const eurCash = ok(await m.post('/api/treasury/boxes', { name: 'صندوق يورو', kind: 'cash', currencyCode: 'EUR' }), 201);
  ctx = { co, m, shop, main, usdBank, eurBank, eurCash, acc: (c) => accounts.find((a) => a.code === c).id };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function voucher(body) {
  const v = ok(await ctx.m.post('/api/treasury/vouchers', body), 201);
  return ok(await ctx.m.post(`/api/treasury/vouchers/${v.id}/approve`, {}));
}

test('re-importing the same bank statement creates no duplicate lines (identical lines inside one file still import)', async () => {
  const { m, usdBank } = ctx;
  const rows = [[TODAY, 'رسوم', 'A1', '-2.00'], [TODAY, 'رسوم', 'A1', '-2.00'], [TODAY, 'إيداع', 'D9', '50.00']];
  const mapping = { date: 0, description: 1, reference: 2, amount: 3 };
  const first = ok(await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, mapping, rows }), 201);
  assert.equal(first.lines.length, 3, 'two identical lines in one file are two real lines');
  const again = await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, mapping, rows });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'statement_already_imported');
  // Overlapping export: two old lines + one new.
  const overlap = ok(await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, mapping, rows: [...rows.slice(1), [TODAY, 'رسوم', 'A1', '-2.00'], [day(1), 'رسوم', 'B2', '-3.00']] }), 201);
  assert.equal(overlap.skipped_duplicates, 3);
  assert.deepEqual(overlap.lines.map((l) => [l.reference, l.amount_minor]), [['B2', -300]]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bank_statement_lines WHERE cash_box_id = ?').get(usdBank.id).c, 4);
  // Clean up for the next tests: ignore these lines.
  for (const l of db.prepare('SELECT id FROM bank_statement_lines WHERE cash_box_id = ?').all(usdBank.id)) ok(await m.post(`/api/treasury/bank/lines/${l.id}/review`, { action: 'ignore' }));
});

test('several same-amount bank lines on one day: one-to-one by reference; without references -> suggestions, each to a different ledger line', async () => {
  const { m, usdBank } = ctx;
  const withRef = [];
  for (const ref of ['TRX-1001', 'TRX-1002', 'TRX-1003']) withRef.push(await voucher({ type: 'bank_fee', cashBoxId: usdBank.id, amount: '7', reference: ref }));
  const lineOf = (v) => db.prepare('SELECT id FROM journal_lines WHERE entry_id = ? AND account_id = ?').get(v.journal_entry_id, usdBank.account_id).id;
  // Statement lists them in another order.
  const st = ok(await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, mapping: { date: 0, description: 1, reference: 2, amount: 3 }, rows: [[TODAY, 'charge', 'TRX-1003', '-7'], [TODAY, 'charge', 'TRX-1001', '-7'], [TODAY, 'charge', 'TRX-1002', '-7']] }), 201);
  const byRef = Object.fromEntries(st.lines.map((l) => [l.reference, l]));
  for (const [i, ref] of ['TRX-1001', 'TRX-1002', 'TRX-1003'].entries()) {
    assert.equal(byRef[ref].status, 'matched', ref);
    assert.equal(byRef[ref].confidence, 100);
    assert.equal(byRef[ref].journal_line_id, lineOf(withRef[i]), `${ref} -> its own voucher`);
  }
  // Same amounts, no references: ambiguous -> suggested, never two on one ledger line; confirming all reconciles all.
  const noRef = [];
  for (let i = 0; i < 3; i++) noRef.push(await voucher({ type: 'bank_fee', cashBoxId: usdBank.id, amount: '9' }));
  const st2 = ok(await m.post('/api/treasury/bank/statements', { cashBoxId: usdBank.id, mapping: { date: 0, description: 1, amount: 2 }, rows: [[TODAY, 'fee', '-9'], [TODAY, 'fee', '-9'], [TODAY, 'fee', '-9']] }), 201);
  assert.deepEqual(st2.lines.map((l) => l.status), ['suggested', 'suggested', 'suggested']);
  const used = new Set(st2.lines.map((l) => l.journal_line_id));
  assert.equal(used.size, 3, 'each suggestion on a different ledger line');
  assert.deepEqual([...used].sort(), noRef.map(lineOf).sort());
  for (const l of st2.lines) ok(await m.post(`/api/treasury/bank/lines/${l.id}/review`, { action: 'confirm' }));
  assert.equal(ok(await m.get(`/api/treasury/bank/statements/${st2.id}`)).counts.matched, 3);
});

// Deterministic PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertInvariant(label) {
  const cid = ctx.co.companyId;
  const boxes = db.prepare('SELECT * FROM cash_boxes WHERE company_id = ?').all(cid);
  const boxBase = boxes.reduce((s, b) => s + T.boxBalance(cid, b).base_minor, 0);
  const ledgerCash = db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND a.report_class = 'cash' AND COALESCE(a.system_key, '') <> 'bank_in_transit'`).get(cid).s;
  assert.equal(boxBase, ledgerCash, `${label}: sum of box balances = ledger cash accounts`);
  for (const b of boxes) {
    const orig = db.prepare(`SELECT COALESCE(SUM(CASE WHEN l.debit_minor > 0 THEN l.amount_original_minor ELSE -l.amount_original_minor END), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.status IN ('posted','reversed') AND l.account_id = ?`).get(b.account_id).s;
    assert.equal(T.boxBalance(cid, b).balance_minor, orig, `${label}: ${b.name} in ${b.currency_code}`);
  }
  const bad = db.prepare('SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.company_id = ? GROUP BY e.id HAVING SUM(l.debit_minor) <> SUM(l.credit_minor)').all(cid);
  assert.deepEqual(bad, [], `${label}: every entry balances`);
}

test('property: across 120 random treasury operations, sum of cash box balances = ledger cash accounts (per box in its currency)', async () => {
  const { m, main, usdBank, eurBank, eurCash, shop } = ctx;
  const R = rng(20261017);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const amt = () => (1 + Math.floor(R() * 50000) / 100).toFixed(2);
  const boxes = [main, usdBank, eurBank, eurCash];
  const banks = [usdBank, eurBank];
  // Seed money in every box.
  for (const b of boxes) await voucher({ type: 'receipt', cashBoxId: b.id, amount: '5000', counterAccountId: ctx.acc('3100') });
  assertInvariant('seed');
  const posted = [];
  const openIssued = [];
  const openReceived = [];
  let n = 0;
  for (let i = 0; i < 120; i++) {
    const op = pick(['rv', 'pv', 'ev', 'bf', 'tr', 'tr', 'chq', 'chq_done', 'rchq', 'rchq_done', 'reverse']);
    const label = `op ${i} ${op}`;
    if (op === 'rv') posted.push(await voucher({ type: 'receipt', cashBoxId: pick(boxes).id, amount: amt(), counterAccountId: ctx.acc('4900') }));
    else if (op === 'pv') posted.push(await voucher({ type: 'payment', cashBoxId: pick(boxes).id, amount: amt(), counterAccountId: ctx.acc('6200') }));
    else if (op === 'ev') posted.push(await voucher({ type: 'expense', cashBoxId: pick(boxes).id, amount: '23.00', tax: '3.00', counterAccountId: ctx.acc('6300') }));
    else if (op === 'bf') posted.push(await voucher({ type: 'bank_fee', cashBoxId: pick(banks).id, amount: '1.25' }));
    else if (op === 'tr') {
      const from = pick(boxes);
      const to = pick(boxes.filter((b) => b.id !== from.id));
      const body = { type: 'transfer', cashBoxId: from.id, toCashBoxId: to.id, amount: amt() };
      if (from.currency_code !== to.currency_code && R() < 0.5) body.toAmount = amt();
      posted.push(await voucher(body));
    } else if (op === 'chq') {
      const b = pick(banks);
      openIssued.push(ok(await m.post('/api/treasury/cheques', { cashBoxId: b.id, chequeNumber: `P-${i}`, amount: amt(), counterAccountId: ctx.acc('6200') }), 201));
    } else if (op === 'chq_done' && openIssued.length) {
      const c = openIssued.splice(Math.floor(R() * openIssued.length), 1)[0];
      const what = pick(['clear', 'clear', 'bounce', 'cancel']);
      ok(await m.post(`/api/treasury/cheques/${c.id}/${what}`, { reason: 'اختبار', date: what === 'clear' ? pick([TODAY, day(1)]) : undefined }));
    } else if (op === 'rchq') {
      const eur = R() < 0.5;
      openReceived.push(ok(await m.post('/api/receivables/cheques', { shopId: shop, chequeNumber: `R-${i}`, bankName: 'B', receivedDate: TODAY, dueDate: day(5), amount: amt(), ...(eur ? { currencyCode: 'EUR' } : {}) }), 201));
    } else if (op === 'rchq_done' && openReceived.length) {
      const c = openReceived.splice(Math.floor(R() * openReceived.length), 1)[0];
      if (R() < 0.3) ok(await m.post(`/api/receivables/cheques/${c.id}/bounce`, { reason: 'مرتد' }));
      else ok(await m.post(`/api/receivables/cheques/${c.id}/clear`, { cashBoxId: (c.currency_code === 'EUR' ? eurBank : usdBank).id, date: pick([TODAY, day(1)]) }));
    } else if (op === 'reverse' && posted.length) {
      const v = posted.splice(Math.floor(R() * posted.length), 1)[0];
      ok(await m.post(`/api/treasury/vouchers/${v.id}/reverse`, { reason: 'عكس' }));
    } else continue;
    n += 1;
    assertInvariant(label);
  }
  assert.ok(n >= 90, `ran ${n} operations`);
  assert.deepEqual(ok(await m.get('/api/ledger/integrity-check')).violations, []);
});
