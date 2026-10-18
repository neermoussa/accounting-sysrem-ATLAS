const db = require('../db/init');
const { haversineKm } = require('./geo');
const { createNotification, hasUnreadNotification } = require('./notify');

function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function logPointChange(companyId, pointId, { action, field, before, after, user }) {
  db.prepare(
    `INSERT INTO wave_point_changes (company_id, wave_point_id, action, field, before_value, after_value, changed_by_id, changed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    pointId,
    action,
    field || null,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    user?.id ?? null,
    user?.name ?? null
  );
}

// Idempotent: the first request for a given rep/date/wave materializes that
// day's wave_instance + wave_points straight from whatever wave_templates
// exist for that weekday; every later request for the same day just
// returns the already-materialized (and possibly since-edited) instance —
// the template is never re-applied on top of manual edits.
function ensureWaveInstancesForDay(companyId, repId, planDate) {
  const dow = dayOfWeek(planDate);
  const templates = db
    .prepare('SELECT * FROM wave_templates WHERE company_id = ? AND rep_id = ? AND day_of_week = ? ORDER BY wave_number')
    .all(companyId, repId, dow);

  for (const tpl of templates) {
    const existing = db
      .prepare('SELECT id FROM wave_instances WHERE company_id = ? AND rep_id = ? AND plan_date = ? AND wave_number = ?')
      .get(companyId, repId, planDate, tpl.wave_number);
    if (existing) continue;

    const info = db
      .prepare(
        `INSERT INTO wave_instances (company_id, rep_id, plan_date, wave_number, label, region, created_from_template_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(companyId, repId, planDate, tpl.wave_number, tpl.label, tpl.region, tpl.id);
    const instanceId = info.lastInsertRowid;

    const points = db
      .prepare('SELECT * FROM wave_template_points WHERE wave_template_id = ? ORDER BY sequence')
      .all(tpl.id);
    const insertPoint = db.prepare(
      `INSERT INTO wave_points (company_id, rep_id, wave_instance_id, shop_id, sequence) VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of points) insertPoint.run(companyId, repId, instanceId, p.shop_id, p.sequence);
  }

  return db
    .prepare('SELECT * FROM wave_instances WHERE company_id = ? AND rep_id = ? AND plan_date = ? ORDER BY wave_number')
    .all(companyId, repId, planDate);
}

function getWavePoints(waveInstanceId) {
  return db
    .prepare(
      `SELECT wp.*, s.name AS shop_name, s.phone AS shop_phone, s.address AS shop_address, s.lat AS shop_lat, s.lng AS shop_lng
       FROM wave_points wp JOIN shops s ON s.id = wp.shop_id
       WHERE wp.wave_instance_id = ? ORDER BY wp.sequence, wp.id`
    )
    .all(waveInstanceId);
}

function buildDayReport(companyId, repId, planDate) {
  const instances = ensureWaveInstancesForDay(companyId, repId, planDate);
  const waves = instances.map((inst) => ({
    ...inst,
    points: getWavePoints(inst.id),
  }));
  const unscheduled = db
    .prepare(
      `SELECT wp.*, s.name AS shop_name, s.phone AS shop_phone
       FROM wave_points wp JOIN shops s ON s.id = wp.shop_id
       WHERE wp.company_id = ? AND wp.rep_id = ? AND wp.wave_instance_id IS NULL AND wp.removed_at IS NOT NULL
       ORDER BY wp.removed_at DESC`
    )
    .all(companyId, repId);
  return { planDate, repId, waves, unscheduled };
}

// Geofence + lateness + unplanned-visit checks, run right after a visit is
// recorded or a point's status changes — each condition fires at most one
// unread notification per point/visit (createNotification+entity_id is
// enough de-dup on its own for a one-shot event like this).
const GEOFENCE_ALERT_TYPE = 'rep_geofence_violation';
const UNPLANNED_VISIT_TYPE = 'rep_unplanned_visit';
const LATE_WAVE_TYPE = 'rep_late';

function geofenceRadiusMeters(companyId) {
  const value = db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'geofence_radius_meters'").get(companyId)?.value;
  return value ? Number(value) : 500; // sane default: 500m
}

function checkGeofence(companyId, { rep, shop, lat, lng, visitRecordId }) {
  if (lat == null || lng == null || shop.lat == null || shop.lng == null) return;
  const distanceKm = haversineKm({ lat, lng }, { lat: shop.lat, lng: shop.lng });
  const radiusKm = geofenceRadiusMeters(companyId) / 1000;
  if (distanceKm > radiusKm) {
    createNotification({
      companyId,
      type: GEOFENCE_ALERT_TYPE,
      message_ar: `المندوب ${rep.name} سجّل زيارة لمحل ${shop.name} من خارج المنطقة المخصصة (${Math.round(distanceKm * 1000)} م).`,
      message_en: `Rep ${rep.name} recorded a visit to ${shop.name} outside the assigned area (${Math.round(distanceKm * 1000)}m).`,
      link_path: `/shops/${shop.id}`,
      entity_type: 'visit_record',
      entity_id: visitRecordId,
    });
    // AI advisory layer: the same event, recorded as a severity-rated,
    // human-decidable row (lib/aiRecommendations.js) — separate toggle,
    // separate audit trail, on top of (not instead of) the notification
    // above.
    try {
      require('./aiRecommendations').flagGeofenceAnomaly(companyId, { rep, shop, distanceKm, radiusKm, visitRecordId });
    } catch (err) {
      console.error('[waves] AI geofence anomaly flagging failed:', err.message);
    }
  }
}

function checkUnplannedVisit(companyId, { rep, shop, waveInstanceId, wavePointId, visitRecordId }) {
  if (wavePointId) return; // a visit tied to a real scheduled point is never "unplanned"
  createNotification({
    companyId,
    type: UNPLANNED_VISIT_TYPE,
    message_ar: `المندوب ${rep.name} زار محل ${shop.name} دون أن يكون مجدولًا ضمن خطته.`,
    message_en: `Rep ${rep.name} visited ${shop.name} without it being on their planned schedule.`,
    link_path: `/shops/${shop.id}`,
    entity_type: 'visit_record',
    entity_id: visitRecordId,
  });
}

// Fires at most once per wave (hasUnreadNotification de-dupes by
// entity_id) once the wave has been running longer than
// expected_minutes_per_point × remaining unstarted points would justify —
// a simple, explainable pace check rather than anything needing live GPS.
function checkLate(companyId, waveInstance) {
  if (!waveInstance.started_at || waveInstance.status === 'completed') return;
  if (hasUnreadNotification(companyId, LATE_WAVE_TYPE, waveInstance.id, 'wave_instance')) return;

  const points = getWavePoints(waveInstance.id);
  const total = points.length;
  if (total === 0) return;
  const done = points.filter((p) => p.status === 'visited' || p.status === 'order_taken').length;
  const expectedMinutesPerPoint = Number(
    db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'wave_expected_minutes_per_point'").get(companyId)?.value || 20
  );
  const elapsedMinutes = (Date.now() - new Date(waveInstance.started_at.replace(' ', 'T') + 'Z').getTime()) / 60000;
  const expectedMinutesSoFar = done * expectedMinutesPerPoint;
  // Only alert once the rep is meaningfully behind pace (more than 1.5x one
  // point's worth of time over what their completed count would predict).
  if (elapsedMinutes - expectedMinutesSoFar > expectedMinutesPerPoint * 1.5 && done < total) {
    const rep = db.prepare('SELECT name FROM users WHERE id = ?').get(waveInstance.rep_id);
    createNotification({
      companyId,
      type: LATE_WAVE_TYPE,
      message_ar: `المندوب ${rep?.name || ''} متأخر عن الوتيرة المتوقعة في لفة ${waveInstance.plan_date} (أنجز ${done} من ${total}).`,
      message_en: `Rep ${rep?.name || ''} is behind pace on the ${waveInstance.plan_date} wave (${done}/${total} done).`,
      link_path: `/rep-waves/${waveInstance.id}`,
      entity_type: 'wave_instance',
      entity_id: waveInstance.id,
    });
  }
}

module.exports = {
  dayOfWeek,
  logPointChange,
  ensureWaveInstancesForDay,
  getWavePoints,
  buildDayReport,
  checkGeofence,
  checkUnplannedVisit,
  checkLate,
  GEOFENCE_ALERT_TYPE,
  UNPLANNED_VISIT_TYPE,
  LATE_WAVE_TYPE,
};
