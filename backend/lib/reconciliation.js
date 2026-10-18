const db = require('../db/init');
const { createNotification } = require('./notify');
const { sendToManager } = require('./whatsapp');

// The daily Amin report only ever records a shop's running balance for that
// date (see `balances` — no per-invoice amount exists anywhere in that
// data). The closest real signal to "what did this shop buy today" is the
// day-over-day balance increase, so that's what confirmed invoice totals
// are checked against — not an exact per-invoice match. A small tolerance
// absorbs rounding noise without masking a real discrepancy.
const TOLERANCE = 1;

// Runs whenever either side of the comparison could have just become
// available — a rep confirming an invoice, or a manager committing that
// day's Amin report — since either can happen first. No-ops until both a
// confirmed invoice AND that date's balance import exist for the shop.
async function reconcileShopDay(shopId, date) {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
  if (!shop) return;

  const invoices = db
    .prepare(
      `SELECT i.id, i.reconciliation_status, i.reconciliation_diff, o.total_value
       FROM invoices i JOIN orders o ON o.id = i.order_id
       WHERE i.shop_id = ? AND i.invoice_date = ? AND i.order_id IS NOT NULL`
    )
    .all(shopId, date);
  if (invoices.length === 0) return;

  const balanceRows = db
    .prepare('SELECT report_date, balance FROM balances WHERE shop_id = ? AND report_date <= ? ORDER BY report_date DESC LIMIT 2')
    .all(shopId, date);
  const todayRow = balanceRows.find((b) => b.report_date === date);
  if (!todayRow) return; // that date's Amin report hasn't been imported yet

  const priorRow = balanceRows.find((b) => b.report_date !== date);
  const priorBalance = priorRow ? priorRow.balance : 0;
  const delta = Math.round((todayRow.balance - priorBalance) * 100) / 100;

  const invoicesTotal = Math.round(invoices.reduce((sum, i) => sum + (i.total_value || 0), 0) * 100) / 100;
  const diff = Math.round((delta - invoicesTotal) * 100) / 100;
  const matched = Math.abs(diff) <= TOLERANCE;
  // A shop's Amin balance can get re-imported after a correction, which
  // recomputes this diff — re-notify when that changes the picture instead
  // of only on the first-ever mismatch, otherwise the notification text
  // goes stale and keeps pointing at a diff that's no longer true.
  const previouslyFlaggedDiff = invoices.find((i) => i.reconciliation_status === 'mismatch')?.reconciliation_diff;
  const diffChanged = previouslyFlaggedDiff == null || Math.abs(previouslyFlaggedDiff - diff) > TOLERANCE;

  const status = matched ? 'matched' : 'mismatch';
  const updateStmt = db.prepare(
    `UPDATE invoices SET reconciliation_status = ?, reconciliation_diff = ?, reconciled_at = datetime('now') WHERE id = ?`
  );
  for (const inv of invoices) updateStmt.run(status, matched ? 0 : diff, inv.id);

  if (!matched && diffChanged) {
    const firstInvoiceId = invoices[0].id;
    const message =
      `⚠ شبهة خطأ بفاتورة — ${shop.name}\n` +
      `فرق الرصيد اليومي (تقرير الأمين): ${delta.toLocaleString('ar')} — مجموع الفواتير المسجّلة: ${invoicesTotal.toLocaleString('ar')} (فرق ${diff.toLocaleString('ar')})`;
    createNotification({
      companyId: shop.company_id,
      type: 'invoice_mismatch',
      message_ar: message,
      message_en:
        `Suspected invoice error — ${shop.name}\n` +
        `Daily balance delta (Amin report): ${delta} — recorded invoices total: ${invoicesTotal} (diff ${diff})`,
      link_path: `/?shop=${shopId}&invoice=${firstInvoiceId}`,
      entity_type: 'invoice',
      entity_id: firstInvoiceId,
    });
    await sendToManager(shop.company_id, message);
  }
}

module.exports = { reconcileShopDay, TOLERANCE };
