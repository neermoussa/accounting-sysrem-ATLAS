// Local recovery/bootstrap helper for a development/test copy of the
// platform. Run from backend: node create-platform-admin.js
// Creates (or promotes) a platform-admin account — one with no company_id
// and is_platform_admin = 1, which is the only thing that unlocks
// routes/platformAdmin.js (see middleware/auth.js requirePlatformAdmin).
// This is intentionally NOT run automatically at db init, not wired into
// any npm script, and not referenced by CI — a platform admin is
// provisioned deliberately, by hand, not seeded by default.
//
// Password: never hardcoded. Set PLATFORM_ADMIN_PASSWORD in the
// environment to choose one explicitly (useful for scripted/CI bootstraps);
// otherwise this generates a cryptographically random one and prints it to
// stdout exactly once when it finishes. Nothing is ever written to a file,
// log, or anywhere in the repo — copy it down immediately, it cannot be
// recovered afterwards. Change it after first login via the account's own
// password-change flow (PUT /api/auth/password, "current password" screen
// in account settings — the same endpoint every user, including platform
// admins, uses to change their own password).
const crypto = require('crypto');
const db = require('./db/init');
const { hashPassword } = require('./lib/auth');

const CONTACT = 'platform-admin@atlas.local';
const NAME = 'Atlas Platform Admin';

function generatePassword() {
  // 24 random bytes, base64url-encoded -> 32 chars, no ambiguous padding.
  return crypto.randomBytes(24).toString('base64url');
}

const password = process.env.PLATFORM_ADMIN_PASSWORD || generatePassword();
const generated = !process.env.PLATFORM_ADMIN_PASSWORD;

const existing = db.prepare('SELECT id FROM users WHERE contact = ?').get(CONTACT);
if (existing) {
  db.prepare(
    `UPDATE users SET name = ?, password_hash = ?, status = 'approved', is_platform_admin = 1, company_id = NULL WHERE id = ?`
  ).run(NAME, hashPassword(password), existing.id);
} else {
  db.prepare(
    `INSERT INTO users (company_id, name, contact, password_hash, role, status, is_platform_admin)
     VALUES (NULL, ?, ?, ?, 'platform_admin', 'approved', 1)`
  ).run(NAME, CONTACT, hashPassword(password));
}

console.log('Platform admin account is ready.');
console.log(`Account: ${CONTACT}`);
if (generated) {
  console.log(`Password (generated, shown ONCE — save it now, it is not stored anywhere): ${password}`);
  console.log('Change it immediately after first login via account settings > change password.');
} else {
  console.log('Password: set from PLATFORM_ADMIN_PASSWORD (not printed here).');
  console.log('Change it after first login via account settings > change password if this was a shared/CI value.');
}
