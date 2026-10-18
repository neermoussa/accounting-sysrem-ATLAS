// backend/test/customerBalance.random.test.js
//
// 50 random operations on a ledger-live company (seeded PRNG, so a failure
// is reproducible: the seed is printed). After EVERY operation, for EVERY
// customer, the balance the app displays (GET /api/shops/:id -> balance)
// must equal the sum of that customer's receivable ledger lines, computed
// here straight from SQLite, independently of lib/customerLedger.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const h = require('./salesHelpers');

const SEED = Number(process.env.RANDOM_OPS_SEED || 20261016);
const OPS = 50;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test(`displayed customer balance equals the sum of its ledger lines after each of ${OPS} random operations (seed ${SEED})`, async () => {
  const rnd = mulberry32(SEED);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const cents = (max) => (Math.floor(rnd() * max * 100) / 100).toFixed(2);

  const company = await h.createUsdCompany(server.baseUrl, 'شركة العمليات العشوائية');
  const m = company.manager;
  const cid = company.companyId;
  const { accounts } = await h.setupLedger(m);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  const shops = [];
  for (let i = 0; i < 4; i++) shops.push(await h.mkShop(m, `زبون عشوائي ${i + 1}`));
  const product = await h.mkProduct(m, { name: 'مادة عشوائية', base_price: 3.35, cost_price: 1.2 });
  h.seedSnapshot(server.dbPath, shops[0], 250.75);
  h.seedSnapshot(server.dbPath, shops[1], -12.3);
  const { res: live } = await h.goLive(m);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  await m.put('/api/returns/settings/financial', { autoFinancialAdjustment: true });

  const postedInvoices = [];
  const collectionEntries = [];
  const log = [];

  async function check(step) {
    for (const s of shops) {
      const shown = await h.displayedBalance(m, s);
      const ledgerMinor = h.arSumMinor(server.dbPath, cid, s);
      const shownMinor = shown === null ? 0 : Math.round(shown * 100);
      assert.equal(shownMinor, ledgerMinor, `after op ${step} (${log[log.length - 1]}): shop ${s} shows ${shown}, ledger ${ledgerMinor}`);
    }
  }

  const ops = {
    async invoice() {
      const lines = [];
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        lines.push(rnd() < 0.4
          ? { productId: product, qty: 1 + Math.floor(rnd() * 5) }
          : { description: `بند ${i}`, qty: (1 + Math.floor(rnd() * 40)) / 8, unitPrice: cents(20), taxRate: pick(['0', '5', '12.5']) });
      }
      const inv = await m.post('/api/sales/invoices', { shopId: pick(shops), lines });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      const posted = await m.post(`/api/sales/invoices/${inv.body.id}/post`, {});
      if (posted.status === 400 && posted.body.error === 'zero_total') return 'invoice (zero, skipped)';
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      postedInvoices.push(posted.body);
      return `invoice ${posted.body.invoice_number} ${posted.body.total}`;
    },
    async collection() {
      const shopId = pick(shops);
      const c = await m.post('/api/collections', { shopId, method: pick(['cash', 'transfer']), amount: Number(cents(60)) + 0.01, transferReference: 'R' });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      const ok = await m.post(`/api/collections/${c.body.id}/confirm`, {});
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const e = h.raw(server.dbPath).prepare("SELECT id FROM journal_entries WHERE source_type = 'collection' AND source_id = ?").get(c.body.id);
      collectionEntries.push(e.id);
      return `collection ${c.body.amount}`;
    },
    async returnCredit() {
      const r = await m.post('/api/returns', {
        shopId: pick(shops),
        items: [{ productName: 'مرتجع', qty: 1 + Math.floor(rnd() * 4), unitValue: Math.floor(rnd() * 10000) / 1000 + 0.001 }],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      for (const it of r.body.items) await m.put(`/api/returns/${r.body.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: it.requested_qty });
      const ok = await m.post(`/api/returns/${r.body.id}/approve`, {});
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      return `return credit ${ok.body.creditApplied}`;
    },
    async creditNote() {
      const open = postedInvoices.filter((i) => i.status === 'posted');
      if (!open.length) return ops.invoice();
      const inv = (await m.get(`/api/sales/invoices/${pick(open).id}`)).body;
      const line = inv.lines.find((l) => l.qty - l.credited_qty > 0);
      if (!line) return 'credit note (nothing open)';
      const qty = Math.max(0.125, Math.floor((line.qty - line.credited_qty) * rnd() * 8) / 8) || 0.125;
      const body = { invoiceId: inv.id, lines: [{ invoiceLineId: line.id, qty: Math.min(qty, line.qty - line.credited_qty) }], restock: rnd() < 0.5 };
      let res = await m.post('/api/sales/credit-notes', body);
      if (res.status === 409 && res.body.error === 'exceeds_invoice_open') {
        // Paid invoice: un-allocate its receipts (they stay as customer
        // credit), then the credit note goes through.
        const d = h.raw(server.dbPath);
        const receiptIds = d.prepare('SELECT DISTINCT receipt_id FROM receipt_allocations WHERE invoice_id = ?').all(inv.id).map((r) => r.receipt_id);
        for (const rid of receiptIds) {
          const keep = d.prepare('SELECT invoice_id, amount_minor FROM receipt_allocations WHERE receipt_id = ? AND invoice_id <> ?').all(rid, inv.id)
            .map((a) => ({ invoiceId: a.invoice_id, amountMinor: a.amount_minor }));
          const put = await m.put(`/api/receivables/receipts/${rid}/allocations`, { allocations: keep });
          assert.equal(put.status, 200, JSON.stringify(put.body));
        }
        d.close();
        res = await m.post('/api/sales/credit-notes', body);
      }
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const refreshed = (await m.get(`/api/sales/invoices/${inv.id}`)).body;
      postedInvoices[postedInvoices.findIndex((i) => i.id === inv.id)] = refreshed;
      return `credit note ${res.body.total} on ${inv.invoice_number}`;
    },
    async reverseCollection() {
      const candidates = collectionEntries.filter((id) => h.raw(server.dbPath).prepare('SELECT status FROM journal_entries WHERE id = ?').get(id).status === 'posted');
      if (!candidates.length) return ops.collection();
      const id = pick(candidates);
      // Collections are reversed through their own action (the generic
      // journal reverse refuses entries that come from a document).
      const collectionId = h.raw(server.dbPath).prepare('SELECT source_id FROM journal_entries WHERE id = ?').get(id).source_id;
      const rev = await m.post(`/api/collections/${collectionId}/reverse`, { reason: 'عشوائي' });
      assert.equal(rev.status, 200, JSON.stringify(rev.body));
      assert.equal(rev.body.status, 'reversed');
      return `reverse collection ${collectionId}`;
    },
    async receipt() {
      const res = await m.post('/api/receivables/receipts', { shopId: pick(shops), method: pick(['cash', 'transfer']), amount: (Number(cents(40)) + 0.01).toFixed(2) });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return `receipt ${res.body.amount}`;
    },
    async cheque() {
      const due = new Date(Date.now() + Math.floor(rnd() * 60) * 86400000).toISOString().slice(0, 10);
      const res = await m.post('/api/receivables/cheques', { shopId: pick(shops), chequeNumber: `CHQ-${Math.floor(rnd() * 1e9)}`, bankName: 'بنك سورية', dueDate: due, amount: (Number(cents(50)) + 0.01).toFixed(2) });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const roll = rnd();
      if (roll < 0.35) {
        const b = await m.post(`/api/receivables/cheques/${res.body.id}/bounce`, { reason: 'رصيد غير كافٍ' });
        assert.equal(b.status, 200, JSON.stringify(b.body));
        return `cheque ${res.body.cheque_number} bounced`;
      }
      if (roll < 0.6) {
        const c = await m.post(`/api/receivables/cheques/${res.body.id}/clear`, {});
        assert.equal(c.status, 200, JSON.stringify(c.body));
        return `cheque ${res.body.cheque_number} cleared`;
      }
      return `cheque ${res.body.cheque_number} in portfolio`;
    },
    async manualEntry() {
      const amount = cents(30);
      const res = await m.post('/api/ledger/entries', {
        date: h.TODAY, post: true, description: 'تسوية يدوية',
        lines: [{ accountId: acc('1130'), debit: amount, partyType: 'customer', partyId: pick(shops) }, { accountId: acc('4900'), credit: amount }],
      });
      if (res.status === 400 && res.body.error === 'one_side_required') return 'manual entry (zero, skipped)';
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return `manual entry ${amount}`;
    },
  };
  const names = Object.keys(ops);

  await check(0);
  for (let i = 1; i <= OPS; i++) {
    log.push(await ops[pick(names)]());
    await check(i);
  }

  const integrity = await m.get('/api/ledger/integrity-check');
  assert.deepEqual(integrity.body.violations, []);
  // Prompt 3: aging total equals the AR control account; reconciliation clean.
  const aging = await m.get('/api/receivables/aging');
  assert.equal(aging.body.totals.total, aging.body.control_minor);
  assert.equal(aging.body.unassigned_minor, 0);
  const recon = await m.get('/api/receivables/reconciliation');
  assert.equal(recon.body.current.difference_minor, 0);
  assert.deepEqual(recon.body.current.differences, []);
  // No invoice is over-allocated, no receipt over-allocated.
  const d = h.raw(server.dbPath);
  const overInv = d.prepare(`SELECT i.id FROM sales_invoices i WHERE i.company_id = ? AND i.total_minor - i.credited_minor
    - COALESCE((SELECT SUM(a.amount_minor) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = i.id AND r.status = 'posted'), 0) < 0`).all(cid);
  const overRc = d.prepare(`SELECT r.id FROM customer_receipts r WHERE r.company_id = ? AND r.amount_minor < COALESCE((SELECT SUM(amount_minor) FROM receipt_allocations a WHERE a.receipt_id = r.id), 0)`).all(cid);
  d.close();
  assert.deepEqual(overInv, []);
  assert.deepEqual(overRc, []);
  // Every operation type actually ran.
  const kinds = new Set(log.map((l) => l.split(' ')[0]));
  for (const k of ['invoice', 'collection', 'return', 'credit', 'reverse', 'manual', 'receipt', 'cheque']) assert.ok(kinds.has(k), `op ${k} never ran with seed ${SEED}: ${[...kinds]}`);
});
