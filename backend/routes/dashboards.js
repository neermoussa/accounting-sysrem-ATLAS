const express = require('express');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const { getManagerDashboard, getSupervisorDashboard, getRepDashboard, getHiddenSections, setHiddenSections } = require('../lib/dashboards');

const router = express.Router();
router.use(requireCompany);

router.get('/manager', requirePermission('view_statistics'), (req, res) => {
  res.json(getManagerDashboard(req.companyId));
});

router.get('/supervisor', requireAnyPermission('manage_waves', 'approve_orders', 'record_deliveries'), (req, res) => {
  res.json(getSupervisorDashboard(req.companyId));
});

// Every user sees their OWN rep dashboard — there's no permission gate
// beyond being an authenticated company member, since it's always scoped
// to req.user.id and never another rep's data.
router.get('/rep', (req, res) => {
  res.json(getRepDashboard(req.companyId, req.user.id));
});

// Section customization (spec item 4) — which dashboard sections a
// company hides, on top of the module on/off switches it already has.
router.get('/:dashboard/sections', requirePermission('manage_settings'), (req, res) => {
  if (!['manager', 'supervisor', 'rep'].includes(req.params.dashboard)) return res.status(400).json({ error: 'invalid_dashboard' });
  res.json({ hidden: [...getHiddenSections(req.companyId, req.params.dashboard)] });
});

router.put('/:dashboard/sections', requirePermission('manage_settings'), (req, res) => {
  if (!['manager', 'supervisor', 'rep'].includes(req.params.dashboard)) return res.status(400).json({ error: 'invalid_dashboard' });
  const { hidden } = req.body || {};
  if (!Array.isArray(hidden)) return res.status(400).json({ error: 'hidden_must_be_array' });
  setHiddenSections(req.companyId, req.params.dashboard, hidden);
  res.status(204).end();
});

module.exports = router;
