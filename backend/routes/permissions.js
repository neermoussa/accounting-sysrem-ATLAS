const express = require('express');
const db = require('../db/init');
const { requirePermission } = require('../middleware/auth');
const { publicUser } = require('../lib/auth');
const { logAudit } = require('../lib/auditLog');
const {
  PERMISSIONS,
  MANAGE_PERMISSIONS,
  MANAGE_PERMISSIONS_LABEL,
  ALL_PERMISSION_KEYS,
  isValidPermission,
  getUserPermissions,
  setUserPermissions,
  grantPermission,
  revokePermission,
  countHoldersOf,
  getTemplates,
} = require('../lib/permissions');

const router = express.Router();
// Every route below is the exclusive "manager's permission" screen — only
// someone who already holds manage_permissions can reach any of it,
// including reading it. There is no read-only view for anyone else.
router.use(requirePermission('manage_permissions'));

router.get('/catalog', (req, res) => {
  res.json({
    permissions: ALL_PERMISSION_KEYS.map((key) => ({ key, label: PERMISSIONS[key] })),
    managePermissions: { key: MANAGE_PERMISSIONS, label: MANAGE_PERMISSIONS_LABEL },
  });
});

router.get('/users', (req, res) => {
  const users = db
    .prepare(`SELECT * FROM users WHERE company_id = ? ORDER BY (status = 'pending') DESC, created_at DESC`)
    .all(req.companyId);
  res.json(users.map(publicUser));
});

router.get('/templates', (req, res) => {
  res.json(getTemplates(req.companyId));
});

router.post('/templates', (req, res) => {
  const { name, permissions } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
  const list = Array.isArray(permissions) ? permissions.filter(isValidPermission) : [];
  try {
    const info = db
      .prepare('INSERT INTO permission_templates (company_id, name, permissions_json) VALUES (?, ?, ?)')
      .run(req.companyId, name.trim(), JSON.stringify([...new Set(list)]));
    const template = db.prepare('SELECT * FROM permission_templates WHERE id = ? AND company_id = ?').get(info.lastInsertRowid, req.companyId);
    res.status(201).json({ ...template, permissions: JSON.parse(template.permissions_json) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'template_name_exists' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

// Built-in templates (company_id IS NULL) are intentionally excluded from
// this lookup — they're readable/usable by every company as starting
// points, but never editable, so an unscoped id can't be used to modify a
// platform-wide template through a company-scoped endpoint.
router.put('/templates/:id', (req, res) => {
  const template = db.prepare('SELECT * FROM permission_templates WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!template) return res.status(404).json({ error: 'template_not_found' });
  const { name, permissions } = req.body || {};
  const nextName = name?.trim() || template.name;
  const nextPermissions = Array.isArray(permissions)
    ? [...new Set(permissions.filter(isValidPermission))]
    : JSON.parse(template.permissions_json);
  try {
    db.prepare(
      `UPDATE permission_templates SET name = ?, permissions_json = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
    ).run(nextName, JSON.stringify(nextPermissions), template.id, req.companyId);
    const updated = db.prepare('SELECT * FROM permission_templates WHERE id = ? AND company_id = ?').get(template.id, req.companyId);
    res.json({ ...updated, permissions: JSON.parse(updated.permissions_json) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'template_name_exists' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

router.delete('/templates/:id', (req, res) => {
  const template = db.prepare('SELECT * FROM permission_templates WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!template) return res.status(404).json({ error: 'template_not_found' });
  db.prepare('DELETE FROM permission_templates WHERE id = ? AND company_id = ?').run(template.id, req.companyId);
  res.status(204).end();
});

// Full replace of a user's regular permission set. manage_permissions is
// deliberately never accepted here — even if the caller's request body
// includes it, it's silently stripped — so granting it is always its own
// explicit, separately-logged action via the endpoint below, never a side
// effect of a broader template apply or checkbox-grid save.
router.put('/users/:id/permissions', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const { permissions } = req.body || {};
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions_array_required' });
  const invalid = permissions.filter((p) => p !== MANAGE_PERMISSIONS && !isValidPermission(p));
  if (invalid.length) return res.status(400).json({ error: 'invalid_permissions', permissions: invalid });

  const before = getUserPermissions(user.id);
  const hadMeta = before.includes(MANAGE_PERMISSIONS);
  const next = permissions.filter((p) => p !== MANAGE_PERMISSIONS);
  if (hadMeta) next.push(MANAGE_PERMISSIONS); // preserved, not settable from this endpoint

  setUserPermissions(user.id, next, req.user.id);

  logAudit({
    companyId: req.companyId,
    actor: req.user,
    action: 'permissions_set',
    entityType: 'user',
    entityId: user.id,
    before: { permissions: before },
    after: { permissions: next },
  });

  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(user.id, req.companyId)));
});

// A template applied here may be either this company's own custom template
// or one of the platform-wide built-ins (company_id IS NULL) — both are
// valid starting points, but never another company's custom template.
router.post('/users/:id/apply-template/:templateId', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const template = db
    .prepare('SELECT * FROM permission_templates WHERE id = ? AND (company_id IS NULL OR company_id = ?)')
    .get(req.params.templateId, req.companyId);
  if (!template) return res.status(404).json({ error: 'template_not_found' });

  const before = getUserPermissions(user.id);
  const hadMeta = before.includes(MANAGE_PERMISSIONS);
  const next = JSON.parse(template.permissions_json).filter(isValidPermission);
  if (hadMeta) next.push(MANAGE_PERMISSIONS);

  setUserPermissions(user.id, next, req.user.id);

  logAudit({
    companyId: req.companyId,
    actor: req.user,
    action: 'permissions_apply_template',
    entityType: 'user',
    entityId: user.id,
    before: { permissions: before, template: null },
    after: { permissions: next, template: template.name },
  });

  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(user.id, req.companyId)));
});

// The one truly exclusive toggle: grants/revokes the ability to manage
// everyone's permissions, including one's own. Blocked from ever reaching
// zero holders — that would permanently lock the whole permission system
// with nobody left able to fix it short of editing the database directly.
router.put('/users/:id/manage-permissions', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const { grant } = req.body || {};
  if (typeof grant !== 'boolean') return res.status(400).json({ error: 'grant_boolean_required' });

  const currentlyHolds = getUserPermissions(user.id).includes(MANAGE_PERMISSIONS);

  if (!grant && currentlyHolds && countHoldersOf(MANAGE_PERMISSIONS, req.companyId) <= 1) {
    return res.status(400).json({ error: 'cannot_remove_last_permission_manager' });
  }

  if (grant) grantPermission(user.id, MANAGE_PERMISSIONS, req.user.id);
  else revokePermission(user.id, MANAGE_PERMISSIONS);

  logAudit({
    companyId: req.companyId,
    actor: req.user,
    action: grant ? 'manage_permissions_grant' : 'manage_permissions_revoke',
    entityType: 'user',
    entityId: user.id,
    before: { manage_permissions: currentlyHolds },
    after: { manage_permissions: grant },
  });

  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(user.id, req.companyId)));
});

module.exports = router;
