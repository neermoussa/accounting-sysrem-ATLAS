const db = require('../db/init');

// App-lock (PIN/biometric) is necessarily device-native — this backend
// never sees or stores it. What it DOES own: which devices an account is
// allowed to use at all, and remote wipe (spec item 2). A client calls
// registerOrHeartbeat on every app open / reconnect; the response tells it
// whether it's still trusted and whether a wipe was requested since its
// last check-in.

function registerOrHeartbeat(companyId, user, { deviceId, deviceName, platform }) {
  if (!deviceId) throw Object.assign(new Error('device_id_required'), { status: 400 });
  const existing = db.prepare('SELECT * FROM trusted_devices WHERE user_id = ? AND device_id = ?').get(user.id, deviceId);
  if (existing) {
    db.prepare("UPDATE trusted_devices SET last_seen_at = datetime('now'), device_name = COALESCE(?, device_name), platform = COALESCE(?, platform) WHERE id = ?").run(
      deviceName || null,
      platform || null,
      existing.id
    );
    return db.prepare('SELECT * FROM trusted_devices WHERE id = ?').get(existing.id);
  }
  const info = db
    .prepare('INSERT INTO trusted_devices (company_id, user_id, device_id, device_name, platform) VALUES (?, ?, ?, ?, ?)')
    .run(companyId, user.id, deviceId, deviceName || null, platform || null);
  return db.prepare('SELECT * FROM trusted_devices WHERE id = ?').get(info.lastInsertRowid);
}

function listDevices(userId) {
  return db.prepare('SELECT * FROM trusted_devices WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId);
}

// Revoking untrusts the device (blocking new access via checkDeviceAccess
// below) AND flags it for remote wipe — the two are inseparable here: a
// device you no longer trust should also stop holding locally-cached data.
function revokeDevice(companyId, deviceRowId, requestedBy) {
  const row = db.prepare('SELECT * FROM trusted_devices WHERE id = ? AND company_id = ?').get(deviceRowId, companyId);
  if (!row) throw Object.assign(new Error('not_found'), { status: 404 });
  db.prepare("UPDATE trusted_devices SET trusted = 0, wipe_requested = 1, revoked_at = datetime('now') WHERE id = ?").run(row.id);
  return db.prepare('SELECT * FROM trusted_devices WHERE id = ?').get(row.id);
}

// A wiped device acknowledges the client actually cleared its local cache
// — clears the flag but the device stays untrusted until re-registered
// (which a revoked device_id can never do again on its own; a NEW
// deviceId — i.e. a fresh app install — would be needed).
function acknowledgeWipe(userId, deviceId) {
  db.prepare("UPDATE trusted_devices SET wipe_requested = 0 WHERE user_id = ? AND device_id = ?").run(userId, deviceId);
}

// Gate used by middleware/auth's session check (or called directly by a
// route) — a revoked device must not keep working even with a valid
// session cookie/token.
function isDeviceTrusted(userId, deviceId) {
  if (!deviceId) return true; // requests with no device context (browser/desktop, no device registration flow) are unaffected
  const row = db.prepare('SELECT trusted FROM trusted_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
  return !row || row.trusted === 1;
}

module.exports = { registerOrHeartbeat, listDevices, revokeDevice, acknowledgeWipe, isDeviceTrusted };
