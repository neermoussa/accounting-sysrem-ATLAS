// backend/test/fixtures/warehouseScenario.js
//
// Golden scenario of the EXISTING warehouse behaviour (recorded before
// Prompt 8 touched any warehouse code): factory + car stock screens
// (create, edit, quantity, delete, alerts), a counted stock check, a
// custody transfer with a discrepancy resolved and closed, a return
// restocked into car stock and an offline-sync car count (goods receipts
// are covered by test/purchasingStock.test.js). Run through the real HTTP API on a company that has NOT
// activated the stock ledger; the normalized responses + every table those
// flows write are compared with warehouseScenario.golden.json by
// test/warehouseGolden.test.js.

const { openLiveDb } = require('../liveDb');
const { normalize: baseNormalize } = require('./legacyScenario');

// legacyScenario's normalize plus: random tokens, and timestamps embedded
// inside JSON strings (sync results).
function normalize(v) {
  return JSON.parse(JSON.stringify(baseNormalize(v)), (k, x) => {
    if (k === 'public_token') return '<TOKEN>';
    if (typeof x === 'string') return x.replace(/<TODAY> \d\d:\d\d:\d\d/g, '<TODAY> <TIME>').replace(/"(created_at|updated_at)":"[^"]*"/g, '"$1":"<TS>"');
    return x;
  });
}

async function runWarehouseScenario({ base, manager, dbPath, companyId, createRep }) {
  const steps = {};
  const s = (name, r) => { if (process.env.WH_DEBUG) console.error('step', name, r.status); steps[name] = { status: r.status, body: r.body }; return r.body; };
  const prod = async (name, extra = {}) => s(`product_${name}`, await manager.post('/api/products', { name, ...extra })).id;
  const p1 = await prod('سكر 1كغ');
  const p2 = await prod('شاي 500غ');
  const p3 = await prod('رز 5كغ');
  s('warehouse', await manager.post('/api/companies/warehouses', { name: 'المستودع المركزي', kind: 'factory' }));
  const vehicle = s('vehicle', await manager.post('/api/companies/vehicles', { label: 'سيارة 1' }));
  const keeper = await createRep(base, manager, { name: 'أمين المستودع', permissions: ['view_app', 'create_custody_transfers', 'manage_custody_transfer_items', 'approve_custody_transfer_readiness'] });
  const rep = await createRep(base, manager, { name: 'مندوب المناقلات', permissions: ['view_app', 'confirm_custody_transfer_receipt', 'request_returns'] });

  // Factory stock screen.
  const f1 = s('factory_create_p1', await manager.post('/api/factory-inventory', { product_id: p1, current_quantity: 100, min_quantity: 20 }));
  const f2 = s('factory_create_typed', await manager.post('/api/factory-inventory', { item_name: 'زيت 1ل', current_quantity: 8, min_quantity: 10 }));
  s('factory_create_p3', await manager.post('/api/factory-inventory', { product_id: p3, current_quantity: 40 }));
  s('factory_duplicate_refused', await manager.post('/api/factory-inventory', { product_id: p1, current_quantity: 1 }));
  s('factory_edit', await manager.put(`/api/factory-inventory/${f2.id}`, { item_name: 'زيت 1ل', current_quantity: 12, min_quantity: 10 }));
  s('factory_quantity', await manager.put(`/api/factory-inventory/${f1.id}/quantity`, { current_quantity: 90 }));
  s('factory_alerts', await manager.get('/api/factory-inventory/alerts'));
  // Car stock screen.
  const c2 = s('car_create_p2', await manager.post('/api/inventory', { product_id: p2, current_quantity: 6, min_quantity: 2 }));
  s('car_quantity', await manager.put(`/api/inventory/${c2.id}/quantity`, { current_quantity: 5 }));
  // Stock count on factory (manual rows).
  s('factory_count', await manager.post('/api/factory-inventory/count/confirm', {
    filename: 'جرد الشهر',
    rows: [
      { itemName: 'سكر 1كغ', matchedItemId: f1.id, expectedQuantity: 90, countedQuantity: 87, variance: -3, variancePct: -3.33, classification: 'minor', reason: 'تلف' },
      { itemName: 'زيت 1ل', matchedItemId: f2.id, expectedQuantity: 12, countedQuantity: 12, variance: 0, variancePct: 0, classification: 'matched' },
    ],
  }));
  s('factory_count_history', await manager.get('/api/factory-inventory/count/history'));

  // Custody transfer: two lines, one received short, discrepancy resolved, closed into car stock.
  const tr = s('transfer_create', await keeper.client.post('/api/custody-transfers', { warehouseId: steps.warehouse.body.id, vehicleId: vehicle.id, repId: rep.userId, notes: 'تحميل الصباح' }));
  const i1 = s('transfer_item_p1', await keeper.client.post(`/api/custody-transfers/${tr.id}/items`, { productId: p1, productName: 'سكر 1كغ', preparedQty: 20 }));
  s('transfer_item_p1_merge', await keeper.client.post(`/api/custody-transfers/${tr.id}/items`, { productId: p1, productName: 'سكر 1كغ', preparedQty: 5 }));
  s('transfer_item_p2', await keeper.client.post(`/api/custody-transfers/${tr.id}/items`, { productId: p2, productName: 'شاي 500غ', preparedQty: 10 }));
  s('transfer_item_free', await keeper.client.post(`/api/custody-transfers/${tr.id}/items`, { productName: 'أكياس', preparedQty: 50 }));
  s('transfer_ready', await keeper.client.post(`/api/custody-transfers/${tr.id}/ready`, {}));
  const detail = s('transfer_detail', await rep.client.get(`/api/custody-transfers/${tr.id}`));
  const items = detail.items || [];
  const byName = (n) => items.find((it) => it.product_name === n);
  s('transfer_confirm', await rep.client.post(`/api/custody-transfers/${tr.id}/confirm-receipt`, {
    items: [{ itemId: byName('سكر 1كغ')?.id ?? i1.id, receivedQty: 25 }, { itemId: byName('شاي 500غ')?.id, receivedQty: 9 }, { itemId: byName('أكياس')?.id, receivedQty: 50 }],
  }));
  s('transfer_resolve', await manager.put(`/api/custody-transfers/${tr.id}/items/${byName('شاي 500غ')?.id}/resolve-discrepancy`, { reason: 'كسر', note: 'علبة مكسورة' }));
  s('transfer_final', await manager.get(`/api/custody-transfers/${tr.id}`));

  // Return restocked into car stock.
  const shop = s('shop', await manager.post('/api/shops', { name: 'زبون المرتجع', lat: 33.5, lng: 36.3 })).id;
  const ret = s('return_create', await rep.client.post('/api/returns', { shopId: shop, reason: 'زيادة', items: [{ productId: p3, productName: 'رز 5كغ', qty: 4, unitValue: 7.5 }, { productName: 'مادة بلا رقم', qty: 1 }] }));
  for (const it of ret.items || []) s(`return_inspect_${it.id}`, await manager.put(`/api/returns/${ret.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: it.requested_qty }));
  s('return_approve', await manager.post(`/api/returns/${ret.id}/approve`, {}));

  // Offline-sync car count by the rep.
  s('sync_count', await manager.post('/api/sync/batch', { operations: [{ clientId: 'c1', idempotencyKey: 'golden-count-1', entityType: 'inventory_count', operation: 'create', payload: { productId: p1, quantity: 24 } }] }));

  // Delete a factory row.
  s('factory_delete', await manager.del(`/api/factory-inventory/${f2.id}`));
  s('factory_list', await manager.get('/api/factory-inventory'));
  s('car_list', await manager.get('/api/inventory'));

  const db = openLiveDb(dbPath);
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const tables = {
    factory_inventory: q('SELECT id, item_name, product_id, current_quantity, min_quantity, low_stock_alert_active FROM factory_inventory WHERE company_id = ? ORDER BY id', companyId),
    car_inventory: q('SELECT id, item_name, product_id, current_quantity, min_quantity, low_stock_alert_active FROM car_inventory WHERE company_id = ? ORDER BY id', companyId),
    products: q('SELECT id, name, cost_price FROM products WHERE company_id = ? ORDER BY id', companyId),
    custody_transfers: q('SELECT id, warehouse_id, vehicle_id, rep_id, status, notes, prepared_by_name, readied_by_name, confirmed_by_name FROM custody_transfers WHERE company_id = ? ORDER BY id', companyId),
    custody_transfer_items: q('SELECT i.id, i.product_id, i.product_name, i.prepared_qty, i.received_qty, i.variance_qty, i.discrepancy_reason, i.discrepancy_note FROM custody_transfer_items i JOIN custody_transfers t ON t.id = i.transfer_id WHERE t.company_id = ? ORDER BY i.id', companyId),
    custody_transfer_changes: q('SELECT transfer_id, item_id, action, field, before_value, after_value, changed_by_name FROM custody_transfer_changes WHERE company_id = ? ORDER BY id', companyId),
    inventory_counts: q('SELECT id, warehouse, filename, item_count, variance_count FROM inventory_counts WHERE company_id = ? ORDER BY id', companyId),
    inventory_count_rows: q('SELECT r.count_id, r.item_name, r.matched_item_id, r.expected_quantity, r.counted_quantity, r.variance, r.classification, r.reason FROM inventory_count_rows r JOIN inventory_counts c ON c.id = r.count_id WHERE c.company_id = ? ORDER BY r.id', companyId),
    return_items: q('SELECT product_id, product_name, requested_qty, inspection_status, inspected_qty, restocked FROM return_items WHERE company_id = ? ORDER BY id', companyId),
    notifications: q("SELECT type, entity_type, entity_id, message_ar FROM notifications WHERE company_id = ? AND type NOT LIKE 'return%' ORDER BY id", companyId),
  };
  db.close();
  return normalize({ steps, tables });
}

module.exports = { runWarehouseScenario };
