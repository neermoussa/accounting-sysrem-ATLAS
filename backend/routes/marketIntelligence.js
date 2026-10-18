const express = require('express');
const { requireCompany } = require('../middleware/auth');
const { getSnapshot } = require('../lib/marketIntelligence');

const router = express.Router();
router.use(requireCompany);

// Deliberately open to any authenticated company user (no extra
// permission gate) — every row this can ever return is already fully
// anonymized and k-anonymity-floored (see lib/marketIntelligence.js), so
// there is no privacy reason to restrict who on a company's own team can
// see it. It never reveals which OTHER company contributed what.
router.get('/stats', (req, res) => {
  const { period, geoLevel, geoValue, metricType, productName, allPeriods } = req.query;
  res.json(getSnapshot({ period, geoLevel, geoValue, metricType, productName, allPeriods: allPeriods === '1' }));
});

module.exports = router;
