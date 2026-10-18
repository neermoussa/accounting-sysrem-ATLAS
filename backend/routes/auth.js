const express = require('express');
const db = require('../db/init');
const {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  publicUser,
  SESSION_COOKIE,
} = require('../lib/auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// A brand-new company (with its first, auto-approved manager account) is
// created exclusively through POST /api/companies (see routes/companies.js
// / lib/companies.js createCompanyWithAdmin) — that is the only bootstrap
// path left. This endpoint only ever joins an *existing* company as an
// additional, unprivileged pending account awaiting that company's own
// manage_users approval, so companyId is mandatory and validated, and the
// account is always created pending/rep — never auto-approved here.
router.post('/register', (req, res) => {
  const { name, contact, password } = req.body || {};
  const companyId = Number(req.body?.companyId);
  if (!name?.trim() || !contact?.trim() || !password) {
    return res.status(400).json({ error: 'name_contact_password_required' });
  }
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return res.status(400).json({ error: 'company_id_required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }

  const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
  if (!company) {
    return res.status(400).json({ error: 'invalid_company' });
  }

  const defaultLanguage =
    db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, 'default_language')
      ?.value || 'ar';

  try {
    const info = db
      .prepare(
        `INSERT INTO users (company_id, name, contact, password_hash, role, status, language)
         VALUES (?, ?, ?, ?, 'rep', 'pending', ?)`
      )
      .run(companyId, name.trim(), contact.trim(), hashPassword(password), defaultLanguage);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

    res.status(201).json({
      user: publicUser(user),
      autoApproved: false,
      message: 'تم إرسال طلبك، بانتظار موافقة المدير',
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'contact_already_registered' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

// Every attempt, success or failure, is logged to login_attempts —
// Platform Admin's technical dashboard reads this to watch for brute-force
// patterns (spec item 3). Logged AFTER the decision is made so the reason
// (bad password vs. pending vs. rejected) is captured too.
function logLoginAttempt(req, { contact, userId, companyId, success, reason }) {
  db.prepare('INSERT INTO login_attempts (contact, user_id, company_id, success, reason, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    contact || null,
    userId ?? null,
    companyId ?? null,
    success ? 1 : 0,
    reason || null,
    req.ip || null,
    req.headers['user-agent'] || null
  );
}

router.post('/login', (req, res) => {
  const { contact, password } = req.body || {};
  if (!contact?.trim() || !password) {
    return res.status(400).json({ error: 'contact_and_password_required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE contact = ?').get(contact.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    logLoginAttempt(req, { contact: contact.trim(), userId: user?.id, companyId: user?.company_id, success: false, reason: 'invalid_credentials' });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (user.status === 'pending') {
    logLoginAttempt(req, { contact: contact.trim(), userId: user.id, companyId: user.company_id, success: false, reason: 'pending_approval' });
    return res.status(403).json({ error: 'pending_approval' });
  }
  if (user.status === 'rejected') {
    logLoginAttempt(req, { contact: contact.trim(), userId: user.id, companyId: user.company_id, success: false, reason: 'account_rejected' });
    return res.status(403).json({ error: 'account_rejected' });
  }

  logLoginAttempt(req, { contact: contact.trim(), userId: user.id, companyId: user.company_id, success: true });
  const { token } = createSession(user.id);
  setSessionCookie(req, res, token);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) deleteSession(token);
  clearSessionCookie(req, res);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.put('/language', requireAuth, (req, res) => {
  const { language } = req.body || {};
  if (language !== 'ar' && language !== 'en') {
    return res.status(400).json({ error: 'invalid_language' });
  }
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.user.id);
  res.json({ user: publicUser({ ...req.user, language }) });
});

// Self password change from the account-settings dropdown — distinct from
// admin user-management, which never sees or sets another user's password.
router.put('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'current_and_new_password_required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return res.status(401).json({ error: 'current_password_incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  res.status(204).end();
});

module.exports = router;
