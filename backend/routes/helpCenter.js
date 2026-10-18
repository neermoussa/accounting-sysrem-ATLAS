const express = require('express');
const db = require('../db/init');
const { requireCompany } = require('../middleware/auth');

const router = express.Router();
router.use(requireCompany);

// Platform-wide content — every company reads the same list. Writing is
// Platform Admin only (routes/platformAdmin.js).
router.get('/training-videos', (req, res) => {
  res.json(db.prepare('SELECT * FROM training_videos ORDER BY category, created_at DESC').all());
});

router.get('/changelog', (req, res) => {
  res.json(db.prepare('SELECT * FROM platform_changelog ORDER BY released_at DESC').all());
});

module.exports = router;
