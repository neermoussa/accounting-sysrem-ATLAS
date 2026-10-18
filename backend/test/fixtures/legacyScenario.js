// backend/test/fixtures/legacyScenario.js
//
// A fixed sequence of the existing balance-affecting flows (collections
// confirmed/rejected, two events on the same day, a return approved with
// automatic financial adjustment, a manual adjustment) run through the real
// HTTP API, then a normalized snapshot of every response and every table
// those flows write. legacyScenario.golden.json was produced by running this
// against the BASELINE code (commit cfd63a6, before the ledger existed);
// test/ledgerLiveFlag.test.js runs it against the current code with
// modules_json.ledger_live off and requires an identical snapshot.

const { openLiveDb } = require('../liveDb');

const TODAY = new Date().toISOString().slice(0, 10);
const VOLATILE = /(_at|_date)$|^(created|updated|imported|collected|changed|reviewed|granted)/;

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE.test(k) && k !== 'report_date' && k !== 'balance_date') continue;
      out[k] = normalize(value[k]);
    }
    return out;
  }
  if (typeof value === 'string') return value.split(TODAY).join('<TODAY>');
  return value;
}

async function runLegacyScenario({ manager, dbPath, companyId }) {
  const steps = {};
  const shopA = await manager.post('/api/shops', { name: 'زبون السيناريو أ', lat: 33.51, lng: 36.29 });
  const shopB = await manager.post('/api/shops', { name: 'زبون السيناريو ب', lat: 33.52, lng: 36.3 });
  steps.shops = [shopA.status, shopB.status];
  const a = shopA.body.id;
  const b = shopB.body.id;

  // Seed a starting balance the way the old system did (raw snapshot, as an
  // Amin import would) so collections have something to reduce.
  const raw = openLiveDb(dbPath);
  raw.prepare("INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, '2026-01-01', 1000, 'seed')").run(a);
  raw.prepare("INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, '2026-01-01', 400, 'seed')").run(b);
  raw.close();

  const c1 = await manager.post('/api/collections', { shopId: a, method: 'cash', amount: 150 });
  const c2 = await manager.post('/api/collections', { shopId: a, method: 'transfer', amount: 70.5, transferReference: 'TRX-1' });
  const c3 = await manager.post('/api/collections', { shopId: b, method: 'cash', amount: 30 });
  steps.record = [c1, c2, c3].map((r) => ({ status: r.status, body: r.body }));
  steps.confirm1 = await manager.post(`/api/collections/${c1.body.id}/confirm`, {});
  steps.confirm2 = await manager.post(`/api/collections/${c2.body.id}/confirm`, {}); // same day as confirm1
  steps.confirmAgain = await manager.post(`/api/collections/${c1.body.id}/confirm`, {});
  steps.reject3 = await manager.post(`/api/collections/${c3.body.id}/reject`, { reason: 'خطأ' });

  steps.settings = (await manager.put('/api/returns/settings/financial', { autoFinancialAdjustment: true })).status;
  const r1 = await manager.post('/api/returns', {
    shopId: a, reason: 'تالف',
    items: [{ productName: 'مادة 1', qty: 3, unitValue: 12.25 }, { productName: 'مادة 2', qty: 1, unitValue: 9.99 }],
  });
  steps.returnCreate = { status: r1.status };
  for (const it of r1.body.items) {
    await manager.put(`/api/returns/${r1.body.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: it.requested_qty });
  }
  steps.approve1 = await manager.post(`/api/returns/${r1.body.id}/approve`, {});

  // Approval without auto adjustment, then the manual endpoint.
  await manager.put('/api/returns/settings/financial', { autoFinancialAdjustment: false });
  const r2 = await manager.post('/api/returns', { shopId: b, items: [{ productName: 'مادة 3', qty: 2, unitValue: 5 }] });
  for (const it of r2.body.items) {
    await manager.put(`/api/returns/${r2.body.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: 2 });
  }
  steps.approve2 = await manager.post(`/api/returns/${r2.body.id}/approve`, {});
  steps.manualAdjust = await manager.post(`/api/returns/${r2.body.id}/apply-financial-adjustment`, {});
  steps.manualAdjustAgain = await manager.post(`/api/returns/${r2.body.id}/apply-financial-adjustment`, {});

  steps.shopA = await manager.get(`/api/shops/${a}`);
  steps.shopB = await manager.get(`/api/shops/${b}`);
  steps.statementA = await manager.get(`/api/collections/statement/${a}`);
  for (const k of ['shopA', 'shopB']) {
    const s = steps[k].body;
    steps[k] = { status: steps[k].status, balance: s.balance, balance_date: s.balance_date, status_color: s.status, balanceHistory: s.balanceHistory };
  }

  const db = openLiveDb(dbPath);
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const tables = {
    balances: q('SELECT shop_id, report_date, balance, source_file FROM balances ORDER BY shop_id, report_date, id'),
    collections: q('SELECT id, shop_id, method, amount, status, transfer_reference, confirmed_by_name, rejected_reason FROM collections WHERE company_id = ? ORDER BY id', companyId),
    collection_changes: q('SELECT collection_id, action, field, before_value, after_value FROM collection_changes WHERE company_id = ? ORDER BY id', companyId),
    return_requests: q('SELECT id, shop_id, status, financial_adjustment_applied, financial_adjustment_amount FROM return_requests WHERE company_id = ? ORDER BY id', companyId),
    return_items: q('SELECT return_request_id, product_name, requested_qty, unit_value, inspection_status, inspected_qty, restocked FROM return_items WHERE company_id = ? ORDER BY id', companyId),
    return_changes: q('SELECT return_request_id, action, field, before_value, after_value FROM return_changes WHERE company_id = ? ORDER BY id', companyId),
  };
  db.close();
  return normalize({ steps, tables });
}

module.exports = { runLegacyScenario, normalize };
