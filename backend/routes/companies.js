const express = require('express');
const db = require('../db/init');
const { requireCompany, requirePermission } = require('../middleware/auth');
const { createSession, setSessionCookie, publicUser } = require('../lib/auth');
const {
  createCompanyWithAdmin,
  getCompany,
  updateCompanyProfile,
  updateModules,
  markSetupComplete,
  getSetupState,
  saveSetupState,
  snapshotConfig,
} = require('../lib/companies');

const router = express.Router();

// The one and only way a company comes into existence — no seeded/default
// company anywhere else in this codebase. Creates the company row and its
// first user (that company's manager, auto-approved, full permissions) in
// one transaction, then logs the new manager straight into a session so
// they land directly in the Startup Setup wizard.
router.post('/', (req, res) => {
  const { companyName, adminName, adminContact, adminPassword, currency, acceptedPrivacyPolicy } = req.body || {};
  if (!companyName?.trim() || !adminName?.trim() || !adminContact?.trim() || !adminPassword) {
    return res.status(400).json({ error: 'company_name_admin_name_contact_password_required' });
  }
  if (adminPassword.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  // Spec item 4: the privacy policy (GET /api/legal/privacy-policy) must be
  // shown and explicitly accepted before any data collection — enforced
  // here at the only entry point a company can ever be created through,
  // not left to the frontend's discretion.
  if (acceptedPrivacyPolicy !== true) {
    return res.status(400).json({ error: 'privacy_policy_must_be_accepted' });
  }
  try {
    const { company, admin } = createCompanyWithAdmin({
      companyName: companyName.trim(),
      adminName: adminName.trim(),
      adminContact: adminContact.trim(),
      adminPassword,
      currency,
    });
    const { token } = createSession(admin.id);
    setSessionCookie(req, res, token);
    res.status(201).json({ company: getCompany(company.id), user: publicUser({ ...admin, permissions: undefined }) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'contact_already_registered' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

router.get('/me', requireCompany, (req, res) => {
  res.json(getCompany(req.companyId));
});

router.put('/me', requirePermission('manage_settings'), (req, res) => {
  try {
    snapshotConfig(req.companyId, 'profile_edit', req.user);
    res.json(updateCompanyProfile(req.companyId, req.body || {}));
  } catch (err) {
    if (err.code === 'currency_locked') return res.status(409).json({ error: err.code, message: err.message });
    throw err;
  }
});

router.get('/setup', requireCompany, (req, res) => {
  res.json({ company: getCompany(req.companyId), setup: getSetupState(req.companyId) });
});

// Saved as a draft on every step — a manager can leave the wizard mid-way
// and come back to exactly where they were. `stepData` is whatever fields
// that step collected; merged into the company profile immediately so nothing
// is lost even if `completedSteps` never reaches the end.
router.put('/setup', requirePermission('manage_settings'), (req, res) => {
  const { currentStep, completedSteps, stepData } = req.body || {};
  if (stepData && typeof stepData === 'object') {
    try {
      updateCompanyProfile(req.companyId, stepData);
    } catch (err) {
      if (err.code === 'currency_locked') return res.status(409).json({ error: err.code, message: err.message });
      throw err;
    }
  }
  const setup = saveSetupState(req.companyId, { currentStep, completedSteps });
  res.json({ company: getCompany(req.companyId), setup });
});

router.post('/setup/complete', requirePermission('manage_settings'), (req, res) => {
  markSetupComplete(req.companyId);
  res.json(getCompany(req.companyId));
});

router.put('/modules', requirePermission('manage_settings'), (req, res) => {
  snapshotConfig(req.companyId, 'modules_toggle', req.user);
  res.json(updateModules(req.companyId, req.body?.modules || {}));
});

// ---- Warehouses ----
router.get('/warehouses', requireCompany, (req, res) => {
  res.json(db.prepare('SELECT * FROM warehouses WHERE company_id = ? ORDER BY created_at').all(req.companyId));
});
router.post('/warehouses', requirePermission('manage_settings'), (req, res) => {
  const { name, kind, branch } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
  const info = db
    .prepare('INSERT INTO warehouses (company_id, name, kind, branch) VALUES (?, ?, ?, ?)')
    .run(req.companyId, name.trim(), kind || 'factory', branch?.trim() || null);
  res.status(201).json(db.prepare('SELECT * FROM warehouses WHERE id = ?').get(info.lastInsertRowid));
});
router.delete('/warehouses/:id', requirePermission('manage_settings'), (req, res) => {
  const row = db.prepare('SELECT id FROM warehouses WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM warehouses WHERE id = ?').run(row.id);
  res.status(204).end();
});

// Custom customer-profile fields a company's manager defines for their own
// shop records (item 6 of the customer-profile spec) — stored per-company,
// values live in each shop's custom_fields_json keyed by `key`.
router.get('/custom-fields', requireCompany, (req, res) => {
  res.json(db.prepare('SELECT * FROM company_custom_fields WHERE company_id = ? ORDER BY id').all(req.companyId));
});
router.post('/custom-fields', requirePermission('manage_settings'), (req, res) => {
  const { key, label, field_type, options } = req.body || {};
  if (!key?.trim() || !label?.trim()) return res.status(400).json({ error: 'key_and_label_required' });
  const cleanKey = key.trim().replace(/\s+/g, '_');
  try {
    const info = db
      .prepare('INSERT INTO company_custom_fields (company_id, key, label, field_type, options_json) VALUES (?, ?, ?, ?, ?)')
      .run(req.companyId, cleanKey, label.trim(), field_type || 'text', Array.isArray(options) ? JSON.stringify(options) : null);
    res.status(201).json(db.prepare('SELECT * FROM company_custom_fields WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'key_already_exists' });
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});
router.delete('/custom-fields/:id', requirePermission('manage_settings'), (req, res) => {
  const row = db.prepare('SELECT id FROM company_custom_fields WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM company_custom_fields WHERE id = ?').run(row.id);
  res.status(204).end();
});

// ---- Vehicles + rep assignment ----
router.get('/vehicles', requireCompany, (req, res) => {
  const vehicles = db.prepare('SELECT * FROM vehicles WHERE company_id = ? ORDER BY created_at').all(req.companyId);
  const reps = db
    .prepare(
      `SELECT vr.vehicle_id, u.id as user_id, u.name FROM vehicle_reps vr
       JOIN users u ON u.id = vr.user_id WHERE vr.vehicle_id IN (SELECT id FROM vehicles WHERE company_id = ?)`
    )
    .all(req.companyId);
  res.json(
    vehicles.map((v) => ({ ...v, reps: reps.filter((r) => r.vehicle_id === v.id).map((r) => ({ id: r.user_id, name: r.name })) }))
  );
});
router.post('/vehicles', requirePermission('manage_settings'), (req, res) => {
  const { label } = req.body || {};
  if (!label?.trim()) return res.status(400).json({ error: 'label_required' });
  const info = db.prepare('INSERT INTO vehicles (company_id, label) VALUES (?, ?)').run(req.companyId, label.trim());
  res.status(201).json(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(info.lastInsertRowid));
});
router.delete('/vehicles/:id', requirePermission('manage_settings'), (req, res) => {
  const row = db.prepare('SELECT id FROM vehicles WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(row.id);
  res.status(204).end();
});
router.put('/vehicles/:id/reps', requirePermission('manage_settings'), (req, res) => {
  const vehicle = db.prepare('SELECT id FROM vehicles WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!vehicle) return res.status(404).json({ error: 'not_found' });
  const repIds = Array.isArray(req.body?.repIds) ? req.body.repIds : [];
  // Every rep id must actually belong to this company — silently drop
  // anything else rather than trust the client's list at face value.
  const validRepIds = repIds.filter((id) =>
    db.prepare('SELECT 1 FROM users WHERE id = ? AND company_id = ?').get(id, req.companyId)
  );
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vehicle_reps WHERE vehicle_id = ?').run(vehicle.id);
    const insert = db.prepare('INSERT INTO vehicle_reps (vehicle_id, user_id) VALUES (?, ?)');
    for (const repId of validRepIds) insert.run(vehicle.id, repId);
  });
  tx();
  res.json({ vehicleId: vehicle.id, repIds: validRepIds });
});

// ---- Requests that only a platform admin can approve (routes/platformAdmin.js) ----

router.get('/data-restore-requests', requireCompany, (req, res) => {
  res.json(
    db.prepare('SELECT * FROM data_restore_requests WHERE company_id = ? ORDER BY created_at DESC').all(req.companyId)
  );
});
router.post('/data-restore-requests', requirePermission('manage_settings'), (req, res) => {
  const { description } = req.body || {};
  if (!description?.trim()) return res.status(400).json({ error: 'description_required' });
  const info = db
    .prepare(
      `INSERT INTO data_restore_requests (company_id, description, requested_by_id, requested_by_name)
       VALUES (?, ?, ?, ?)`
    )
    .run(req.companyId, description.trim(), req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM data_restore_requests WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/document-templates', requireCompany, (req, res) => {
  res.json(
    db.prepare('SELECT * FROM document_templates WHERE company_id = ? ORDER BY created_at DESC').all(req.companyId)
  );
});
router.post('/document-templates', requirePermission('manage_settings'), (req, res) => {
  const { name, file_path, document_type } = req.body || {};
  const { isValidDocumentType } = require('../lib/documentTemplates');
  if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
  if (!isValidDocumentType(document_type)) return res.status(400).json({ error: 'invalid_document_type' });
  const info = db
    .prepare(
      `INSERT INTO document_templates (company_id, document_type, name, file_path, submitted_by_id, submitted_by_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, document_type, name.trim(), file_path || null, req.user.id, req.user.name);
  // Never auto-published as usable — routes/documentTemplates.js's PUT
  // /selections only accepts a custom_template_id once status='approved'
  // (Platform Admin, routes/platformAdmin.js's reviewQueue).
  res.status(201).json(db.prepare('SELECT * FROM document_templates WHERE id = ?').get(info.lastInsertRowid));
});

module.exports = router;
