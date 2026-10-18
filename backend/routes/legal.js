const express = require('express');
const { PRIVACY_POLICY_VERSION, PRIVACY_POLICY_TEXT_AR } = require('../lib/legal');

const router = express.Router();

// Public — must be readable before a company even exists (shown during
// signup, per spec item 4), so this deliberately has no auth middleware.
router.get('/privacy-policy', (req, res) => {
  res.json({ version: PRIVACY_POLICY_VERSION, text: PRIVACY_POLICY_TEXT_AR });
});

module.exports = router;
