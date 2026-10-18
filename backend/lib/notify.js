const db = require('../db/init');

// Single insertion point for every notification-center row — every alert
// source (inventory, shop debt/overdue sweep, Amin import, invoices) calls
// this instead of writing to the table directly, so the shape stays
// consistent and read/unread has one definition.
function createNotification({ companyId, type, message_ar, message_en, link_path = null, entity_type = null, entity_id = null }) {
  if (!companyId) throw new Error('createNotification requires companyId');
  db.prepare(
    `INSERT INTO notifications (company_id, type, message_ar, message_en, link_path, entity_type, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, type, message_ar, message_en, link_path, entity_type, entity_id);
}

// Guards continuously-true conditions re-checked on a timer (the debt/overdue
// sweep runs every 15 minutes regardless of whether WhatsApp delivery ever
// succeeds) from flooding the bell with a fresh row every cycle — at most one
// unread notification per (type, entity) stays outstanding at a time. Once
// it's read, the condition re-notifies on the next cycle if still true,
// which is a reminder, not a duplicate.
// entityType matters here, not just entityId — car_inventory and
// factory_inventory are separate tables with independent autoincrement ids,
// so id 5 in one is unrelated to id 5 in the other.
function hasUnreadNotification(companyId, type, entityId, entityType = null) {
  return !!db
    .prepare(
      'SELECT 1 FROM notifications WHERE company_id = ? AND type = ? AND entity_id = ? AND entity_type IS ? AND read_at IS NULL LIMIT 1'
    )
    .get(companyId, type, entityId, entityType);
}

module.exports = { createNotification, hasUnreadNotification };
