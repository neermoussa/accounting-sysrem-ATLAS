const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const {
  logChange,
  getTransfer,
  getItems,
  findDuplicateItem,
  notifyRepReadyForPickup,
  notifyDiscrepancy,
  tryClose,
} = require('../lib/custodyTransfers');

const router = express.Router();
router.use(requireCompany);

const VIEW_PERMS = [
  'view_app',
  'create_custody_transfers',
  'manage_custody_transfer_items',
  'approve_custody_transfer_readiness',
  'confirm_custody_transfer_receipt',
  'resolve_transfer_discrepancy',
  'manage_replenish_requests',
];

// Enriches the raw row with display-ready fields the frontend list/detail
// views need — never computed client-side so a rename/relabel never has to
// touch more than one place.
function withItems(transfer) {
  const warehouse = transfer.warehouse_id
    ? db.prepare('SELECT name, branch FROM warehouses WHERE id = ?').get(transfer.warehouse_id)
    : null;
  const vehicle = transfer.vehicle_id ? db.prepare('SELECT label FROM vehicles WHERE id = ?').get(transfer.vehicle_id) : null;
  const rep = transfer.rep_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(transfer.rep_id) : null;
  const destinationParts = [vehicle?.label, rep?.name].filter(Boolean);
  return {
    ...transfer,
    items: getItems(transfer.id),
    warehouse_name: warehouse ? (warehouse.branch ? `${warehouse.name} — ${warehouse.branch}` : warehouse.name) : null,
    destination_label: destinationParts.length ? destinationParts.join(' / ') : null,
  };
}

// An item's prepared/received quantity is locked the moment the transfer's
// readiness is approved (readied_at set) — from then on only someone who
// holds approve_custody_transfer_readiness (the same permission that set
// the lock) can override it, and every override still runs through the
// normal logChange audit trail like any other item edit.
function itemsLocked(transfer, user) {
  return !!transfer.readied_at && !user.permissions?.includes('approve_custody_transfer_readiness');
}

// ---------------------------------------------------------------------
// Create / list / detail
// ---------------------------------------------------------------------

router.get('/', requireAnyPermission(...VIEW_PERMS), (req, res) => {
  const { status, repId } = req.query;
  let sql = 'SELECT * FROM custody_transfers WHERE company_id = ?';
  const params = [req.companyId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (repId) {
    sql += ' AND rep_id = ?';
    params.push(repId);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params).map(withItems));
});

router.get('/:id', requireAnyPermission(...VIEW_PERMS), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  res.json(withItems(transfer));
});

router.get('/:id/changes', requireAnyPermission(...VIEW_PERMS), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM custody_transfer_changes WHERE transfer_id = ? ORDER BY changed_at DESC').all(transfer.id));
});

router.post('/', requirePermission('create_custody_transfers'), (req, res) => {
  const { warehouseId, vehicleId, repId, notes } = req.body || {};
  const info = db
    .prepare(
      `INSERT INTO custody_transfers (company_id, warehouse_id, vehicle_id, rep_id, notes, prepared_by_id, prepared_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, warehouseId || null, vehicleId || null, repId || null, notes || null, req.user.id, req.user.name);
  const transfer = db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(info.lastInsertRowid);
  logChange(req.companyId, transfer.id, null, { action: 'create', user: req.user });
  res.status(201).json(withItems(transfer));
});

// Convenience: pre-fill a transfer straight from an approved
// warehouse-replenish request (routes/production.js) so the warehouse
// keeper doesn't have to re-type what the automatic stock check already
// worked out.
router.post('/from-replenish-request/:requestId', requirePermission('create_custody_transfers'), (req, res) => {
  const request = db.prepare('SELECT * FROM warehouse_replenish_requests WHERE id = ? AND company_id = ?').get(req.params.requestId, req.companyId);
  if (!request) return res.status(404).json({ error: 'replenish_request_not_found' });

  const info = db
    .prepare(
      `INSERT INTO custody_transfers (company_id, rep_id, source_replenish_request_id, status, prepared_by_id, prepared_by_name)
       VALUES (?, ?, ?, 'loading', ?, ?)`
    )
    .run(req.companyId, request.rep_id, request.id, req.user.id, req.user.name);
  const transferId = info.lastInsertRowid;
  db.prepare(
    'INSERT INTO custody_transfer_items (company_id, transfer_id, product_id, product_name, unit_key, prepared_qty) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.companyId, transferId, request.product_id, request.product_name, request.unit_key, request.requested_qty);

  const transfer = db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(transferId);
  logChange(req.companyId, transfer.id, null, { action: 'create_from_replenish_request', field: 'source_replenish_request_id', after: request.id, user: req.user });
  res.status(201).json(withItems(transfer));
});

// ---------------------------------------------------------------------
// Loading stage: warehouse keeper adds/adjusts items on the pallet.
// A transfer still in 'pending_preparation' silently graduates to
// 'loading' on its first item — there's no separate "start loading"
// button to click, the state just reflects what actually happened.
// ---------------------------------------------------------------------

router.post('/:id/items', requirePermission('manage_custody_transfer_items'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (!['pending_preparation', 'loading'].includes(transfer.status)) {
    return res.status(409).json({ error: 'transfer_not_open_for_items', currentStatus: transfer.status });
  }
  if (itemsLocked(transfer, req.user)) return res.status(409).json({ error: 'transfer_items_locked' });
  const { productId, productName, unitKey, preparedQty } = req.body || {};
  if (!productName?.trim() || !(Number(preparedQty) > 0)) return res.status(400).json({ error: 'productName_and_preparedQty_required' });

  if (transfer.status === 'pending_preparation') {
    db.prepare("UPDATE custody_transfers SET status = 'loading', updated_at = datetime('now') WHERE id = ?").run(transfer.id);
    logChange(req.companyId, transfer.id, null, { action: 'start_loading', field: 'status', before: 'pending_preparation', after: 'loading', user: req.user });
  }

  const duplicate = findDuplicateItem(transfer.id, { productId: productId || null, productName: productName.trim() });
  if (duplicate) {
    const merged = duplicate.prepared_qty + Number(preparedQty);
    db.prepare("UPDATE custody_transfer_items SET prepared_qty = ?, updated_at = datetime('now') WHERE id = ?").run(merged, duplicate.id);
    logChange(req.companyId, transfer.id, duplicate.id, { action: 'merge_item', field: 'prepared_qty', before: duplicate.prepared_qty, after: merged, user: req.user });
    return res.status(200).json(db.prepare('SELECT * FROM custody_transfer_items WHERE id = ?').get(duplicate.id));
  }

  const info = db
    .prepare('INSERT INTO custody_transfer_items (company_id, transfer_id, product_id, product_name, unit_key, prepared_qty) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, transfer.id, productId || null, productName.trim(), unitKey || null, Number(preparedQty));
  logChange(req.companyId, transfer.id, info.lastInsertRowid, { action: 'add_item', field: 'prepared_qty', after: Number(preparedQty), user: req.user });
  res.status(201).json(db.prepare('SELECT * FROM custody_transfer_items WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id/items/:itemId', requirePermission('manage_custody_transfer_items'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (!['pending_preparation', 'loading'].includes(transfer.status)) {
    return res.status(409).json({ error: 'transfer_not_open_for_items', currentStatus: transfer.status });
  }
  if (itemsLocked(transfer, req.user)) return res.status(409).json({ error: 'transfer_items_locked' });
  const item = db.prepare('SELECT * FROM custody_transfer_items WHERE id = ? AND transfer_id = ?').get(req.params.itemId, transfer.id);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  const { preparedQty } = req.body || {};
  if (!(Number(preparedQty) > 0)) return res.status(400).json({ error: 'preparedQty_must_be_positive' });
  db.prepare("UPDATE custody_transfer_items SET prepared_qty = ?, updated_at = datetime('now') WHERE id = ?").run(Number(preparedQty), item.id);
  logChange(req.companyId, transfer.id, item.id, {
    action: transfer.readied_at ? 'edit_item_override' : 'edit_item',
    field: 'prepared_qty',
    before: item.prepared_qty,
    after: Number(preparedQty),
    user: req.user,
  });
  res.json(db.prepare('SELECT * FROM custody_transfer_items WHERE id = ?').get(item.id));
});

router.delete('/:id/items/:itemId', requirePermission('manage_custody_transfer_items'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (!['pending_preparation', 'loading'].includes(transfer.status)) {
    return res.status(409).json({ error: 'transfer_not_open_for_items', currentStatus: transfer.status });
  }
  if (itemsLocked(transfer, req.user)) return res.status(409).json({ error: 'transfer_items_locked' });
  const item = db.prepare('SELECT * FROM custody_transfer_items WHERE id = ? AND transfer_id = ?').get(req.params.itemId, transfer.id);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  db.prepare('DELETE FROM custody_transfer_items WHERE id = ?').run(item.id);
  logChange(req.companyId, transfer.id, null, { action: 'remove_item', field: 'product_name', before: item.product_name, user: req.user });
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Readiness approval: locks item quantities (see itemsLocked above) and
// notifies the rep the pallet is ready to pick up. Distinct from
// confirm-receipt below — this is the warehouse side signing off, not the
// rep's own confirmation.
// ---------------------------------------------------------------------

router.post('/:id/ready', requirePermission('approve_custody_transfer_readiness'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (transfer.status !== 'loading') return res.status(409).json({ error: 'transfer_not_loading', currentStatus: transfer.status });
  if (getItems(transfer.id).length === 0) return res.status(409).json({ error: 'no_items_to_ready' });
  if (transfer.readied_at) return res.status(409).json({ error: 'already_readied' });

  db.prepare(
    "UPDATE custody_transfers SET readied_at = datetime('now'), readied_by_id = ?, readied_by_name = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(req.user.id, req.user.name, transfer.id);
  logChange(req.companyId, transfer.id, null, { action: 'approve_readiness', field: 'readied_at', after: true, user: req.user });
  const updated = db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(transfer.id);
  notifyRepReadyForPickup(req.companyId, updated);
  res.json(withItems(updated));
});

// ---------------------------------------------------------------------
// Rep confirms what was actually received — only once the pallet has
// been marked ready, never before.
// ---------------------------------------------------------------------

router.post('/:id/confirm-receipt', requirePermission('confirm_custody_transfer_receipt'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (transfer.status !== 'loading') return res.status(409).json({ error: 'transfer_not_loading', currentStatus: transfer.status });
  if (!transfer.readied_at) return res.status(409).json({ error: 'transfer_not_ready_yet' });
  if (transfer.confirmed_at) return res.status(409).json({ error: 'already_confirmed' });
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items_required' });

  const existingItems = getItems(transfer.id);
  const mismatched = [];
  for (const submitted of items) {
    const item = existingItems.find((it) => it.id === submitted.itemId);
    if (!item) continue;
    const receivedQty = Number(submitted.receivedQty);
    const variance = receivedQty - item.prepared_qty;
    db.prepare("UPDATE custody_transfer_items SET received_qty = ?, variance_qty = ?, updated_at = datetime('now') WHERE id = ?").run(
      receivedQty,
      variance,
      item.id
    );
    logChange(req.companyId, transfer.id, item.id, { action: 'confirm_receipt', field: 'received_qty', before: item.prepared_qty, after: receivedQty, user: req.user });
    if (Math.abs(variance) > 0.0001) mismatched.push({ ...item, received_qty: receivedQty, variance_qty: variance });
  }

  // confirmed_at is set exactly once, right here, and every route above
  // that could re-enter this handler (transfer_not_loading /
  // already_confirmed) is checked before this line runs — that's what
  // makes tryClose's single car_inventory update safe against a page
  // reopen or a double click on the confirm button.
  db.prepare("UPDATE custody_transfers SET confirmed_by_id = ?, confirmed_by_name = ?, confirmed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(
    req.user.id,
    req.user.name,
    transfer.id
  );

  if (mismatched.length > 0) {
    db.prepare("UPDATE custody_transfers SET status = 'discrepancy' WHERE id = ?").run(transfer.id);
    logChange(req.companyId, transfer.id, null, { action: 'flag_discrepancy', field: 'status', before: 'loading', after: 'discrepancy', user: req.user });
    notifyDiscrepancy(req.companyId, transfer, mismatched);
    return res.json({ ...withItems(db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(transfer.id)), mismatched });
  }

  let closed;
  try {
    closed = tryClose(req.companyId, transfer.id, req.user);
  } catch (err) {
    if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message, closeRetry: `/api/custody-transfers/${transfer.id}/close` });
    throw err;
  }
  res.json(withItems(closed));
});

// ---------------------------------------------------------------------
// Discrepancy resolution — mandatory reason + note, authorized user only
// ---------------------------------------------------------------------

router.put('/:id/items/:itemId/resolve-discrepancy', requirePermission('resolve_transfer_discrepancy'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (transfer.status !== 'discrepancy') return res.status(409).json({ error: 'transfer_not_in_discrepancy', currentStatus: transfer.status });
  const item = db.prepare('SELECT * FROM custody_transfer_items WHERE id = ? AND transfer_id = ?').get(req.params.itemId, transfer.id);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  if (Math.abs(item.variance_qty || 0) < 0.0001) return res.status(409).json({ error: 'item_has_no_discrepancy' });

  const { reason, note, correctedQty } = req.body || {};
  if (!reason?.trim() || !note?.trim()) return res.status(400).json({ error: 'reason_and_note_required' });

  const finalReceivedQty = correctedQty != null ? Number(correctedQty) : item.received_qty;
  const finalVariance = finalReceivedQty - item.prepared_qty;

  db.prepare(
    `UPDATE custody_transfer_items SET received_qty = ?, variance_qty = ?, discrepancy_reason = ?, discrepancy_note = ?,
     discrepancy_resolved_by_id = ?, discrepancy_resolved_by_name = ?, discrepancy_resolved_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(finalReceivedQty, finalVariance, reason.trim(), note.trim(), req.user.id, req.user.name, item.id);
  logChange(req.companyId, transfer.id, item.id, {
    action: 'resolve_discrepancy',
    field: 'discrepancy_reason',
    before: { received_qty: item.received_qty, variance: item.variance_qty },
    after: { received_qty: finalReceivedQty, variance: finalVariance, reason: reason.trim(), note: note.trim() },
    user: req.user,
  });

  let closed;
  try {
    closed = tryClose(req.companyId, transfer.id, req.user);
  } catch (err) {
    if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message, closeRetry: `/api/custody-transfers/${transfer.id}/close` });
    throw err;
  }
  const updatedItem = db.prepare('SELECT * FROM custody_transfer_items WHERE id = ?').get(item.id);
  res.json({ item: updatedItem, transfer: closed ? withItems(closed) : withItems(db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(transfer.id)) });
});

// Stock ledger: retry closing a confirmed transfer whose stock move was
// refused (e.g. not enough in the source warehouse at the time).
router.post('/:id/close', requirePermission('resolve_transfer_discrepancy'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (transfer.status === 'closed') return res.status(409).json({ error: 'already_closed' });
  if (!transfer.confirmed_at) return res.status(409).json({ error: 'not_confirmed' });
  try {
    const closed = tryClose(req.companyId, transfer.id, req.user);
    if (!closed) return res.status(409).json({ error: 'items_not_settled' });
    return res.json(withItems(closed));
  } catch (err) {
    if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
});

router.post('/:id/cancel', requirePermission('create_custody_transfers'), (req, res) => {
  const transfer = getTransfer(req.companyId, req.params.id);
  if (!transfer) return res.status(404).json({ error: 'not_found' });
  if (transfer.status === 'closed') return res.status(409).json({ error: 'already_closed' });
  db.prepare("UPDATE custody_transfers SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(transfer.id);
  logChange(req.companyId, transfer.id, null, { action: 'cancel', field: 'status', before: transfer.status, after: 'cancelled', user: req.user });
  res.json(withItems(db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(transfer.id)));
});

module.exports = router;
