const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const { periodRange, getCommissionSettings, setCommissionSettings, computeCommissionStatement, sumAttributedSales } = require('../lib/commissions');

const router = express.Router();
router.use(requireCompany);

// ---------------------------------------------------------------------
// Rep profile: region, linked customers, vehicle, targets, commission,
// results — one aggregate read.
// ---------------------------------------------------------------------

router.get('/:id/profile', requireAnyPermission('view_app', 'manage_users', 'manage_rep_targets'), (req, res) => {
  const rep = db.prepare("SELECT id, name, contact, region, role FROM users WHERE id = ? AND company_id = ?").get(req.params.id, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });

  const shops = db.prepare('SELECT id, name, phone, region, active FROM shops WHERE company_id = ? AND assigned_rep_id = ?').all(req.companyId, rep.id);
  const vehicles = db
    .prepare('SELECT v.id, v.label FROM vehicles v JOIN vehicle_reps vr ON vr.vehicle_id = v.id WHERE vr.user_id = ? AND v.company_id = ?')
    .all(rep.id, req.companyId);
  const targets = db.prepare('SELECT * FROM rep_targets WHERE company_id = ? AND user_id = ?').all(req.companyId, rep.id);
  const { start: monthStart, end: monthEnd } = periodRange('monthly');
  const results = sumAttributedSales(req.companyId, rep.id, monthStart, monthEnd);

  res.json({ ...rep, shops, vehicles, targets, monthToDate: { ...results, start: monthStart, end: monthEnd } });
});

router.put('/:id/profile', requirePermission('manage_users'), (req, res) => {
  const rep = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });
  const { region } = req.body || {};
  db.prepare('UPDATE users SET region = ? WHERE id = ? AND company_id = ?').run(region ?? rep.region, rep.id, req.companyId);
  res.json({ id: rep.id, region: region ?? rep.region });
});

// ---------------------------------------------------------------------
// Targets (daily/weekly/monthly × sales/collection/visits/product)
// ---------------------------------------------------------------------

router.get('/:id/targets', requireAnyPermission('view_app', 'manage_rep_targets'), (req, res) => {
  res.json(db.prepare('SELECT * FROM rep_targets WHERE company_id = ? AND user_id = ?').all(req.companyId, req.params.id));
});

router.put('/:id/targets', requirePermission('manage_rep_targets'), (req, res) => {
  const rep = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });
  const { period, target_type, product_id, target_value } = req.body || {};
  if (!['daily', 'weekly', 'monthly'].includes(period)) return res.status(400).json({ error: 'invalid_period' });
  const type = target_type || 'sales';
  if (!['sales', 'collection', 'visits', 'product'].includes(type)) return res.status(400).json({ error: 'invalid_target_type' });
  if (type === 'product' && !product_id) return res.status(400).json({ error: 'product_id_required_for_product_target' });
  const productIdValue = type === 'product' ? product_id : 0;

  if (target_value === null || target_value === undefined || target_value === '') {
    db.prepare('DELETE FROM rep_targets WHERE company_id = ? AND user_id = ? AND period = ? AND target_type = ? AND product_id = ?').run(
      req.companyId,
      rep.id,
      period,
      type,
      productIdValue
    );
    return res.json({ deleted: true });
  }

  db.prepare(
    `INSERT INTO rep_targets (company_id, user_id, period, target_type, product_id, target_value)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, period, target_type, product_id) DO UPDATE SET target_value = excluded.target_value, updated_at = datetime('now')`
  ).run(req.companyId, rep.id, period, type, productIdValue, Number(target_value));
  res.json(
    db
      .prepare('SELECT * FROM rep_targets WHERE company_id = ? AND user_id = ? AND period = ? AND target_type = ? AND product_id = ?')
      .get(req.companyId, rep.id, period, type, productIdValue)
  );
});

// ---------------------------------------------------------------------
// Attendance (check-in/out, route start/end) — location optional per
// company setting.
// ---------------------------------------------------------------------

function locationRequired(companyId) {
  return db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'attendance_location_required'").get(companyId)?.value === '1';
}

router.get('/attendance/settings', (req, res) => {
  res.json({ locationRequired: locationRequired(req.companyId) });
});

router.put('/attendance/settings', requirePermission('manage_settings'), (req, res) => {
  const required = req.body?.locationRequired ? '1' : '0';
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'attendance_location_required', ?)
     ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(req.companyId, required);
  res.json({ locationRequired: required === '1' });
});

router.post('/attendance', (req, res) => {
  const { type, lat, lng } = req.body || {};
  if (!['check_in', 'check_out', 'route_start', 'route_end'].includes(type)) return res.status(400).json({ error: 'invalid_type' });
  const required = locationRequired(req.companyId);
  if (required && (lat == null || lng == null)) {
    return res.status(400).json({ error: 'location_required' });
  }
  const info = db
    .prepare('INSERT INTO rep_attendance (company_id, user_id, type, lat, lng, location_required) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, req.user.id, type, lat ?? null, lng ?? null, required ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM rep_attendance WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/:id/attendance', requireAnyPermission('view_app', 'manage_users'), (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM rep_attendance WHERE company_id = ? AND user_id = ?';
  const params = [req.companyId, req.params.id];
  if (from) {
    sql += ' AND recorded_at >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND recorded_at <= ?';
    params.push(`${to} 23:59:59`);
  }
  sql += ' ORDER BY recorded_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// ---------------------------------------------------------------------
// Route points (data structure only — periodic samples, no live stream)
// ---------------------------------------------------------------------

router.post('/route-points', (req, res) => {
  const { lat, lng, speed_kmh, activity, shop_id } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat_lng_required' });
  const info = db
    .prepare('INSERT INTO rep_route_points (company_id, user_id, lat, lng, speed_kmh, activity, shop_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.companyId, req.user.id, lat, lng, speed_kmh ?? null, ['driving', 'stopped', 'selling'].includes(activity) ? activity : 'driving', shop_id ?? null);
  res.status(201).json(db.prepare('SELECT * FROM rep_route_points WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/:id/route', requireAnyPermission('view_app', 'manage_users'), (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM rep_route_points WHERE company_id = ? AND user_id = ?';
  const params = [req.companyId, req.params.id];
  if (from) {
    sql += ' AND recorded_at >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND recorded_at <= ?';
    params.push(`${to} 23:59:59`);
  }
  sql += ' ORDER BY recorded_at ASC';
  const points = db.prepare(sql).all(...params);

  // Rough driving-vs-selling breakdown: the gap between consecutive points
  // is attributed to whichever activity the EARLIER point recorded.
  let drivingMs = 0;
  let sellingMs = 0;
  let stoppedMs = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const gap = new Date(points[i + 1].recorded_at.replace(' ', 'T') + 'Z') - new Date(points[i].recorded_at.replace(' ', 'T') + 'Z');
    if (points[i].activity === 'driving') drivingMs += gap;
    else if (points[i].activity === 'selling') sellingMs += gap;
    else stoppedMs += gap;
  }
  res.json({ points, summary: { drivingMinutes: drivingMs / 60000, sellingMinutes: sellingMs / 60000, stoppedMinutes: stoppedMs / 60000 } });
});

// ---------------------------------------------------------------------
// Commission settings + statement
// ---------------------------------------------------------------------

router.get('/commission-settings', requireAnyPermission('manage_rep_targets', 'manage_settings'), (req, res) => {
  res.json(getCommissionSettings(req.companyId));
});

router.put('/commission-settings', requireAnyPermission('manage_rep_targets', 'manage_settings'), (req, res) => {
  res.json(setCommissionSettings(req.companyId, req.body || {}));
});

router.get('/:id/commission-statement', requireAnyPermission('view_commissions', 'manage_rep_targets'), (req, res) => {
  const rep = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });
  const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'monthly';
  try {
    res.json(computeCommissionStatement(req.companyId, rep.id, period, req.query.anchor));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

// ---------------------------------------------------------------------
// Scorecard: compares reps/regions against each other
// ---------------------------------------------------------------------

router.get('/scorecard', requireAnyPermission('view_statistics', 'manage_rep_targets'), (req, res) => {
  const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'monthly';
  const reps = db.prepare("SELECT id, name, region FROM users WHERE company_id = ? AND role = 'rep' AND status = 'approved'").all(req.companyId);
  const rows = reps.map((rep) => {
    const statement = computeCommissionStatement(req.companyId, rep.id, period);
    const achievementPct = statement.targetValue ? (statement.salesTotal / statement.targetValue) * 100 : null;
    return {
      repId: rep.id,
      repName: rep.name,
      region: rep.region,
      salesTotal: statement.salesTotal,
      orderCount: statement.orderCount,
      targetValue: statement.targetValue,
      achievementPct,
      commission: statement.totalCommission,
    };
  });
  rows.sort((a, b) => b.salesTotal - a.salesTotal);
  rows.forEach((r, i) => (r.rank = i + 1));

  const byRegion = {};
  for (const r of rows) {
    const key = r.region || 'بدون منطقة';
    byRegion[key] = (byRegion[key] || 0) + r.salesTotal;
  }

  res.json({ period, reps: rows, byRegion });
});

// ---------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------

router.get('/announcements', (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, (r.user_id IS NOT NULL) AS read
       FROM announcements a
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
       WHERE a.company_id = ? ORDER BY a.created_at DESC`
    )
    .all(req.user.id, req.companyId);
  res.json(rows.map((r) => ({ ...r, read: !!r.read })));
});

router.post('/announcements', requirePermission('manage_announcements'), (req, res) => {
  const { title, body, target_role } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'title_and_body_required' });
  const info = db
    .prepare('INSERT INTO announcements (company_id, title, body, target_role, created_by_id, created_by_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, title.trim(), body.trim(), target_role === 'reps' ? 'reps' : 'all', req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM announcements WHERE id = ?').get(info.lastInsertRowid));
});

router.post('/announcements/:id/read', (req, res) => {
  const announcement = db.prepare('SELECT id FROM announcements WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!announcement) return res.status(404).json({ error: 'not_found' });
  db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)').run(announcement.id, req.user.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Visit ratings (supervisor + customer, both optional)
// ---------------------------------------------------------------------

router.post('/:id/visit-ratings', requirePermission('rate_visits'), (req, res) => {
  const rep = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });
  const { shopId, rating, comment } = req.body || {};
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  if (!shop || !(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'shopId_and_rating_1_to_5_required' });
  const info = db
    .prepare(
      `INSERT INTO visit_ratings (company_id, shop_id, rep_id, rated_by_type, rated_by_id, rated_by_name, rating, comment)
       VALUES (?, ?, ?, 'supervisor', ?, ?, ?, ?)`
    )
    .run(req.companyId, shop.id, rep.id, req.user.id, req.user.name, rating, comment || null);
  res.status(201).json(db.prepare('SELECT * FROM visit_ratings WHERE id = ?').get(info.lastInsertRowid));
});

// Customer-submitted rating — reachable via the shop's own public link
// (routes/public.js), not this authenticated router, but exposed here too
// for a staff member entering it on the customer's behalf.
router.get('/:id/visit-ratings', requireAnyPermission('view_app', 'manage_rep_targets'), (req, res) => {
  res.json(db.prepare('SELECT * FROM visit_ratings WHERE company_id = ? AND rep_id = ? ORDER BY created_at DESC').all(req.companyId, req.params.id));
});

// ---------------------------------------------------------------------
// Points / leaderboard
// ---------------------------------------------------------------------

router.post('/:id/points', requirePermission('manage_rep_targets'), (req, res) => {
  const rep = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!rep) return res.status(404).json({ error: 'rep_not_found' });
  const { points, reason } = req.body || {};
  if (!Number.isFinite(Number(points))) return res.status(400).json({ error: 'points_required' });
  const info = db
    .prepare('INSERT INTO rep_points_log (company_id, user_id, points, reason, awarded_by_id, awarded_by_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, rep.id, Number(points), reason || null, req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM rep_points_log WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/leaderboard', requireAnyPermission('view_statistics', 'manage_rep_targets'), (req, res) => {
  const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'monthly';
  const { start, end } = periodRange(period);
  const reps = db.prepare("SELECT id, name, region FROM users WHERE company_id = ? AND role = 'rep' AND status = 'approved'").all(req.companyId);
  const rows = reps.map((rep) => {
    const statement = computeCommissionStatement(req.companyId, rep.id, period);
    const achievementPct = statement.targetValue ? Math.min(200, (statement.salesTotal / statement.targetValue) * 100) : 0;
    const onTimeCheckins = db
      .prepare("SELECT COUNT(*) c FROM rep_attendance WHERE company_id = ? AND user_id = ? AND type = 'check_in' AND recorded_at BETWEEN ? AND ?")
      .get(req.companyId, rep.id, start, `${end} 23:59:59`).c;
    const bonusPoints = db
      .prepare('SELECT COALESCE(SUM(points), 0) s FROM rep_points_log WHERE company_id = ? AND user_id = ? AND created_at BETWEEN ? AND ?')
      .get(req.companyId, rep.id, start, `${end} 23:59:59`).s;
    // A simple, transparent composite: achievement% (capped 200) + 5 pts
    // per check-in this period + any manually-awarded bonus points.
    const score = Math.round(achievementPct + onTimeCheckins * 5 + bonusPoints);
    return { repId: rep.id, repName: rep.name, region: rep.region, achievementPct, onTimeCheckins, bonusPoints, score };
  });
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => (r.rank = i + 1));
  res.json({ period, start, end, leaderboard: rows });
});

module.exports = router;
