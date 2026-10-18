const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const { getGlobalSettings, enrichShop } = require('../lib/shopData');
const { recomputeShopClassification } = require('../lib/classification');
const { findShopByPhone } = require('../lib/shopLookup');
const { normalizePhone } = require('../lib/phone');
const { sendToCustomer } = require('../lib/whatsapp');
const {
  logOrderChange,
  getSetting,
  checkCreditLimit,
  partialDeliveryCreatesFollowup,
  followupOrderStatus,
  notifyOrderPendingApproval,
  notifyWhatsappOrderReceived,
  notifyCustomerOfChange,
} = require('../lib/orderLifecycle');
const { checkStockAndRoute } = require('../lib/stockCheck');
const { resolveScopeWithElevation, canAccessRepOwnedRecord, ORDER_ELEVATED_PERMISSIONS } = require('../lib/repAccess');

const router = express.Router();
router.use(requireCompany);

function getOrder(companyId, orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL').get(orderId, companyId);
}

function getShop(companyId, shopId) {
  return db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(shopId, companyId);
}

// ---------------------------------------------------------------------
// Listing / detail / history
// ---------------------------------------------------------------------

router.get('/', requireAnyPermission('view_app', 'approve_orders', 'record_deliveries'), (req, res) => {
  const { status, shopId, repId } = req.query;
  // A plain rep-scoped holder (add_orders/delete_orders/record_deliveries
  // only, no approve_orders/manage_settings) may only ever list their own
  // orders — 'view_app' alone previously let any rep list every order
  // company-wide via this endpoint with no repId filter. Note: for a
  // non-elevated caller this also naturally excludes rep_id IS NULL
  // (office-entered) orders below, since 'rep_id = ?' never matches NULL.
  const scope = resolveScopeWithElevation(req, repId ?? null, ORDER_ELEVATED_PERMISSIONS);
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  let sql = 'SELECT * FROM orders WHERE company_id = ? AND deleted_at IS NULL';
  const params = [req.companyId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (shopId) {
    sql += ' AND shop_id = ?';
    params.push(shopId);
  }
  if (scope.repId != null) {
    sql += ' AND rep_id = ?';
    params.push(scope.repId);
  }
  sql += ' ORDER BY order_date DESC, id DESC';
  const rows = db.prepare(sql).all(...params).map((o) => ({ ...o, items: JSON.parse(o.items_json || '[]') }));
  res.json(rows);
});

router.get('/:id', requireAnyPermission('view_app', 'approve_orders', 'record_deliveries'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  res.json({ ...order, items: JSON.parse(order.items_json || '[]') });
});

router.get('/:id/history', requireAnyPermission('view_app', 'approve_orders', 'record_deliveries'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  res.json(db.prepare('SELECT * FROM order_status_changes WHERE order_id = ? ORDER BY changed_at DESC').all(order.id));
});

// ---------------------------------------------------------------------
// Approval: pending_approval -> approved. Gated by a standalone
// permission (approve_orders), grantable to any role — never hardcoded
// to "manager only".
// ---------------------------------------------------------------------

router.post('/:id/approve', requirePermission('approve_orders'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.status !== 'pending_approval') return res.status(409).json({ error: 'not_pending_approval', currentStatus: order.status });
  const shop = getShop(req.companyId, order.shop_id);

  db.prepare(
    "UPDATE orders SET status = 'approved', approved_by_id = ?, approved_by_name = ?, approved_at = datetime('now') WHERE id = ?"
  ).run(req.user.id, req.user.name, order.id);
  logOrderChange(req.companyId, order.id, { action: 'approve', field: 'status', before: 'pending_approval', after: 'approved', user: req.user });

  // Stock check + everything a normally-approved order already triggers,
  // now that it's official.
  recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));
  const items = JSON.parse(order.items_json || '[]');
  const itemsSummary = items.map((it) => `${it.product_name} × ${it.qty}`).join('، ');
  sendToCustomer(
    req.companyId,
    shop,
    `مرحبًا ${shop.name}،\nتم اعتماد طلبكم بتاريخ ${order.order_date}.\nالأصناف: ${itemsSummary || '—'}\nإجمالي الطلب: ${Math.round(order.total_value).toLocaleString('ar')} $`
  ).catch(() => {});
  checkStockAndRoute(req.companyId, { ...order, status: 'approved' }, shop);

  res.json({ ...db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), items });
});

router.post('/:id/reject', requirePermission('approve_orders'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.status !== 'pending_approval') return res.status(409).json({ error: 'not_pending_approval', currentStatus: order.status });
  const { reason } = req.body || {};
  db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ?, cancelled_at = datetime('now') WHERE id = ?").run(
    reason || 'رُفض عند المراجعة',
    order.id
  );
  logOrderChange(req.companyId, order.id, { action: 'reject', field: 'status', before: 'pending_approval', after: 'cancelled', user: req.user });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
});

// ---------------------------------------------------------------------
// Amend: full edit of quantity/price/date on an order at any lifecycle
// stage before delivery — recomputes everything downstream and notifies
// the customer of the change (no reconfirmation asked).
// ---------------------------------------------------------------------

router.put('/:id/amend', requirePermission('add_orders'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  if (['delivered', 'paid', 'returned', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ error: 'order_locked', currentStatus: order.status });
  }
  const shop = getShop(req.companyId, order.shop_id);
  const { order_date, items, total_value } = req.body || {};
  if (!order_date || total_value === undefined) return res.status(400).json({ error: 'order_date_and_total_value_required' });
  const itemsList = Array.isArray(items) ? items : [];
  if (itemsList.some((it) => !(Number(it.qty) > 0))) return res.status(400).json({ error: 'item_quantity_must_be_positive' });

  const before = { order_date: order.order_date, items: JSON.parse(order.items_json), total_value: order.total_value };
  db.prepare(`UPDATE orders SET order_date = ?, items_json = ?, total_value = ?, edited_at = datetime('now') WHERE id = ?`).run(
    order_date,
    JSON.stringify(itemsList),
    total_value,
    order.id
  );
  const after = { order_date, items: itemsList, total_value };
  logOrderChange(req.companyId, order.id, { action: 'amend', field: 'order', before, after, user: req.user });

  // Downstream recheck: inventory/classification recompute, then a plain
  // notice to the customer.
  recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));
  const itemsSummary = itemsList.map((it) => `${it.product_name} × ${it.qty}`).join('، ');
  notifyCustomerOfChange(
    sendToCustomer,
    req.companyId,
    shop,
    { order_date },
    `الأصناف المعدّلة: ${itemsSummary || '—'}\nالإجمالي الجديد: ${Math.round(total_value).toLocaleString('ar')} $`
  );

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ ...updated, items: JSON.parse(updated.items_json) });
});

// ---------------------------------------------------------------------
// Fulfillment status transitions
// ---------------------------------------------------------------------

router.put('/:id/status', requirePermission('add_orders'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  const { status } = req.body || {};
  if (!['processing', 'out_for_delivery'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  if (order.status !== 'approved' && order.status !== 'processing') {
    return res.status(409).json({ error: 'invalid_transition', currentStatus: order.status });
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  logOrderChange(req.companyId, order.id, { action: 'status_change', field: 'status', before: order.status, after: status, user: req.user });

  // Automatic, no-approval-needed goods-arrival notice — unlike the account
  // statement (which always needs an employee's explicit send), this is
  // purely informational and fires the moment the order actually goes out.
  if (status === 'out_for_delivery') {
    const shop = getShop(req.companyId, order.shop_id);
    if (shop) {
      sendToCustomer(
        req.companyId,
        shop,
        `مرحبًا ${shop.name}،\nطلبكم بتاريخ ${order.order_date} في الطريق إليكم الآن.`
      ).catch(() => {});
    }
  }

  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
});

// Partial delivery: qty_delivered per item may be less than ordered. Any
// shortfall optionally spins off a follow-up order (company setting) —
// never silently dropped.
router.post('/:id/deliver', requirePermission('record_deliveries'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  if (!['approved', 'processing', 'out_for_delivery'].includes(order.status)) {
    return res.status(409).json({ error: 'invalid_transition', currentStatus: order.status });
  }
  const { deliveredItems, notes, signatureDataUrl } = req.body || {};
  if (!Array.isArray(deliveredItems) || deliveredItems.length === 0) return res.status(400).json({ error: 'deliveredItems_required' });

  const orderedItems = JSON.parse(order.items_json || '[]');
  const shortfall = [];
  for (const oi of orderedItems) {
    if (oi.is_free) continue;
    const delivered = deliveredItems.find((d) => d.product_name === oi.product_name || (d.product_id && d.product_id === oi.product_id));
    const deliveredQty = Number(delivered?.qty ?? 0);
    if (deliveredQty < oi.qty) {
      shortfall.push({ ...oi, qty: oi.qty - deliveredQty });
    }
  }

  db.prepare(
    'INSERT INTO order_deliveries (company_id, order_id, delivered_items_json, notes, signature_data_url, delivered_by_id, delivered_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.companyId, order.id, JSON.stringify(deliveredItems), notes || null, signatureDataUrl || null, req.user.id, req.user.name);

  if (shortfall.length > 0) {
    const shop = getShop(req.companyId, order.shop_id);
    const orderedTotalQty = orderedItems.filter((it) => !it.is_free).reduce((sum, it) => sum + Number(it.qty), 0);
    const shortfallTotalQty = shortfall.reduce((sum, it) => sum + Number(it.qty), 0);
    if (shop) {
      try {
        const { flagDeliveryMismatchAnomaly } = require('../lib/aiRecommendations');
        flagDeliveryMismatchAnomaly(req.companyId, { shop, order, orderedQty: orderedTotalQty, shortfallQty: shortfallTotalQty });
      } catch (err) {
        console.error('[orders] AI delivery-mismatch anomaly flagging failed:', err.message);
      }
    }
  }

  db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(order.id);
  logOrderChange(req.companyId, order.id, {
    action: 'deliver',
    field: 'status',
    before: order.status,
    after: 'delivered',
    user: req.user,
  });

  let followUpOrder = null;
  if (shortfall.length > 0 && partialDeliveryCreatesFollowup(req.companyId)) {
    const followUpTotal = shortfall.reduce((sum, it) => sum + (it.line_total ?? 0), 0);
    const status = followupOrderStatus(req.companyId);
    const info = db
      .prepare(
        `INSERT INTO orders (company_id, shop_id, rep_id, order_date, items_json, total_value, status, source, follow_up_of_order_id, approved_by_id, approved_by_name, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'direct', ?, ?, ?, ?)`
      )
      .run(
        req.companyId,
        order.shop_id,
        order.rep_id,
        order.order_date,
        JSON.stringify(shortfall),
        followUpTotal,
        status,
        order.id,
        status === 'approved' ? req.user.id : null,
        status === 'approved' ? req.user.name : null,
        status === 'approved' ? new Date().toISOString() : null
      );
    followUpOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
    logOrderChange(req.companyId, followUpOrder.id, { action: 'created_from_partial_delivery', field: 'follow_up_of_order_id', before: null, after: order.id, user: req.user });
    if (status === 'pending_approval') {
      const shop = getShop(req.companyId, order.shop_id);
      notifyOrderPendingApproval(req.companyId, followUpOrder, shop);
    }
  }

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: { ...updated, items: JSON.parse(updated.items_json) }, shortfall, followUpOrder });
});

router.post('/:id/mark-paid', requirePermission('add_orders'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(order.id);
  logOrderChange(req.companyId, order.id, { action: 'mark_paid', field: 'status', before: order.status, after: 'paid', user: req.user });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
});

router.post('/:id/return', requirePermission('delete_orders'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  const { reason } = req.body || {};
  db.prepare("UPDATE orders SET status = 'returned', return_reason = ?, returned_at = datetime('now') WHERE id = ?").run(reason || null, order.id);
  logOrderChange(req.companyId, order.id, { action: 'return', field: 'status', before: order.status, after: 'returned', user: req.user });
  const shop = getShop(req.companyId, order.shop_id);
  recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
});

router.post('/:id/cancel', requirePermission('delete_orders'), (req, res) => {
  const order = getOrder(req.companyId, req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (!canAccessRepOwnedRecord(req, order.rep_id, ORDER_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  if (['delivered', 'paid'].includes(order.status)) return res.status(409).json({ error: 'order_already_fulfilled', currentStatus: order.status });
  const { reason } = req.body || {};
  db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ?, cancelled_at = datetime('now') WHERE id = ?").run(reason || null, order.id);
  logOrderChange(req.companyId, order.id, { action: 'cancel', field: 'status', before: order.status, after: 'cancelled', user: req.user });

  // Cancelling only cancels the quantity "reminder" this order created —
  // there was never a physical stock reservation to release, since
  // checkStockAndRoute only ever opened requests, it never decremented
  // inventory. Still-open production/replenish requests for this order no
  // longer need fulfilling, so they're cancelled too rather than left
  // dangling for the production manager/warehouse keeper to act on.
  db.prepare("UPDATE production_requests SET status = 'cancelled', updated_at = datetime('now') WHERE order_id = ? AND status IN ('pending_processing', 'in_production')").run(order.id);
  db.prepare("UPDATE warehouse_replenish_requests SET status = 'cancelled', updated_at = datetime('now') WHERE order_id = ? AND status = 'pending'").run(order.id);

  const shop = getShop(req.companyId, order.shop_id);
  recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
});

// ---------------------------------------------------------------------
// WhatsApp order inbox — never a real order until a rep reviews and
// approves it against the actual conversation with the customer.
//
// Deliberately NOT rep-scoped like the orders endpoints above:
// `whatsapp_orders` has no settled "who owns this" column analogous to
// `orders.rep_id`. It does carry `assigned_rep_id`, but that's copied from
// the shop's assignment at intake time (lib/shopLookup.js), not stamped by
// whoever actually reviews/approves the row — it's a routing hint, not an
// ownership record, and can be NULL or point at a rep who never touches
// this particular message. Rather than invent a scope concept the data
// doesn't cleanly support, these endpoints stay permission-gated only,
// same as before this pass.
// ---------------------------------------------------------------------

router.get('/whatsapp/inbox', requireAnyPermission('view_app', 'add_orders'), (req, res) => {
  const status = req.query.status || 'pending_review';
  const rows = db
    .prepare('SELECT * FROM whatsapp_orders WHERE company_id = ? AND status = ? ORDER BY received_at DESC')
    .all(req.companyId, status);
  res.json(rows.map((r) => ({ ...r, items: JSON.parse(r.items_json || '[]') })));
});

// Manual/simulated ingestion — the same path the real WhatsApp message
// listener (lib/whatsapp.js) calls when a message arrives on a connected
// session; also usable by a manager keying in an order that came by phone
// call or a screenshot.
router.post('/whatsapp/inbox', requirePermission('add_orders'), (req, res) => {
  const { fromPhone, rawText, items } = req.body || {};
  if (!fromPhone || !rawText?.trim()) return res.status(400).json({ error: 'fromPhone_and_rawText_required' });
  const shop = findShopByPhone(req.companyId, normalizePhone(fromPhone));
  const info = db
    .prepare(
      `INSERT INTO whatsapp_orders (company_id, shop_id, from_phone, raw_text, items_json, assigned_rep_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, shop?.id ?? null, fromPhone, rawText.trim(), JSON.stringify(items || []), shop?.assigned_rep_id ?? null);
  const whatsappOrder = db.prepare('SELECT * FROM whatsapp_orders WHERE id = ?').get(info.lastInsertRowid);
  notifyWhatsappOrderReceived(req.companyId, whatsappOrder, shop);
  res.status(201).json({ ...whatsappOrder, items: JSON.parse(whatsappOrder.items_json) });
});

// The rep reviews with the customer, finalizes the real items/total, and
// this single action both approves the WhatsApp message AND creates the
// official order (source='whatsapp', status='approved') in one step — per
// the spec, the rep's approval IS what makes it official.
router.post('/whatsapp/inbox/:id/approve', requirePermission('add_orders'), (req, res) => {
  const whatsappOrder = db.prepare('SELECT * FROM whatsapp_orders WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!whatsappOrder) return res.status(404).json({ error: 'not_found' });
  if (whatsappOrder.status !== 'pending_review') return res.status(409).json({ error: 'already_reviewed', currentStatus: whatsappOrder.status });

  const { shopId, order_date, items, total_value, credit_override_reason } = req.body || {};
  const shop = getShop(req.companyId, shopId || whatsappOrder.shop_id);
  if (!shop) return res.status(400).json({ error: 'shop_required' });
  const itemsList = Array.isArray(items) ? items : [];
  if (!order_date || total_value === undefined || itemsList.length === 0) {
    return res.status(400).json({ error: 'order_date_items_and_total_value_required' });
  }

  const creditCheck = checkCreditLimit(req.companyId, shop, total_value);
  // Prompt 3: a hard block can be overridden by someone holding
  // override_credit_limit who gives a reason (recorded on the order).
  const creditOverridden = creditCheck.exceeded && creditCheck.mode === 'blocked'
    && req.user.permissions.includes('override_credit_limit') && !!credit_override_reason?.trim();
  if (creditCheck.exceeded && creditCheck.mode === 'blocked' && !creditOverridden) {
    return res.status(403).json({ error: 'credit_limit_blocked', limit: creditCheck.limit, projectedBalance: creditCheck.projectedBalance, canOverride: req.user.permissions.includes('override_credit_limit') });
  }
  if (creditCheck.exceeded && creditCheck.mode === 'rep_decides' && !credit_override_reason?.trim()) {
    return res.status(400).json({ error: 'credit_override_reason_required', limit: creditCheck.limit, projectedBalance: creditCheck.projectedBalance });
  }
  const needsApproval = creditCheck.exceeded && creditCheck.mode === 'requires_approval';
  const status = needsApproval ? 'pending_approval' : 'approved';

  const info = db
    .prepare(
      `INSERT INTO orders (company_id, shop_id, rep_id, order_date, items_json, total_value, status, source, credit_limit_exceeded, credit_override_reason, approved_by_id, approved_by_name, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?)`
    )
    .run(
      req.companyId,
      shop.id,
      req.user.id,
      order_date,
      JSON.stringify(itemsList),
      total_value,
      status,
      creditCheck.exceeded ? 1 : 0,
      creditCheck.exceeded ? credit_override_reason?.trim() || null : null,
      status === 'approved' ? req.user.id : null,
      status === 'approved' ? req.user.name : null,
      status === 'approved' ? new Date().toISOString() : null
    );
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);

  db.prepare("UPDATE whatsapp_orders SET status = 'approved', reviewed_by_id = ?, reviewed_by_name = ?, reviewed_at = datetime('now'), order_id = ? WHERE id = ?").run(
    req.user.id,
    req.user.name,
    order.id,
    whatsappOrder.id
  );

  if (status === 'approved') {
    recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));
    checkStockAndRoute(req.companyId, order, shop);
  } else {
    notifyOrderPendingApproval(req.companyId, order, shop);
  }

  res.status(201).json({ ...order, items: JSON.parse(order.items_json) });
});

router.post('/whatsapp/inbox/:id/reject', requirePermission('add_orders'), (req, res) => {
  const whatsappOrder = db.prepare('SELECT * FROM whatsapp_orders WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!whatsappOrder) return res.status(404).json({ error: 'not_found' });
  db.prepare("UPDATE whatsapp_orders SET status = 'rejected', reviewed_by_id = ?, reviewed_by_name = ?, reviewed_at = datetime('now') WHERE id = ?").run(
    req.user.id,
    req.user.name,
    whatsappOrder.id
  );
  res.json(db.prepare('SELECT * FROM whatsapp_orders WHERE id = ?').get(whatsappOrder.id));
});

// ---------------------------------------------------------------------
// Company-wide order-lifecycle settings
// ---------------------------------------------------------------------

router.get('/settings/lifecycle', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  res.json({
    creditLimitEnforcement: getSetting(req.companyId, 'credit_limit_enforcement', 'rep_decides'),
    repManualOrderAutoApprove: getSetting(req.companyId, 'rep_manual_order_auto_approve', '0') === '1',
    partialDeliveryCreatesFollowup: getSetting(req.companyId, 'partial_delivery_creates_followup', '1') === '1',
    followupOrderStatus: getSetting(req.companyId, 'followup_order_status', 'pending_approval'),
    defaultCreditLimit: getSetting(req.companyId, 'default_credit_limit', null),
  });
});

router.put('/settings/lifecycle', requirePermission('manage_settings'), (req, res) => {
  const { creditLimitEnforcement, repManualOrderAutoApprove, partialDeliveryCreatesFollowup, followupOrderStatus, defaultCreditLimit } = req.body || {};
  const set = (key, value) =>
    db
      .prepare(`INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`)
      .run(req.companyId, key, String(value));
  if (creditLimitEnforcement) set('credit_limit_enforcement', creditLimitEnforcement);
  if (repManualOrderAutoApprove !== undefined) set('rep_manual_order_auto_approve', repManualOrderAutoApprove ? '1' : '0');
  if (partialDeliveryCreatesFollowup !== undefined) set('partial_delivery_creates_followup', partialDeliveryCreatesFollowup ? '1' : '0');
  if (followupOrderStatus) set('followup_order_status', followupOrderStatus);
  if (defaultCreditLimit !== undefined) set('default_credit_limit', defaultCreditLimit);
  res.status(204).end();
});

module.exports = router;
