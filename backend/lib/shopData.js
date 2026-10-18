const db = require('../db/init');
const { computeShopStatus, computeOrderStats } = require('./status');
const { computePaymentOverdueStatus, mergeWorstColor } = require('./collections');

// Every setting is per-company (see db/init.js) — there is no such thing as
// a "global" setting anymore, so `companyId` is required, not optional.
function getGlobalSettings(companyId) {
  if (!companyId) throw new Error('getGlobalSettings requires a companyId');
  const rows = db.prepare('SELECT key, value FROM settings WHERE company_id = ?').all(companyId);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

function getLatestBalance(shopId) {
  return db
    .prepare('SELECT * FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1')
    .get(shopId);
}

function getOrderDates(shopId) {
  return db
    .prepare('SELECT order_date FROM orders WHERE shop_id = ? AND deleted_at IS NULL ORDER BY order_date ASC')
    .all(shopId)
    .map((r) => r.order_date);
}

function enrichShop(shop, globalSettings) {
  const latestBalance = getLatestBalance(shop.id);
  const orderStats = computeOrderStats(getOrderDates(shop.id));
  const statusInfo = computeShopStatus(shop, latestBalance, orderStats, globalSettings);

  // Payment-overdue is a second, independent, opt-in signal into the same
  // red/yellow/green concept — it can only ever push the color to worse
  // than what the existing debt/order-cycle check already computed, never
  // better, and only ever runs when the company has turned it on.
  const paymentOverdue = computePaymentOverdueStatus(shop.company_id, shop, globalSettings);
  const finalStatus = mergeWorstColor(statusInfo.status, paymentOverdue);

  return {
    ...shop,
    balance: latestBalance ? latestBalance.balance : null,
    balance_date: latestBalance ? latestBalance.report_date : null,
    ...statusInfo,
    status: finalStatus,
    ...(paymentOverdue ? { isPaymentOverdue: paymentOverdue.isPaymentOverdue, daysSincePayment: paymentOverdue.daysSincePayment, paymentOverdueDays: paymentOverdue.paymentOverdueDays } : {}),
  };
}

function getAllEnrichedShops(companyId, { includeInactive = false } = {}) {
  if (!companyId) throw new Error('getAllEnrichedShops requires a companyId');
  const globalSettings = getGlobalSettings(companyId);
  const shops = includeInactive
    ? db.prepare('SELECT * FROM shops WHERE company_id = ? ORDER BY name COLLATE NOCASE').all(companyId)
    : db.prepare('SELECT * FROM shops WHERE company_id = ? AND active = 1 ORDER BY name COLLATE NOCASE').all(companyId);
  return shops.map((s) => enrichShop(s, globalSettings));
}

// classification: 'A' | 'B' | 'C' | 'unclassified' | falsy (no filter)
function filterByClassification(shops, classification) {
  if (!classification) return shops;
  if (classification === 'unclassified') return shops.filter((s) => !s.classification);
  return shops.filter((s) => s.classification === classification);
}

module.exports = {
  getGlobalSettings,
  getLatestBalance,
  getOrderDates,
  enrichShop,
  getAllEnrichedShops,
  filterByClassification,
};
