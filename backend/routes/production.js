const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');

const router = express.Router();
router.use(requireCompany);

// ---------------------------------------------------------------------
// Production requests — status is only ever changed from inside the app
// (this API), never from WhatsApp: there is no WhatsApp-triggered path
// anywhere in this codebase that touches production_requests.status.
// ---------------------------------------------------------------------

router.get('/requests', requireAnyPermission('view_app', 'manage_production_requests', 'manage_factory_inventory'), (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM production_requests WHERE company_id = ? AND status = ? ORDER BY created_at DESC').all(req.companyId, status)
    : db.prepare('SELECT * FROM production_requests WHERE company_id = ? ORDER BY created_at DESC').all(req.companyId);
  res.json(rows);
});

router.get('/requests/:id', requireAnyPermission('view_app', 'manage_production_requests'), (req, res) => {
  const row = db.prepare('SELECT * FROM production_requests WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.put('/requests/:id/status', requirePermission('manage_production_requests'), (req, res) => {
  const row = db.prepare('SELECT * FROM production_requests WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const { status } = req.body || {};
  if (!['pending_processing', 'in_production', 'ready', 'fulfilled', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  db.prepare("UPDATE production_requests SET status = ?, updated_by_id = ?, updated_by_name = ?, updated_at = datetime('now') WHERE id = ?").run(
    status,
    req.user.id,
    req.user.name,
    row.id
  );
  res.json(db.prepare('SELECT * FROM production_requests WHERE id = ?').get(row.id));
});

// ---------------------------------------------------------------------
// Warehouse replenish requests (load the rep's car from warehouse stock)
// ---------------------------------------------------------------------

router.get('/replenish-requests', requireAnyPermission('view_app', 'manage_replenish_requests', 'manage_factory_inventory'), (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM warehouse_replenish_requests WHERE company_id = ? AND status = ? ORDER BY created_at DESC').all(req.companyId, status)
    : db.prepare('SELECT * FROM warehouse_replenish_requests WHERE company_id = ? ORDER BY created_at DESC').all(req.companyId);
  res.json(rows);
});

router.put('/replenish-requests/:id/status', requirePermission('manage_replenish_requests'), (req, res) => {
  const row = db.prepare('SELECT * FROM warehouse_replenish_requests WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const { status } = req.body || {};
  if (!['pending', 'prepared', 'delivered_to_car', 'cancelled'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  db.prepare("UPDATE warehouse_replenish_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, row.id);
  res.json(db.prepare('SELECT * FROM warehouse_replenish_requests WHERE id = ?').get(row.id));
});

// ---------------------------------------------------------------------
// Prep/load lead-time policies (per company default, per category, or
// per specific product)
// ---------------------------------------------------------------------

router.get('/prep-policies', requireAnyPermission('view_app', 'manage_production_requests', 'manage_settings'), (req, res) => {
  res.json(db.prepare('SELECT * FROM prep_lead_time_policies WHERE company_id = ? ORDER BY id').all(req.companyId));
});

router.post('/prep-policies', requirePermission('manage_settings'), (req, res) => {
  const { product_id, category, lead_time_days, load_early } = req.body || {};
  if (lead_time_days == null) return res.status(400).json({ error: 'lead_time_days_required' });
  const info = db
    .prepare('INSERT INTO prep_lead_time_policies (company_id, product_id, category, lead_time_days, load_early) VALUES (?, ?, ?, ?, ?)')
    .run(req.companyId, product_id || null, product_id ? null : category || null, Number(lead_time_days), load_early ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM prep_lead_time_policies WHERE id = ?').get(info.lastInsertRowid));
});

// Must stay ahead of PUT /prep-policies/:id — otherwise Express would
// match "default" as :id.
router.put('/prep-policies/default', requirePermission('manage_settings'), (req, res) => {
  const { lead_time_days } = req.body || {};
  if (lead_time_days == null) return res.status(400).json({ error: 'lead_time_days_required' });
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'default_prep_lead_time_days', ?)
     ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(req.companyId, String(lead_time_days));
  res.status(204).end();
});

router.put('/prep-policies/:id', requirePermission('manage_settings'), (req, res) => {
  const row = db.prepare('SELECT * FROM prep_lead_time_policies WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const { lead_time_days, load_early } = req.body || {};
  db.prepare("UPDATE prep_lead_time_policies SET lead_time_days = ?, load_early = ?, updated_at = datetime('now') WHERE id = ?").run(
    lead_time_days ?? row.lead_time_days,
    load_early === undefined ? row.load_early : load_early ? 1 : 0,
    row.id
  );
  res.json(db.prepare('SELECT * FROM prep_lead_time_policies WHERE id = ?').get(row.id));
});

router.delete('/prep-policies/:id', requirePermission('manage_settings'), (req, res) => {
  const row = db.prepare('SELECT id FROM prep_lead_time_policies WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM prep_lead_time_policies WHERE id = ?').run(row.id);
  res.status(204).end();
});

module.exports = router;
