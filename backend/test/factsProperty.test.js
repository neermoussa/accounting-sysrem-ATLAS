// backend/test/factsProperty.test.js
//
// NEXT ACTION item 4: randomized property test, several seeds. A random
// sequence of real documents (sales invoices, credit notes with and without
// restock, approved returns, customer receipts, purchase receipts, supplier
// invoices, payments and debit notes, stock adjustments / transfers /
// wastage, production orders closed or rejected, payroll imports, posts and
// corrections, manual entries and their reversals). After EVERY operation:
// the facts are brought up to date incrementally — in random small chunks —
// and compared row for row with a full rebuild.
//
// The rebuild runs inside a transaction that is rolled back, so the
// incremental fact state is never reset: it carries across the whole
// sequence, exactly as in production.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-factprop-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000); // no background sweep

const app = require('../server');
const db = require('../db/init');
const facts = require('../lib/analytics/facts');
const S = require('../lib/stockLedger');
const h = require('./salesHelpers');

const D = new Date().toISOString().slice(0, 10);
const Y = D.slice(0, 4);
const SEEDS = [11, 2026, 90210];
const OPS = 60;
let listener;
let base;
const ok = (r, status) => {
  if (status ? r.status !== status : r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
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

function snapshot(cid) {
  const out = {};
  for (const t of facts.FACT_TABLES) out[t] = db.prepare(`SELECT * FROM ${t} WHERE company_id = ?`).all(cid).map((r) => JSON.stringify(r)).sort();
  return out;
}
// Incremental (random chunk sizes) vs a full rebuild that is rolled back.
function check(cid, R, label) {
  for (let guard = 0; facts.freshness(cid).pending_changes > 0; guard++) {
    assert.ok(guard < 500, `${label}: queue drains`);
    facts.refresh(cid, { limit: 1 + Math.floor(R() * 6) });
  }
  const inc = snapshot(cid);
  db.exec('BEGIN IMMEDIATE');
  let full;
  try {
    facts.rebuild(cid);
    full = snapshot(cid);
  } finally {
    db.exec('ROLLBACK');
  }
  for (const t of facts.FACT_TABLES) assert.deepEqual(inc[t], full[t], `${label}: ${t} incremental == rebuild`);
  assert.deepEqual(snapshot(cid), inc, `${label}: the rolled-back rebuild left the incremental state untouched`);
}

async function runSeed(seed) {
  const R = rng(seed);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const amt = (lo, hi) => (lo + R() * (hi - lo)).toFixed(2);
  const co = await h.createUsdCompany(base, `شركة خاصية الحقائق ${seed}`);
  const m = co.manager;
  const cid = co.companyId;
  const { accounts } = await h.setupLedger(m);
  const acc = (c) => accounts.find((a) => a.code === c).id;
  ok((await h.goLive(m, `${Y}-01-01`)).res);
  ok(await m.put('/api/companies/me', { branches: ['دمشق', 'حلب'] }));
  const branches = ok(await m.get('/api/ledger/meta')).branches.map((b) => b.id);
  const p = {};
  for (const [k, n, cost] of [['a', 'مادة خام أ', 2], ['b', 'مادة خام ب', 3], ['t', 'بضاعة تجارية', 4], ['mix', 'خلطة', 0]]) {
    p[k] = await h.mkProduct(m, { name: `${n} ${seed}` });
    if (cost) {
      db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(cost, p[k]);
      ok(await m.post('/api/factory-inventory', { product_id: p[k], current_quantity: 60 }), 201);
    }
  }
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: D }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  const whMain = S.warehouseHolder(cid, null);
  const w2 = ok(await m.post('/api/companies/warehouses', { name: `مستودع 2 ${seed}`, kind: 'factory' }), 201);
  const wh2 = S.warehouseHolder(cid, w2.id);
  assert.notEqual(wh2.id, whMain.id);
  const shops = [await h.mkShop(m, `زبون 1 ${seed}`), await h.mkShop(m, `زبون 2 ${seed}`)];
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: `مورد ${seed}`, currencyCode: 'USD' }), 201);
  const v = ok(await m.post('/api/manufacturing/versions', { productId: p.mix, batchOutputQty: 10, outputKgPerUnit: 1, labourHoursPerBatch: 1, components: [{ productId: p.a, qtyPerBatch: 4 }, { productId: p.b, qtyPerBatch: 2 }] }), 201);
  ok(await m.post(`/api/manufacturing/versions/${v.id}/activate`, {}));
  ok(await m.post('/api/manufacturing/cost-rates', { kind: 'labour', basis: 'hour', rate: '5.00', effectiveFrom: `${Y}-01-01` }), 201);
  ok(await m.put('/api/payroll/settings', { expenseAccountId: acc('6100'), employerExpenseAccountId: acc('6500'), salariesPayableAccountId: acc('2130'), deductionsPayableAccountId: acc('2120'), advancesAccountId: acc('1160') }));
  ok(await m.put('/api/returns/settings/financial', { autoFinancialAdjustment: true }));
  check(cid, R, `seed ${seed} start`);

  const st = { invoices: [], receipts: [], payrollPosted: [], payrollMonth: 0, entries: [] };
  const qty = (prod, holder) => S.poolRow(cid, prod, holder.id).qty;
  const counts = {};
  let done = 0;
  for (let i = 0; done < OPS && i < OPS * 6; i++) {
    const op = pick(['sale', 'sale', 'credit', 'credit', 'return', 'receipt_customer', 'purchase', 'purchase', 'supplier_invoice', 'payment', 'debit_note', 'adjust', 'transfer', 'wastage', 'produce', 'produce', 'payroll', 'payroll_fix', 'manual', 'manual_reverse']);
    const label = `seed ${seed} op ${done} ${op}`;
    if (op === 'sale') {
      const prod = pick([p.t, p.mix, p.a]);
      const hold = pick([[null, whMain], [w2.id, wh2]]);
      const q = Math.floor(qty(prod, hold[1]) * R() * 0.5);
      if (q < 1) continue;
      const inv = ok(await m.post('/api/sales/invoices', { shopId: pick(shops), invoiceDate: D, branchId: pick([...branches, null]), ...(hold[0] ? { warehouseId: hold[0] } : {}), lines: [{ productId: prod, qty: q, unitPrice: amt(5, 15) }, { description: 'خدمة', qty: 1, unitPrice: amt(1, 3) }] }), 201);
      st.invoices.push(ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {})));
    } else if (op === 'credit') {
      const inv = st.invoices.find((x) => !x.creditDone);
      if (!inv) continue;
      inv.creditDone = true;
      const q = Math.max(1, Math.floor(inv.lines[0].qty * R()));
      ok(await m.post('/api/sales/credit-notes', { invoiceId: inv.id, date: D, restock: R() < 0.5, lines: [{ invoiceLineId: inv.lines[0].id, qty: Math.min(q, inv.lines[0].qty) }] }), 201);
    } else if (op === 'return') {
      const r = ok(await m.post('/api/returns', { shopId: pick(shops), reason: 'تالف', items: [{ productName: 'مادة مرتجعة', qty: 1 + Math.floor(R() * 3), unitValue: Number(amt(2, 9)) }] }), 201);
      for (const it of r.items) ok(await m.put(`/api/returns/${r.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: it.requested_qty }));
      ok(await m.post(`/api/returns/${r.id}/approve`, {}));
    } else if (op === 'receipt_customer') {
      ok(await m.post('/api/receivables/receipts', { shopId: pick(shops), method: pick(['cash', 'transfer']), amount: amt(5, 40), date: D }), 201);
    } else if (op === 'purchase') {
      const prod = pick([p.a, p.b, p.t]);
      const toW2 = R() < 0.3;
      const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: D, ...(toW2 ? { warehouseId: w2.id } : {}), lines: [{ productId: prod, qty: 5 + Math.floor(R() * 20), unitPrice: amt(1, 6) }] }), 201);
      const s = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
      ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
      const g = ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: D, lines: [{ poLineId: s.lines[0].id, qty: s.lines[0].qty }] }), 201);
      st.receipts.push({ po: s, grn: g });
    } else if (op === 'supplier_invoice') {
      const r = st.receipts.find((x) => !x.inv);
      if (!r) continue;
      const price = (r.po.lines[0].unit_price_minor / 100 + (R() < 0.5 ? 0 : 0.01)).toFixed(2);
      const inv = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: r.po.id, invoiceDate: D, lines: [{ poLineId: r.po.lines[0].id, qty: r.po.lines[0].qty, unitPrice: price }] }), 201);
      r.inv = ok(await m.post(`/api/purchasing/invoices/${inv.id}/post`, {}));
    } else if (op === 'payment') {
      ok(await m.post('/api/purchasing/payments', { supplierId: supplier.id, amount: amt(5, 30), paymentDate: D, method: 'transfer' }), 201);
    } else if (op === 'debit_note') {
      const r = st.receipts.find((x) => x.inv && !x.returned);
      if (!r) continue;
      r.returned = true;
      const holder = r.grn.warehouse_id ? S.warehouseHolder(cid, r.grn.warehouse_id) : whMain;
      const q = Math.floor(Math.min(qty(r.po.lines[0].product_id, holder), r.po.lines[0].qty) / 2);
      if (q < 1) continue;
      const dn = await m.post('/api/purchasing/debit-notes', { invoiceId: r.inv.id, returnGoods: true, lines: [{ invoiceLineId: r.inv.lines[0].id, qty: q }] });
      // Payments already allocated to the invoice can leave too little open:
      // a legitimate refusal (nothing written; the next check proves it).
      if (dn.status === 409 && dn.body.error === 'exceeds_invoice_open') continue;
      ok(dn, 201);
    } else if (op === 'adjust') {
      const prod = pick([p.a, p.b, p.t]);
      const hold = pick([whMain, wh2]);
      const nq = Math.max(0, Math.round((qty(prod, hold) + (R() * 10 - 4)) * 100) / 100);
      ok(await m.post('/api/stock/adjustments', { productId: prod, holderId: hold.id, newQty: nq, reasonCode: 'count', date: D }));
    } else if (op === 'transfer') {
      const prod = pick([p.a, p.b, p.t, p.mix]);
      const [from, to] = R() < 0.5 ? [whMain, wh2] : [wh2, whMain];
      const q = Math.round(qty(prod, from) * R() * 0.5 * 100) / 100;
      if (q < 0.01) continue;
      ok(await m.post('/api/stock/transfers', { productId: prod, fromHolderId: from.id, toHolderId: to.id, qty: q }), 201);
    } else if (op === 'wastage') {
      const prod = pick([p.a, p.b, p.t]);
      const q = Math.round(qty(prod, whMain) * R() * 0.2 * 100) / 100;
      if (q < 0.01) continue;
      ok(await m.post('/api/stock/wastage', { holderId: whMain.id, reasonCode: pick(['damage', 'expiry', 'loss']), lines: [{ productId: prod, qty: q }] }), 201);
    } else if (op === 'produce') {
      if (qty(p.a, whMain) < 4 || qty(p.b, whMain) < 2) continue;
      const o = ok(await m.post('/api/manufacturing/orders', { productId: p.mix, batches: 1, plannedDate: D }), 201);
      ok(await m.post(`/api/manufacturing/orders/${o.id}/release`, {}));
      ok(await m.post(`/api/manufacturing/orders/${o.id}/issue`, { date: D }));
      if (R() < 0.2) {
        ok(await m.post(`/api/manufacturing/orders/${o.id}/reject`, { reason: 'دفعة غير مطابقة', date: D }));
      } else {
        ok(await m.post(`/api/manufacturing/orders/${o.id}/events`, { kind: 'output', qty: 8 + Math.floor(R() * 3) }));
        if (R() < 0.5) ok(await m.post(`/api/manufacturing/orders/${o.id}/events`, { kind: 'wastage', qty: 0.5, stage: 'sorting', productId: p.a }));
        ok(await m.post(`/api/manufacturing/orders/${o.id}/close`, { date: D }));
      }
    } else if (op === 'payroll') {
      if (st.payrollMonth >= 10) continue;
      st.payrollMonth += 1;
      const period = `${Y}-${String(st.payrollMonth).padStart(2, '0')}`;
      const gross = Number(amt(500, 2000));
      const ded = Math.round(gross * 10) / 100;
      const pp = ok(await m.post('/api/payroll/periods/import', { period, externalId: `HR-${period}`, lines: [{ department: 'المبيعات', currencyCode: 'USD', gross: gross.toFixed(2), deductions: ded.toFixed(2), employerContributions: '20.00', net: (gross - ded).toFixed(2) }] }), 201);
      ok(await m.post(`/api/payroll/periods/${pp.id}/post`, {}));
      st.payrollPosted.push({ id: pp.id, period });
    } else if (op === 'payroll_fix') {
      const pp = st.payrollPosted.find((x) => !x.fixed);
      if (!pp) continue;
      pp.fixed = true;
      ok(await m.post(`/api/payroll/periods/${pp.id}/reopen`, { reason: 'تصحيح كشف الرواتب', date: D }));
      const re = ok(await m.post('/api/payroll/periods/import', { period: pp.period, externalId: `HR-${pp.period}`, lines: [{ department: 'المعمل', currencyCode: 'USD', gross: '900.00', deductions: '90.00', net: '810.00' }] }));
      ok(await m.post(`/api/payroll/periods/${re.id}/post`, {}));
    } else if (op === 'manual') {
      const a = amt(1, 50);
      st.entries.push(ok(await m.post('/api/ledger/entries', { date: D, description: 'قيد عشوائي', post: true, branchId: pick([...branches, null]), lines: [{ accountId: acc(pick(['6100', '6500'])), debit: a }, { accountId: acc('1110'), credit: a }] }), 201));
    } else if (op === 'manual_reverse') {
      const e = st.entries.find((x) => !x.reversed);
      if (!e) continue;
      e.reversed = true;
      ok(await m.post(`/api/ledger/entries/${e.id}/reverse`, { date: D, reason: 'عكس عشوائي' }));
    }
    counts[op] = (counts[op] || 0) + 1;
    done += 1;
    check(cid, R, label);
  }
  // Every kind of operation happened at least once for this seed.
  for (const k of ['sale', 'credit', 'return', 'purchase', 'supplier_invoice', 'payment', 'adjust', 'transfer', 'wastage', 'produce', 'payroll', 'manual']) assert.ok(counts[k] > 0, `seed ${seed}: ${k} ran (${JSON.stringify(counts)})`);
  assert.ok(done >= OPS, `seed ${seed}: ${done} operations`);
  // Every fact table got rows from this sequence.
  for (const t of facts.FACT_TABLES) assert.ok(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE company_id = ?`).get(cid).n > 0, `seed ${seed}: ${t} has rows`);
  return counts;
}

for (const seed of SEEDS) {
  test(`facts: incremental refresh == full rebuild after every random operation (seed ${seed})`, async () => {
    await runSeed(seed);
  });
}
