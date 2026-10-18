// backend/test/payrollAdvancesProperty.test.js
//
// Property (before Prompt 12, item 3): random advances and random PARTIAL
// recoveries in USD and SYP, with the SYP rate moving every month. After
// every step:
//  - the advances control account (ledger) == the sum of the per-employee,
//    per-currency outstanding balances (base), to the minor unit;
//  - an employee whose advances are fully recovered has exactly zero base
//    left (no residue parked in the advances account);
//  - every rate difference is in realized FX: the fx_realized lines of the
//    payroll entries == sum over recoveries of (value at the posting rate -
//    the advance base relieved).
// Seeded (PROPERTY_SEED), reproducible.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-advprop-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const PR = require('../lib/payroll');
const T = require('../lib/treasury');
const P = require('../lib/purchasing');
const h = require('./salesHelpers');

const SEED = Number(process.env.PROPERTY_SEED || 20261120);
function rng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
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

async function setup(name) {
  const co = await h.createUsdCompany(base, name);
  const m = co.manager;
  await h.setupLedger(m, 'trading');
  const res = (await h.goLive(m, '2026-01-01')).res;
  assert.equal(res.status, 200);
  const cid = co.companyId;
  const acc = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(cid, code).id;
  const u = db.prepare('SELECT * FROM users WHERE company_id = ? LIMIT 1').get(cid);
  const actor = { ...u, permissions: db.prepare('SELECT permission FROM user_permissions WHERE user_id = ?').all(u.id).map((x) => x.permission) };
  PR.saveSettings(cid, { expenseAccountId: acc('6100'), employerExpenseAccountId: acc('6500'), salariesPayableAccountId: acc('2130'), deductionsPayableAccountId: acc('2120'), advancesAccountId: acc('1160') }, actor);
  const main = (await m.get('/api/treasury/boxes')).body[0];
  const syp = T.createBox(cid, { name: 'ليرة', kind: 'cash', currencyCode: 'SYP' }, actor);
  return { cid, actor, acc, boxes: { USD: main.id, SYP: syp.id } };
}
const advancesLedger = (cid, aid) => db.prepare("SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND l.account_id = ?").get(cid, aid).b;

for (const k of [0, 1, 2]) {
  test(`advances: control account == sum of employee balances at every step; differences all in realized FX (seed ${SEED + k})`, async () => {
    const r = rng(SEED + k);
    const c = await setup(`سلف ${k}`);
    const cur = require('../lib/currency');
    const employees = ['E1', 'E2', 'E3', 'E4'];
    const advAcc = c.acc('1160');
    let expectedFx = 0;
    for (let month = 1; month <= 10; month += 1) {
      const mm = String(month).padStart(2, '0');
      // SYP moves every month (12,000 .. 16,000 per USD).
      const sypRate = int(r, 12000, 16000);
      cur.addRate(c.cid, { currencyCode: 'SYP', rate: String(sypRate), rateQuote: 'foreign_per_base', effectiveAt: `2026-${mm}-01` }, c.actor);
      // Some advances.
      for (let n = int(r, 0, 3); n > 0; n -= 1) {
        const ccy = r() < 0.5 ? 'USD' : 'SYP';
        const amountMinor = ccy === 'USD' ? int(r, 1000, 100000) : int(r, 100000, 5000000);
        const adv = PR.recordAdvance(c.cid, { employeeRef: employees[int(r, 0, employees.length - 1)], cashBoxId: c.boxes[ccy], currencyCode: ccy, amountMinor, date: `2026-${mm}-03` }, c.actor);
        T.approveVoucher(c.cid, adv.voucher_id, {}, c.actor);
      }
      // A payroll period recovering random parts of what is outstanding.
      const recoveries = [];
      for (const e of employees) {
        for (const ccy of ['USD', 'SYP']) {
          const b = PR.advanceBalance(c.cid, e, ccy);
          if (b.outstanding <= 0 || r() < 0.4) continue;
          const amt = r() < 0.25 ? b.outstanding : int(r, 1, b.outstanding);
          recoveries.push({ employeeRef: e, currencyCode: ccy, amountMinor: amt });
        }
      }
      const ded = { USD: 0, SYP: 0 };
      for (const x of recoveries) ded[x.currencyCode] += x.amountMinor;
      const lines = ['USD', 'SYP'].map((ccy) => {
        const gross = (ccy === 'USD' ? 500000 : 50000000) + ded[ccy];
        return { department: 'كل الأقسام', currencyCode: ccy, grossMinor: gross, deductionsMinor: ded[ccy], netMinor: gross - ded[ccy] };
      });
      const p = PR.importPeriod(c.cid, { period: `2026-${mm}`, externalId: `B-${mm}`, lines, advanceRecoveries: recoveries }, c.actor);
      const posted = PR.postPeriod(c.cid, p.id, {}, c.actor);
      // Expected realized FX: value at the posting rate - base relieved.
      for (const rec of db.prepare('SELECT * FROM payroll_advance_recoveries WHERE period_id = ?').all(p.id)) {
        const now = rec.currency_code === 'USD' ? rec.amount_minor : P.toBase(c.cid, 'SYP', rec.amount_minor, { rateE8: posted.rates.SYP.rate_e8, quote: posted.rates.SYP.quote });
        expectedFx += now - rec.base_minor;
      }
      // Invariants after the step.
      const label = JSON.stringify({ seed: SEED + k, month, recoveries });
      let sumBase = 0;
      for (const e of employees) {
        for (const ccy of ['USD', 'SYP']) {
          const b = PR.advanceBalance(c.cid, e, ccy);
          assert.ok(b.outstanding >= 0, label);
          if (b.outstanding === 0) assert.equal(b.outstanding_base, 0, `${label}: ${e}/${ccy} fully recovered leaves no base`);
          sumBase += b.outstanding_base;
        }
      }
      assert.equal(advancesLedger(c.cid, advAcc), sumBase, `${label}: advances control = sum of employee balances`);
      const fxPosted = db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.company_id = ? AND e.source_type = 'payroll_period' AND a.system_key = 'fx_realized'`).get(c.cid).s;
      assert.equal(fxPosted, expectedFx, `${label}: realized FX on recoveries`);
      const unbalanced = db.prepare("SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.company_id = ? GROUP BY e.id HAVING SUM(l.debit_minor) <> SUM(l.credit_minor)").all(c.cid);
      assert.deepEqual(unbalanced, []);
    }
    // The run must actually exercise partial recoveries and FX.
    const recs = db.prepare("SELECT COUNT(*) n, SUM(currency_code = 'SYP') syp FROM payroll_advance_recoveries WHERE company_id = ? AND posted = 1").get(c.cid);
    assert.ok(recs.n >= 5 && recs.syp >= 2, JSON.stringify(recs));
    assert.notEqual(expectedFx, 0, 'rate differences occurred');
  });
}
