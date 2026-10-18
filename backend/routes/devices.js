const express = require('express');
const db = require('../db/init');
const { requirePermission, requireCompany } = require('../middleware/auth');
const { registerOrHeartbeat, listDevices, revokeDevice, acknowledgeWipe } = require('../lib/devices');

const router = express.Router();
router.use(requireCompany);

// Called on every app open / reconnect. A revoked device gets a 403 with
// wipeRequested:true instead of a normal row — the app-lock/session on
// that device should treat this as "log out and clear local data now."
router.post('/register', (req, res) => {
  const { deviceId, deviceName, platform } = req.body || {};
  try {
    const existing = deviceId ? db.prepare('SELECT * FROM trusted_devices WHERE user_id = ? AND device_id = ?').get(req.user.id, deviceId) : null;
    if (existing && existing.trusted === 0) {
      return res.status(403).json({ error: 'device_revoked', wipeRequested: !!existing.wipe_requested });
    }
    const device = registerOrHeartbeat(req.companyId, req.user, { deviceId, deviceName, platform });
    res.json({ device, wipeRequested: !!device.wipe_requested });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

router.post('/acknowledge-wipe', (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'device_id_required' });
  acknowledgeWipe(req.user.id, deviceId);
  res.status(204).end();
});

// Every device the requesting user has ever registered from.
router.get('/', (req, res) => {
  res.json(listDevices(req.user.id));
});

// A manager can also see/manage another user's devices — e.g. a lost
// phone reported by someone other than its owner.
router.get('/users/:userId', requirePermission('manage_users'), (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(req.params.userId, req.companyId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  res.json(listDevices(user.id));
});

router.post('/:id/revoke', (req, res) => {
  const device = db.prepare('SELECT * FROM trusted_devices WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!device) return res.status(404).json({ error: 'not_found' });
  // Any user can revoke their OWN device (e.g. "I lost my phone"); revoking
  // someone else's requires manage_users.
  if (device.user_id !== req.user.id && !req.user.permissions?.includes('manage_users')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(revokeDevice(req.companyId, device.id, req.user));
});

module.exports = router;
