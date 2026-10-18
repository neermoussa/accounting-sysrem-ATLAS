const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const { processOperation, decidePendingOperation, resolveConflict, sensitiveOpsMode } = require('../lib/offlineSync');

const router = express.Router();
router.use(requireCompany);

// ---------------------------------------------------------------------
// 2) Local-cache pull: what a rep's app should store on-device so it can
// keep working offline — their own shops, active products, and price
// lists. Read-only, safe to call repeatedly (e.g. once per reconnect).
// ---------------------------------------------------------------------

router.get('/pull-data', (req, res) => {
  const canSeeAllShops = req.user.permissions?.includes('manage_shops') || req.user.permissions?.includes('reassign_shops');
  const shops = canSeeAllShops
    ? db.prepare('SELECT * FROM shops WHERE company_id = ? AND active = 1').all(req.companyId)
    : db.prepare('SELECT * FROM shops WHERE company_id = ? AND active = 1 AND assigned_rep_id = ?').all(req.companyId, req.user.id);
  const products = db.prepare('SELECT * FROM products WHERE company_id = ? AND active = 1').all(req.companyId);
  const priceLists = db.prepare('SELECT * FROM price_lists WHERE company_id = ?').all(req.companyId);
  res.json({ shops, products, priceLists, pulledAt: new Date().toISOString() });
});

// ---------------------------------------------------------------------
// 1)+3)+5) Batch sync: a rep's app submits everything it queued while
// offline in one call. Each operation is processed independently and
// idempotently (repeating the exact same idempotencyKey never re-applies
// it) — the response array is the "sync queue" a UI would render, with a
// clear status per item (applied / pending_approval / conflict / error).
// ---------------------------------------------------------------------

router.post('/batch', (req, res) => {
  const { operations } = req.body || {};
  if (!Array.isArray(operations) || operations.length === 0) return res.status(400).json({ error: 'operations_required' });
  const results = operations.map((op) => {
    try {
      const row = processOperation(req.companyId, req.user, op);
      return { ...row, payload: JSON.parse(row.payload_json), result: row.result_json ? JSON.parse(row.result_json) : null };
    } catch (err) {
      return { clientId: op.clientId, idempotencyKey: op.idempotencyKey, status: 'error', error_message: err.message };
    }
  });
  res.status(201).json({ results });
});

// This user's own queue history — every operation they've ever submitted,
// whatever its outcome, so the app can show "3 synced, 1 pending review,
// 1 failed" instead of a black box.
router.get('/queue', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM sync_operations WHERE user_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(req.user.id, req.companyId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json), result: r.result_json ? JSON.parse(r.result_json) : null }));
  res.json(rows);
});

// ---------------------------------------------------------------------
// 7) Sensitive operations awaiting human approval before they ever apply.
// ---------------------------------------------------------------------

router.get('/settings', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  res.json({ sensitiveOpsMode: sensitiveOpsMode(req.companyId) });
});

router.put('/settings', requirePermission('manage_settings'), (req, res) => {
  const { sensitiveOpsMode: mode } = req.body || {};
  if (!['auto_apply', 'requires_approval'].includes(mode)) return res.status(400).json({ error: 'invalid_mode' });
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'offline_sensitive_ops_mode', ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(req.companyId, mode);
  res.status(204).end();
});

router.get('/pending-approval', requireAnyPermission('approve_offline_sync', 'view_app'), (req, res) => {
  const rows = db
    .prepare("SELECT * FROM sync_operations WHERE company_id = ? AND status = 'pending_approval' ORDER BY created_at DESC")
    .all(req.companyId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
  res.json(rows);
});

router.post('/pending-approval/:id/decide', requirePermission('approve_offline_sync'), (req, res) => {
  const { decision } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
  try {
    const row = decidePendingOperation(req.companyId, req.params.id, decision, req.user);
    res.json({ ...row, payload: JSON.parse(row.payload_json), result: row.result_json ? JSON.parse(row.result_json) : null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', currentStatus: err.currentStatus });
  }
});

// ---------------------------------------------------------------------
// 4) Conflicts awaiting manual review — never auto-resolved, never
// silently drops either the client's or the server's version.
// ---------------------------------------------------------------------

router.get('/conflicts', requireAnyPermission('approve_offline_sync', 'view_app'), (req, res) => {
  const { status = 'pending' } = req.query;
  const rows = db
    .prepare('SELECT * FROM sync_conflicts WHERE company_id = ? AND status = ? ORDER BY created_at DESC')
    .all(req.companyId, status)
    .map((r) => ({ ...r, clientPayload: JSON.parse(r.client_payload_json), serverSnapshot: JSON.parse(r.server_snapshot_json) }));
  res.json(rows);
});

router.post('/conflicts/:id/resolve', requirePermission('approve_offline_sync'), (req, res) => {
  const { resolution, mergedPayload, notes } = req.body || {};
  try {
    const row = resolveConflict(req.companyId, req.params.id, { resolution, mergedPayload, notes, user: req.user });
    res.json({ ...row, clientPayload: JSON.parse(row.client_payload_json), serverSnapshot: JSON.parse(row.server_snapshot_json) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', currentStatus: err.currentStatus });
  }
});

module.exports = router;
