// backend/test/fxRate.test.js
//
// Exchange-rate audit (before Prompt 5):
//  - rates stored at 1e8 scale in the most-significant direction (rate >= 1);
//  - amount x rate in BigInt, rounded once (half away from zero);
//  - SYP amounts around 1e10 and rates with 4+ decimals;
//  - property: every foreign-currency entry balances exactly in base
//    currency, the residue going to rounding_difference.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fx-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');

const app = require('../server');
const db = require('../db/init');
const fx = require('../lib/fxRate');
const h = require('./salesHelpers');
const { createCompany } = require('./helpers');

let listener;
let base;
const Y = 2026;

test.before(() => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

// Independent reference: exact rational value, rounded half away from zero,
// via a different arrangement of the same BigInt maths.
function reference(orig, rateStr, quote, lineDigits, baseDigits) {
  const [i, f = ''] = rateStr.split('.');
  const rNum = BigInt(i + f); // rate = rNum / 10^f.length
  const rDen = 10n ** BigInt(f.length);
  let num = BigInt(orig) * 10n ** BigInt(Math.max(0, baseDigits - lineDigits));
  let den = 10n ** BigInt(Math.max(0, lineDigits - baseDigits));
  if (quote === 'base_per_foreign') { num *= rNum; den *= rDen; } else { num *= rDen; den *= rNum; }
  const q = num / den;
  return Number((num % den) * 2n >= den ? q + 1n : q);
}

test('rates parse exactly at 1e8 scale; < 1 is refused (use the other direction); > 8 decimals refused', () => {
  assert.equal(fx.parseRate('13500.1234').rateE8, 1350012340000);
  assert.equal(fx.parseRate('13500.12345678', 'foreign_per_base').rateE8, 1350012345678);
  assert.equal(fx.formatRate(1350012345678), '13500.12345678');
  assert.equal(fx.formatRate(100000000), '1');
  assert.throws(() => fx.parseRate('0.0000740'), (e) => e.code === 'rate_below_one' && /الاتجاه الآخر/.test(e.message));
  assert.throws(() => fx.parseRate('1.123456789'), (e) => e.code === 'invalid_rate');
  assert.throws(() => fx.parseRate('abc'), (e) => e.code === 'invalid_rate');
  assert.throws(() => fx.parseRate('5', 'sideways'), (e) => e.code === 'invalid_rate_quote');
});

test('SYP amounts around 1e10 with 4+ decimal rates convert exactly, both directions', () => {
  const cases = [
    // SYP line (0 digits) into a USD base (2 digits): SYP per 1 USD.
    [12345678901, '13500.1234', 'foreign_per_base', 0, 2],
    [99999999999, '14999.99999999', 'foreign_per_base', 0, 2],
    [10000000000, '13500.5', 'foreign_per_base', 0, 2],
    // USD line (cents) into a SYP base: SYP per 1 USD.
    [74000055, '13500.5678', 'base_per_foreign', 2, 0],
    [99999999999, '14999.12345678', 'base_per_foreign', 2, 0],
    // EUR line into USD base: USD per 1 EUR.
    [123456789012, '1.08765432', 'base_per_foreign', 2, 2],
  ];
  for (const [orig, rate, quote, ld, bd] of cases) {
    const { rateE8 } = fx.parseRate(rate, quote);
    const got = fx.toBaseMinor(orig, rateE8, quote, ld, bd);
    assert.equal(got, reference(orig, rate, quote, ld, bd), `${orig} @ ${rate} ${quote}`);
    assert.ok(Number.isSafeInteger(got));
  }
  // The old ppm path could not even represent the USD-base case: 1/13500 at 1e6 = 74 ppm.
  const oldWay = Math.round((1 / 13500.1234) * 1e6);
  assert.equal(oldWay, 74);
  assert.notEqual(Math.round((12345678901 * oldWay * 100) / 1e6), reference(12345678901, '13500.1234', 'foreign_per_base', 0, 2));
  // Results beyond safe integers are refused, not silently wrong.
  assert.throws(() => fx.toBaseMinor(9e15, fx.parseRate('99999').rateE8, 'base_per_foreign', 0, 2), (e) => e.code === 'amount_too_large');
});

test('half-away-from-zero rounding at exact halves', () => {
  // 1 SYP at 2 SYP per USD = 0.5 cent -> 1 cent; 3 SYP -> 1.5 -> 2 cents (x100 -> 150, 50).
  assert.equal(fx.toBaseMinor(1, fx.parseRate('200', 'foreign_per_base').rateE8, 'foreign_per_base', 0, 2), 1);
  assert.equal(fx.toBaseMinor(1, fx.parseRate('400', 'foreign_per_base').rateE8, 'foreign_per_base', 0, 2), 0);
  assert.equal(fx.toBaseMinor(3, fx.parseRate('200', 'foreign_per_base').rateE8, 'foreign_per_base', 0, 2), 2);
});

// ---- through the ledger ----

async function setup(kind) {
  const co = kind === 'USD' ? await h.createUsdCompany(base, 'شركة دولار fx') : await createCompany(base, { name: 'شركة ليرة fx' });
  const m = co.manager || co.client;
  const { accounts } = await h.setupLedger(m);
  return { co, m, accounts, id: (code) => accounts.find((a) => a.code === code).id };
}

test('API entry: SYP line ~1e10 in a USD company, rate typed as SYP per USD with 4+ decimals', async () => {
  const c = await setup('USD');
  const res = await c.m.post('/api/ledger/entries', {
    date: `${Y}-03-01`, description: 'تحويل ليرة', post: true,
    lines: [
      { accountId: c.id('1120'), currencyCode: 'SYP', exchangeRate: '13500.1234', rateQuote: 'foreign_per_base', debit: '12345678901' },
      { accountId: c.id('3100'), credit: String(reference(12345678901, '13500.1234', 'foreign_per_base', 0, 2) / 100) },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const line = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? AND line_no = 1').get(res.body.id);
  assert.equal(line.rate_e8, 1350012340000);
  assert.equal(line.rate_quote, 'foreign_per_base');
  assert.equal(line.debit_minor, reference(12345678901, '13500.1234', 'foreign_per_base', 0, 2));
  assert.equal(res.body.lines[0].exchange_rate, '13500.1234');
  // Same rate typed the low-precision way is refused with guidance.
  const low = await c.m.post('/api/ledger/entries', { date: `${Y}-03-01`, description: 'x', post: true, lines: [
    { accountId: c.id('1120'), currencyCode: 'SYP', exchangeRate: '0.00007407', debit: '1000' },
    { accountId: c.id('3100'), credit: '0.07' },
  ] });
  assert.equal(low.status, 400);
  assert.equal(low.body.error, 'rate_below_one');
});

test('property: random foreign-currency entries always balance exactly; residue -> rounding_difference (<= half a unit per converted line)', async () => {
  let seed = 20261016;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rateStr = (lo, hi) => `${Math.floor(lo + rnd() * (hi - lo))}.${String(Math.floor(rnd() * 1e8)).padStart(8, '0').slice(0, 4 + Math.floor(rnd() * 5))}`;
  for (const kind of ['USD', 'SYP']) {
    const c = await setup(kind);
    const rounding = c.id('6850');
    const foreignCases = kind === 'USD'
      ? [['SYP', 0, 'foreign_per_base', () => rateStr(9000, 16000)], ['EUR', 2, 'base_per_foreign', () => `1.${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`]]
      : [['USD', 2, 'base_per_foreign', () => rateStr(9000, 16000)], ['EUR', 2, 'base_per_foreign', () => rateStr(10000, 17000)]];
    let withResidue = 0;
    for (let n = 0; n < 60; n++) {
      const [cur, digits, quote, mkRate] = foreignCases[n % foreignCases.length];
      const rate = mkRate();
      const k = 2 + Math.floor(rnd() * 4); // credit split into k foreign lines
      const parts = Array.from({ length: k }, () => 1 + Math.floor(rnd() * (cur === 'SYP' ? 3e9 : 3e8)));
      const total = parts.reduce((s, x) => s + x, 0);
      const amt = (minor) => (digits ? `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}` : String(minor));
      // Exactly balanced in the foreign currency at one rate; the k+1 roundings may not cancel.
      const lines = [
        { accountId: c.id('1120'), currencyCode: cur, exchangeRate: rate, rateQuote: quote, debit: amt(total) },
        ...parts.map((p) => ({ accountId: c.id('3300'), currencyCode: cur, exchangeRate: rate, rateQuote: quote, credit: amt(p) })),
      ];
      const draft = n % 5 === 0; // some go through draft -> post
      let res = await c.m.post('/api/ledger/entries', { date: `${Y}-04-${String(1 + (n % 28)).padStart(2, '0')}`, description: `fx ${n}`, post: !draft, lines });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      if (draft) {
        res = await c.m.post(`/api/ledger/entries/${res.body.id}/post`, {});
        assert.equal(res.status, 200, JSON.stringify(res.body));
      }
      const rows = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(res.body.id);
      const dr = rows.reduce((s, l) => s + l.debit_minor, 0);
      const cr = rows.reduce((s, l) => s + l.credit_minor, 0);
      assert.equal(dr, cr, `${kind} entry ${n} balances in base`);
      // Every converted line equals the exact reference conversion.
      for (const l of rows.filter((x) => x.currency_code === cur)) {
        assert.equal(l.debit_minor || l.credit_minor, reference(l.amount_original_minor, rate, quote, digits, kind === 'USD' ? 2 : 0));
      }
      const plug = rows.filter((l) => l.account_id === rounding);
      const residue = plug.reduce((s, l) => s + l.debit_minor - l.credit_minor, 0);
      assert.ok(Math.abs(residue) * 2 <= k + 1, `residue ${residue} within half a unit per line`);
      if (plug.length) withResidue += 1;
    }
    assert.ok(withResidue > 0, `${kind}: the property run exercised at least one rounding residue`);
    assert.deepEqual((await c.m.get('/api/ledger/integrity-check')).body.violations, []);
  }
});

test('a real imbalance in foreign currency is still refused (not hidden in rounding)', async () => {
  const c = await setup('USD');
  const res = await c.m.post('/api/ledger/entries', { date: `${Y}-05-01`, description: 'x', post: true, lines: [
    { accountId: c.id('1120'), currencyCode: 'EUR', exchangeRate: '1.0876', debit: '100' },
    { accountId: c.id('3100'), credit: '108.70' },
  ] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unbalanced');
});

test('lines stored before the fix (ppm only) still read and reverse with their exact rate', async () => {
  const c = await setup('USD');
  const ledger = require('../lib/ledger');
  const e = ledger.postEntry(c.co.companyId, { date: `${Y}-06-01`, description: 'قديم', lines: [
    { accountId: c.id('1120'), currencyCode: 'EUR', amountOriginalMinor: 10000, exchangeRatePpm: 1087654, debitMinor: 10877 },
    { accountId: c.id('3100'), creditMinor: 10877 },
  ] }, null);
  // A pre-0012 row has rate_e8 NULL: the reader falls back to the ppm column.
  const l = { ...db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? AND line_no = 1').get(e.id), rate_e8: null, rate_quote: null };
  assert.equal(l.exchange_rate_ppm, 1087654);
  assert.deepEqual(ledger.lineRate(l), { rateE8: 108765400, rateQuote: 'base_per_foreign' });
  assert.equal(e.lines[0].exchange_rate, '1.087654');
  const rev = await c.m.post(`/api/ledger/entries/${e.id}/reverse`, { reason: 'اختبار' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const rl = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? AND line_no = 1').get(rev.body.reversal.id);
  assert.equal(rl.rate_e8, 108765400);
  assert.equal(rl.credit_minor, 10877);
});
