const express = require('express');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const { listReps, defaultRepId, getTargets, setTarget, computeProgress } = require('../lib/targets');

const router = express.Router();

// Reps list + progress readout are needed by both the Settings > الأهداف
// screen (manage_settings) and the Statistics > Overview gauges
// (view_statistics) — either permission is enough to read.
router.use(requireAnyPermission('manage_settings', 'view_statistics'));

router.get('/reps', (req, res) => {
  res.json({ reps: listReps(req.companyId), defaultRepId: defaultRepId(req.companyId) });
});

router.get('/', (req, res) => {
  const userId = Number(req.query.userId) || defaultRepId(req.companyId);
  if (!userId) return res.json({ userId: null, weekly: null, monthly: null });
  res.json({ userId, ...getTargets(req.companyId, userId) });
});

router.get('/progress', (req, res) => {
  const userId = Number(req.query.userId) || defaultRepId(req.companyId);
  if (!userId) return res.json({ userId: null, weekly: null, monthly: null });
  res.json(computeProgress(req.companyId, userId));
});

router.put('/', requirePermission('manage_settings'), (req, res) => {
  const { userId, period, value } = req.body || {};
  if (!userId || !period) return res.status(400).json({ error: 'userId_and_period_required' });
  try {
    const targets = setTarget(req.companyId, Number(userId), period, value);
    res.json({ userId: Number(userId), ...targets });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
