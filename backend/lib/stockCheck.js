const db = require('../db/init');
const { toBaseQty } = require('./productUnits');
const { createNotification } = require('./notify');

function getSetting(companyId, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}

// Most specific policy wins: a rule scoped to this exact product, then one
// scoped to its category, then the company-wide default setting, then a
// hardcoded 1-day fallback so a company that never configured anything
// still gets a sane expected date instead of null.
function resolvePrepPolicy(companyId, { productId, category }) {
  if (productId) {
    const row = db.prepare('SELECT * FROM prep_lead_time_policies WHERE company_id = ? AND product_id = ?').get(companyId, productId);
    if (row) return row;
  }
  if (category) {
    const row = db.prepare('SELECT * FROM prep_lead_time_policies WHERE company_id = ? AND category = ? AND product_id IS NULL').get(companyId, category);
    if (row) return row;
  }
  const defaultDays = getSetting(companyId, 'default_prep_lead_time_days');
  return { lead_time_days: defaultDays != null ? Number(defaultDays) : 1, load_early: 1 };
}

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getInventoryQty(table, companyId, productId) {
  if (!productId) return 0;
  return db.prepare(`SELECT current_quantity FROM ${table} WHERE company_id = ? AND product_id = ?`).get(companyId, productId)?.current_quantity ?? 0;
}

function notifyWarehouseKeeper(companyId, request, shop) {
  createNotification({
    companyId,
    type: 'car_replenish_needed',
    message_ar: `يحتاج تجهيز ${request.requested_qty} من "${request.product_name}" لتزويد سيارة المندوب — طلب #${request.order_id} لمحل ${shop.name}.`,
    message_en: `Prepare ${request.requested_qty} of "${request.product_name}" for the rep's car — order #${request.order_id} for ${shop.name}.`,
    link_path: `/inventory`,
    entity_type: 'warehouse_replenish_request',
    entity_id: request.id,
  });
}

function notifyProductionManager(companyId, request, shop) {
  const rep = request.rep_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(request.rep_id) : null;
  createNotification({
    companyId,
    type: 'production_request_created',
    message_ar:
      `طلب إنتاج جديد — طلب #${request.order_id}، العميل ${shop.name}، الصنف "${request.product_name}"، ` +
      `المطلوب ${request.requested_qty}، المتوفر ${request.available_qty}، الناقص ${request.shortage_qty}، ` +
      `المندوب ${rep?.name || '—'}، موعد التسليم المتوقع ${request.expected_delivery_date || '—'}.`,
    message_en:
      `New production request — order #${request.order_id}, customer ${shop.name}, item "${request.product_name}", ` +
      `requested ${request.requested_qty}, available ${request.available_qty}, short ${request.shortage_qty}, ` +
      `rep ${rep?.name || '—'}, expected delivery ${request.expected_delivery_date || '—'}.`,
    link_path: `/factory-inventory`,
    entity_type: 'production_request',
    entity_id: request.id,
  });
}

// Runs once an order becomes 'approved' (routes/shops.js order creation,
// routes/orders.js /approve and /whatsapp/inbox/:id/approve). Car stock is
// checked first, then the factory warehouse, per item — items with no
// product_id (free-text legacy entries) can't be matched against real
// inventory rows and are silently skipped, same as every other
// catalog-only feature in this app.
function checkStockAndRoute(companyId, order, shop) {
  const items = JSON.parse(order.items_json || '[]').filter((it) => !it.is_free && it.product_id);
  const results = { replenishRequests: [], productionRequests: [] };

  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(item.product_id, companyId);
    if (!product) continue;

    const neededQty = item.unit_key ? toBaseQty(product.id, item.qty, item.unit_key) : Number(item.qty);
    const carQty = getInventoryQty('car_inventory', companyId, product.id);
    if (carQty >= neededQty) continue; // fully covered by the rep's own car — nothing to do

    const warehouseQty = getInventoryQty('factory_inventory', companyId, product.id);
    const carShortfall = neededQty - carQty;

    if (carShortfall <= warehouseQty) {
      // Warehouse has enough to cover what the car is missing — a
      // replenish/load task, not a production shortage.
      const info = db
        .prepare(
          `INSERT INTO warehouse_replenish_requests (company_id, order_id, shop_id, product_id, product_name, unit_key, requested_qty, rep_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(companyId, order.id, shop.id, product.id, product.name, item.unit_key || null, carShortfall, order.rep_id);
      const request = db.prepare('SELECT * FROM warehouse_replenish_requests WHERE id = ?').get(info.lastInsertRowid);
      notifyWarehouseKeeper(companyId, request, shop);
      results.replenishRequests.push(request);
    } else {
      // Neither the car nor the warehouse has enough — a real production
      // shortage for the full remaining gap.
      const shortageQty = carShortfall - warehouseQty;
      const policy = resolvePrepPolicy(companyId, { productId: product.id, category: product.category });
      const expectedDeliveryDate = addDaysStr(order.order_date, policy.lead_time_days ?? 1);

      const info = db
        .prepare(
          `INSERT INTO production_requests (
             company_id, order_id, shop_id, product_id, product_name, unit_key,
             requested_qty, available_qty, shortage_qty, rep_id, expected_delivery_date
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          companyId,
          order.id,
          shop.id,
          product.id,
          product.name,
          item.unit_key || null,
          neededQty,
          carQty + warehouseQty,
          shortageQty,
          order.rep_id,
          expectedDeliveryDate
        );
      const request = db.prepare('SELECT * FROM production_requests WHERE id = ?').get(info.lastInsertRowid);
      notifyProductionManager(companyId, request, shop);
      results.productionRequests.push(request);

      // The car-side shortfall covered by whatever's already in the
      // warehouse is still worth loading now, independent of the
      // production shortage — the two aren't mutually exclusive.
      if (warehouseQty > 0) {
        const replenishInfo = db
          .prepare(
            `INSERT INTO warehouse_replenish_requests (company_id, order_id, shop_id, product_id, product_name, unit_key, requested_qty, rep_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(companyId, order.id, shop.id, product.id, product.name, item.unit_key || null, warehouseQty, order.rep_id);
        const replenishRequest = db.prepare('SELECT * FROM warehouse_replenish_requests WHERE id = ?').get(replenishInfo.lastInsertRowid);
        notifyWarehouseKeeper(companyId, replenishRequest, shop);
        results.replenishRequests.push(replenishRequest);
      }
    }
  }

  return results;
}

module.exports = { checkStockAndRoute, resolvePrepPolicy, addDaysStr };
