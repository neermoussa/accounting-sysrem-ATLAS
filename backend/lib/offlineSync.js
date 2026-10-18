const db = require('../db/init');
const { logPointChange, checkGeofence, checkUnplannedVisit } = require('./waves');
const { checkCreditLimit, logOrderChange, notifyOrderPendingApproval } = require('./orderLifecycle');
const { createCollection } = require('./collections');
const { getGlobalSettings } = require('./shopData');
const { recomputeShopClassification } = require('./classification');

// A rep's offline queue can hold: visits, orders, collections, and vehicle
// inventory counts (spec item 1). Sensitive types (item 7) — collection,
// custody_transfer, delete — are gated by a company setting rather than
// always applying the instant a batch reaches the server.
const SENSITIVE_TYPES = ['collection', 'custody_transfer', 'delete'];

function getSetting(companyId, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}

// Safer default: an offline-synced sensitive operation waits for a human
// to approve it, same "no financial/inventory change without a person
// confirming" pattern used everywhere else in this app (collections,
// custody-transfer discrepancies, return inspection).
function sensitiveOpsMode(companyId) {
  const v = getSetting(companyId, 'offline_sensitive_ops_mode', 'requires_approval');
  return ['auto_apply', 'requires_approval'].includes(v) ? v : 'requires_approval';
}

function orderVersionOf(order) {
  return order.edited_at || order.created_at;
}

// ---------------------------------------------------------------------
// Per-entity-type appliers. Each returns { serverEntityId, result } on
// success, or throws { status, message } for a validation failure, or
// returns { conflict: {...} } when an update's base_version is stale.
// ---------------------------------------------------------------------

function applyVisit(companyId, user, payload) {
  const { wavePointId, shopId, result, refusalReason, notVisitedReason, tasks, answers, voiceNoteText, signatureDataUrl, lat, lng, formTemplateId } = payload;
  let point = null;
  let shop = null;
  if (wavePointId) {
    point = db.prepare('SELECT * FROM wave_points WHERE id = ? AND company_id = ?').get(wavePointId, companyId);
    if (!point) throw Object.assign(new Error('wave_point_not_found'), { status: 400 });
    shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(point.shop_id);
  } else {
    shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(shopId, companyId);
    if (!shop) throw Object.assign(new Error('shop_not_found'), { status: 400 });
  }

  const validResults = ['order_taken', 'no_order', 'shop_closed', 'refused', 'other'];
  const finalResult = validResults.includes(result) ? result : 'other';

  const info = db
    .prepare(
      `INSERT INTO visit_records
        (company_id, wave_point_id, shop_id, rep_id, form_template_id, result, refusal_reason, not_visited_reason,
         tasks_json, answers_json, voice_note_text, signature_data_url, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      companyId,
      point ? point.id : null,
      shop.id,
      user.id,
      formTemplateId || null,
      finalResult,
      refusalReason || null,
      notVisitedReason || null,
      JSON.stringify(tasks || {}),
      JSON.stringify(answers || {}),
      voiceNoteText || null,
      signatureDataUrl || null,
      lat != null ? Number(lat) : null,
      lng != null ? Number(lng) : null
    );
  const visitRecordId = info.lastInsertRowid;

  if (point) {
    db.prepare("UPDATE wave_points SET status = 'visited', visited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(point.id);
    logPointChange(companyId, point.id, { action: 'status_change', field: 'status', before: point.status, after: 'visited', user });
  }
  checkGeofence(companyId, { rep: user, shop, lat: lat != null ? Number(lat) : null, lng: lng != null ? Number(lng) : null, visitRecordId });
  checkUnplannedVisit(companyId, { rep: user, shop, wavePointId: point?.id, visitRecordId });

  return { serverEntityId: visitRecordId, result: db.prepare('SELECT * FROM visit_records WHERE id = ?').get(visitRecordId) };
}

function applyOrderCreate(companyId, user, payload) {
  const { shopId, orderDate, items, totalValue, creditOverrideReason } = payload;
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(shopId, companyId);
  if (!shop) throw Object.assign(new Error('shop_not_found'), { status: 400 });
  const itemsList = Array.isArray(items) ? items : [];
  if (itemsList.length === 0 || itemsList.some((it) => !(Number(it.qty) > 0))) {
    throw Object.assign(new Error('items_with_positive_qty_required'), { status: 400 });
  }
  if (!(Number(totalValue) > 0)) throw Object.assign(new Error('total_value_must_be_positive'), { status: 400 });

  const creditCheck = checkCreditLimit(companyId, shop, Number(totalValue));
  if (creditCheck.exceeded && creditCheck.mode === 'blocked') {
    throw Object.assign(new Error('credit_limit_blocked'), { status: 403 });
  }
  if (creditCheck.exceeded && creditCheck.mode === 'rep_decides' && !creditOverrideReason?.trim()) {
    throw Object.assign(new Error('credit_override_reason_required'), { status: 400 });
  }
  const needsApproval = creditCheck.exceeded && creditCheck.mode === 'requires_approval';
  const initialStatus = needsApproval ? 'pending_approval' : 'approved';

  const info = db
    .prepare(
      `INSERT INTO orders (company_id, shop_id, rep_id, order_date, items_json, total_value, status, source, credit_limit_exceeded, credit_override_reason, approved_by_id, approved_by_name, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'rep_manual', ?, ?, ?, ?, ?)`
    )
    .run(
      companyId,
      shop.id,
      user.id,
      orderDate,
      JSON.stringify(itemsList),
      Number(totalValue),
      initialStatus,
      creditCheck.exceeded ? 1 : 0,
      creditCheck.exceeded ? creditOverrideReason?.trim() || null : null,
      initialStatus === 'approved' ? user.id : null,
      initialStatus === 'approved' ? user.name : null,
      initialStatus === 'approved' ? new Date().toISOString() : null
    );
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  if (initialStatus === 'pending_approval') notifyOrderPendingApproval(companyId, order, shop);
  else recomputeShopClassification(shop.id, getGlobalSettings(companyId));

  return { serverEntityId: order.id, result: { ...order, items: itemsList } };
}

function applyOrderUpdate(companyId, user, payload, baseVersion) {
  const { orderId, orderDate, items, totalValue } = payload;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL').get(orderId, companyId);
  if (!order) throw Object.assign(new Error('order_not_found'), { status: 404 });

  // The whole point of base_version: if the record moved server-side since
  // this client last saw it, never blindly overwrite — surface a conflict
  // instead (spec item 4).
  if (baseVersion && baseVersion !== orderVersionOf(order)) {
    return { conflict: { entityType: 'order', entityId: order.id, serverSnapshot: order } };
  }
  if (['delivered', 'paid', 'returned', 'cancelled'].includes(order.status)) {
    throw Object.assign(new Error('order_locked'), { status: 409 });
  }

  const itemsList = Array.isArray(items) ? items : [];
  if (itemsList.some((it) => !(Number(it.qty) > 0))) throw Object.assign(new Error('item_quantity_must_be_positive'), { status: 400 });

  const before = { order_date: order.order_date, items: JSON.parse(order.items_json), total_value: order.total_value };
  db.prepare(`UPDATE orders SET order_date = ?, items_json = ?, total_value = ?, edited_at = datetime('now') WHERE id = ?`).run(
    orderDate,
    JSON.stringify(itemsList),
    Number(totalValue),
    order.id
  );
  logOrderChange(companyId, order.id, { action: 'amend', field: 'order', before, after: { order_date: orderDate, items: itemsList, total_value: totalValue }, user });

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  return { serverEntityId: order.id, result: { ...updated, items: itemsList } };
}

function applyCollection(companyId, user, payload) {
  const { shopId, method, amount, transferReference, notes } = payload;
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, companyId);
  if (!shop) throw Object.assign(new Error('shop_not_found'), { status: 400 });
  const collection = createCollection(companyId, { shopId, method, amount, transferReference, notes }, user);
  return { serverEntityId: collection.id, result: collection };
}

// Workshop tablet (Prompt 9): material issue, output and wastage recorded
// offline. The sync idempotency key doubles as the event's client key, so a
// replay never records twice. The user needs record_production.
function applyProduction(companyId, user, entityType, payload = {}) {
  const perms = db.prepare('SELECT permission FROM user_permissions WHERE user_id = ?').all(user.id).map((r) => r.permission);
  if (!perms.includes('record_production')) throw Object.assign(new Error('forbidden'), { status: 403 });
  const O = require('./manufacturingOrders');
  const actor = { id: user.id, name: user.name };
  const key = payload.clientKey ? `sync:${payload.clientKey}` : null;
  let order;
  if (entityType === 'production_issue') order = O.issueMaterials(companyId, payload.orderId, { lines: [{ productId: payload.productId, qty: payload.qty, lotId: payload.lotId }], clientKey: key }, actor);
  else if (entityType === 'production_output') order = O.recordEvent(companyId, payload.orderId, { kind: payload.kind === 'byproduct' ? 'byproduct' : payload.kind === 'rework' ? 'rework' : 'output', qty: payload.qty, productId: payload.productId, clientKey: key, labourHours: payload.labourHours }, actor);
  else order = O.recordEvent(companyId, payload.orderId, { kind: 'wastage', qty: payload.qty, productId: payload.productId, stage: payload.stage, notes: payload.notes, clientKey: key }, actor);
  return { serverEntityId: order.id, result: { order_id: order.id, status: order.status, output_qty: order.output_qty, wastage_qty: order.wastage_qty } };
}

function applyInventoryCount(companyId, user, payload) {
  const { productId, itemName, quantity } = payload;
  if (!(Number(quantity) >= 0)) throw Object.assign(new Error('quantity_must_be_non_negative'), { status: 400 });
  const name = itemName || db.prepare('SELECT name FROM products WHERE id = ?').get(productId)?.name;
  if (!name) throw Object.assign(new Error('item_name_or_product_id_required'), { status: 400 });
  const stock = require('./stockLedger');
  const write = () => {
    const r = require('./holderStock').applyQty('car_inventory', companyId, productId || null, name, Number(quantity), { mode: 'set' });
    // Prompt 8: the counted car total becomes a 'count' move (posted).
    if (stock.isActive(companyId) && r.product_id) stock.setPooledTotal(companyId, 'car_inventory', r.product_id, Number(quantity), { moveType: 'count', reasonCode: 'offline_count', sourceType: 'offline_count', actor: user });
    return r;
  };
  const row = stock.isActive(companyId) ? require('./ledger').transaction(write) : write();
  return { serverEntityId: row.id, result: row };
}

function applyDelete(companyId, user, payload) {
  const { targetType, targetId, reason } = payload;
  if (targetType === 'order') {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL').get(targetId, companyId);
    if (!order) throw Object.assign(new Error('order_not_found'), { status: 404 });
    if (!['pending_approval', 'approved'].includes(order.status)) throw Object.assign(new Error('order_locked'), { status: 409 });
    db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ?, cancelled_at = datetime('now') WHERE id = ?").run(reason || 'ألغي عبر مزامنة offline', order.id);
    logOrderChange(companyId, order.id, { action: 'cancel', field: 'status', before: order.status, after: 'cancelled', user });
    return { serverEntityId: order.id, result: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id) };
  }
  throw Object.assign(new Error('unsupported_delete_target'), { status: 400 });
}

// ---------------------------------------------------------------------
// Dispatcher + idempotency + sensitive-op gating
// ---------------------------------------------------------------------

function applyByType(companyId, user, entityType, operation, payload, baseVersion) {
  if (entityType === 'visit') return applyVisit(companyId, user, payload);
  if (entityType === 'order' && operation === 'update') return applyOrderUpdate(companyId, user, payload, baseVersion);
  if (entityType === 'order') return applyOrderCreate(companyId, user, payload);
  if (entityType === 'collection') return applyCollection(companyId, user, payload);
  if (entityType === 'inventory_count') return applyInventoryCount(companyId, user, payload);
  if (['production_issue', 'production_output', 'production_wastage'].includes(entityType)) return applyProduction(companyId, user, entityType, payload);
  if (entityType === 'delete') return applyDelete(companyId, user, payload);
  throw Object.assign(new Error('unsupported_entity_type'), { status: 400 });
}

function recordOperation(companyId, user, op, status, { serverEntityId, result, errorMessage } = {}) {
  const info = db
    .prepare(
      `INSERT INTO sync_operations (company_id, user_id, idempotency_key, client_id, entity_type, operation, base_version, payload_json, status, server_entity_id, result_json, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      companyId,
      user.id,
      op.idempotencyKey,
      op.clientId || null,
      op.entityType,
      op.operation || 'create',
      op.baseVersion || null,
      JSON.stringify(op.payload || {}),
      status,
      serverEntityId ?? null,
      result ? JSON.stringify(result) : null,
      errorMessage || null
    );
  return db.prepare('SELECT * FROM sync_operations WHERE id = ?').get(info.lastInsertRowid);
}

// The single entry point routes/sync.js's POST /batch calls per queued
// operation. Idempotency check happens first, before anything else.
function processOperation(companyId, user, op) {
  if (!op.idempotencyKey) throw Object.assign(new Error('idempotency_key_required'), { status: 400 });

  const existing = db.prepare('SELECT * FROM sync_operations WHERE user_id = ? AND idempotency_key = ?').get(user.id, op.idempotencyKey);
  if (existing) return existing; // exact replay — never re-applied

  const entityType = op.entityType;
  const isSensitive = SENSITIVE_TYPES.includes(entityType);

  if (isSensitive && sensitiveOpsMode(companyId) === 'requires_approval') {
    return recordOperation(companyId, user, op, 'pending_approval');
  }

  try {
    const applied = applyByType(companyId, user, entityType, op.operation || 'create', op.payload, op.baseVersion);
    if (applied.conflict) {
      const savedOp = recordOperation(companyId, user, op, 'conflict');
      db.prepare(
        `INSERT INTO sync_conflicts (company_id, sync_operation_id, entity_type, entity_id, client_payload_json, server_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(companyId, savedOp.id, applied.conflict.entityType, applied.conflict.entityId, JSON.stringify(op.payload), JSON.stringify(applied.conflict.serverSnapshot));
      return db.prepare('SELECT * FROM sync_operations WHERE id = ?').get(savedOp.id);
    }
    return recordOperation(companyId, user, op, 'applied', { serverEntityId: applied.serverEntityId, result: applied.result });
  } catch (err) {
    return recordOperation(companyId, user, op, 'error', { errorMessage: err.message });
  }
}

// Applies a previously pending_approval operation now that an authorized
// user reviewed it — approve runs it through the exact same applyByType
// path a normal sync would have, reject just closes it out with no data
// change on either side.
function decidePendingOperation(companyId, syncOperationId, decision, user) {
  const op = db.prepare('SELECT * FROM sync_operations WHERE id = ? AND company_id = ?').get(syncOperationId, companyId);
  if (!op) throw Object.assign(new Error('not_found'), { status: 404 });
  if (op.status !== 'pending_approval') throw Object.assign(new Error('not_pending'), { status: 409, currentStatus: op.status });

  if (decision === 'reject') {
    db.prepare("UPDATE sync_operations SET status = 'error', error_message = 'rejected_by_reviewer' WHERE id = ?").run(op.id);
    return db.prepare('SELECT * FROM sync_operations WHERE id = ?').get(op.id);
  }

  const payload = JSON.parse(op.payload_json);
  const opUser = db.prepare('SELECT id, name FROM users WHERE id = ?').get(op.user_id);
  try {
    const applied = applyByType(companyId, opUser, op.entity_type, op.operation, payload, op.base_version);
    if (applied.conflict) {
      db.prepare("UPDATE sync_operations SET status = 'conflict' WHERE id = ?").run(op.id);
      db.prepare(
        `INSERT INTO sync_conflicts (company_id, sync_operation_id, entity_type, entity_id, client_payload_json, server_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(companyId, op.id, applied.conflict.entityType, applied.conflict.entityId, op.payload_json, JSON.stringify(applied.conflict.serverSnapshot));
    } else {
      db.prepare("UPDATE sync_operations SET status = 'applied', server_entity_id = ?, result_json = ? WHERE id = ?").run(
        applied.serverEntityId,
        JSON.stringify(applied.result),
        op.id
      );
    }
  } catch (err) {
    db.prepare("UPDATE sync_operations SET status = 'error', error_message = ? WHERE id = ?").run(err.message, op.id);
  }
  return db.prepare('SELECT * FROM sync_operations WHERE id = ?').get(op.id);
}

// Manual conflict resolution — never auto-picks a side. 'use_server' makes
// no data change (the server's current state simply stands); 'use_client'
// re-applies the client's original payload, bypassing the version check
// since a human just made the call; 'merged' applies whatever combined
// payload the reviewer submits.
function resolveConflict(companyId, conflictId, { resolution, mergedPayload, notes, user }) {
  const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE id = ? AND company_id = ?').get(conflictId, companyId);
  if (!conflict) throw Object.assign(new Error('not_found'), { status: 404 });
  if (conflict.status !== 'pending') throw Object.assign(new Error('already_resolved'), { status: 409, currentStatus: conflict.status });
  if (!['use_client', 'use_server', 'merged'].includes(resolution)) throw Object.assign(new Error('invalid_resolution'), { status: 400 });

  const op = db.prepare('SELECT * FROM sync_operations WHERE id = ?').get(conflict.sync_operation_id);

  if (resolution !== 'use_server') {
    const payload = resolution === 'merged' ? mergedPayload : JSON.parse(conflict.client_payload_json);
    if (!payload) throw Object.assign(new Error('merged_payload_required'), { status: 400 });
    const opUser = db.prepare('SELECT id, name FROM users WHERE id = ?').get(op.user_id);
    const applied = applyByType(companyId, opUser, conflict.entity_type, op.operation, payload, null); // version check bypassed — human decided
    db.prepare("UPDATE sync_operations SET status = 'applied', server_entity_id = ?, result_json = ? WHERE id = ?").run(
      applied.serverEntityId,
      JSON.stringify(applied.result),
      op.id
    );
  } else {
    db.prepare("UPDATE sync_operations SET status = 'applied', error_message = 'conflict_resolved_kept_server_version' WHERE id = ?").run(op.id);
  }

  db.prepare(
    `UPDATE sync_conflicts SET status = ?, resolved_by_id = ?, resolved_by_name = ?, resolved_at = datetime('now'), resolution_notes = ? WHERE id = ?`
  ).run(`resolved_${resolution}`, user.id, user.name, notes || null, conflict.id);

  return db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(conflict.id);
}

module.exports = {
  SENSITIVE_TYPES,
  sensitiveOpsMode,
  processOperation,
  decidePendingOperation,
  resolveConflict,
  orderVersionOf,
};
