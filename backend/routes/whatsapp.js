const express = require('express');
const { requirePermission } = require('../middleware/auth');
const whatsapp = require('../lib/whatsapp');

const router = express.Router();
router.use(requirePermission('manage_settings'));

router.get('/status', (req, res) => res.json(whatsapp.getState(req.companyId)));

// Step 1 of the link flow: a company admin requests a number be linked.
// This only records the request — it never touches the WhatsApp client
// itself. A platform admin must separately approve it before /connect
// will do anything (see lib/whatsapp.js's requestLink/connect).
router.post('/request', (req, res) => {
  const { requested_number } = req.body || {};
  res.json(whatsapp.requestLink(req.companyId, requested_number, req.user));
});

router.post('/connect', (req, res) => res.json(whatsapp.connect(req.companyId)));

router.post('/disconnect', async (req, res) => {
  await whatsapp.disconnect(req.companyId);
  res.json(whatsapp.getState(req.companyId));
});

module.exports = router;
