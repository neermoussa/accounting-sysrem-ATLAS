const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const {
  logChange,
  autoFinancialAdjustmentEnabled,
  getItems,
  getReturn,
  notifyReturnFiled,
  restockValidItems,
  applyFinancialAdjustment,
} = require('../lib/returns');
const { resolveScopeWithElevation, RETURNS_ELEVATED_PERMISSIONS } = require('../lib/repAccess');

const { isLedgerLive } = require('../lib/customerLedger');
const { checkpoint } = require('../lib/faultInjection');

const router = express.Router();
router.use(requireCompany);

const RETURN_MEDIA_DIR = path.join(__dirname, '..', 'uploads', 'return-media');
if (!fs.existsSync(RETURN_MEDIA_DIR)) fs.mkdirSync(RETURN_MEDIA_DIR, { recursive: true });
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RETURN_MEDIA_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن تكون الصورة بصيغة PNG أو JPG أو WEBP'), ok);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

function withItems(request) {
  return { ...request, items: getItems(request.id), media: db.prepare('SELECT * FROM return_media WHERE return_request_id = ?').all(request.id) };
}

// ---------------------------------------------------------------------
// File a return request — a rep on the customer's behalf. Balance and
// inventory are completely untouched here: every item starts
// 'pending_inspection', the whole request starts 'pending_review'.
// ---------------------------------------------------------------------

router.post('/', requirePermission('request_returns'), (req, res) => {
  const { orderId, shopId, reason, items } = req.body || {};
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  if (!shop) return res.status(400).json({ error: 'shop_not_found' });
  const itemsList = Array.isArray(items) ? items : [];
  if (itemsList.length === 0 || itemsList.some((it) => !(Number(it.qty) > 0))) {
    return res.status(400).json({ error: 'items_with_positive_qty_required' });
  }
  if (orderId) {
    const order = db.prepare('SELECT id FROM orders WHERE id = ? AND company_id = ?').get(orderId, req.companyId);
    if (!order) return res.status(400).json({ error: 'order_not_found' });
  }

  const info = db
    .prepare('INSERT INTO return_requests (company_id, order_id, shop_id, reason, requested_by_id, requested_by_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, orderId || null, shop.id, reason || null, req.user.id, req.user.name);
  const requestId = info.lastInsertRowid;

  const insertItem = db.prepare(
    'INSERT INTO return_items (company_id, return_request_id, product_id, product_name, unit_key, requested_qty, unit_value) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const it of itemsList) {
    insertItem.run(req.companyId, requestId, it.productId || null, it.productName, it.unitKey || null, Number(it.qty), it.unitValue ?? null);
  }
  logChange(req.companyId, requestId, null, { action: 'file_request', field: 'status', after: 'pending_review', user: req.user });

  const request = db.prepare('SELECT * FROM return_requests WHERE id = ?').get(requestId);
  notifyReturnFiled(req.companyId, request, shop);

  const { flagReturnRepeatAnomaly } = require('../lib/aiRecommendations');
  for (const it of itemsList) {
    try {
      flagReturnRepeatAnomaly(req.companyId, { shop, productName: it.productName, productId: it.productId || null });
    } catch (err) {
      console.error('[returns] AI return-repeat anomaly flagging failed:', err.message);
    }
  }

  res.status(201).json(withItems(request));
});

router.get('/', requireAnyPermission('view_app', 'request_returns', 'approve_returns'), (req, res) => {
  const { status, shopId, repId } = req.query;
  // Same leak class as orders/collections: a plain rep only holding
  // 'view_app' could otherwise list every return company-wide. Scope by
  // the filing rep (requested_by_id) unless the caller has approver-level
  // reach — approve_returns, not the unrelated manage_waves.
  const scope = resolveScopeWithElevation(req, repId ?? null, RETURNS_ELEVATED_PERMISSIONS);
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  let sql = 'SELECT * FROM return_requests WHERE company_id = ?';
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
    sql += ' AND requested_by_id = ?';
    params.push(scope.repId);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params).map(withItems));
});

router.get('/:id', requireAnyPermission('view_app', 'request_returns', 'approve_returns'), (req, res) => {
  const request = getReturn(req.companyId, req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  const scope = resolveScopeWithElevation(req, request.requested_by_id, RETURNS_ELEVATED_PERMISSIONS);
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  res.json(withItems(request));
});

router.get('/:id/changes', requireAnyPermission('view_app', 'approve_returns'), (req, res) => {
  const request = getReturn(req.companyId, req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM return_changes WHERE return_request_id = ? ORDER BY changed_at DESC').all(request.id));
});

router.post('/:id/media', requirePermission('approve_returns'), mediaUpload.single('file'), (req, res) => {
  const request = getReturn(req.companyId, req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const url = `/uploads/return-media/${req.file.filename}`;
  const info = db
    .prepare('INSERT INTO return_media (company_id, return_request_id, item_id, url) VALUES (?, ?, ?, ?)')
    .run(req.companyId, request.id, req.body?.itemId || null, url);
  res.status(201).json(db.prepare('SELECT * FROM return_media WHERE id = ?').get(info.lastInsertRowid));
});

// ---------------------------------------------------------------------
// Inspection — the reviewer physically checks the item and records the
// real outcome. inspected_qty differing from requested_qty (the rep's
// original claim) requires a mandatory discrepancy reason, same pattern
// as every other variance in this app.
// ---------------------------------------------------------------------

router.put('/:id/items/:itemId/inspect', requirePermission('approve_returns'), (req, res) => {
  const request = getReturn(req.companyId, req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  if (request.status !== 'pending_review') return res.status(409).json({ error: 'request_not_pending_review', currentStatus: request.status });
  const item = db.prepare('SELECT * FROM return_items WHERE id = ? AND return_request_id = ?').get(req.params.itemId, request.id);
  if (!item) return res.status(404).json({ error: 'item_not_found' });

  const { inspectedQty, inspectionStatus, discrepancyReason, notes } = req.body || {};
  if (!['valid', 'needs_further_inspection', 'damaged'].includes(inspectionStatus)) return res.status(400).json({ error: 'invalid_inspection_status' });
  if (!(Number(inspectedQty) >= 0)) return res.status(400).json({ error: 'inspectedQty_required' });
  const qtyDiffers = Number(inspectedQty) !== item.requested_qty;
  if (qtyDiffers && !discrepancyReason?.trim()) {
    return res.status(400).json({ error: 'discrepancy_reason_required', requestedQty: item.requested_qty, inspectedQty: Number(inspectedQty) });
  }

  db.prepare(
    `UPDATE return_items SET inspection_status = ?, inspected_qty = ?, discrepancy_reason = ?, inspection_notes = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(inspectionStatus, Number(inspectedQty), qtyDiffers ? discrepancyReason.trim() : null, notes || null, item.id);
  logChange(req.companyId, request.id, item.id, {
    action: 'inspect',
    field: 'inspection_status',
    before: { status: item.inspection_status, requested_qty: item.requested_qty },
    after: { status: inspectionStatus, inspected_qty: Number(inspectedQty) },
    user: req.user,
  });
  res.json(db.prepare('SELECT * FROM return_items WHERE id = ?').get(item.id));
});

// ---------------------------------------------------------------------
// Approve / reject the whole request — this is the ONLY point where
// balance/inventory can change, and only after every item has actually
// been inspected.
// ---------------------------------------------------------------------

router.post('/:id/approve', requirePermission('approve_returns'), (req, res) => {
  const request = getReturn(req.companyId, req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  if (request.status !== 'pending_review') return res.status(409).json({ error: 'request_not_pending_review', currentStatus: request.status });

  const items = getItems(request.id);
  const uninspected = items.filter((it) => it.inspection_status === 'pending_inspection');
  if (uninspected.length > 0) {
    return res.status(409).json({ error: 'items_not_all_inspected', pendingItemIds: uninspected.map((it) => it.id) });
  }

  // Ledger-live companies: approval, restock and the credit-note posting
  // commit together or not at all. Otherwise this is the original flow.
  const live = isLedgerLive(req.companyId);
  let creditApplied = null;
  const apply = () => {
    db.prepare(
      "UPDATE return_requests SET status = 'approved', reviewed_by_id = ?, reviewed_by_name = ?, reviewed_at = datetime('now'), review_notes = ? WHERE id = ?"
    ).run(req.user.id, req.user.name, req.body?.notes || null, request.id);
    logChange(req.companyId, request.id, null, { action: 'approve', field: 'status', before: 'pending_review', after: 'approved', user: req.user });
    checkpoint('returns.approve.after_status');

    // Inventory: only valid items, only once (restocked flag guards re-runs).
    // Prompt 8: stock ledger -> a 'return_restock' move into the filing
    // rep's custody, posted (Dr custody stock / Cr COGS); else as before.
    if (require('../lib/stockLedger').isActive(req.companyId)) require('../lib/stockDocs').returnRestock(req.companyId, request, items, req.user);
    else restockValidItems(req.companyId, items);

    // Financial: gated by BOTH the company setting and the approving user's
    // own permission — an approval from someone without
    // apply_return_financial_adjustment still restocks and closes the
    // review, it just never touches the customer's balance.
    if (autoFinancialAdjustmentEnabled(req.companyId) && req.user.permissions.includes('apply_return_financial_adjustment')) {
      creditApplied = applyFinancialAdjustment(req.companyId, request, getItems(request.id), req.user);
      if (creditApplied) {
        logChange(req.companyId, request.id, null, { action: 'apply_financial_adjustment', field: 'balance', after: creditApplied, user: req.user });
      }
    }
  };
  try {
    if (live) db.transaction(apply)();
    else apply();
  } catch (err) {
    if (live && err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }

  const updated = db.prepare('SELECT * FROM return_requests WHERE id = ?').get(request.id);
  res.json({ ...withItems(updated), creditApplied });
});

router.post('/:id/reject', requirePermission('approve_returns'), (req, res) => {
  const request = getReturn(req.companyId, req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  if (request.status !== 'pending_review') return res.status(409).json({ error: 'request_not_pending_review', currentStatus: request.status });
  const { notes } = req.body || {};
  db.prepare(
    "UPDATE return_requests SET status = 'rejected', reviewed_by_id = ?, reviewed_by_name = ?, reviewed_at = datetime('now'), review_notes = ? WHERE id = ?"
  ).run(req.user.id, req.user.name, notes || null, request.id);
  logChange(req.companyId, request.id, null, { action: 'reject', field: 'status', before: 'pending_review', after: 'rejected', user: req.user });
  res.json(withItems(db.prepare('SELECT * FROM return_requests WHERE id = ?').get(request.id)));
});

// A manual, explicit financial-adjustment application for the case where
// approval happened without it (setting was off, or the approver lacked
// the permission) — separately gated, and only usable on an already
// approved request that hasn't had one applied yet.
router.post('/:id/apply-financial-adjustment', requirePermission('apply_return_financial_adjustment'), (req, res) => {
  const request = getReturn(req.companyId, req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  if (request.status !== 'approved') return res.status(409).json({ error: 'request_not_approved', currentStatus: request.status });
  if (request.financial_adjustment_applied) return res.status(409).json({ error: 'already_applied' });
  const live = isLedgerLive(req.companyId);
  let creditApplied = null;
  const apply = () => {
    creditApplied = applyFinancialAdjustment(req.companyId, request, getItems(request.id), req.user);
    if (creditApplied) {
      logChange(req.companyId, request.id, null, { action: 'apply_financial_adjustment', field: 'balance', after: creditApplied, user: req.user });
    }
  };
  try {
    if (live) db.transaction(apply)();
    else apply();
  } catch (err) {
    if (live && err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
  if (!creditApplied) return res.status(400).json({ error: 'no_creditable_value' });
  res.json({ ...withItems(db.prepare('SELECT * FROM return_requests WHERE id = ?').get(request.id)), creditApplied });
});

// ---------------------------------------------------------------------
// Company settings for automatic financial adjustment
// ---------------------------------------------------------------------

router.get('/settings/financial', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  res.json({
    autoFinancialAdjustment: db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'return_auto_financial_adjustment'").get(req.companyId)?.value === '1',
  });
});

router.put('/settings/financial', requirePermission('manage_settings'), (req, res) => {
  const value = req.body?.autoFinancialAdjustment ? '1' : '0';
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'return_auto_financial_adjustment', ?)
     ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(req.companyId, value);
  res.status(204).end();
});

module.exports = router;
