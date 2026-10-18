const express = require('express');
const { requireCompany } = require('../middleware/auth');
const { getCompany } = require('../lib/companies');
const { DEPARTMENTS, canAccess, getDepartmentDashboard } = require('../lib/departments');

const router = express.Router();
router.use(requireCompany);

// Which departments the current user may open — one source of truth for
// the sidebar so it can never offer a link the dashboard route would 403.
router.get('/', (req, res) => {
  const company = getCompany(req.companyId);
  res.json({ departments: Object.keys(DEPARTMENTS).filter((k) => canAccess(k, req.user, company)) });
});

router.get('/:dept', (req, res) => {
  const { dept } = req.params;
  if (!DEPARTMENTS[dept]) return res.status(404).json({ error: 'unknown_department' });
  if (!canAccess(dept, req.user, getCompany(req.companyId))) return res.status(403).json({ error: 'forbidden' });
  res.json(getDepartmentDashboard(req.companyId, dept));
});

module.exports = router;
