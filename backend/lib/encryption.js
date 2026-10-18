const crypto = require('crypto');

// Field-level encryption at rest for genuinely sensitive DB columns (spec
// item 1) — separate from and in addition to transport encryption (HTTPS,
// terminated at Nginx in production per DEPLOYMENT.md; this sandbox has no
// real TLS to test). AES-256-GCM: authenticated, so tampering with a
// stored ciphertext is detected on decrypt rather than silently producing
// garbage. The key comes from ENCRYPTION_KEY (32 raw bytes, base64) — a
// fixed dev-only fallback is used when it's unset so every environment
// this app runs in (including this sandbox) still works, but production
// deployment MUST set a real one (see DEPLOYMENT.md) or every row
// encrypted under the fallback becomes unreadable the moment it's changed.
const DEV_FALLBACK_KEY_B64 = 'sQ8x6bYQ3sVJmXHU2NnE0Yy2VqzKt7hR9pQeLxN3fWk=';

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || DEV_FALLBACK_KEY_B64;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

// Returns "iv:authTag:ciphertext" (all base64) — a single self-contained
// string that fits in a normal TEXT column.
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(stored) {
  if (stored === null || stored === undefined) return null;
  const parts = String(stored).split(':');
  if (parts.length !== 3) return null; // not our format — caller decides what to do with legacy/plain data
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    console.error('[encryption] decrypt failed (wrong key or tampered data):', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
