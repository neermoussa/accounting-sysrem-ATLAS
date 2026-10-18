const db = require('../db/init');
const { createNotification } = require('./notify');

function logOrderChange(companyId, orderId, { action, field, before, after, user }) {
  db.prepare(
    `INSERT INTO order_status_changes (company_id, order_id, action, field, before_value, after_value, changed_by_id, changed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    orderId,
    action,
    field || null,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    user?.id ?? null,
    user?.name ?? null
  );
}

function getSetting(companyId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key);
  return row?.value ?? fallback;
}

// 'rep_decides' (default): allowed, but the caller must supply a non-empty
// override reason when exceeded. 'requires_approval': allowed, but the
// resulting order is forced into pending_approval regardless of any
// auto-approve setting. 'blocked': rejected outright.
function creditLimitEnforcement(companyId) {
  const v = getSetting(companyId, 'credit_limit_enforcement', 'rep_decides');
  return ['rep_decides', 'requires_approval', 'blocked'].includes(v) ? v : 'rep_decides';
}

function repManualAutoApprove(companyId) {
  return getSetting(companyId, 'rep_manual_order_auto_approve', '0') === '1';
}

function partialDeliveryCreatesFollowup(companyId) {
  return getSetting(companyId, 'partial_delivery_creates_followup', '1') === '1';
}

function followupOrderStatus(companyId) {
  const v = getSetting(companyId, 'followup_order_status', 'pending_approval');
  return ['pending_approval', 'approved'].includes(v) ? v : 'pending_approval';
}

// Credit limit = the shop's own override if set, else the company default
// (settings.default_credit_limit). No limit configured at all means no
// check is possible — never silently blocks/flags in that case.
function getCreditLimit(companyId, shop) {
  if (shop.debt_threshold_override != null) return shop.debt_threshold_override;
  const def = getSetting(companyId, 'default_credit_limit');
  return def != null && def !== '' ? Number(def) : null;
}

function getCurrentBalance(shopId) {
  return (
    db.prepare('SELECT balance FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shopId)?.balance ?? 0
  );
}

// Checked BEFORE inserting a new order — projects the balance forward by
// this order's total to see whether it would cross the limit. Returns:
//   { exceeded: false }
//   { exceeded: true, mode: 'blocked', limit, projectedBalance }
//   { exceeded: true, mode: 'requires_approval', limit, projectedBalance }
//   { exceeded: true, mode: 'rep_decides', limit, projectedBalance } — caller
//     must then require a non-empty override reason before proceeding.
function checkCreditLimit(companyId, shop, orderTotal) {
  const limit = getCreditLimit(companyId, shop);
  if (limit == null) return { exceeded: false };
  const projectedBalance = getCurrentBalance(shop.id) + orderTotal;
  if (projectedBalance <= limit) return { exceeded: false, limit, projectedBalance };
  return { exceeded: true, mode: creditLimitEnforcement(companyId), limit, projectedBalance };
}

// Sends the customer a plain notice of the change — never a re-confirmation
// request, per the spec ("no new confirmation asked; if they object, they
// contact the company directly").
async function notifyCustomerOfChange(sendToCustomer, companyId, shop, order, changeSummary) {
  const message = `مرحبًا ${shop.name}،\nتم تعديل طلبكم بتاريخ ${order.order_date}.\n${changeSummary}\nللاستفسار يرجى التواصل معنا مباشرة.`;
  try {
    await sendToCustomer(companyId, shop, message);
  } catch {
    // best-effort, same as every other customer notification in this app
  }
}

function notifyOrderPendingApproval(companyId, order, shop) {
  createNotification({
    companyId,
    type: 'order_pending_approval',
    message_ar: `طلب جديد بانتظار الموافقة لمحل ${shop.name} بقيمة ${Math.round(order.total_value).toLocaleString('ar')}.`,
    message_en: `New order awaiting approval for ${shop.name}, value ${Math.round(order.total_value)}.`,
    link_path: `/shops/${shop.id}`,
    entity_type: 'order',
    entity_id: order.id,
  });
}

function notifyWhatsappOrderReceived(companyId, whatsappOrder, shop) {
  createNotification({
    companyId,
    type: 'whatsapp_order_received',
    message_ar: `رسالة واتساب تُشبه طلبًا من ${shop ? shop.name : whatsappOrder.from_phone} — بانتظار مراجعة المندوب.`,
    message_en: `A WhatsApp message that looks like an order from ${shop ? shop.name : whatsappOrder.from_phone} is awaiting rep review.`,
    link_path: shop ? `/shops/${shop.id}` : null,
    entity_type: 'whatsapp_order',
    entity_id: whatsappOrder.id,
  });
}

module.exports = {
  logOrderChange,
  getSetting,
  creditLimitEnforcement,
  repManualAutoApprove,
  partialDeliveryCreatesFollowup,
  followupOrderStatus,
  getCreditLimit,
  getCurrentBalance,
  checkCreditLimit,
  notifyCustomerOfChange,
  notifyOrderPendingApproval,
  notifyWhatsappOrderReceived,
};
