// backend/test/fixtures/productionScenario.js
//
// Golden scenario of the EXISTING production behaviour, recorded BEFORE
// Prompt 9 (manufacturing) touched any code: prep lead-time policies
// (product / category / company default), order approval routing through
// lib/stockCheck.js (car covers it / warehouse replenish / production
// shortage with expected date / both), production request and replenish
// request status changes, lists, refusals. Run through the real HTTP API;
// normalized responses + every table those flows write are compared with
// productionScenario.golden.json by test/productionGolden.test.js.

const { openLiveDb } = require('../liveDb');
const { normalize: baseNormalize } = require('./legacyScenario');

function normalize(v) {
  return JSON.parse(JSON.stringify(baseNormalize(v)), (k, x) => (k === 'public_token' ? '<TOKEN>' : typeof x === 'string' ? x.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<ISO>') : x));
}

async function runProductionScenario({ base, manager, dbPath, companyId, createRep }) {
  const steps = {};
  // List endpoints order by created_at only; rows created in the same second
  // tie in any order, so list bodies are snapshotted sorted by id.
  const s = (name, r) => { if (process.env.PROD_DEBUG) console.error('step', name, r.status); steps[name] = { status: r.status, body: Array.isArray(r.body) ? [...r.body].sort((a, b) => a.id - b.id) : r.body }; return r.body; };
  const prod = async (name, extra = {}) => s(`product_${name}`, await manager.post('/api/products', { name, ...extra })).id;
  const pCar = await prod('لوز 1كغ', { category: 'مكسرات' });
  const pWh = await prod('كاجو 1كغ', { category: 'مكسرات' });
  const pShort = await prod('فستق 1كغ', { category: 'مكسرات' });
  const pBoth = await prod('خلطة فاخرة 1كغ', { category: 'خلطات' });
  const pNone = await prod('زبيب 500غ');
  s('car_pCar', await manager.post('/api/inventory', { product_id: pCar, current_quantity: 50 }));
  s('wh_pWh', await manager.post('/api/factory-inventory', { product_id: pWh, current_quantity: 40 }));
  s('car_pWh', await manager.post('/api/inventory', { product_id: pWh, current_quantity: 2 }));
  s('wh_pBoth', await manager.post('/api/factory-inventory', { product_id: pBoth, current_quantity: 3 }));

  // Prep policies: product, category, default; refusals; update; delete.
  s('policy_missing_days', await manager.post('/api/production/prep-policies', { product_id: pShort }));
  const polP = s('policy_product', await manager.post('/api/production/prep-policies', { product_id: pShort, lead_time_days: 4, load_early: true }));
  s('policy_category', await manager.post('/api/production/prep-policies', { category: 'خلطات', lead_time_days: 2 }));
  const polX = s('policy_extra', await manager.post('/api/production/prep-policies', { category: 'سكاكر', lead_time_days: 9 }));
  s('policy_default_missing', await manager.put('/api/production/prep-policies/default', {}));
  s('policy_default', await manager.put('/api/production/prep-policies/default', { lead_time_days: 3 }));
  s('policy_update', await manager.put(`/api/production/prep-policies/${polP.id}`, { lead_time_days: 5 }));
  s('policy_delete', await manager.del(`/api/production/prep-policies/${polX.id}`));
  s('policy_delete_again', await manager.del(`/api/production/prep-policies/${polX.id}`));
  s('policy_list', await manager.get('/api/production/prep-policies'));

  // Orders (office entry = approved immediately -> stock check).
  const shop = s('shop', await manager.post('/api/shops', { name: 'محل المكسرات', lat: 33.5, lng: 36.3 })).id;
  s('order_car_covers', await manager.post(`/api/shops/${shop}/orders`, { order_date: '2026-03-10', total_value: 100, items: [{ product_id: pCar, product_name: 'لوز 1كغ', qty: 10 }] }));
  s('order_replenish', await manager.post(`/api/shops/${shop}/orders`, { order_date: '2026-03-10', total_value: 100, items: [{ product_id: pWh, product_name: 'كاجو 1كغ', qty: 12 }] }));
  s('order_production', await manager.post(`/api/shops/${shop}/orders`, { order_date: '2026-03-10', total_value: 100, items: [{ product_id: pShort, product_name: 'فستق 1كغ', qty: 7 }] }));
  s('order_both', await manager.post(`/api/shops/${shop}/orders`, { order_date: '2026-03-10', total_value: 100, items: [{ product_id: pBoth, product_name: 'خلطة فاخرة 1كغ', qty: 8 }, { product_name: 'مادة حرة', qty: 1 }] }));
  s('order_default_policy', await manager.post(`/api/shops/${shop}/orders`, { order_date: '2026-03-10', total_value: 100, items: [{ product_id: pNone, product_name: 'زبيب 500غ', qty: 2 }] }));
  // Pending order approved later -> stock check at approval.
  const rep = await createRep(base, manager, { name: 'مندوب الإنتاج', permissions: ['view_app', 'add_orders'] });
  const pend = s('order_pending', await rep.client.post(`/api/shops/${shop}/orders`, { order_date: '2026-03-11', total_value: 50, source: 'rep_manual', items: [{ product_id: pShort, product_name: 'فستق 1كغ', qty: 1 }] }));
  s('order_approve', await manager.post(`/api/orders/${pend.id}/approve`, {}));

  // Requests: lists, filters, status changes, refusals.
  const reqs = s('requests_list', await manager.get('/api/production/requests'));
  s('requests_filtered', await manager.get('/api/production/requests?status=pending_processing'));
  const first = [...reqs].sort((a, b) => a.id - b.id)[0];
  s('request_get', await manager.get(`/api/production/requests/${first.id}`));
  s('request_get_missing', await manager.get('/api/production/requests/999999'));
  s('request_status_bad', await manager.put(`/api/production/requests/${first.id}/status`, { status: 'done' }));
  s('request_status_in_production', await manager.put(`/api/production/requests/${first.id}/status`, { status: 'in_production' }));
  s('request_status_ready', await manager.put(`/api/production/requests/${first.id}/status`, { status: 'ready' }));
  s('request_rep_forbidden', await rep.client.put(`/api/production/requests/${first.id}/status`, { status: 'cancelled' }));
  const rr = s('replenish_list', await manager.get('/api/production/replenish-requests'));
  const r1 = [...rr].sort((a, b) => a.id - b.id)[0];
  s('replenish_filtered', await manager.get('/api/production/replenish-requests?status=pending'));
  s('replenish_status_bad', await manager.put(`/api/production/replenish-requests/${r1.id}/status`, { status: 'loaded' }));
  s('replenish_status', await manager.put(`/api/production/replenish-requests/${r1.id}/status`, { status: 'prepared' }));
  s('replenish_missing', await manager.put('/api/production/replenish-requests/999999/status', { status: 'prepared' }));

  const db = openLiveDb(dbPath);
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const tables = {
    production_requests: q('SELECT id, order_id, shop_id, product_id, product_name, unit_key, requested_qty, available_qty, shortage_qty, rep_id, expected_delivery_date AS expected_delivery, status, updated_by_name FROM production_requests WHERE company_id = ? ORDER BY id', companyId),
    warehouse_replenish_requests: q('SELECT id, order_id, shop_id, product_id, product_name, unit_key, requested_qty, rep_id, status FROM warehouse_replenish_requests WHERE company_id = ? ORDER BY id', companyId),
    prep_lead_time_policies: q('SELECT id, product_id, category, lead_time_days, load_early FROM prep_lead_time_policies WHERE company_id = ? ORDER BY id', companyId),
    settings: q("SELECT key, value FROM settings WHERE company_id = ? AND key = 'default_prep_lead_time_days'", companyId),
    factory_inventory: q('SELECT product_id, current_quantity FROM factory_inventory WHERE company_id = ? ORDER BY id', companyId),
    car_inventory: q('SELECT product_id, current_quantity FROM car_inventory WHERE company_id = ? ORDER BY id', companyId),
    notifications: q("SELECT type, entity_type, entity_id, message_ar FROM notifications WHERE company_id = ? AND type IN ('production_request_created', 'car_replenish_needed') ORDER BY id", companyId),
  };
  db.close();
  return normalize({ steps, tables });
}

module.exports = { runProductionScenario };
