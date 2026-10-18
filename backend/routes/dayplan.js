const express = require('express');
const db = require('../db/init');
const { getAllEnrichedShops, getGlobalSettings, filterByClassification } = require('../lib/shopData');
const { nearestNeighborRoute } = require('../lib/geo');
const { requirePermission } = require('../middleware/auth');
const { listReps } = require('../lib/targets');
const { resolveRepScope } = require('../lib/repAccess');

const router = express.Router();
router.use(requirePermission('view_app'));

// Default base point (Damascus city center) used only when the user hasn't set a start point yet.
const FALLBACK_BASE = { lat: 33.5138, lng: 36.2765 };

// YYYY-MM-DD only — anything else falls back to today so a malformed date
// query param can't produce a broken/empty plan silently.
function resolvePlanDate(raw) {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

function getOverrides(companyId, planDate) {
  const rows = db
    .prepare('SELECT shop_id, action FROM day_plan_overrides WHERE company_id = ? AND plan_date = ?')
    .all(companyId, planDate);
  const added = new Set();
  const removed = new Set();
  for (const row of rows) (row.action === 'add' ? added : removed).add(row.shop_id);
  return { added, removed };
}

function buildPlan(companyId, planDate, classification, repId) {
  const settings = getGlobalSettings(companyId);
  let allShops = filterByClassification(getAllEnrichedShops(companyId), classification);
  // Restricting to one rep's own assigned shops is what makes this page a
  // usable per-rep route instead of one shared company-wide list — every
  // downstream section (route, attention, unpositioned) is derived from
  // this already-filtered set so they all stay consistent with the same rep.
  if (repId) allShops = allShops.filter((s) => s.assigned_rep_id === repId);
  const shopsById = new Map(allShops.map((s) => [s.id, s]));

  const base = {
    lat: settings.base_lat ? Number(settings.base_lat) : FALLBACK_BASE.lat,
    lng: settings.base_lng ? Number(settings.base_lng) : FALLBACK_BASE.lng,
  };
  const hasCustomBase = Boolean(settings.base_lat && settings.base_lng);

  const { added, removed } = getOverrides(companyId, planDate);

  // Route candidates: shops that need action today (not calmly green),
  // minus anything manually removed from this date's plan.
  const candidates = allShops.filter((s) => s.status !== 'green' && !removed.has(s.id));
  const positioned = candidates.filter((s) => s.lat != null && s.lng != null);
  const unpositionedAuto = candidates.filter((s) => s.lat == null || s.lng == null);

  // Manually-added shops: anyone the manager pinned to this date's plan who
  // isn't already an auto candidate (classification filter can also drop a
  // manually-added shop that no longer matches — same rule as everything else).
  const autoIds = new Set(candidates.map((s) => s.id));
  const manualShops = [...added]
    .map((id) => shopsById.get(id))
    .filter((s) => s && !autoIds.has(s.id));
  const manualPositioned = manualShops.filter((s) => s.lat != null && s.lng != null);
  const manualUnpositioned = manualShops.filter((s) => s.lat == null || s.lng == null);

  // Priority-then-geography: visit every red (over-debt) shop before any
  // yellow (overdue) shop, then any manually-added shop last — but route
  // nearest-neighbor within each group so the rep isn't zig-zagging across
  // the city, each leg picking up from wherever the previous one ended so
  // the whole route stays continuous. Re-run on every request, so a manual
  // add/remove is reflected in the route the moment it happens.
  const redPositioned = positioned.filter((s) => s.status === 'red');
  const yellowPositioned = positioned.filter((s) => s.status === 'yellow');

  const redOrdered = nearestNeighborRoute(
    redPositioned.map((s) => ({ lat: s.lat, lng: s.lng, shop: s })),
    base
  );
  const lastRedPoint = redOrdered.length ? redOrdered[redOrdered.length - 1] : base;
  const yellowOrdered = nearestNeighborRoute(
    yellowPositioned.map((s) => ({ lat: s.lat, lng: s.lng, shop: s })),
    lastRedPoint
  );
  const lastYellowPoint = yellowOrdered.length ? yellowOrdered[yellowOrdered.length - 1] : lastRedPoint;
  const manualOrdered = nearestNeighborRoute(
    manualPositioned.map((s) => ({ lat: s.lat, lng: s.lng, shop: s })),
    lastYellowPoint
  );

  const route = [...redOrdered, ...yellowOrdered, ...manualOrdered].map((entry, idx) => ({
    sequence: idx + 1,
    distanceFromPrevKm: entry.distanceFromPrevKm,
    isManual: manualPositioned.includes(entry.shop),
    ...entry.shop,
  }));

  const unpositioned = [
    ...unpositionedAuto.map((s) => ({ ...s, isManual: false })),
    ...manualUnpositioned.map((s) => ({ ...s, isManual: true })),
  ];

  // "Needs immediate attention": over the debt threshold, or abnormally overdue vs. their own cycle.
  const attention = allShops
    .filter((s) => s.isOverDebt || s.isAbnormallyOverdue)
    .sort((a, b) => {
      if (a.isOverDebt !== b.isOverDebt) return a.isOverDebt ? -1 : 1;
      return (b.daysSinceOrder ?? 0) - (a.daysSinceOrder ?? 0);
    });

  return { planDate, base, hasCustomBase, attention, route, unpositioned };
}

router.get('/', (req, res) => {
  const planDate = resolvePlanDate(req.query.date);
  const scope = resolveRepScope(req, Number(req.query.repId) || null);
  if (!scope.ok) return res.status(403).json({ error: 'forbidden' });
  res.json(buildPlan(req.companyId, planDate, req.query.classification, scope.repId));
});

// Delivery reps a plan can be filtered to — same catalog used by the
// targets screen, exposed here too since this route only requires
// view_app (a plain rep should be able to see who's on the list).
router.get('/reps', (req, res) => {
  res.json({ reps: listReps(req.companyId) });
});

// Pin a shop onto a given date's plan even if it wouldn't normally qualify
// (e.g. it's currently green/healthy). Replaces any prior override for the
// same (date, shop) pair — including a previous "remove".
router.post('/manual', requirePermission('view_app'), (req, res) => {
  const shopId = Number(req.body.shopId);
  if (!shopId) return res.status(400).json({ error: 'shop_id_required' });
  const planDate = resolvePlanDate(req.body.date);
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });

  db.prepare(
    `INSERT INTO day_plan_overrides (company_id, plan_date, shop_id, action, created_by_id, created_by_name)
     VALUES (?, ?, ?, 'add', ?, ?)
     ON CONFLICT(company_id, plan_date, shop_id) DO UPDATE SET action = 'add', created_by_id = excluded.created_by_id, created_by_name = excluded.created_by_name, created_at = datetime('now')`
  ).run(req.companyId, planDate, shopId, req.user.id, req.user.name);

  const addScope = resolveRepScope(req, Number(req.query.repId) || null);
  if (!addScope.ok) return res.status(403).json({ error: 'forbidden' });
  res.json(buildPlan(req.companyId, planDate, req.query.classification, addScope.repId));
});

// Take a shop off a given date's plan — whether it got there automatically
// (its status qualifies it) or via a manual add.
router.delete('/manual/:shopId', requirePermission('view_app'), (req, res) => {
  const shopId = Number(req.params.shopId);
  const planDate = resolvePlanDate(req.query.date);

  const existingAdd = db
    .prepare("SELECT id FROM day_plan_overrides WHERE company_id = ? AND plan_date = ? AND shop_id = ? AND action = 'add'")
    .get(req.companyId, planDate, shopId);
  if (existingAdd) {
    // Undo a manual add outright rather than leaving a "remove" behind —
    // the shop simply goes back to whatever the automatic rule would say.
    db.prepare('DELETE FROM day_plan_overrides WHERE id = ? AND company_id = ?').run(existingAdd.id, req.companyId);
  } else {
    db.prepare(
      `INSERT INTO day_plan_overrides (company_id, plan_date, shop_id, action, created_by_id, created_by_name)
       VALUES (?, ?, ?, 'remove', ?, ?)
       ON CONFLICT(company_id, plan_date, shop_id) DO UPDATE SET action = 'remove', created_by_id = excluded.created_by_id, created_by_name = excluded.created_by_name, created_at = datetime('now')`
    ).run(req.companyId, planDate, shopId, req.user.id, req.user.name);
  }

  const removeScope = resolveRepScope(req, Number(req.query.repId) || null);
  if (!removeScope.ok) return res.status(403).json({ error: 'forbidden' });
  res.json(buildPlan(req.companyId, planDate, req.query.classification, removeScope.repId));
});

module.exports = router;
