const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const { resolveRepScope } = require('../lib/repAccess');
const {
  logPointChange,
  ensureWaveInstancesForDay,
  getWavePoints,
  buildDayReport,
  checkGeofence,
  checkUnplannedVisit,
  checkLate,
} = require('../lib/waves');

const router = express.Router();
router.use(requireCompany);

const VISIT_MEDIA_DIR = path.join(__dirname, '..', 'uploads', 'visit-media');
if (!fs.existsSync(VISIT_MEDIA_DIR)) fs.mkdirSync(VISIT_MEDIA_DIR, { recursive: true });
const visitUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VISIT_MEDIA_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن تكون الصورة بصيغة PNG أو JPG أو WEBP'), ok);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

// ---------------------------------------------------------------------
// Weekly recurring templates
// ---------------------------------------------------------------------

router.get('/reps/:repId/templates', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const scope = resolveRepScope(req, Number(req.params.repId));
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  const templates = db
    .prepare('SELECT * FROM wave_templates WHERE company_id = ? AND rep_id = ? ORDER BY day_of_week, wave_number')
    .all(req.companyId, scope.repId);
  const withPoints = templates.map((t) => ({
    ...t,
    points: db
      .prepare(
        `SELECT wtp.*, s.name AS shop_name FROM wave_template_points wtp JOIN shops s ON s.id = wtp.shop_id
         WHERE wtp.wave_template_id = ? ORDER BY wtp.sequence`
      )
      .all(t.id),
  }));
  res.json(withPoints);
});

router.post('/reps/:repId/templates', requirePermission('manage_waves'), (req, res) => {
  const rep = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(req.params.repId, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });
  const { day_of_week, wave_number, label, region } = req.body || {};
  if (day_of_week == null || day_of_week < 0 || day_of_week > 6) return res.status(400).json({ error: 'invalid_day_of_week' });
  try {
    const info = db
      .prepare('INSERT INTO wave_templates (company_id, rep_id, day_of_week, wave_number, label, region) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.companyId, rep.id, day_of_week, wave_number || 1, label || null, region || null);
    res.status(201).json(db.prepare('SELECT * FROM wave_templates WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'wave_already_exists_for_this_day' });
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

router.put('/templates/:id', requirePermission('manage_waves'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM wave_templates WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  const { label, region } = req.body || {};
  db.prepare("UPDATE wave_templates SET label = ?, region = ?, updated_at = datetime('now') WHERE id = ?").run(
    label ?? tpl.label,
    region ?? tpl.region,
    tpl.id
  );
  res.json(db.prepare('SELECT * FROM wave_templates WHERE id = ?').get(tpl.id));
});

router.delete('/templates/:id', requirePermission('manage_waves'), (req, res) => {
  const tpl = db.prepare('SELECT id FROM wave_templates WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM wave_templates WHERE id = ?').run(tpl.id);
  res.status(204).end();
});

router.post('/templates/:id/points', requirePermission('manage_waves'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM wave_templates WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  const { shopId } = req.body || {};
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  if (!shop) return res.status(400).json({ error: 'shop_not_found' });
  const maxSeq = db.prepare('SELECT MAX(sequence) m FROM wave_template_points WHERE wave_template_id = ?').get(tpl.id).m || 0;
  try {
    const info = db
      .prepare('INSERT INTO wave_template_points (company_id, wave_template_id, shop_id, sequence) VALUES (?, ?, ?, ?)')
      .run(req.companyId, tpl.id, shop.id, maxSeq + 1);
    res.status(201).json(db.prepare('SELECT * FROM wave_template_points WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'shop_already_in_this_wave' });
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

router.delete('/templates/:id/points/:pointId', requirePermission('manage_waves'), (req, res) => {
  const point = db
    .prepare('SELECT * FROM wave_template_points WHERE id = ? AND wave_template_id = ? AND company_id = ?')
    .get(req.params.pointId, req.params.id, req.companyId);
  if (!point) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM wave_template_points WHERE id = ?').run(point.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Daily report — auto-built from the template, live status baked in via
// the shops join (so debt/overdue/order state is always current, not
// snapshotted at materialization time).
// ---------------------------------------------------------------------

router.get('/day', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const requestedRepId = Number(req.query.repId);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  if (!requestedRepId) return res.status(400).json({ error: 'repId_required' });
  const scope = resolveRepScope(req, requestedRepId);
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  const rep = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(scope.repId, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });
  const report = buildDayReport(req.companyId, scope.repId, date);
  for (const wave of report.waves) checkLate(req.companyId, wave);
  res.json(report);
});

// ---------------------------------------------------------------------
// Supervisor point management: add / cancel / reassign / reorder / status
// ---------------------------------------------------------------------

router.post('/instances/:id/points', requirePermission('manage_waves'), (req, res) => {
  const instance = db.prepare('SELECT * FROM wave_instances WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!instance) return res.status(404).json({ error: 'not_found' });
  const { shopId } = req.body || {};
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  if (!shop) return res.status(400).json({ error: 'shop_not_found' });
  const maxSeq = db.prepare('SELECT MAX(sequence) m FROM wave_points WHERE wave_instance_id = ?').get(instance.id).m || 0;
  const info = db
    .prepare('INSERT INTO wave_points (company_id, rep_id, wave_instance_id, shop_id, sequence) VALUES (?, ?, ?, ?, ?)')
    .run(req.companyId, instance.rep_id, instance.id, shop.id, maxSeq + 1);
  logPointChange(req.companyId, info.lastInsertRowid, { action: 'add_point', field: 'wave_instance_id', before: null, after: instance.id, user: req.user });
  res.status(201).json(getWavePoints(instance.id).find((p) => p.id === info.lastInsertRowid));
});

function getPoint(companyId, pointId) {
  return db.prepare('SELECT * FROM wave_points WHERE id = ? AND company_id = ?').get(pointId, companyId);
}

// Cancel = detach from the current wave. body.newWaveInstanceId (optional)
// re-homes it immediately in the same call; otherwise it becomes an
// unscheduled point a supervisor still has to resolve — the customer and
// any order tied to this point are never touched.
router.delete('/points/:id', requirePermission('manage_waves'), (req, res) => {
  const point = getPoint(req.companyId, req.params.id);
  if (!point) return res.status(404).json({ error: 'not_found' });
  const { newWaveInstanceId, reason } = req.body || {};

  let targetInstance = null;
  if (newWaveInstanceId) {
    targetInstance = db.prepare('SELECT * FROM wave_instances WHERE id = ? AND company_id = ?').get(newWaveInstanceId, req.companyId);
    if (!targetInstance) return res.status(400).json({ error: 'target_wave_not_found' });
  }

  db.prepare(
    `UPDATE wave_points SET wave_instance_id = ?, removed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(targetInstance ? targetInstance.id : null, point.id);
  logPointChange(req.companyId, point.id, {
    action: targetInstance ? 'move_wave' : 'remove_point',
    field: 'wave_instance_id',
    before: point.wave_instance_id,
    after: targetInstance ? targetInstance.id : null,
    user: req.user,
  });
  if (reason) {
    db.prepare('UPDATE wave_points SET not_visited_reason = ? WHERE id = ?').run(reason, point.id);
  }
  res.json(db.prepare('SELECT * FROM wave_points WHERE id = ?').get(point.id));
});

// Explicit reassign (distinct from cancel) for moving an already-unscheduled
// point onto a wave, or moving a scheduled point to a different wave/day
// without going through the "cancel" verb.
router.put('/points/:id/reassign', requirePermission('manage_waves'), (req, res) => {
  const point = getPoint(req.companyId, req.params.id);
  if (!point) return res.status(404).json({ error: 'not_found' });
  const { waveInstanceId } = req.body || {};
  let targetInstance = null;
  if (waveInstanceId) {
    targetInstance = db.prepare('SELECT * FROM wave_instances WHERE id = ? AND company_id = ?').get(waveInstanceId, req.companyId);
    if (!targetInstance) return res.status(400).json({ error: 'target_wave_not_found' });
  }
  const maxSeq = targetInstance
    ? db.prepare('SELECT MAX(sequence) m FROM wave_points WHERE wave_instance_id = ?').get(targetInstance.id).m || 0
    : 0;
  if (targetInstance) {
    db.prepare(
      `UPDATE wave_points SET wave_instance_id = ?, sequence = ?, removed_at = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(targetInstance.id, maxSeq + 1, point.id);
  } else {
    db.prepare(
      `UPDATE wave_points SET wave_instance_id = NULL, removed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(point.id);
  }
  logPointChange(req.companyId, point.id, {
    action: 'move_wave',
    field: 'wave_instance_id',
    before: point.wave_instance_id,
    after: targetInstance ? targetInstance.id : null,
    user: req.user,
  });
  res.json(db.prepare('SELECT * FROM wave_points WHERE id = ?').get(point.id));
});

router.put('/instances/:id/reorder', requirePermission('manage_waves'), (req, res) => {
  const instance = db.prepare('SELECT id FROM wave_instances WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!instance) return res.status(404).json({ error: 'not_found' });
  const { orderedPointIds } = req.body || {};
  if (!Array.isArray(orderedPointIds)) return res.status(400).json({ error: 'orderedPointIds_required' });
  const tx = db.transaction(() => {
    orderedPointIds.forEach((pointId, i) => {
      const point = db.prepare('SELECT * FROM wave_points WHERE id = ? AND wave_instance_id = ?').get(pointId, instance.id);
      if (!point) return;
      if (point.sequence !== i + 1) {
        logPointChange(req.companyId, point.id, { action: 'reorder', field: 'sequence', before: point.sequence, after: i + 1, user: req.user });
      }
      db.prepare('UPDATE wave_points SET sequence = ? WHERE id = ?').run(i + 1, point.id);
    });
  });
  tx();
  res.json(getWavePoints(instance.id));
});

router.put('/points/:id/status', requirePermission('manage_waves'), (req, res) => {
  const point = getPoint(req.companyId, req.params.id);
  if (!point) return res.status(404).json({ error: 'not_found' });
  const { status } = req.body || {};
  if (!['not_started', 'arrived', 'visited', 'order_taken'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const timestampField = { arrived: 'arrived_at', visited: 'visited_at', order_taken: 'order_taken_at' }[status];
  db.prepare(
    `UPDATE wave_points SET status = ?${timestampField ? `, ${timestampField} = datetime('now')` : ''}, updated_at = datetime('now') WHERE id = ?`
  ).run(status, point.id);
  logPointChange(req.companyId, point.id, { action: 'status_change', field: 'status', before: point.status, after: status, user: req.user });
  const updated = db.prepare('SELECT * FROM wave_points WHERE id = ?').get(point.id);
  if (updated.wave_instance_id) {
    const instance = db.prepare('SELECT * FROM wave_instances WHERE id = ?').get(updated.wave_instance_id);
    if (instance) checkLate(req.companyId, instance);
  }
  res.json(updated);
});

router.put('/points/:id/not-visited', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const point = getPoint(req.companyId, req.params.id);
  if (!point) return res.status(404).json({ error: 'not_found' });
  if (!resolveRepScope(req, point.rep_id).ok) return res.status(403).json({ error: 'forbidden' });
  const { reason } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ error: 'reason_required' });
  db.prepare("UPDATE wave_points SET not_visited_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason.trim(), point.id);
  logPointChange(req.companyId, point.id, { action: 'not_visited', field: 'not_visited_reason', before: point.not_visited_reason, after: reason.trim(), user: req.user });
  res.json(db.prepare('SELECT * FROM wave_points WHERE id = ?').get(point.id));
});

router.get('/points/:id/changes', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const point = getPoint(req.companyId, req.params.id);
  if (!point) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM wave_point_changes WHERE wave_point_id = ? ORDER BY changed_at DESC').all(point.id));
});

// ---------------------------------------------------------------------
// Wave start/end
// ---------------------------------------------------------------------

router.post('/instances/:id/start', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const instance = db.prepare('SELECT * FROM wave_instances WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!instance) return res.status(404).json({ error: 'not_found' });
  db.prepare("UPDATE wave_instances SET status = 'in_progress', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(instance.id);
  res.json(db.prepare('SELECT * FROM wave_instances WHERE id = ?').get(instance.id));
});

router.post('/instances/:id/end', requireAnyPermission('view_app', 'manage_waves'), async (req, res) => {
  const instance = db.prepare('SELECT * FROM wave_instances WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!instance) return res.status(404).json({ error: 'not_found' });
  db.prepare("UPDATE wave_instances SET status = 'completed', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(instance.id);
  const points = getWavePoints(instance.id);
  const notVisited = points.filter((p) => p.status !== 'visited' && p.status !== 'order_taken');

  let aiSummary = null;
  try {
    const { summarizeWave } = require('../lib/aiRecommendations');
    aiSummary = await summarizeWave(req.companyId, instance.id);
  } catch (err) {
    console.error('[waves] AI wave summary failed:', err.message);
  }

  res.json({ instance: db.prepare('SELECT * FROM wave_instances WHERE id = ?').get(instance.id), points, notVisited, aiSummary });
});

// ---------------------------------------------------------------------
// Visit form templates
// ---------------------------------------------------------------------

router.get('/visit-form-templates', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  res.json(db.prepare('SELECT * FROM visit_form_templates WHERE company_id = ? ORDER BY id DESC').all(req.companyId));
});

router.post('/visit-form-templates', requirePermission('manage_waves'), (req, res) => {
  const { name, tasks, questions } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
  const info = db
    .prepare('INSERT INTO visit_form_templates (company_id, name, tasks_json, questions_json) VALUES (?, ?, ?, ?)')
    .run(req.companyId, name.trim(), JSON.stringify(tasks || []), JSON.stringify(questions || []));
  res.status(201).json(db.prepare('SELECT * FROM visit_form_templates WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/visit-form-templates/:id', requirePermission('manage_waves'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM visit_form_templates WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  const { name, tasks, questions, active } = req.body || {};
  db.prepare("UPDATE visit_form_templates SET name = ?, tasks_json = ?, questions_json = ?, active = ?, updated_at = datetime('now') WHERE id = ?").run(
    name ?? tpl.name,
    tasks ? JSON.stringify(tasks) : tpl.tasks_json,
    questions ? JSON.stringify(questions) : tpl.questions_json,
    active === undefined ? tpl.active : active ? 1 : 0,
    tpl.id
  );
  res.json(db.prepare('SELECT * FROM visit_form_templates WHERE id = ?').get(tpl.id));
});

// ---------------------------------------------------------------------
// Visit records (the filled-in visit report)
// ---------------------------------------------------------------------

// pointId may be a real wave_points.id, or 'unplanned' + a shopId in the
// body — an unplanned visit still gets a full report, it's just flagged
// (checkUnplannedVisit) since it has no wave_point behind it.
router.post('/points/:id/visit', requirePermission('view_app'), visitUpload.fields([{ name: 'before', maxCount: 1 }, { name: 'after', maxCount: 1 }]), (req, res) => {
  let point = null;
  let shop = null;
  if (req.params.id !== 'unplanned') {
    point = getPoint(req.companyId, req.params.id);
    if (!point) return res.status(404).json({ error: 'not_found' });
    // A point belongs to the rep it was scheduled for (wave_points.rep_id)
    // — a plain rep may only record a visit against their own point, a
    // manage_waves holder (manager) may record against any.
    if (!resolveRepScope(req, point.rep_id).ok) return res.status(403).json({ error: 'forbidden' });
    shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(point.shop_id);
  } else {
    shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.body.shopId, req.companyId);
    if (!shop) return res.status(400).json({ error: 'shop_not_found' });
    // No wave point to check ownership against for an unplanned visit —
    // fall back to the shop's own rep assignment. An unassigned shop has
    // no owner to restrict against, so any view_app holder may log it.
    if (shop.assigned_rep_id != null && !resolveRepScope(req, shop.assigned_rep_id).ok) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  const { result, refusal_reason, not_visited_reason, tasks, answers, voice_note_text, signature_data_url, lat, lng } = req.body;
  const validResults = ['order_taken', 'no_order', 'shop_closed', 'refused', 'other'];
  const finalResult = validResults.includes(result) ? result : 'other';

  const info = db
    .prepare(
      `INSERT INTO visit_records (
         company_id, wave_point_id, shop_id, rep_id, form_template_id, result, refusal_reason, not_visited_reason,
         tasks_json, answers_json, voice_note_text, signature_data_url, lat, lng
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.companyId,
      point ? point.id : null,
      shop.id,
      req.user.id,
      req.body.form_template_id || null,
      finalResult,
      refusal_reason || null,
      not_visited_reason || null,
      tasks ? (typeof tasks === 'string' ? tasks : JSON.stringify(tasks)) : '{}',
      answers ? (typeof answers === 'string' ? answers : JSON.stringify(answers)) : '{}',
      voice_note_text || null,
      signature_data_url || null,
      lat ? Number(lat) : null,
      lng ? Number(lng) : null
    );
  const visitRecordId = info.lastInsertRowid;

  if (req.files?.before?.[0]) {
    db.prepare('INSERT INTO visit_media (company_id, visit_record_id, kind, url) VALUES (?, ?, ?, ?)').run(
      req.companyId,
      visitRecordId,
      'before',
      `/uploads/visit-media/${req.files.before[0].filename}`
    );
  }
  if (req.files?.after?.[0]) {
    db.prepare('INSERT INTO visit_media (company_id, visit_record_id, kind, url) VALUES (?, ?, ?, ?)').run(
      req.companyId,
      visitRecordId,
      'after',
      `/uploads/visit-media/${req.files.after[0].filename}`
    );
  }

  if (point) {
    db.prepare("UPDATE wave_points SET status = 'visited', visited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(point.id);
    logPointChange(req.companyId, point.id, { action: 'visit_recorded', field: 'status', before: point.status, after: 'visited', user: req.user });
  }

  checkGeofence(req.companyId, { rep: req.user, shop, lat: lat ? Number(lat) : null, lng: lng ? Number(lng) : null, visitRecordId });
  checkUnplannedVisit(req.companyId, { rep: req.user, shop, wavePointId: point?.id, visitRecordId });

  const media = db.prepare('SELECT * FROM visit_media WHERE visit_record_id = ?').all(visitRecordId);
  res.status(201).json({ ...db.prepare('SELECT * FROM visit_records WHERE id = ?').get(visitRecordId), media });
});

router.get('/points/:id/visits', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const point = getPoint(req.companyId, req.params.id);
  if (!point) return res.status(404).json({ error: 'not_found' });
  // Same ownership check as POST /points/:id/visit above — a point belongs
  // to the rep it was scheduled for; a plain view_app holder may only read
  // their own visit history, a manage_waves holder may read any.
  if (!resolveRepScope(req, point.rep_id).ok) return res.status(403).json({ error: 'forbidden' });
  const records = db.prepare('SELECT * FROM visit_records WHERE wave_point_id = ? AND company_id = ? ORDER BY recorded_at DESC').all(req.params.id, req.companyId);
  res.json(
    records.map((r) => ({ ...r, media: db.prepare('SELECT * FROM visit_media WHERE visit_record_id = ?').all(r.id) }))
  );
});

// ---------------------------------------------------------------------
// Calls / follow-ups
// ---------------------------------------------------------------------

router.post('/calls', requirePermission('view_app'), (req, res) => {
  const { shopId, call_type, outcome, notes, follow_up_at } = req.body || {};
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  if (!shop) return res.status(400).json({ error: 'shop_not_found' });
  const info = db
    .prepare('INSERT INTO rep_calls (company_id, rep_id, shop_id, call_type, outcome, notes, follow_up_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.companyId, req.user.id, shop.id, call_type === 'follow_up' ? 'follow_up' : 'call', outcome || null, notes || null, follow_up_at || null);
  res.status(201).json(db.prepare('SELECT * FROM rep_calls WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/calls', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const { shopId } = req.query;
  const scope = resolveRepScope(req, req.query.repId ? Number(req.query.repId) : null);
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  let sql = 'SELECT * FROM rep_calls WHERE company_id = ?';
  const params = [req.companyId];
  if (scope.repId) {
    sql += ' AND rep_id = ?';
    params.push(scope.repId);
  }
  if (shopId) {
    sql += ' AND shop_id = ?';
    params.push(shopId);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Reminders due: follow_up_at has passed and not yet reminded — a
// polling/sweep endpoint the frontend (or a future timer) calls.
router.get('/calls/due-reminders', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  // No repId param here — unlike /calls, this list has no explicit
  // "whose reminders" input to check, it's just unconditionally
  // company-wide. Same rule applies anyway: a plain rep sees only their
  // own due reminders, a manage_waves holder sees everyone's.
  const scope = resolveRepScope(req, null);
  const sql = scope.repId
    ? "SELECT * FROM rep_calls WHERE company_id = ? AND rep_id = ? AND follow_up_at IS NOT NULL AND follow_up_at <= datetime('now') AND reminded = 0"
    : "SELECT * FROM rep_calls WHERE company_id = ? AND follow_up_at IS NOT NULL AND follow_up_at <= datetime('now') AND reminded = 0";
  const params = scope.repId ? [req.companyId, scope.repId] : [req.companyId];
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

router.post('/calls/:id/remind', requireAnyPermission('view_app', 'manage_waves'), (req, res) => {
  const call = db.prepare('SELECT * FROM rep_calls WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!call) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE rep_calls SET reminded = 1 WHERE id = ?').run(call.id);
  res.status(204).end();
});

module.exports = router;
