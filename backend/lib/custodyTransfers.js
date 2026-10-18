const db = require('../db/init');
const { createNotification } = require('./notify');

function logChange(companyId, transferId, itemId, { action, field, before, after, user }) {
  db.prepare(
    `INSERT INTO custody_transfer_changes (company_id, transfer_id, item_id, action, field, before_value, after_value, changed_by_id, changed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    transferId,
    itemId || null,
    action,
    field || null,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    user?.id ?? null,
    user?.name ?? null
  );
}

function getTransfer(companyId, transferId) {
  return db.prepare('SELECT * FROM custody_transfers WHERE id = ? AND company_id = ?').get(transferId, companyId);
}

function getItems(transferId) {
  return db.prepare('SELECT * FROM custody_transfer_items WHERE transfer_id = ? ORDER BY id').all(transferId);
}

// Same product on the same still-open transfer is never a second row —
// matched by product_id when the item is catalog-backed, otherwise by a
// case-insensitive trim of the free-text name — the existing row's
// prepared_qty is just topped up instead ("دمج تلقائي" per spec).
function findDuplicateItem(transferId, { productId, productName }) {
  const items = getItems(transferId);
  if (productId) return items.find((it) => it.product_id === productId) || null;
  const normalized = productName.trim().toLowerCase();
  return items.find((it) => !it.product_id && it.product_name.trim().toLowerCase() === normalized) || null;
}

function notifyRepReadyForPickup(companyId, transfer) {
  if (!transfer.rep_id) return;
  createNotification({
    companyId,
    type: 'custody_transfer_ready',
    message_ar: `مناقلة #${transfer.id} جاهزة على الطبلية — يرجى المرور بالمستودع لاستلامها وتأكيد الكميات.`,
    message_en: `Transfer #${transfer.id} is staged and ready — pick up at the warehouse and confirm quantities.`,
    link_path: `/custody-transfers`,
    entity_type: 'custody_transfer',
    entity_id: transfer.id,
  });
}

function notifyDiscrepancy(companyId, transfer, mismatchedItems) {
  const summary = mismatchedItems.map((it) => `${it.product_name} (سُلِّم ${it.prepared_qty} / استُلم ${it.received_qty})`).join('، ');
  createNotification({
    companyId,
    type: 'custody_transfer_discrepancy',
    message_ar: `فرق بمناقلة #${transfer.id}: ${summary}. بانتظار سبب وملاحظة من مستخدم مخوّل قبل الإغلاق.`,
    message_en: `Discrepancy on transfer #${transfer.id}: ${summary}. Awaiting an authorized reason/note before it can close.`,
    link_path: `/custody-transfers`,
    entity_type: 'custody_transfer',
    entity_id: transfer.id,
  });
}

// Applies every item's final quantity (received_qty, or the corrected
// value from a resolved discrepancy) onto the single, existing
// company-wide car_inventory pool — the app's established car-stock
// model; this transfer's vehicle_id/rep_id remain the accountability
// record of who it was for, not a separate per-holder ledger.
function applyToCarInventory(companyId, items) {
  const { applyQty } = require('./holderStock');
  for (const item of items) {
    if (!item.product_id) continue; // can't be matched into the catalog-backed inventory table
    applyQty('car_inventory', companyId, item.product_id, item.product_name, item.received_qty);
  }
}

// Closes the transfer once every item either matched exactly or had its
// discrepancy resolved — never partially. Returns the closed transfer.
function tryClose(companyId, transferId, user) {
  const items = getItems(transferId);
  const allSettled = items.every((it) => it.received_qty != null && (it.variance_qty === 0 || it.discrepancy_resolved_at));
  if (!allSettled) return null;

  const stock = require('./stockLedger');
  if (!stock.isActive(companyId)) {
    applyToCarInventory(companyId, items);
    db.prepare("UPDATE custody_transfers SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(transferId);
    logChange(companyId, transferId, null, { action: 'close', field: 'status', before: 'discrepancy_or_loading', after: 'closed', user });
    return db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(transferId);
  }
  // Stock ledger (Prompt 8): the received quantities MOVE from the source
  // warehouse to the vehicle (or the rep, or the car pool) at cost — the
  // factory stock goes down, the car stock up — and one entry moves their
  // value from `inventory` to `inventory_custody`, all with the close.
  const transfer = getTransfer(companyId, transferId);
  return require('./ledger').transaction(() => {
    const from = stock.warehouseHolder(companyId, transfer.warehouse_id);
    const to = transfer.vehicle_id ? stock.vehicleHolder(companyId, transfer.vehicle_id) : stock.custodyHolderForRep(companyId, transfer.rep_id);
    const lines = [];
    const moveIds = [];
    for (const it of items) {
      if (!it.product_id || !(it.received_qty > 0)) continue;
      const qty = stock.baseQty(it.product_id, it.received_qty, it.unit_key);
      const t = stock.moveTransfer(companyId, { productId: it.product_id, fromHolderId: from.id, toHolderId: to.id, qty, sourceType: 'custody_transfer', sourceId: transferId, groupKey: `custody_transfer:${transferId}`, actor: user });
      moveIds.push(...(t.moveIds || [t.outMoveId, t.inMoveId]));
      lines.push({ accountId: stock.holderAccount(companyId, to), amount: t.value, memo: it.product_name }, { accountId: stock.holderAccount(companyId, from), amount: -t.value, memo: it.product_name });
    }
    stock.post(companyId, { description: `مناقلة عهدة #${transferId}: ${from.name} ← ${to.name}`, lines, moveIds }, user);
    require('./faultInjection').checkpoint('stock.custody_transfer.after_entry');
    db.prepare("UPDATE custody_transfers SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(transferId);
    logChange(companyId, transferId, null, { action: 'close', field: 'status', before: 'discrepancy_or_loading', after: 'closed', user });
    return db.prepare('SELECT * FROM custody_transfers WHERE id = ?').get(transferId);
  });
}

module.exports = {
  logChange,
  getTransfer,
  getItems,
  findDuplicateItem,
  notifyRepReadyForPickup,
  notifyDiscrepancy,
  applyToCarInventory,
  tryClose,
};
