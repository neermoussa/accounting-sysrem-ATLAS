const db = require('../db/init');
const { getAllEnrichedShops } = require('./shopData');
const { sendToManager } = require('./whatsapp');
const { createNotification, hasUnreadNotification } = require('./notify');

// Debt and overdue conditions can become true purely from time passing
// (no order/import write ever fires), so this sweep is the only thing that
// reliably catches those transitions. It only messages the manager once per
// transition into the problem state: `*_alert_active` stays 0 until a send
// succeeds, so if WhatsApp isn't connected yet the same shop is retried on
// the next sweep instead of being silently marked as handled.
//
// Runs across every company in one pass, each fully independent — one
// company's shops, settings, and WhatsApp link are never consulted while
// evaluating another's.
async function runShopAlertSweep() {
  const companyIds = db.prepare('SELECT id FROM companies').all().map((r) => r.id);

  for (const companyId of companyIds) {
    let shops;
    try {
      shops = getAllEnrichedShops(companyId);
    } catch (err) {
      console.error(`[alertSweep] failed to load shops for company ${companyId}:`, err.message);
      continue;
    }

    for (const shop of shops) {
      if (shop.isOverDebt && !shop.debt_alert_active) {
        const message =
          `⚠️ رصيد مستحق\n${shop.name}\n` +
          `الرصيد الحالي: ${shop.balance?.toLocaleString('ar')} (الحد: ${shop.debtThreshold})`;
        if (!hasUnreadNotification(companyId, 'debt', shop.id, 'shop')) {
          createNotification({
            companyId,
            type: 'debt',
            message_ar: message,
            message_en: `Balance due — ${shop.name}\nCurrent balance: ${shop.balance} (limit: ${shop.debtThreshold})`,
            link_path: `/?shop=${shop.id}`,
            entity_type: 'shop',
            entity_id: shop.id,
          });
        }
        const sent = await sendToManager(companyId, message);
        if (sent) {
          db.prepare('UPDATE shops SET debt_alert_active = 1 WHERE id = ?').run(shop.id);
        }
      } else if (!shop.isOverDebt && shop.debt_alert_active) {
        db.prepare('UPDATE shops SET debt_alert_active = 0 WHERE id = ?').run(shop.id);
      }

      if (shop.isAbnormallyOverdue && !shop.overdue_alert_active) {
        const message =
          `⚠️ تأخر غير طبيعي عن دورة الطلب\n${shop.name}\n` +
          `${shop.daysSinceOrder} يوم بدون طلب (الدورة المعتادة: ${Math.round(shop.expectedCycleDays)} يوم)`;
        if (!hasUnreadNotification(companyId, 'overdue', shop.id, 'shop')) {
          createNotification({
            companyId,
            type: 'overdue',
            message_ar: message,
            message_en: `Unusually overdue for a reorder — ${shop.name}\n${shop.daysSinceOrder} days without an order (usual cycle: ${Math.round(shop.expectedCycleDays)} days)`,
            link_path: `/?shop=${shop.id}`,
            entity_type: 'shop',
            entity_id: shop.id,
          });
        }
        const sent = await sendToManager(companyId, message);
        if (sent) {
          db.prepare('UPDATE shops SET overdue_alert_active = 1 WHERE id = ?').run(shop.id);
        }
      } else if (!shop.isAbnormallyOverdue && shop.overdue_alert_active) {
        db.prepare('UPDATE shops SET overdue_alert_active = 0 WHERE id = ?').run(shop.id);
      }
    }
  }
}

module.exports = { runShopAlertSweep };
