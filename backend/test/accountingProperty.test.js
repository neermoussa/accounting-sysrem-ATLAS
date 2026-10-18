// backend/test/accountingProperty.test.js
//
// After Prompt 10, item 5 — property tests (seeded, reproducible):
//  (a) depreciation: for random cost / salvage / opening / life / method,
//      the months add up to exactly cost - salvage - opening, the last month
//      of the life absorbs the remainder, declining balance never takes NBV
//      below salvage, and no month is negative;
//  (b) tax: for random prices, quantities, discounts and rates, inclusive
//      and exclusive coded lines round-trip (net + tax = the line's gross,
//      net = gross / (1 + rate) within half a unit) and the document totals
//      equal the sum of its lines (+ the explicit rounding line);
//  (c) effective dates: the rate used is the one in effect ON the document
//      date — the day before a change keeps the old rate, the day of the
//      change takes the new one, before the first date nothing applies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-prop10-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const FA = require('../lib/fixedAssets');
const TC = require('../lib/taxCodes');
const S = require('../lib/salesPosting');
const h = require('./salesHelpers');

const SEED = Number(process.env.PROPERTY_SEED || 20261120);
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
let listener;
let ctx;
test.before(async () => {
  listener = app.listen(0);
  const base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'خصائص');
  const { accounts } = await h.setupLedger(co.manager, 'trading');
  const res = (await h.goLive(co.manager, '2026-01-01')).res;
  assert.equal(res.status, 200);
  const shop = await h.mkShop(co.manager, 'زبون');
  const actor = db.prepare('SELECT u.* FROM users u WHERE u.company_id = ? LIMIT 1').get(co.companyId);
  ctx = { co, shop, actor, out: accounts.find((a) => a.code === '2140').id };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('(a) depreciation: exact total, last month absorbs the remainder, never below salvage (500 random assets)', () => {
  const r = rng(SEED);
  for (let n = 0; n < 500; n += 1) {
    const cost = int(r, 1, 50000000);
    const salvage = r() < 0.3 ? 0 : int(r, 0, Math.floor(cost * 0.5));
    const opening = r() < 0.2 ? int(r, 0, cost - salvage) : 0;
    const life = int(r, 1, 240);
    const method = r() < 0.5 ? 'straight_line' : 'declining_balance';
    const rate = method === 'declining_balance' ? (r() < 0.5 ? Math.min(10000, Math.round(240000 / life)) : int(r, 1, 10000)) : null;
    const a = { cost_minor: cost, salvage_minor: salvage, opening_accumulated_minor: opening, useful_life_months: life, method, declining_rate_bp: rate };
    const label = JSON.stringify({ seed: SEED, n, ...a });
    let sum = 0;
    const months = [];
    for (let k = 0; k < life; k += 1) {
      const amt = FA.monthAmount(a, k, sum);
      assert.ok(Number.isInteger(amt) && amt >= 0, `${label} month ${k}: ${amt}`);
      sum += amt;
      months.push(amt);
      assert.ok(cost - opening - sum >= salvage, `${label}: NBV below salvage at month ${k}`);
    }
    assert.equal(sum, cost - salvage - opening, `${label}: total`);
    assert.equal(FA.monthAmount(a, life, sum), 0, `${label}: nothing after the life`);
    // The last month takes exactly what is left after the others.
    const beforeLast = months.slice(0, -1).reduce((t, x) => t + x, 0);
    assert.equal(months[life - 1], cost - salvage - opening - beforeLast, `${label}: last month = remainder`);
    if (method === 'straight_line' && life > 1) {
      const even = (cost - salvage - opening) / life;
      for (const x of months) assert.ok(Math.abs(x - even) <= 1, `${label}: straight-line month ${x} vs ${even}`);
    }
  }
});

test('(b) inclusive and exclusive coded lines round-trip; document totals = sum of lines (200 random invoices)', () => {
  const r = rng(SEED + 1);
  const { co, shop, actor } = ctx;
  const codes = [];
  db.prepare("INSERT OR REPLACE INTO company_tax_settings (company_id, price_mode) VALUES (?, 'exclusive')").run(co.companyId);
  for (const bp of [0, 1, 500, 750, 1000, 1250, 1500, 2000, 333, 10000]) {
    codes.push(TC.createCode(co.companyId, { code: `P${bp}`, name: `rate ${bp}`, type: 'sales', accountId: ctx.out, rate: String(bp / 100), effectiveFrom: '2026-01-01' }, actor));
  }
  for (let n = 0; n < 200; n += 1) {
    const mode = r() < 0.5 ? 'inclusive' : 'exclusive';
    db.prepare('UPDATE company_tax_settings SET price_mode = ? WHERE company_id = ?').run(mode, co.companyId);
    const lines = [];
    for (let i = 0, m = int(r, 1, 6); i < m; i += 1) {
      const price = (int(r, 1, 2000000) / 100).toFixed(2);
      const qty = r() < 0.3 ? (int(r, 1, 5000) / 1000).toString() : String(int(r, 1, 50));
      const code = codes[int(r, 0, codes.length - 1)];
      const discount = r() < 0.2 ? (int(r, 0, Math.floor(Number(price) * Number(qty) * 50)) / 100).toFixed(2) : undefined;
      lines.push({ description: `l${i}`, qty, unitPrice: price, discount, taxCodeId: code.id, _bp: code.rates[0].rate_bp });
    }
    const inv = S.createInvoice(co.companyId, { shopId: shop, invoiceDate: '2026-06-01', lines: lines.map(({ _bp, ...l }) => l) }, actor);
    const label = JSON.stringify({ seed: SEED + 1, n, mode, lines });
    let sumNet = 0;
    let sumTax = 0;
    for (const [i, l] of inv.lines.entries()) {
      const gross = Math.round(l.unit_price_minor * l.qty) - l.discount_minor;
      const exactGross = l.unit_price_minor * l.qty - l.discount_minor;
      const bp = lines[i]._bp;
      if (mode === 'inclusive') {
        assert.equal(l.net_minor + l.tax_minor, Math.sign(exactGross) * Math.round(Math.abs(exactGross)), `${label} line ${i}: net + tax = gross`);
        assert.ok(Math.abs(l.net_minor - (exactGross * 10000) / (10000 + bp)) <= 0.5 + 1e-9, `${label} line ${i}: net = gross / (1 + rate)`);
      } else {
        assert.ok(Math.abs(l.net_minor - exactGross) <= 0.5 + 1e-9, `${label} line ${i}: net = gross`);
        assert.ok(Math.abs(l.tax_minor - (exactGross * bp) / 10000) <= 0.5 + 1e-9, `${label} line ${i}: tax = net x rate`);
      }
      void gross;
      sumNet += l.net_minor;
      sumTax += l.tax_minor;
    }
    // Stored subtotal is before discount (existing convention): subtotal - discount = sum of nets.
    assert.equal(inv.subtotal_minor - inv.discount_minor, sumNet, `${label}: subtotal - discount = sum of line nets`);
    assert.equal(inv.discount_minor, inv.lines.reduce((t, l) => t + l.discount_minor, 0), `${label}: discount = sum of line discounts`);
    assert.equal(inv.tax_minor, sumTax, `${label}: tax = sum of line taxes`);
    assert.equal(inv.total_minor, sumNet + sumTax + inv.rounding_minor, `${label}: total = nets + taxes + rounding`);
    assert.ok(Math.abs(inv.rounding_minor) <= inv.lines.length, `${label}: rounding within half a unit per line`);
  }
});

test('(c) the rate used is the one in effect on the document date (random change dates, boundaries)', () => {
  const r = rng(SEED + 2);
  const { co, actor } = ctx;
  const day = (d) => new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10);
  for (let n = 0; n < 40; n += 1) {
    const changes = [...new Set(Array.from({ length: int(r, 1, 5) }, () => int(r, 0, 300)))].sort((a, b) => a - b).map((d) => ({ date: day(d), bp: int(r, 0, 3000) }));
    const code = TC.createCode(co.companyId, { code: `E${n}`, name: 'eff', type: 'sales', accountId: ctx.out, rate: String(changes[0].bp / 100), effectiveFrom: changes[0].date }, actor);
    for (const c of changes.slice(1)) TC.addRate(co.companyId, code.id, { rate: String(c.bp / 100), effectiveFrom: c.date }, actor);
    const expected = (date) => [...changes].reverse().find((c) => c.date <= date)?.bp;
    const probes = [day(int(r, 0, 330)), ...changes.flatMap((c) => [c.date, day((Date.parse(c.date) - Date.UTC(2026, 0, 1)) / 86400000 - 1)])];
    for (const d of probes) {
      const label = JSON.stringify({ seed: SEED + 2, n, changes, d });
      const want = expected(d);
      if (want === undefined) {
        assert.throws(() => TC.resolve(co.companyId, code.id, 'sales', d, 1), (e) => e.code === 'tax_rate_not_effective', label);
      } else {
        assert.equal(TC.resolve(co.companyId, code.id, 'sales', d, 1).rate_bp, want, label);
      }
    }
  }
});
