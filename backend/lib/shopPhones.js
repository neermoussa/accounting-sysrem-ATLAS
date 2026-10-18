const crypto = require('crypto');
const db = require('../db/init');
const { normalizePhone } = require('./phone');
const { sendToNumber } = require('./whatsapp');
const { createNotification } = require('./notify');
const { encrypt, decrypt } = require('./encryption');

const OTP_TTL_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 3;

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

// A newly added number inherits full messaging permissions by default (it's
// simply another line for the same shop) — excluded_from_notify is the one
// explicit per-number opt-out a manager can flip later, never set here.
function addPhone(companyId, shopId, { phone, label }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw Object.assign(new Error('invalid_phone'), { status: 400 });
  const existingCount = db.prepare('SELECT COUNT(*) c FROM shop_phones WHERE shop_id = ?').get(shopId).c;
  const info = db
    .prepare(
      `INSERT INTO shop_phones (company_id, shop_id, phone, label, is_primary) VALUES (?, ?, ?, ?, ?)`
    )
    .run(companyId, shopId, phone, label || null, existingCount === 0 ? 1 : 0);
  if (existingCount === 0) {
    // First phone on a shop that had none also becomes the shop's headline
    // phone field, so every existing feature that reads shop.phone directly
    // (exports, order confirmations, the map pin) keeps working unchanged.
    db.prepare("UPDATE shops SET phone = ?, updated_at = datetime('now') WHERE id = ? AND phone IS NULL").run(phone, shopId);
  }
  return db.prepare('SELECT * FROM shop_phones WHERE id = ?').get(info.lastInsertRowid);
}

async function requestOtp(companyId, phoneRow) {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  // Encrypted at rest (spec item 1) — a plain SELECT on this column (a DB
  // dump, a misconfigured admin tool) never exposes a live, usable code.
  db.prepare(
    `UPDATE shop_phones SET otp_code = ?, otp_expires_at = ?, otp_attempts = 0, otp_requested_at = datetime('now') WHERE id = ?`
  ).run(encrypt(code), expiresAt, phoneRow.id);
  const message = `رمز التحقق الخاص بك: ${code}\nصالح لمدة ${OTP_TTL_MINUTES} دقائق.`;
  const sent = await sendToNumber(companyId, phoneRow.phone, message);
  return { sent, expiresAt };
}

// Returns { ok: true } on success, or { ok: false, reason, attemptsLeft,
// needsManualConfirm } — the caller (route) decides how to surface each
// reason; needsManualConfirm=true is the signal to notify an employee, per
// the "3 failed attempts" requirement.
function verifyOtp(companyId, phoneRow, code) {
  if (phoneRow.verified) return { ok: true, alreadyVerified: true };
  if (!phoneRow.otp_code || !phoneRow.otp_expires_at) {
    return { ok: false, reason: 'no_pending_otp' };
  }
  if (new Date(phoneRow.otp_expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'otp_expired' };
  }
  if (String(code).trim() !== decrypt(phoneRow.otp_code)) {
    const attempts = phoneRow.otp_attempts + 1;
    db.prepare('UPDATE shop_phones SET otp_attempts = ? WHERE id = ?').run(attempts, phoneRow.id);
    const needsManualConfirm = attempts >= MAX_OTP_ATTEMPTS;
    if (needsManualConfirm) {
      const shop = db.prepare('SELECT id, name FROM shops WHERE id = ?').get(phoneRow.shop_id);
      createNotification({
        companyId,
        type: 'shop_phone_otp_failed',
        message_ar: `فشل تحقق OTP 3 مرات لرقم ${phoneRow.phone} الخاص بمحل ${shop?.name || ''}. يحتاج تأكيد يدوي.`,
        message_en: `OTP verification failed 3 times for number ${phoneRow.phone} on shop ${shop?.name || ''}. Needs manual confirmation.`,
        link_path: `/shops/${phoneRow.shop_id}`,
        entity_type: 'shop_phone',
        entity_id: phoneRow.id,
      });
    }
    return { ok: false, reason: 'wrong_code', attemptsLeft: Math.max(0, MAX_OTP_ATTEMPTS - attempts), needsManualConfirm };
  }
  db.prepare(
    `UPDATE shop_phones SET verified = 1, verified_at = datetime('now'), verified_by = 'otp', otp_code = NULL, otp_expires_at = NULL WHERE id = ?`
  ).run(phoneRow.id);
  return { ok: true };
}

function manualConfirm(phoneRow, byUser) {
  db.prepare(
    `UPDATE shop_phones SET verified = 1, verified_at = datetime('now'), verified_by = ?, otp_code = NULL, otp_expires_at = NULL WHERE id = ?`
  ).run(`manual:${byUser?.name || byUser?.id || 'unknown'}`, phoneRow.id);
  return db.prepare('SELECT * FROM shop_phones WHERE id = ?').get(phoneRow.id);
}

module.exports = { addPhone, requestOtp, verifyOtp, manualConfirm, MAX_OTP_ATTEMPTS, OTP_TTL_MINUTES };
