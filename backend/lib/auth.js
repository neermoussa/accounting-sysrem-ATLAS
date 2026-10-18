const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { getUserPermissions } = require('./permissions');

const SESSION_COOKIE = 'session_token';
const SESSION_DAYS = 30;
const SALT_ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expiresAt
  );
  return { token, expiresAt };
}

function getUserBySessionToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, require('./clock').nowSql());
  return row || null;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
}

function publicUser(user) {
  return {
    id: user.id,
    company_id: user.company_id ?? null,
    name: user.name,
    contact: user.contact,
    status: user.status,
    role: user.role,
    is_platform_admin: !!user.is_platform_admin,
    created_at: user.created_at,
    language: user.language || 'ar',
    // requireAuth already attaches this fresh from the DB on every request;
    // for the few callers building a publicUser without going through
    // requireAuth first (register/login/approve/reject), fall back to a
    // fresh read here so the shape is always the same either way. A
    // platform-admin account has no company permissions at all — it's
    // gated by is_platform_admin instead, never by this list.
    permissions: user.is_platform_admin ? [] : user.permissions || getUserPermissions(user.id),
  };
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  getUserBySessionToken,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  publicUser,
};
