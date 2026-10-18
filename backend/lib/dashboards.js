const db = require('../db/init');
const { getCompany } = require('./companies');
const { getOverviewKpis, getInventoryReport } = require('./reports');
const { getAllEnrichedShops } = require('./shopData');

function getSetting(companyId, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}

// ---------------------------------------------------------------------
// Per-company, per-dashboard section visibility — spec item 4 ("كل لوحة
// قابلة للتخصيص حسب صلاحيات الشركة"). Stored as a JSON array of HIDDEN
// section keys in the existing generic `settings` table (one row per
// dashboard) rather than a new table — every section defaults visible
// until a company explicitly hides it.
// ---------------------------------------------------------------------

function getHiddenSections(companyId, dashboard) {
  const raw = getSetting(companyId, `dashboard_hidden_sections_${dashboard}`, '[]');
  try {
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function setHiddenSections(companyId, dashboard, hiddenKeys) {
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(companyId, `dashboard_hidden_sections_${dashboard}`, JSON.stringify(hiddenKeys));
}

function moduleEnabled(company, key) {
  return company.modules?.[key] !== false; // missing key defaults to visible, same convention as lib/companies.js
}

// Applies both gates a section must pass: the company's enabled MODULES
// (whole feature areas, set in Startup Setup / Settings) and this
// dashboard's own hidden-section list (finer-grained, per spec item 4).
function buildSections(companyId, dashboard, company, hidden, candidates) {
  const out = {};
  for (const [key, { module, build }] of Object.entries(candidates)) {
    if (module && !moduleEnabled(company, module)) continue;
    if (hidden.has(key)) continue;
    out[key] = build();
  }
  return out;
}

// ---------------------------------------------------------------------
// Manager: company-wide performance across every enabled module.
// ---------------------------------------------------------------------

function getManagerDashboard(companyId) {
  const company = getCompany(companyId);
  const hidden = getHiddenSections(companyId, 'manager');

  const candidates = {
    sales: { build: () => getOverviewKpis(companyId) },
    collections: {
      module: 'collections',
      build: () => {
        const rows = db.prepare("SELECT status, amount FROM collections WHERE company_id = ?").all(companyId);
        return {
          confirmedTotal: rows.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amount, 0),
          // 'reversed' collections are neither collected nor pending.
          pendingTotal: rows.filter((r) => r.status === 'pending_accountant_confirmation' || r.status === 'pending_verification').reduce((s, r) => s + r.amount, 0),
        };
      },
    },
    debts: {
      build: () => {
        const shops = getAllEnrichedShops(companyId);
        return { overdueCount: shops.filter((s) => s.isOverDebt).length, totalOutstanding: shops.reduce((s, sh) => s + (sh.balance > 0 ? sh.balance : 0), 0) };
      },
    },
    inventory: { module: 'warehouses', build: () => getInventoryReport(companyId) },
    discrepancies: {
      module: 'warehouses',
      build: () => db.prepare("SELECT COUNT(*) c FROM custody_transfers WHERE company_id = ? AND status = 'discrepancy'").get(companyId),
    },
    damaged: {
      build: () => db.prepare("SELECT COUNT(*) c FROM return_items WHERE company_id = ? AND inspection_status = 'damaged'").get(companyId),
    },
    returns: {
      build: () => db.prepare("SELECT COUNT(*) c FROM return_requests WHERE company_id = ?").get(companyId),
    },
    repPerformance: {
      module: 'reps',
      build: () => db.prepare("SELECT COUNT(DISTINCT rep_id) c FROM orders WHERE company_id = ? AND rep_id IS NOT NULL").get(companyId),
    },
    customers: {
      build: () => db.prepare('SELECT COUNT(*) c FROM shops WHERE company_id = ? AND active = 1').get(companyId),
    },
    waves: {
      module: 'reps',
      build: () => {
        const row = db
          .prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM wave_instances WHERE company_id = ?")
          .get(companyId);
        return { totalWaves: row.total, completedWaves: row.completed || 0 };
      },
    },
    production: {
      module: 'production',
      build: () => db.prepare("SELECT COUNT(*) c FROM production_requests WHERE company_id = ? AND status = 'pending_processing'").get(companyId),
    },
    whatsapp: {
      module: 'whatsapp',
      build: () => ({
        openTickets: db.prepare("SELECT COUNT(*) c FROM whatsapp_tickets WHERE company_id = ? AND status = 'open'").get(companyId).c,
        openAlerts: db.prepare("SELECT COUNT(*) c FROM whatsapp_message_alerts WHERE company_id = ? AND status = 'open'").get(companyId).c,
      }),
    },
  };

  return { dashboard: 'manager', sections: buildSections(companyId, 'manager', company, hidden, candidates) };
}

// ---------------------------------------------------------------------
// Supervisor: today's operations.
// ---------------------------------------------------------------------

function getSupervisorDashboard(companyId) {
  const company = getCompany(companyId);
  const hidden = getHiddenSections(companyId, 'supervisor');
  const today = new Date().toISOString().slice(0, 10);

  const candidates = {
    waves: {
      module: 'reps',
      build: () => {
        const rows = db.prepare('SELECT status, COUNT(*) c FROM wave_instances WHERE company_id = ? AND plan_date = ? GROUP BY status').all(companyId, today);
        return Object.fromEntries(rows.map((r) => [r.status, r.c]));
      },
    },
    visits: {
      module: 'reps',
      build: () => db.prepare('SELECT COUNT(*) c FROM visit_records WHERE company_id = ? AND date(recorded_at) = ?').get(companyId, today),
    },
    orders: {
      build: () => {
        const pending = db.prepare("SELECT COUNT(*) c FROM orders WHERE company_id = ? AND status = 'pending_approval' AND deleted_at IS NULL").get(companyId).c;
        const today_ = db.prepare('SELECT COUNT(*) c FROM orders WHERE company_id = ? AND order_date = ? AND deleted_at IS NULL').get(companyId, today).c;
        return { pendingApproval: pending, ordersToday: today_ };
      },
    },
    shortages: {
      module: 'production',
      build: () => db.prepare("SELECT COUNT(*) c FROM production_requests WHERE company_id = ? AND status = 'pending_processing'").get(companyId),
    },
    custodyTransfers: {
      module: 'warehouses',
      build: () => db.prepare("SELECT COUNT(*) c FROM custody_transfers WHERE company_id = ? AND status IN ('loading','discrepancy')").get(companyId),
    },
    operationalIssues: {
      build: () => db.prepare("SELECT COUNT(*) c FROM ai_recommendations WHERE company_id = ? AND decision_status = 'pending' AND type LIKE 'anomaly_%'").get(companyId),
    },
  };

  return { dashboard: 'supervisor', sections: buildSections(companyId, 'supervisor', company, hidden, candidates) };
}

// ---------------------------------------------------------------------
// Rep: strictly their own data — waves, shops, orders, collections, car
// inventory (company-wide pool, disclosed as such — see lib/waves.js /
// lib/reportsExtra.js's identical note on car_inventory not being
// per-vehicle in this schema).
// ---------------------------------------------------------------------

function getRepDashboard(companyId, userId) {
  const company = getCompany(companyId);
  const hidden = getHiddenSections(companyId, 'rep');
  const today = new Date().toISOString().slice(0, 10);

  const candidates = {
    myWaveToday: {
      module: 'reps',
      build: () => {
        const instance = db.prepare('SELECT * FROM wave_instances WHERE company_id = ? AND rep_id = ? AND plan_date = ?').get(companyId, userId, today);
        if (!instance) return { instance: null, points: [] };
        const points = db.prepare('SELECT wp.*, s.name as shop_name FROM wave_points wp JOIN shops s ON s.id = wp.shop_id WHERE wave_instance_id = ? AND removed_at IS NULL').all(instance.id);
        return { instance, points };
      },
    },
    myShops: {
      build: () => db.prepare('SELECT COUNT(*) c FROM shops WHERE company_id = ? AND assigned_rep_id = ? AND active = 1').get(companyId, userId),
    },
    myOrders: {
      build: () => {
        const rows = db.prepare("SELECT status, COUNT(*) c FROM orders WHERE company_id = ? AND rep_id = ? AND deleted_at IS NULL GROUP BY status").all(companyId, userId);
        return Object.fromEntries(rows.map((r) => [r.status, r.c]));
      },
    },
    myCollections: {
      module: 'collections',
      build: () => db.prepare("SELECT COALESCE(SUM(amount),0) total, COUNT(*) c FROM collections WHERE company_id = ? AND rep_id = ?").get(companyId, userId),
    },
    myCarInventory: {
      module: 'warehouses',
      build: () => db.prepare('SELECT item_name, current_quantity, min_quantity FROM car_inventory WHERE company_id = ?').all(companyId),
    },
  };

  return { dashboard: 'rep', sections: buildSections(companyId, 'rep', company, hidden, candidates) };
}

module.exports = { getManagerDashboard, getSupervisorDashboard, getRepDashboard, getHiddenSections, setHiddenSections };
