const db = require('../db/init');

// Suggests the least-loaded rep, preferring one who already covers the same
// region (keeps routes geographically sane) before falling back to pure
// load-balancing. This is only ever a suggestion — the route handler always
// lets a supervisor override it with a manual repId.
function suggestRep(companyId, { region, excludeShopId } = {}) {
  const reps = db
    .prepare("SELECT id, name FROM users WHERE company_id = ? AND role = 'rep' AND status = 'approved'")
    .all(companyId);
  if (reps.length === 0) return null;

  const loadRows = db
    .prepare(
      `SELECT assigned_rep_id AS repId, COUNT(*) AS load_count,
              SUM(CASE WHEN region IS ? AND region IS NOT NULL THEN 1 ELSE 0 END) AS region_count
       FROM shops
       WHERE company_id = ? AND assigned_rep_id IS NOT NULL AND active = 1 AND id IS NOT ?
       GROUP BY assigned_rep_id`
    )
    .all(region ?? null, companyId, excludeShopId ?? -1);
  const loadByRep = new Map(loadRows.map((r) => [r.repId, r]));

  const scored = reps.map((rep) => {
    const load = loadByRep.get(rep.id);
    const loadCount = load?.load_count || 0;
    const regionCount = load?.region_count || 0;
    return { repId: rep.id, repName: rep.name, loadCount, regionMatch: regionCount > 0 };
  });

  // Region-matching reps first (sorted by their own load), then everyone
  // else by load — so a rep already serving the area is preferred unless
  // they're clearly overloaded relative to a same-region peer.
  scored.sort((a, b) => {
    if (region && a.regionMatch !== b.regionMatch) return a.regionMatch ? -1 : 1;
    return a.loadCount - b.loadCount;
  });

  return { suggested: scored[0], candidates: scored };
}

module.exports = { suggestRep };
