const db = require('../db/init');
const { getLatestBalance } = require('./shopData');
const { createNotification } = require('./notify');
const { isLedgerLive } = require('./customerLedger');

function logChange(companyId, requestId, itemId, { action, field, before, after, user }) {
  db.prepare(
    `INSERT INTO return_changes (company_id, return_request_id, item_id, action, field, before_value, after_value, changed_by_id, changed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    requestId,
    itemId || null,
    action,
    field || null,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    user?.id ?? null,
    user?.name ?? null
  );
}

function getSetting(companyId, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}

// Off by default: a return is never a silent, automatic financial event —
// a company has to explicitly opt in, and even then it only actually
// happens when the approving user also holds apply_return_financial_adjustment.
function autoFinancialAdjustmentEnabled(companyId) {
  return getSetting(companyId, 'return_auto_financial_adjustment', '0') === '1';
}

function getItems(returnRequestId) {
  return db.prepare('SELECT * FROM return_items WHERE return_request_id = ? ORDER BY id').all(returnRequestId);
}

function getReturn(companyId, id) {
  return db.prepare('SELECT * FROM return_requests WHERE id = ? AND company_id = ?').get(id, companyId);
}

function notifyReturnFiled(companyId, request, shop) {
  createNotification({
    companyId,
    type: 'return_request_filed',
    message_ar: `طلب مرتجع جديد من محل ${shop.name} — بانتظار الفحص والموافقة.`,
    message_en: `New return request from ${shop.name} — awaiting inspection and approval.`,
    link_path: `/shops/${shop.id}`,
    entity_type: 'return_request',
    entity_id: request.id,
  });
}

// Adds inspected_qty back into the single, existing car_inventory pool —
// same target table the custody-transfer feature writes to — only for
// items the inspector actually marked 'valid'. Never called twice for the
// same item (restocked flag guards that).
function restockValidItems(companyId, items) {
  const { applyQty } = require('./holderStock');
  for (const item of items) {
    if (item.inspection_status !== 'valid' || item.restocked || !item.product_id || !item.inspected_qty) continue;
    applyQty('car_inventory', companyId, item.product_id, item.product_name, item.inspected_qty);
    db.prepare('UPDATE return_items SET restocked = 1 WHERE id = ?').run(item.id);
  }
}

// Inserts a new balances snapshot crediting the customer for the returned
// value — this app's balance is a dated-snapshot ledger (see
// lib/import.js), not a live running total, so "adjusting the balance"
// means writing the next snapshot, same as an Amin import would.
//
// Ledger-live companies: instead of a snapshot, a credit note is posted
// (lib/salesPosting.js postReturnCredit) and the balance is derived from
// the ledger. Callers wrap that path in a transaction with the approval.
function applyFinancialAdjustment(companyId, request, items, user) {
  if (isLedgerLive(companyId)) return require('./salesPosting').postReturnCredit(companyId, request, items, user);
  const creditAmount = items
    .filter((it) => it.inspection_status === 'valid' && it.unit_value)
    .reduce((sum, it) => sum + it.unit_value * (it.inspected_qty ?? it.requested_qty), 0);
  if (creditAmount <= 0) return null;

  const latest = getLatestBalance(request.shop_id);
  const newBalance = (latest ? latest.balance : 0) - creditAmount;
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO balances (shop_id, report_date, balance, source_file)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_id, report_date) DO UPDATE SET balance = excluded.balance`
  ).run(request.shop_id, today, newBalance, `return_credit:${request.id}`);

  db.prepare('UPDATE return_requests SET financial_adjustment_applied = 1, financial_adjustment_amount = ? WHERE id = ?').run(
    creditAmount,
    request.id
  );
  return creditAmount;
}

module.exports = {
  logChange,
  getSetting,
  autoFinancialAdjustmentEnabled,
  getItems,
  getReturn,
  notifyReturnFiled,
  restockValidItems,
  applyFinancialAdjustment,
};
