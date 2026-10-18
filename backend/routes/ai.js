const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const {
  getFeatureToggles,
  setFeatureToggles,
  getThresholds,
  setThresholds,
  suggestProductsForShop,
  decideRecommendation,
  computeStockForecasts,
} = require('../lib/aiRecommendations');

const router = express.Router();
router.use(requireCompany);

// ---------------------------------------------------------------------
// 1) Product/quantity/promotion suggestions — generated (or returned from
// today's cache) the moment a rep opens a customer's profile.
// ---------------------------------------------------------------------

router.get('/shops/:shopId/product-suggestions', requireAnyPermission('view_app', 'view_ai_recommendations'), async (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  try {
    const rec = await suggestProductsForShop(req.companyId, shop.id);
    res.json(rec); // null when the feature is off or there's no order history yet
  } catch (err) {
    console.error('[ai] product suggestion failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------
// Unified recommendations/anomalies feed + decision
// ---------------------------------------------------------------------

// Gated on view_ai_recommendations alone (not the 'view_app' fallback every
// user holds) — this is the unified AI recommendations/anomalies feed that
// CLAUDE_CONTEXT.md documents as permission-gated; accepting 'view_app' as
// an alternative made the permission a no-op for every rep. Same fix on
// /recommendations/:id and /stock-forecast below.
router.get('/recommendations', requirePermission('view_ai_recommendations'), (req, res) => {
  const { type, shopId, decisionStatus, severity } = req.query;
  let sql = 'SELECT * FROM ai_recommendations WHERE company_id = ?';
  const params = [req.companyId];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (shopId) {
    sql += ' AND shop_id = ?';
    params.push(shopId);
  }
  if (decisionStatus) {
    sql += ' AND decision_status = ?';
    params.push(decisionStatus);
  }
  if (severity) {
    sql += ' AND severity = ?';
    params.push(severity);
  }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params).map((r) => ({ ...r, data: JSON.parse(r.data_json), suggestion: JSON.parse(r.suggestion_json) }));
  res.json(rows);
});

router.get('/recommendations/:id', requirePermission('view_ai_recommendations'), (req, res) => {
  const row = db.prepare('SELECT * FROM ai_recommendations WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ ...row, data: JSON.parse(row.data_json), suggestion: JSON.parse(row.suggestion_json) });
});

// The one place a human decision on any AI output is recorded — approval or
// rejection, with an optional reason, kept forever for future tuning (spec
// item 5). Nothing here executes anything by itself; a decision is just a
// record.
router.post('/recommendations/:id/decide', requirePermission('decide_ai_recommendations'), (req, res) => {
  const { status, reason } = req.body || {};
  try {
    const row = decideRecommendation(req.companyId, req.params.id, { status, reason, user: req.user });
    res.json({ ...row, data: JSON.parse(row.data_json), suggestion: JSON.parse(row.suggestion_json) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', currentStatus: err.currentStatus });
  }
});

// ---------------------------------------------------------------------
// 3) Stock forecast — manual on-demand trigger (in addition to the
// periodic sweep in server.js) so this can be exercised without waiting
// for the next scheduled tick.
// ---------------------------------------------------------------------

// Fire-and-forget: computeStockForecasts() yields the event loop between
// companies, so this responds immediately rather than holding the request
// open for the whole sweep — the caller checks results via
// GET /stock-forecast afterward, same as waiting for the scheduled sweep.
router.post('/stock-forecast/run', requirePermission('manage_settings'), (req, res) => {
  computeStockForecasts().catch((err) => console.error('[ai] manual stock forecast run failed:', err.message));
  res.status(202).end();
});

router.get('/stock-forecast', requirePermission('view_ai_recommendations'), (req, res) => {
  const rows = db
    .prepare("SELECT * FROM ai_recommendations WHERE company_id = ? AND type = 'stock_forecast' ORDER BY created_at DESC LIMIT 100")
    .all(req.companyId)
    .map((r) => ({ ...r, data: JSON.parse(r.data_json), suggestion: JSON.parse(r.suggestion_json) }));
  res.json(rows);
});

// ---------------------------------------------------------------------
// Settings: per-feature on/off toggles + rule thresholds
// ---------------------------------------------------------------------

// `aiConfigured` is added purely for the frontend's own honest empty-state
// (§"AI not configured" is a normal, expected state per CLAUDE_CONTEXT.md,
// not an error) — it never changes any decision on the backend, which
// already falls back to deterministic templates when AI_API_KEY is unset
// (see lib/ai.js's generateText).
router.get('/settings', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  res.json({
    toggles: getFeatureToggles(req.companyId),
    thresholds: getThresholds(req.companyId),
    aiConfigured: !!process.env.AI_API_KEY,
  });
});

router.put('/settings', requirePermission('manage_settings'), (req, res) => {
  const { toggles, thresholds } = req.body || {};
  if (toggles) setFeatureToggles(req.companyId, toggles);
  if (thresholds) setThresholds(req.companyId, thresholds);
  res.json({ toggles: getFeatureToggles(req.companyId), thresholds: getThresholds(req.companyId) });
});

module.exports = router;
