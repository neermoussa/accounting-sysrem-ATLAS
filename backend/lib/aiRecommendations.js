const db = require('../db/init');
const { createNotification } = require('./notify');
const { generateText } = require('./ai');

// ---------------------------------------------------------------------
// Per-company on/off switches — one per AI sub-feature, independent of
// each other, per spec item 6. Every one defaults ON: unlike, say, the
// WhatsApp bot's direct-ordering toggle, nothing here ever executes a
// sensitive action by itself — every row is a proposal a human still has
// to approve — so there's no destructive default to guard against.
// ---------------------------------------------------------------------

const FEATURES = ['product_suggestions', 'anomaly_detection', 'stock_forecast', 'wave_summary'];

function getSetting(companyId, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}

function setSetting(companyId, key, value) {
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(companyId, key, String(value));
}

function isFeatureEnabled(companyId, feature) {
  return getSetting(companyId, `ai_${feature}_enabled`, '1') === '1';
}

function getFeatureToggles(companyId) {
  return Object.fromEntries(FEATURES.map((f) => [f, isFeatureEnabled(companyId, f)]));
}

function setFeatureToggles(companyId, toggles) {
  for (const f of FEATURES) {
    if (toggles[f] !== undefined) setSetting(companyId, `ai_${f}_enabled`, toggles[f] ? '1' : '0');
  }
}

function getThresholds(companyId) {
  return {
    // Reuses the existing geofence setting from the Waves feature
    // (lib/waves.js) rather than duplicating a second radius config.
    geofenceRadiusMeters: Number(getSetting(companyId, 'geofence_radius_meters', '500')),
    discountAlertPercent: Number(getSetting(companyId, 'ai_discount_alert_percent', '30')),
    returnRepeatCount: Number(getSetting(companyId, 'ai_return_repeat_count', '3')),
    returnRepeatWindowDays: Number(getSetting(companyId, 'ai_return_repeat_window_days', '90')),
    deliveryMismatchPercent: Number(getSetting(companyId, 'ai_delivery_mismatch_percent', '20')),
    stockForecastCriticalDays: Number(getSetting(companyId, 'ai_stock_forecast_critical_days', '7')),
    stockForecastLookbackDays: Number(getSetting(companyId, 'ai_stock_forecast_lookback_days', '30')),
  };
}

function setThresholds(companyId, t) {
  const map = {
    geofenceRadiusMeters: 'geofence_radius_meters',
    discountAlertPercent: 'ai_discount_alert_percent',
    returnRepeatCount: 'ai_return_repeat_count',
    returnRepeatWindowDays: 'ai_return_repeat_window_days',
    deliveryMismatchPercent: 'ai_delivery_mismatch_percent',
    stockForecastCriticalDays: 'ai_stock_forecast_critical_days',
    stockForecastLookbackDays: 'ai_stock_forecast_lookback_days',
  };
  for (const [key, settingKey] of Object.entries(map)) {
    if (t[key] !== undefined) setSetting(companyId, settingKey, t[key]);
  }
}

// ---------------------------------------------------------------------
// Shared row writer — every AI output, of every kind, goes through this so
// the shape (reason/data/confidence, pending decision) is never
// inconsistent between sub-features (spec item 5).
// ---------------------------------------------------------------------

function createRecommendation(companyId, { type, shopId, relatedEntityType, relatedEntityId, severity, confidence, reason, data, suggestion }) {
  const info = db
    .prepare(
      `INSERT INTO ai_recommendations
        (company_id, type, shop_id, related_entity_type, related_entity_id, severity, confidence, reason, data_json, suggestion_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      companyId,
      type,
      shopId ?? null,
      relatedEntityType || null,
      relatedEntityId ?? null,
      severity ?? null,
      confidence ?? null,
      reason,
      JSON.stringify(data ?? {}),
      JSON.stringify(suggestion ?? {})
    );
  return db.prepare('SELECT * FROM ai_recommendations WHERE id = ?').get(info.lastInsertRowid);
}

function decideRecommendation(companyId, id, { status, reason, user }) {
  if (!['approved', 'rejected'].includes(status)) throw Object.assign(new Error('invalid_status'), { status: 400 });
  const row = db.prepare('SELECT * FROM ai_recommendations WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!row) throw Object.assign(new Error('not_found'), { status: 404 });
  if (row.decision_status !== 'pending') throw Object.assign(new Error('already_decided'), { status: 409, currentStatus: row.decision_status });
  db.prepare(
    `UPDATE ai_recommendations SET decision_status = ?, decided_by_id = ?, decided_by_name = ?, decided_at = datetime('now'), decision_reason = ? WHERE id = ?`
  ).run(status, user.id, user.name, reason || null, row.id);
  return db.prepare('SELECT * FROM ai_recommendations WHERE id = ?').get(row.id);
}

// ---------------------------------------------------------------------
// 1) Product/quantity/promotion suggestions for a customer profile
// ---------------------------------------------------------------------

const ORDER_HISTORY_LIMIT = 30;

async function suggestProductsForShop(companyId, shopId) {
  if (!isFeatureEnabled(companyId, 'product_suggestions')) return null;

  // One fresh suggestion per shop per day is enough — re-opening the same
  // profile repeatedly shouldn't spam new rows or extra generateText calls.
  const today = new Date().toISOString().slice(0, 10);
  const existing = db
    .prepare(
      `SELECT * FROM ai_recommendations WHERE company_id = ? AND shop_id = ? AND type = 'product_suggestion' AND date(created_at) = ? ORDER BY id DESC LIMIT 1`
    )
    .get(companyId, shopId, today);
  if (existing) return existing;

  const orders = db
    .prepare(
      `SELECT items_json, order_date FROM orders WHERE company_id = ? AND shop_id = ? AND deleted_at IS NULL ORDER BY order_date DESC, id DESC LIMIT ?`
    )
    .all(companyId, shopId, ORDER_HISTORY_LIMIT);
  if (orders.length === 0) return null;

  const stats = new Map(); // product_name -> { count, totalQty, lastDate, product_id }
  for (const o of orders) {
    const items = JSON.parse(o.items_json || '[]');
    for (const it of items) {
      if (it.is_free) continue;
      const key = it.product_name;
      const entry = stats.get(key) || { count: 0, totalQty: 0, lastDate: o.order_date, product_id: it.product_id ?? null };
      entry.count += 1;
      entry.totalQty += Number(it.qty) || 0;
      if (o.order_date > entry.lastDate) entry.lastDate = o.order_date;
      stats.set(key, entry);
    }
  }

  const ranked = [...stats.entries()]
    .map(([productName, s]) => ({
      product_name: productName,
      product_id: s.product_id,
      frequency: s.count,
      suggested_qty: Math.round(s.totalQty / s.count),
      last_ordered_at: s.lastDate,
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 5);

  if (ranked.length === 0) return null;

  // Attach any currently-active promotion covering a suggested product.
  const now = new Date().toISOString();
  const activePromos = db
    .prepare(
      `SELECT * FROM promotions WHERE company_id = ? AND active = 1
       AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)`
    )
    .all(companyId, now, now);
  for (const item of ranked) {
    const promo = activePromos.find((p) => p.product_id === item.product_id);
    if (promo) item.applicable_promotion = { id: promo.id, name: promo.name, type: promo.type };
  }

  const templateReason = `بناءً على آخر ${orders.length} طلب لهذا الزبون، الأصناف الأكثر تكرارًا: ${ranked
    .map((r) => `${r.product_name} (${r.frequency} مرة، بمعدل ${r.suggested_qty} بالطلب)`)
    .join('، ')}.`;

  const confidence = Math.min(1, orders.length / 10);

  const generated = await generateText(
    `زبون طلب ${orders.length} مرة سابقًا. أكثر الأصناف تكرارًا: ${ranked
      .map((r) => `${r.product_name} (${r.frequency} مرة)`)
      .join('، ')}. اقترح للمندوب بجملة قصيرة ماذا يعرض على هذا الزبون في الزيارة القادمة.`
  );

  return createRecommendation(companyId, {
    type: 'product_suggestion',
    shopId,
    severity: null,
    confidence,
    reason: generated || templateReason,
    data: { ordersConsidered: orders.length },
    suggestion: { items: ranked },
  });
}

// ---------------------------------------------------------------------
// 2) Rule-based anomaly detection — plain thresholds, no learned model.
// ---------------------------------------------------------------------

function severityForRatio(ratio) {
  if (ratio >= 3) return 'critical';
  if (ratio >= 1.5) return 'warning';
  return 'info';
}

// Called from lib/waves.js's checkGeofence, right alongside the existing
// plain notification it already sends — this adds the structured,
// severity-rated, human-decidable record on top, gated by its own toggle.
function flagGeofenceAnomaly(companyId, { rep, shop, distanceKm, radiusKm, visitRecordId }) {
  if (!isFeatureEnabled(companyId, 'anomaly_detection')) return null;
  const ratio = distanceKm / radiusKm;
  const distanceM = Math.round(distanceKm * 1000);
  const radiusM = Math.round(radiusKm * 1000);
  return createRecommendation(companyId, {
    type: 'anomaly_geofence',
    shopId: shop.id,
    relatedEntityType: 'visit_record',
    relatedEntityId: visitRecordId,
    severity: severityForRatio(ratio),
    reason: `زيارة المندوب ${rep.name} لمحل ${shop.name} سُجّلت على بعد ${distanceM} م من موقع المحل، بينما الحد المسموح ${radiusM} م.`,
    data: { distanceMeters: distanceM, radiusMeters: radiusM, repId: rep.id, repName: rep.name },
  });
}

function flagDiscountAnomaly(companyId, { shop, order, item, discountPercent }) {
  if (!isFeatureEnabled(companyId, 'anomaly_detection')) return null;
  const { discountAlertPercent } = getThresholds(companyId);
  if (discountPercent <= discountAlertPercent) return null;
  const ratio = discountPercent / discountAlertPercent;
  const rec = createRecommendation(companyId, {
    type: 'anomaly_discount',
    shopId: shop.id,
    relatedEntityType: 'order',
    relatedEntityId: order.id,
    severity: severityForRatio(ratio),
    reason: `خصم ${discountPercent.toFixed(0)}% على صنف "${item.product_name}" لمحل ${shop.name} في الطلب #${order.id} — يتجاوز الحد المسموح (${discountAlertPercent}%).`,
    data: { productName: item.product_name, discountPercent, thresholdPercent: discountAlertPercent, unitPrice: item.unit_price },
  });
  notifyAnomaly(companyId, rec);
  return rec;
}

function flagReturnRepeatAnomaly(companyId, { shop, productName, productId }) {
  if (!isFeatureEnabled(companyId, 'anomaly_detection')) return null;
  const { returnRepeatCount, returnRepeatWindowDays } = getThresholds(companyId);
  const since = new Date(Date.now() - returnRepeatWindowDays * 86400000).toISOString();
  const count = db
    .prepare(
      `SELECT COUNT(DISTINCT rr.id) c FROM return_requests rr JOIN return_items ri ON ri.return_request_id = rr.id
       WHERE rr.company_id = ? AND rr.shop_id = ? AND rr.created_at >= ?
       AND (ri.product_id = ? OR ri.product_name = ?)`
    )
    .get(companyId, shop.id, since, productId ?? -1, productName).c;
  if (count < returnRepeatCount) return null;
  const ratio = count / returnRepeatCount;
  const rec = createRecommendation(companyId, {
    type: 'anomaly_return_repeat',
    shopId: shop.id,
    severity: severityForRatio(ratio),
    reason: `محل ${shop.name} أعاد صنف "${productName}" ${count} مرات خلال آخر ${returnRepeatWindowDays} يومًا — يتجاوز الحد (${returnRepeatCount} مرات).`,
    data: { productName, count, windowDays: returnRepeatWindowDays, threshold: returnRepeatCount },
  });
  notifyAnomaly(companyId, rec);
  return rec;
}

function flagDeliveryMismatchAnomaly(companyId, { shop, order, orderedQty, shortfallQty }) {
  if (!isFeatureEnabled(companyId, 'anomaly_detection')) return null;
  if (!(orderedQty > 0)) return null;
  const { deliveryMismatchPercent } = getThresholds(companyId);
  const mismatchPercent = (shortfallQty / orderedQty) * 100;
  if (mismatchPercent <= deliveryMismatchPercent) return null;
  const ratio = mismatchPercent / deliveryMismatchPercent;
  const rec = createRecommendation(companyId, {
    type: 'anomaly_delivery_mismatch',
    shopId: shop.id,
    relatedEntityType: 'order',
    relatedEntityId: order.id,
    severity: severityForRatio(ratio),
    reason: `فرق كبير بين الكمية المطلوبة والمُسلَّمة للطلب #${order.id} لمحل ${shop.name}: نقص ${mismatchPercent.toFixed(0)}% (الحد ${deliveryMismatchPercent}%).`,
    data: { orderedQty, shortfallQty, mismatchPercent, thresholdPercent: deliveryMismatchPercent },
  });
  notifyAnomaly(companyId, rec);
  return rec;
}

function notifyAnomaly(companyId, rec) {
  if (!rec) return;
  createNotification({
    companyId,
    type: `ai_${rec.type}`,
    message_ar: rec.reason,
    message_en: rec.reason,
    link_path: rec.shop_id ? `/shops/${rec.shop_id}` : null,
    entity_type: 'ai_recommendation',
    entity_id: rec.id,
  });
}

// ---------------------------------------------------------------------
// 3) Stock-shortage forecast — simple consumption-rate math, confidence
// grows automatically as more historical order data accumulates.
// ---------------------------------------------------------------------

// One SQL aggregation per company (via json_each on items_json, GROUP BY
// product_id) replaces what used to be a per-product re-scan of every one
// of that company's orders — under load-test data (500 companies, ~60
// active products/company, ~3000 orders/company) the old version re-parsed
// the same order set 60 times per company; this parses it once. Only
// products that actually have consumption data ever come back, so the
// inventory lookups below run for a small fraction of a company's catalog,
// not all of it. Also yields the event loop between companies
// (setImmediate) so this sweep — which runs on a timer across every
// company on the platform — never holds Node's single thread for the
// whole run the way the old synchronous version did.
async function computeStockForecasts() {
  const companyIds = db.prepare('SELECT id FROM companies').all().map((r) => r.id);
  for (const companyId of companyIds) {
    if (!isFeatureEnabled(companyId, 'stock_forecast')) {
      await new Promise((resolve) => setImmediate(resolve));
      continue;
    }
    const { stockForecastCriticalDays, stockForecastLookbackDays } = getThresholds(companyId);
    const since = new Date(Date.now() - stockForecastLookbackDays * 86400000).toISOString().slice(0, 10);

    const consumption = db
      .prepare(
        `SELECT CAST(je.value ->> 'product_id' AS INTEGER) AS product_id,
                SUM(CAST(je.value ->> 'qty' AS REAL)) AS totalQty,
                COUNT(DISTINCT o.id) AS orderOccurrences
         FROM orders o, json_each(o.items_json) je
         WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.order_date >= ?
           AND (je.value ->> 'is_free') IS NOT 1
           AND je.value ->> 'product_id' IS NOT NULL
         GROUP BY product_id`
      )
      .all(companyId, since);
    if (consumption.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      continue;
    }

    const productIds = consumption.map((c) => c.product_id);
    const placeholders = productIds.map(() => '?').join(',');
    const products = new Map(
      db.prepare(`SELECT id, name FROM products WHERE company_id = ? AND active = 1 AND id IN (${placeholders})`).all(companyId, ...productIds).map((p) => [p.id, p.name])
    );
    const carStock = new Map(
      db.prepare(`SELECT product_id, current_quantity FROM car_inventory WHERE company_id = ? AND product_id IN (${placeholders})`).all(companyId, ...productIds).map((r) => [r.product_id, r.current_quantity])
    );
    const factoryStock = new Map(
      db.prepare(`SELECT product_id, current_quantity FROM factory_inventory WHERE company_id = ? AND product_id IN (${placeholders})`).all(companyId, ...productIds).map((r) => [r.product_id, r.current_quantity])
    );

    const today = new Date().toISOString().slice(0, 10);
    for (const { product_id: productId, totalQty, orderOccurrences } of consumption) {
      const productName = products.get(productId);
      if (!productName) continue; // inactive/deleted product — nothing to forecast

      const dailyRate = totalQty / stockForecastLookbackDays;
      if (dailyRate <= 0) continue;

      const currentStock = (carStock.get(productId) || 0) + (factoryStock.get(productId) || 0);
      const daysRemaining = currentStock / dailyRate;

      // Only a genuinely near-term shortage is worth surfacing — routine
      // "plenty of stock" analyses never create a row or a notification
      // (spec item 6).
      if (daysRemaining > stockForecastCriticalDays) continue;

      const already = db
        .prepare(
          `SELECT 1 FROM ai_recommendations WHERE company_id = ? AND type = 'stock_forecast' AND related_entity_id = ? AND date(created_at) = ?`
        )
        .get(companyId, productId, today);
      if (already) continue;

      const confidence = Math.min(1, orderOccurrences / 10);
      const rec = createRecommendation(companyId, {
        type: 'stock_forecast',
        relatedEntityType: 'product',
        relatedEntityId: productId,
        severity: daysRemaining <= stockForecastCriticalDays / 2 ? 'critical' : 'warning',
        confidence,
        reason: `المخزون الحالي من "${productName}" (${Math.round(currentStock)}) يكفي لنحو ${Math.max(0, Math.round(daysRemaining))} يوم بمعدل الاستهلاك الحالي (${dailyRate.toFixed(1)}/يوم).`,
        data: { currentStock, dailyRate, daysRemaining, lookbackDays: stockForecastLookbackDays, orderOccurrences },
        suggestion: { productId, productName, suggestedReorderQty: Math.ceil(dailyRate * stockForecastCriticalDays) },
      });
      notifyAnomaly(companyId, rec);
    }

    // Yield between companies — the largest single lever against blocking
    // the event loop for the whole sweep's duration.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------
// 4) End-of-wave summary
// ---------------------------------------------------------------------

async function summarizeWave(companyId, waveInstanceId) {
  if (!isFeatureEnabled(companyId, 'wave_summary')) return null;
  const instance = db.prepare('SELECT * FROM wave_instances WHERE id = ? AND company_id = ?').get(waveInstanceId, companyId);
  if (!instance) return null;

  const points = db.prepare('SELECT * FROM wave_points WHERE wave_instance_id = ? AND removed_at IS NULL').all(waveInstanceId);
  const visited = points.filter((p) => p.status === 'visited' || p.status === 'order_taken');
  const notVisited = points.filter((p) => p.status !== 'visited' && p.status !== 'order_taken');
  const notVisitedDetails = notVisited.map((p) => {
    const shop = db.prepare('SELECT name FROM shops WHERE id = ?').get(p.shop_id);
    return { shopName: shop?.name || `#${p.shop_id}`, reason: p.not_visited_reason || 'غير محدد' };
  });

  const visitRecords = db
    .prepare('SELECT * FROM visit_records WHERE company_id = ? AND wave_point_id IN (SELECT id FROM wave_points WHERE wave_instance_id = ?)')
    .all(companyId, waveInstanceId);
  const refusals = visitRecords.filter((v) => v.result === 'refused');

  const hasProblems = notVisitedDetails.length > 0 || refusals.length > 0;
  const completionRate = points.length ? Math.round((visited.length / points.length) * 100) : 0;

  const templateReason = `تمت زيارة ${visited.length} من ${points.length} نقطة (${completionRate}%).${
    notVisitedDetails.length ? ` نقاط لم تُزَر: ${notVisitedDetails.map((n) => `${n.shopName} (${n.reason})`).join('، ')}.` : ''
  }${refusals.length ? ` عدد حالات الرفض: ${refusals.length}.` : ''}`;

  const generated = await generateText(
    `لفة مندوب انتهت: ${visited.length} من ${points.length} نقطة تمت زيارتها. ${
      notVisitedDetails.length ? `نقاط لم تُزَر: ${notVisitedDetails.map((n) => n.shopName).join('، ')}.` : ''
    } ${refusals.length} حالة رفض. لخّص أهم مشكلة أو فرصة بجملة واحدة.`
  );

  const rec = createRecommendation(companyId, {
    type: 'wave_summary',
    relatedEntityType: 'wave_instance',
    relatedEntityId: waveInstanceId,
    severity: hasProblems ? 'warning' : 'info',
    reason: generated || templateReason,
    data: { totalPoints: points.length, visited: visited.length, notVisited: notVisitedDetails, refusals: refusals.length, completionRate },
  });

  // Only a wave with a real problem is worth pinging a manager about — a
  // clean, fully-completed wave still gets a summary row, just no alert.
  if (hasProblems) notifyAnomaly(companyId, rec);
  return rec;
}

// ---------------------------------------------------------------------
// 5) On-demand report summary (spec item 8 of the dashboards prompt) —
// reuses this exact advisory layer rather than a separate mechanism, per
// spec. Works on whatever report object it's handed (see lib/reports.js /
// lib/reportsExtra.js): flattens it into plain key/value pairs so the
// summary is always traceable back to real numbers, never invented ones —
// what generateText (or the fallback template) says is built FROM those
// same pairs, not from anything else.
// ---------------------------------------------------------------------

const CONCERN_KEY_PATTERN = /overdue|discrepanc|damaged|pending|shortfall|critical|churn|late/i;

function flattenForSummary(obj, prefix = '', out = [], depth = 0) {
  if (depth > 2 || out.length >= 12) return out;
  if (Array.isArray(obj)) return out; // arrays are the detail rows — the summary only needs the aggregate fields
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v != null && typeof v === 'object') flattenForSummary(v, key, out, depth + 1);
      else if (typeof v === 'number' || typeof v === 'string') out.push([key, v]);
    }
  }
  return out;
}

async function summarizeReport(companyId, reportKey, reportData, user) {
  const pairs = flattenForSummary(reportData);
  const concerns = pairs.filter(([k, v]) => CONCERN_KEY_PATTERN.test(k) && Number(v) > 0);

  const templateReason = `ملخص "${reportKey}": ${pairs.map(([k, v]) => `${k}=${v}`).join('، ')}.${
    concerns.length ? ` نقاط تحتاج قرارًا: ${concerns.map(([k, v]) => `${k} (${v})`).join('، ')}.` : ' لا توجد نقاط تستدعي قرارًا فوريًا.'
  }`;

  const generated = await generateText(
    `تقرير "${reportKey}" بالأرقام التالية: ${pairs.map(([k, v]) => `${k}=${v}`).join('، ')}. لخّص بجملتين بالعربية مع التركيز فقط على ما يحتاج قرارًا فعليًا من المدير، دون تكرار كل الأرقام.`
  );

  return createRecommendation(companyId, {
    type: 'report_summary',
    severity: concerns.length ? 'warning' : 'info',
    reason: generated || templateReason,
    data: { reportKey, highlights: Object.fromEntries(pairs), concerns: Object.fromEntries(concerns) },
  });
}

module.exports = {
  FEATURES,
  isFeatureEnabled,
  getFeatureToggles,
  setFeatureToggles,
  getThresholds,
  setThresholds,
  createRecommendation,
  decideRecommendation,
  suggestProductsForShop,
  flagGeofenceAnomaly,
  flagDiscountAnomaly,
  flagReturnRepeatAnomaly,
  flagDeliveryMismatchAnomaly,
  notifyAnomaly,
  computeStockForecasts,
  summarizeWave,
  summarizeReport,
};
