const express = require('express');
const db = require('../db/init');
const { publicUser, deleteSession, hashPassword } = require('../lib/auth');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(requirePermission('manage_users'));

// Direct add — distinct from the public /auth/register + approve flow: a
// manager (or Startup Setup's users step) creating a teammate on purpose
// skips the pending-approval queue entirely, since the person adding them
// already has manage_users and is vouching for them.
router.post('/users', (req, res) => {
  const { name, contact, password } = req.body || {};
  if (!name?.trim() || !contact?.trim() || !password) {
    return res.status(400).json({ error: 'name_contact_password_required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO users (company_id, name, contact, password_hash, role, status)
         VALUES (?, ?, ?, ?, 'rep', 'approved')`
      )
      .run(req.companyId, name.trim(), contact.trim(), hashPassword(password));
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'contact_already_registered' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

function revokeUserSessions(userId) {
  const tokens = db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(userId);
  tokens.forEach((r) => deleteSession(r.token));
}

router.get('/users', (req, res) => {
  const users = db
    .prepare(`SELECT * FROM users WHERE company_id = ? ORDER BY (status = 'pending') DESC, created_at DESC`)
    .all(req.companyId);
  res.json(users.map(publicUser));
});

// Approval only flips status — it grants no permissions on its own. A newly
// approved user starts with whatever permissions they already had (none,
// for a fresh registration) until whoever holds manage_permissions assigns
// them, deliberately, from the permissions screen.
router.post('/users/:id/approve', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  db.prepare("UPDATE users SET status = 'approved' WHERE id = ? AND company_id = ?").run(user.id, req.companyId);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(user.id, req.companyId)));
});

router.post('/users/:id/reject', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  // Rejecting the last remaining holder of manage_permissions would leave
  // nobody able to ever grant any permission again (including this one) —
  // block it the same way the old system protected the last admin.
  const holdsManagePermissions = db
    .prepare("SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = 'manage_permissions'")
    .get(user.id);
  if (holdsManagePermissions) {
    const otherHolders = db
      .prepare(
        `SELECT COUNT(*) c FROM user_permissions up
         JOIN users u ON u.id = up.user_id
         WHERE up.permission = 'manage_permissions' AND u.status = 'approved' AND u.id != ? AND u.company_id = ?`
      )
      .get(user.id, req.companyId).c;
    if (otherHolders === 0) {
      return res.status(400).json({ error: 'cannot_remove_last_permission_manager' });
    }
  }
  db.prepare("UPDATE users SET status = 'rejected' WHERE id = ? AND company_id = ?").run(user.id, req.companyId);
  revokeUserSessions(user.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(user.id, req.companyId)));
});

module.exports = router;
