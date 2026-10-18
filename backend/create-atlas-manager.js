// Local recovery helper for a development/test copy of Atlas.
// Run from backend: node create-atlas-manager.js
// This intentionally creates an approved manager account for local testing only.
const db = require('./db/init');
const { hashPassword } = require('./lib/auth');
const { ALL_PERMISSION_KEYS, MANAGE_PERMISSIONS, setUserPermissions } = require('./lib/permissions');

const CONTACT = 'manager@atlas.local';
const PASSWORD = 'Atlas1234!';
const NAME = 'Atlas Manager';

const existing = db.prepare('SELECT id FROM users WHERE contact = ?').get(CONTACT);
let userId;
if (existing) {
  userId = existing.id;
  db.prepare('UPDATE users SET name = ?, password_hash = ?, role = ?, status = ? WHERE id = ?').run(
    NAME,
    hashPassword(PASSWORD),
    'manager',
    'approved',
    userId
  );
} else {
  const info = db.prepare(
    'INSERT INTO users (name, contact, password_hash, role, status, language) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(NAME, CONTACT, hashPassword(PASSWORD), 'manager', 'approved', 'ar');
  userId = info.lastInsertRowid;
}

setUserPermissions(userId, [...ALL_PERMISSION_KEYS, MANAGE_PERMISSIONS], userId);
console.log('Atlas local manager account is ready.');
console.log(`Account: ${CONTACT}`);
console.log(`Password: ${PASSWORD}`);
console.log('Status: approved; full local permissions granted.');
