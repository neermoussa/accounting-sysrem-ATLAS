const db = require('../db/init');

// ---------------------------------------------------------------------
// k-anonymity floor: a geo/metric/product combination is only ever written
// to market_intelligence_snapshots once at least this many DISTINCT
// COMPANIES contributed to it. Below that, the row is simply never created
// — no suppressed placeholder, no rolled-up substitute, nothing an
// individual company or customer could be inferred from. Configurable via
// env because the right floor depends on how many companies are actually
// on the platform (a floor of 5 is meaningless with 3 total companies, but
// dropping it below 3 in production would start being a genuine privacy
// risk) — 3 is a reasonable development default.
// ---------------------------------------------------------------------

const MIN_CONTRIBUTORS = Number(process.env.MARKET_INTEL_MIN_CONTRIBUTORS || 3);

// shops.region is free text with no dedicated governorate/city/district
// columns in this schema — the established convention (documented here,
// not enforced at input) is "المحافظة" or "المحافظة - المدينة" or
// "المحافظة - المدينة - المنطقة". A region that doesn't follow it still
// works: it's just treated as governorate-only, with no city/district
// breakdown available for it.
function parseGeo(regionRaw) {
  const parts = String(regionRaw || '').split('-').map((s) => s.trim()).filter(Boolean);
  return {
    country: 'سوريا',
    governorate: parts[0] || null,
    city: parts[1] || null,
    district: parts[2] || null,
  };
}

function geoLevelsFor(geo) {
  const levels = [{ level: 'country', value: geo.country }];
  if (geo.governorate) levels.push({ level: 'governorate', value: geo.governorate });
  if (geo.city) levels.push({ level: 'city', value: geo.city });
  if (geo.district) levels.push({ level: 'district', value: geo.district });
  return levels;
}

// ---------------------------------------------------------------------
// Accumulator: keyed by geoLevel|geoValue|metricType|productName, holding
// the set of contributing company ids (never written to the final row —
// only its SIZE is) plus whatever numeric aggregate that metric needs.
// ---------------------------------------------------------------------

function makeAccumulator() {
  const map = new Map();
  function bump(geoLevel, geoValue, metricType, productName, companyId, updateFn) {
    const key = `${geoLevel}|${geoValue}|${metricType}|${productName || ''}`;
    if (!map.has(key)) map.set(key, { geoLevel, geoValue, metricType, productName: productName || null, companies: new Set(), agg: {} });
    const entry = map.get(key);
    entry.companies.add(companyId);
    updateFn(entry.agg);
  }
  return { map, bump };
}

function complaintBucket(text) {
  const t = String(text || '');
  if (/تأخير|تأخر|توصيل|وصول/.test(t)) return 'تأخير التسليم';
  if (/تالف|فاسد|جودة|منتهي/.test(t)) return 'جودة المنتج';
  if (/نقص|كمية|ناقص/.test(t)) return 'خطأ بالكمية';
  if (/سعر|غالي|تسعير/.test(t)) return 'التسعير';
  if (/موظف|رد|خدمة|تعامل/.test(t)) return 'خدمة العملاء';
  return 'أخرى';
}

// Recomputes the WHOLE current-month snapshot from scratch each run — the
// only "state" carried between runs is what's already in
// market_intelligence_snapshots, and this always replaces that period's
// rows atomically rather than incrementing them, so a re-run is always
// safe and never double-counts.
//
// Orders are the dominant cost at scale (everything else in this function —
// promotions, tickets, returns — is comparatively tiny), so that part is
// aggregated per company via SQL (json_each + GROUP BY on region/product)
// instead of pulling every order into JS and looping its items by hand —
// the same fix applied to lib/aiRecommendations.js's computeStockForecasts.
// The cross-company merge itself still has to happen in JS (that's the
// entire point of this table: combining contributions from multiple
// companies into one anonymized row), but each company now contributes a
// handful of grouped subtotal rows instead of thousands of raw order-items,
// and the loop yields the event loop (setImmediate) between companies so
// this sweep no longer blocks the server for its whole duration.
async function computeSnapshot(period = new Date().toISOString().slice(0, 7)) {
  const monthStart = `${period}-01`;
  const [y, m] = period.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month

  const acc = makeAccumulator();

  // --- Orders: top_products, avg_price, order_seasonality, active_regions —
  // one grouped query per company instead of a JS loop over every order-item.
  const companyIds = db.prepare('SELECT id FROM companies').all().map((r) => r.id);
  for (const companyId of companyIds) {
    const regionCounts = db
      .prepare(
        `SELECT s.region AS region, COUNT(*) AS orderCount
         FROM orders o JOIN shops s ON s.id = o.shop_id
         WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.order_date >= ? AND o.order_date <= ?
         GROUP BY s.region`
      )
      .all(companyId, monthStart, monthEnd);
    for (const { region, orderCount } of regionCounts) {
      for (const { level, value } of geoLevelsFor(parseGeo(region))) {
        acc.bump(level, value, 'active_regions', null, companyId, (a) => {
          a.orderCount = (a.orderCount || 0) + orderCount;
        });
        acc.bump(level, value, 'order_seasonality', null, companyId, (a) => {
          a.orderCount = (a.orderCount || 0) + orderCount;
        });
      }
    }

    const productTotals = db
      .prepare(
        `SELECT s.region AS region, je.value ->> 'product_name' AS productName,
                SUM(CAST(je.value ->> 'qty' AS REAL)) AS totalQty,
                COUNT(DISTINCT o.id) AS orderCount,
                SUM(CASE WHEN (je.value ->> 'unit_price') IS NOT NULL THEN CAST(je.value ->> 'unit_price' AS REAL) ELSE 0 END) AS sumPrice,
                SUM(CASE WHEN (je.value ->> 'unit_price') IS NOT NULL THEN 1 ELSE 0 END) AS priceCount
         FROM orders o JOIN shops s ON s.id = o.shop_id, json_each(o.items_json) je
         WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.order_date >= ? AND o.order_date <= ?
           AND (je.value ->> 'is_free') IS NOT 1 AND je.value ->> 'product_name' IS NOT NULL
         GROUP BY s.region, productName`
      )
      .all(companyId, monthStart, monthEnd);
    for (const row of productTotals) {
      for (const { level, value } of geoLevelsFor(parseGeo(row.region))) {
        acc.bump(level, value, 'top_products', row.productName, companyId, (a) => {
          a.totalQty = (a.totalQty || 0) + row.totalQty;
          a.orderCount = (a.orderCount || 0) + row.orderCount;
        });
        if (row.priceCount > 0) {
          acc.bump(level, value, 'avg_price', row.productName, companyId, (a) => {
            a.sumPrice = (a.sumPrice || 0) + row.sumPrice;
            a.count = (a.count || 0) + row.priceCount;
          });
        }
      }
    }

    // Yield between companies so a concurrent request never queues behind
    // the whole platform's worth of aggregation.
    await new Promise((resolve) => setImmediate(resolve));
  }

  // --- Promotions: country-level only (no per-shop scope in this schema) ---
  const promotions = db
    .prepare(`SELECT company_id, type FROM promotions WHERE active = 1 AND created_at >= ? AND created_at <= ?`)
    .all(monthStart, `${monthEnd} 23:59:59`);
  for (const p of promotions) {
    acc.bump('country', 'سوريا', 'promotions', p.type, p.company_id, (a) => {
      a.count = (a.count || 0) + 1;
    });
  }

  // --- Shortages: from the AI stock-forecast layer, country-level (car/
  // factory inventory isn't shop-scoped either) ---
  const shortages = db
    .prepare(
      `SELECT company_id, related_entity_id FROM ai_recommendations
       WHERE type = 'stock_forecast' AND created_at >= ? AND created_at <= ?`
    )
    .all(monthStart, `${monthEnd} 23:59:59`);
  for (const s of shortages) {
    const product = db.prepare('SELECT name, category FROM products WHERE id = ?').get(s.related_entity_id);
    if (!product) continue;
    acc.bump('country', 'سوريا', 'shortages', product.name, s.company_id, (a) => {
      a.count = (a.count || 0) + 1;
      a.category = product.category || null;
    });
  }

  // --- Returns / damaged: attributed via the return request's shop geo
  // (joined directly in SQL — this table is small, but there's no reason
  // to load every shop in the company into memory just for this) ---
  const returnItems = db
    .prepare(
      `SELECT ri.company_id, ri.product_name, ri.inspection_status, s.region
       FROM return_items ri JOIN return_requests rr ON rr.id = ri.return_request_id JOIN shops s ON s.id = rr.shop_id
       WHERE rr.created_at >= ? AND rr.created_at <= ?`
    )
    .all(monthStart, `${monthEnd} 23:59:59`);
  for (const ri of returnItems) {
    for (const { level, value } of geoLevelsFor(parseGeo(ri.region))) {
      acc.bump(level, value, 'returns', ri.product_name, ri.company_id, (a) => {
        a.count = (a.count || 0) + 1;
      });
      if (ri.inspection_status === 'damaged') {
        acc.bump(level, value, 'damaged', ri.product_name, ri.company_id, (a) => {
          a.count = (a.count || 0) + 1;
        });
      }
    }
  }

  // --- Complaint reasons: bucketed, never raw text, country-level only ---
  const tickets = db
    .prepare(`SELECT company_id, description FROM whatsapp_tickets WHERE created_at >= ? AND created_at <= ?`)
    .all(monthStart, `${monthEnd} 23:59:59`);
  for (const t of tickets) {
    const bucket = complaintBucket(t.description);
    acc.bump('country', 'سوريا', 'complaint_reasons', bucket, t.company_id, (a) => {
      a.count = (a.count || 0) + 1;
    });
  }

  // --- Substitutes: for each shortage, the top other product in the same
  // category ordered this period at country level ---
  for (const [, entry] of acc.map) {
    if (entry.metricType !== 'shortages') continue;
    const category = entry.agg.category;
    if (!category) continue;
    const productsInCategory = db.prepare('SELECT name FROM products WHERE category = ? AND name != ?').all(category, entry.productName);
    let best = null;
    for (const p of productsInCategory) {
      const key = `country|سوريا|top_products|${p.name}`;
      const topEntry = acc.map.get(key);
      if (topEntry && (!best || (topEntry.agg.totalQty || 0) > best.qty)) {
        best = { name: p.name, qty: topEntry.agg.totalQty || 0, companies: topEntry.companies };
      }
    }
    if (best && best.companies.size >= MIN_CONTRIBUTORS) {
      acc.bump('country', 'سوريا', 'substitutes', entry.productName, [...best.companies][0], (a) => {
        a.suggestedSubstitute = best.name;
      });
      // Ensure the substitute row's own contributor set matches the
      // product it's actually describing, not just the first company from
      // `best` — bump above only seeded it with one id; union the rest in
      // directly so the k-anonymity count is accurate.
      const subKey = `country|سوريا|substitutes|${entry.productName}`;
      for (const cid of best.companies) acc.map.get(subKey).companies.add(cid);
    }
  }

  // --- Write out: only rows meeting the k-anonymity floor survive ---
  const rows = [...acc.map.values()].filter((e) => e.companies.size >= MIN_CONTRIBUTORS);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM market_intelligence_snapshots WHERE period = ?').run(period);
    const insert = db.prepare(
      `INSERT INTO market_intelligence_snapshots (period, geo_level, geo_value, metric_type, product_name, contributing_count, value_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of rows) {
      const value = { ...e.agg };
      if (e.metricType === 'avg_price' && value.count) value.avgPrice = value.sumPrice / value.count;
      insert.run(period, e.geoLevel, e.geoValue, e.metricType, e.productName, e.companies.size, JSON.stringify(value));
    }
  });
  tx();

  return { period, rowsWritten: rows.length, minContributors: MIN_CONTRIBUTORS };
}

// Load-test finding: with no `period` filter this returned every snapshot
// ever computed (the table is cumulative — a new period never replaces an
// old one) — 20,432 rows / 6.5MB on 500 companies' worth of history.
// Defaults to the current month when the caller doesn't ask for a specific
// one, and caps the row count regardless of how the request is filtered —
// a caller that genuinely wants multiple periods still passes `period`
// explicitly (or `allPeriods: true` to opt out of the default entirely);
// nobody gets the unbounded table by omission.
const SNAPSHOT_HARD_LIMIT = 2000;

function getSnapshot({ period, geoLevel, geoValue, metricType, productName, allPeriods = false } = {}) {
  const effectivePeriod = period || (allPeriods ? null : new Date().toISOString().slice(0, 7));
  let sql = 'SELECT * FROM market_intelligence_snapshots WHERE 1=1';
  const params = [];
  if (effectivePeriod) {
    sql += ' AND period = ?';
    params.push(effectivePeriod);
  }
  if (geoLevel) {
    sql += ' AND geo_level = ?';
    params.push(geoLevel);
  }
  if (geoValue) {
    sql += ' AND geo_value = ?';
    params.push(geoValue);
  }
  if (metricType) {
    sql += ' AND metric_type = ?';
    params.push(metricType);
  }
  if (productName) {
    sql += ' AND product_name = ?';
    params.push(productName);
  }
  sql += ' ORDER BY period DESC, geo_level, geo_value LIMIT ?';
  params.push(SNAPSHOT_HARD_LIMIT);
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({ ...r, value: JSON.parse(r.value_json) }));
}

module.exports = { MIN_CONTRIBUTORS, parseGeo, computeSnapshot, getSnapshot };
