const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/init');
const { requirePermission, requireAuth } = require('../middleware/auth');

const router = express.Router();

const BRANDING_DIR = path.join(__dirname, '..', 'uploads', 'branding');
if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BRANDING_DIR),
    filename: (req, file, cb) => cb(null, `logo-${Date.now()}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpe?g|webp|svg)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن تكون الصورة بصيغة PNG أو JPG أو WEBP أو SVG'), ok);
  },
  limits: { fileSize: 3 * 1024 * 1024 },
});

function getSetting(companyId, key) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? '';
}

const PUBLIC_DEFAULT_KEYS = [
  'company_name',
  'company_logo_url',
  'default_language',
  'map_default_layer',
  'map_default_zoom',
  'map_clustering_enabled',
  'sound_default_muted',
  'sound_volume',
  'sound_chime_preset',
  'inventory_default_min_quantity',
  'inventory_default_unit',
];

// Cross-cutting UX defaults (branding, sound, map, inventory-entry) needed
// by screens every approved user sees regardless of their permission set
// (sidebar branding, the order-save chime, the map) — deliberately open to
// any authenticated user rather than gated by view_app/manage_settings like
// the full settings dump below, since none of these values are sensitive.
router.get('/public-defaults', requireAuth, (req, res) => {
  // requireAuth alone doesn't set req.companyId (that's requireCompany, via
  // the permission gates below) — a platform-admin account legitimately has
  // no company, and this route is reachable by any authenticated user, so
  // that case is rejected explicitly rather than falling through to an
  // unscoped settings query.
  if (!req.user.company_id) return res.status(403).json({ error: 'no_company_context' });
  const obj = {};
  for (const key of PUBLIC_DEFAULT_KEYS) obj[key] = getSetting(req.user.company_id, key);
  res.json(obj);
});

router.get('/', requirePermission('view_app'), (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE company_id = ?').all(req.companyId);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

router.put('/', requirePermission('manage_settings'), (req, res) => {
  const upsert = db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  );
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(req.companyId, k, String(v));
  });
  tx(Object.entries(req.body || {}));
  const rows = db.prepare('SELECT key, value FROM settings WHERE company_id = ?').all(req.companyId);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

router.post('/logo', requirePermission('manage_settings'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const url = `/uploads/branding/${req.file.filename}`;
  const previous = getSetting(req.companyId, 'company_logo_url');
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'company_logo_url', ?)
     ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(req.companyId, url);
  if (previous && previous.startsWith('/uploads/branding/')) {
    const oldPath = path.join(__dirname, '..', previous);
    fs.unlink(oldPath, () => {});
  }
  res.json({ company_logo_url: url });
});

module.exports = router;
