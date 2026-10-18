const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireAllPermissions, requireCompany } = require('../middleware/auth');
const { sendToCustomer } = require('../lib/whatsapp');
const { createCollection, confirmCollection, rejectCollection, reverseCollection, getCollection, logChange, getSetting } = require('../lib/collections');
const { resolveScopeWithElevation, canAccessRepOwnedRecord, COLLECTIONS_ELEVATED_PERMISSIONS } = require('../lib/repAccess');

const router = express.Router();
router.use(requireCompany);

// ---------------------------------------------------------------------
// Record / list / detail
// ---------------------------------------------------------------------

router.post('/', requirePermission('record_collections'), (req, res) => {
  const { shopId, method, amount, transferReference, notes, currencyCode } = req.body || {};
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  if (!shop) return res.status(400).json({ error: 'shop_not_found' });
  try {
    const collection = createCollection(req.companyId, { shopId, method, amount, transferReference, notes, ...(currencyCode ? { currencyCode } : {}) }, req.user);
    res.status(201).json(collection);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', ...(err.detail ? { message: err.detail } : {}) });
  }
});

router.get('/', requireAnyPermission('view_app', 'record_collections', 'confirm_collections', 'view_statistics'), (req, res) => {
  const { status, shopId, repId, method } = req.query;
  // Same class of leak as orders/day-plan: 'view_app' alone is held by
  // every rep, so without this guard a plain rep could list every other
  // rep's collections company-wide by omitting/forging repId. Elevated
  // signal here is confirm_collections (not manage_waves) — see
  // lib/repAccess.js's COLLECTIONS_ELEVATED_PERMISSIONS: someone who can
  // confirm collections is inherently supervising/auditing them
  // company-wide, the same reasoning applied to approve_orders for Orders.
  const scope = resolveScopeWithElevation(req, repId ?? null, COLLECTIONS_ELEVATED_PERMISSIONS);
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  let sql = 'SELECT * FROM collections WHERE company_id = ?';
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
  if (method) {
    sql += ' AND method = ?';
    params.push(method);
  }
  sql += ' ORDER BY collected_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Must stay ahead of GET /:id — otherwise Express would match "reminders"
// as :id.
router.get('/reminders', requireAnyPermission('send_payment_reminders', 'view_app'), (req, res) => {
  const status = req.query.status || 'pending_review';
  res.json(db.prepare('SELECT * FROM payment_reminders WHERE company_id = ? AND status = ? ORDER BY created_at DESC').all(req.companyId, status));
});

router.get('/:id', requireAnyPermission('view_app', 'record_collections', 'confirm_collections'), (req, res) => {
  const collection = getCollection(req.companyId, req.params.id);
  if (!collection) return res.status(404).json({ error: 'not_found' });
  if (!canAccessRepOwnedRecord(req, collection.rep_id, COLLECTIONS_ELEVATED_PERMISSIONS)) return res.status(403).json({ error: 'forbidden' });
  res.json(collection);
});

router.get('/:id/changes', requireAnyPermission('view_app', 'confirm_collections'), (req, res) => {
  const collection = getCollection(req.companyId, req.params.id);
  if (!collection) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM collection_changes WHERE collection_id = ? ORDER BY changed_at DESC').all(collection.id));
});

// ---------------------------------------------------------------------
// Confirmation (accountant confirms cash) / verification (transfer) —
// same action, same permission, the only difference is what the status
// was called going in. This is the only point the balance moves.
// ---------------------------------------------------------------------

router.post('/:id/confirm', requirePermission('confirm_collections'), (req, res) => {
  try {
    const { exchangeRate, rateQuote } = req.body || {};
    const collection = confirmCollection(req.companyId, req.params.id, req.user, { exchangeRate, rateQuote });
    res.json(collection);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', currentStatus: err.currentStatus, ...(err.detail ? { message: err.detail } : {}) });
  }
});

// Reversal of a confirmed collection (ledger-live companies): the only way
// its journal entry can be reversed. Needs confirm_collections AND
// reverse_journal_entries.
router.post('/:id/reverse', requireAllPermissions('confirm_collections', 'reverse_journal_entries'), (req, res) => {
  try {
    res.json(reverseCollection(req.companyId, req.params.id, { reason: req.body?.reason, date: req.body?.date }, req.user));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', currentStatus: err.currentStatus, message: err.detail });
  }
});

router.post('/:id/reject', requirePermission('confirm_collections'), (req, res) => {
  try {
    const collection = rejectCollection(req.companyId, req.params.id, req.body?.reason, req.user);
    res.json(collection);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', currentStatus: err.currentStatus });
  }
});

// ---------------------------------------------------------------------
// Statement: whole-balance based, not per-invoice — the shop's current
// balance plus its full collections history is the entire "account
// statement" this app has (see lib/shopData.js's enrichShop for the
// balance itself).
// ---------------------------------------------------------------------

router.get('/statement/:shopId', requireAnyPermission('view_app', 'view_statistics'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const latestBalance = db.prepare('SELECT * FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shop.id);
  const collections = db.prepare('SELECT * FROM collections WHERE shop_id = ? ORDER BY collected_at DESC').all(shop.id);
  const outstanding = latestBalance ? latestBalance.balance : 0;
  res.json({
    shopId: shop.id,
    currentBalance: outstanding,
    balanceDate: latestBalance?.report_date ?? null,
    collections,
    pendingCollections: collections.filter((c) => c.status === 'pending_accountant_confirmation' || c.status === 'pending_verification'),
    confirmedTotal: collections.filter((c) => c.status === 'confirmed').reduce((sum, c) => sum + c.amount, 0),
  });
});

// ---------------------------------------------------------------------
// Reports (item 7): expected/collected/remaining/pending/discrepancies
// ---------------------------------------------------------------------

router.get('/report/summary', requireAnyPermission('view_statistics', 'confirm_collections'), (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM collections WHERE company_id = ?';
  const params = [req.companyId];
  if (from) {
    sql += ' AND collected_at >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND collected_at <= ?';
    params.push(`${to} 23:59:59`);
  }
  const rows = db.prepare(sql).all(...params);

  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const pending = rows.filter((r) => r.status === 'pending_accountant_confirmation' || r.status === 'pending_verification');
  const rejected = rows.filter((r) => r.status === 'rejected');

  const outstandingBalances = db
    .prepare(
      `SELECT s.id AS shop_id, s.name, b.balance FROM shops s
       LEFT JOIN (SELECT shop_id, balance, report_date FROM balances b1
                  WHERE report_date = (SELECT MAX(report_date) FROM balances b2 WHERE b2.shop_id = b1.shop_id)) b ON b.shop_id = s.id
       WHERE s.company_id = ? AND s.active = 1`
    )
    .all(req.companyId);
  const expectedTotal = outstandingBalances.reduce((sum, r) => sum + (r.balance > 0 ? r.balance : 0), 0);

  res.json({
    expectedTotal,
    collectedTotal: confirmed.reduce((sum, r) => sum + r.amount, 0),
    remainingTotal: expectedTotal - confirmed.reduce((sum, r) => sum + r.amount, 0),
    pendingTotal: pending.reduce((sum, r) => sum + r.amount, 0),
    pendingCount: pending.length,
    discrepancyTotal: rejected.reduce((sum, r) => sum + r.amount, 0),
    discrepancyCount: rejected.length,
    byMethod: {
      cash: confirmed.filter((r) => r.method === 'cash').reduce((sum, r) => sum + r.amount, 0),
      transfer: confirmed.filter((r) => r.method === 'transfer').reduce((sum, r) => sum + r.amount, 0),
    },
    outstandingBalances: outstandingBalances.filter((r) => r.balance > 0),
  });
});

// ---------------------------------------------------------------------
// Payment reminders (item 8) — suggested only, an employee must review
// and explicitly send or dismiss each one. (GET /reminders itself is
// defined earlier, ahead of GET /:id.)
// ---------------------------------------------------------------------

router.post('/reminders/:id/send', requirePermission('send_payment_reminders'), async (req, res) => {
  const reminder = db.prepare('SELECT * FROM payment_reminders WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!reminder) return res.status(404).json({ error: 'not_found' });
  if (reminder.status !== 'pending_review') return res.status(409).json({ error: 'already_reviewed', currentStatus: reminder.status });
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(reminder.shop_id);
  const message = req.body?.message?.trim() || reminder.suggested_message;
  const sent = await sendToCustomer(req.companyId, shop, message);
  db.prepare(
    "UPDATE payment_reminders SET status = 'sent', reviewed_by_id = ?, reviewed_by_name = ?, reviewed_at = datetime('now') WHERE id = ?"
  ).run(req.user.id, req.user.name, reminder.id);
  res.json({ ...db.prepare('SELECT * FROM payment_reminders WHERE id = ?').get(reminder.id), sent });
});

router.post('/reminders/:id/dismiss', requirePermission('send_payment_reminders'), (req, res) => {
  const reminder = db.prepare('SELECT * FROM payment_reminders WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!reminder) return res.status(404).json({ error: 'not_found' });
  if (reminder.status !== 'pending_review') return res.status(409).json({ error: 'already_reviewed', currentStatus: reminder.status });
  db.prepare(
    "UPDATE payment_reminders SET status = 'dismissed', reviewed_by_id = ?, reviewed_by_name = ?, reviewed_at = datetime('now') WHERE id = ?"
  ).run(req.user.id, req.user.name, reminder.id);
  res.json(db.prepare('SELECT * FROM payment_reminders WHERE id = ?').get(reminder.id));
});

// ---------------------------------------------------------------------
// Company settings: color thresholds, overdue policy, statement-on-collect
// ---------------------------------------------------------------------

router.get('/settings/collections', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  res.json({
    creditLimitColorEnabled: getSetting(req.companyId, 'credit_limit_color_enabled', '1') === '1',
    paymentOverdueColorEnabled: getSetting(req.companyId, 'payment_overdue_color_enabled', '0') === '1',
    paymentOverdueDays: Number(getSetting(req.companyId, 'payment_overdue_days', '30')),
    overdueNewOrderPolicy: getSetting(req.companyId, 'overdue_new_order_policy', 'allow'),
    sendStatementOnCollectionConfirmed: getSetting(req.companyId, 'send_statement_on_collection_confirmed', '1') === '1',
  });
});

router.put('/settings/collections', requirePermission('manage_settings'), (req, res) => {
  const { creditLimitColorEnabled, paymentOverdueColorEnabled, paymentOverdueDays, overdueNewOrderPolicy, sendStatementOnCollectionConfirmed } =
    req.body || {};
  const set = (key, value) =>
    db
      .prepare(`INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`)
      .run(req.companyId, key, String(value));
  if (creditLimitColorEnabled !== undefined) set('credit_limit_color_enabled', creditLimitColorEnabled ? '1' : '0');
  if (paymentOverdueColorEnabled !== undefined) set('payment_overdue_color_enabled', paymentOverdueColorEnabled ? '1' : '0');
  if (paymentOverdueDays !== undefined) set('payment_overdue_days', paymentOverdueDays);
  if (overdueNewOrderPolicy) set('overdue_new_order_policy', overdueNewOrderPolicy);
  if (sendStatementOnCollectionConfirmed !== undefined) set('send_statement_on_collection_confirmed', sendStatementOnCollectionConfirmed ? '1' : '0');
  res.status(204).end();
});

module.exports = router;
