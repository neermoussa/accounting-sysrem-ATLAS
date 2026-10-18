const db = require('../db/init');
const { isLedgerLive } = require('./customerLedger');
const { getCompany } = require('./companies');
const { getAllEnrichedShops } = require('./shopData');

// ---------------------------------------------------------------------
// Departments (warehouse / accounting / vendors) — the organisational
// layer over the existing modules. Each department gets its own dashboard
// at /api/departments/:dept, built from a SINGLE registry of fields below.
//
// A field lists every department that needs it (`depts`). It is computed
// once, by one function, and appears on every listed department's
// dashboard flagged with `sharedWith` — so "stock value" can never read
// differently in the warehouse view and the accounting view, because
// there is only one implementation of it.
//
// Fields with `tracked: false` have no data source in the schema yet
// (none since Prompt 6 added suppliers and payables). They are returned with a
// null value so the dashboard can show the slot honestly instead of
// inventing a number; flip `tracked` and add `compute` when that module
// is built and every department listing the field picks it up for free.
// ---------------------------------------------------------------------

// Access mirrors the existing per-action permissions, so a user who could
// already work in a department's screens sees that department's dashboard
// with no re-granting. Vendors has no legacy permission, so it gets its own
// (`view_vendors`) plus the two admin-level escape hatches.
const DEPARTMENTS = {
  warehouse: {
    anyOf: [
      'manage_factory_inventory', 'manage_car_inventory', 'manage_production_requests', 'manage_replenish_requests',
      'create_custody_transfers', 'manage_custody_transfer_items', 'approve_custody_transfer_readiness',
      'confirm_custody_transfer_receipt', 'resolve_transfer_discrepancy', 'approve_returns',
    ],
    anyModule: ['warehouses', 'production', 'delivery'],
  },
  accounting: {
    anyOf: [
      'record_collections', 'confirm_collections', 'send_payment_reminders', 'view_statistics',
      'import_amin', 'apply_return_financial_adjustment', 'view_ledger',
    ],
  },
  vendors: {
    anyOf: ['view_vendors', 'manage_permissions', 'manage_settings'],
  },
};

// Display order only. Which departments show a field is decided by that
// field's own `depts` — a single source of truth, so a shared field can
// never be listed in one place and forgotten in another.
const FIELD_ORDER = [
  'receivables', 'overdueShops', 'collectedTotal', 'pendingCollections', 'rejectedCollections', 'returnsToAdjust',
  'stockValue', 'openOrders', 'pendingReturns',
  'factoryLowStock', 'carLowStock', 'openTransfers', 'transferDiscrepancies', 'pendingReplenish', 'pendingProduction',
  'activeVendors', 'incomingPurchases', 'payables',
];

const FIELDS = {
  // ---- shared: warehouse + accounting ----
  stockValue: {
    depts: ['warehouse', 'accounting'],
    kind: 'money',
    compute: (cid) => {
      const rows = db
        .prepare(
          `SELECT i.current_quantity AS qty, p.cost_price AS cost FROM factory_inventory i LEFT JOIN products p ON p.id = i.product_id WHERE i.company_id = ?
           UNION ALL
           SELECT i.current_quantity, p.cost_price FROM car_inventory i LEFT JOIN products p ON p.id = i.product_id WHERE i.company_id = ?`
        )
        .all(cid, cid);
      let amount = 0;
      let uncosted = 0;
      for (const r of rows) {
        if (r.cost == null) uncosted++;
        else amount += (r.qty || 0) * r.cost;
      }
      return { value: Math.round(amount * 100) / 100, meta: { uncosted } };
    },
  },
  openOrders: {
    depts: ['warehouse', 'accounting'],
    kind: 'money',
    compute: (cid) => {
      const r = db
        .prepare("SELECT COALESCE(SUM(total_value),0) AS amount, COUNT(*) AS c FROM orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ('approved','processing','out_for_delivery')")
        .get(cid);
      return { value: r.amount, meta: { count: r.c } };
    },
  },
  // ---- shared: warehouse + accounting (a return touches stock AND the customer's balance) ----
  pendingReturns: {
    depts: ['warehouse', 'accounting'],
    kind: 'count',
    compute: (cid) => ({ value: db.prepare("SELECT COUNT(*) c FROM return_requests WHERE company_id = ? AND status = 'pending_review'").get(cid).c }),
  },
  returnsToAdjust: {
    depts: ['accounting', 'warehouse'],
    kind: 'count',
    compute: (cid) => ({
      value: db.prepare("SELECT COUNT(*) c FROM return_requests WHERE company_id = ? AND status = 'approved' AND financial_adjustment_applied = 0").get(cid).c,
    }),
  },
  // ---- shared: warehouse + vendors ----
  factoryLowStock: {
    depts: ['warehouse', 'vendors'],
    kind: 'count',
    tone: 'warn',
    compute: (cid) => ({
      value: db.prepare('SELECT COUNT(*) c FROM factory_inventory WHERE company_id = ? AND min_quantity > 0 AND current_quantity <= min_quantity').get(cid).c,
    }),
  },
  // ---- shared: warehouse + vendors (Prompt 6: approved POs still to receive) ----
  incomingPurchases: {
    depts: ['warehouse', 'vendors'],
    kind: 'count',
    compute: (cid) => {
      const r = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(estimated_base_minor), 0) v FROM purchase_orders WHERE company_id = ? AND status IN ('approved','partially_received')").get(cid);
      return { value: r.c, meta: { estimated_base_minor: r.v } };
    },
  },
  // ---- shared: accounting + vendors (Prompt 6: the AP control account) ----
  payables: {
    depts: ['accounting', 'vendors'],
    kind: 'money',
    compute: (cid) => {
      const minor = require('./payables').apControlBalance(cid);
      const d = require('./ledger').getBaseCurrency(cid).minor_unit_digits;
      return { value: minor / 10 ** d, meta: { minor } };
    },
  },

  // ---- warehouse only ----
  carLowStock: {
    depts: ['warehouse'],
    kind: 'count',
    tone: 'warn',
    compute: (cid) => ({
      value: db.prepare('SELECT COUNT(*) c FROM car_inventory WHERE company_id = ? AND min_quantity > 0 AND current_quantity <= min_quantity').get(cid).c,
    }),
  },
  openTransfers: {
    depts: ['warehouse'],
    kind: 'count',
    compute: (cid) => ({
      value: db.prepare("SELECT COUNT(*) c FROM custody_transfers WHERE company_id = ? AND status IN ('pending_preparation','loading')").get(cid).c,
    }),
  },
  transferDiscrepancies: {
    depts: ['warehouse'],
    kind: 'count',
    tone: 'warn',
    compute: (cid) => ({ value: db.prepare("SELECT COUNT(*) c FROM custody_transfers WHERE company_id = ? AND status = 'discrepancy'").get(cid).c }),
  },
  pendingReplenish: {
    depts: ['warehouse'],
    kind: 'count',
    compute: (cid) => ({ value: db.prepare("SELECT COUNT(*) c FROM warehouse_replenish_requests WHERE company_id = ? AND status = 'pending'").get(cid).c }),
  },
  pendingProduction: {
    depts: ['warehouse'],
    kind: 'count',
    compute: (cid) => ({ value: db.prepare("SELECT COUNT(*) c FROM production_requests WHERE company_id = ? AND status = 'pending_processing'").get(cid).c }),
  },

  // ---- accounting only ----
  receivables: {
    depts: ['accounting'],
    kind: 'money',
    compute: (cid) => {
      // Ledger-live companies (Prompt 3): straight from the receivable ledger.
      if (isLedgerLive(cid)) {
        const f = require('./receivables').dashboardFigures(cid);
        return { value: f.receivables, meta: { shops: f.receivableShops } };
      }
      const shops = getAllEnrichedShops(cid);
      return { value: shops.reduce((s, sh) => s + (sh.balance > 0 ? sh.balance : 0), 0), meta: { shops: shops.filter((sh) => sh.balance > 0).length } };
    },
  },
  overdueShops: {
    depts: ['accounting'],
    kind: 'count',
    tone: 'warn',
    // Live: customers with at least one invoice/open item past its due date.
    compute: (cid) => (isLedgerLive(cid)
      ? { value: require('./receivables').dashboardFigures(cid).overdueShops }
      : { value: getAllEnrichedShops(cid).filter((s) => s.isOverDebt).length }),
  },
  collectedTotal: {
    depts: ['accounting'],
    kind: 'money',
    compute: (cid) => ({ value: db.prepare("SELECT COALESCE(SUM(amount),0) a FROM collections WHERE company_id = ? AND status = 'confirmed'").get(cid).a }),
  },
  pendingCollections: {
    depts: ['accounting'],
    kind: 'money',
    compute: (cid) => {
      const r = db
        .prepare("SELECT COALESCE(SUM(amount),0) a, COUNT(*) c FROM collections WHERE company_id = ? AND status IN ('pending_accountant_confirmation','pending_verification')")
        .get(cid);
      return { value: r.a, meta: { count: r.c } };
    },
  },
  rejectedCollections: {
    depts: ['accounting'],
    kind: 'count',
    tone: 'warn',
    compute: (cid) => ({ value: db.prepare("SELECT COUNT(*) c FROM collections WHERE company_id = ? AND status = 'rejected'").get(cid).c }),
  },

  // ---- vendors only (no vendor table exists yet) ----
  activeVendors: {
    depts: ['vendors'],
    kind: 'count',
    compute: (cid) => ({ value: db.prepare('SELECT COUNT(*) c FROM suppliers WHERE company_id = ? AND is_active = 1').get(cid).c }),
  },
};

// Fail loudly at load time rather than silently dropping a field from every dashboard.
for (const key of Object.keys(FIELDS)) {
  if (!FIELD_ORDER.includes(key)) throw new Error(`departments: field "${key}" missing from FIELD_ORDER`);
}
for (const key of FIELD_ORDER) {
  if (!FIELDS[key]) throw new Error(`departments: FIELD_ORDER lists unknown field "${key}"`);
}

// ---- detail lists ----

function lowStockList(cid) {
  return db
    .prepare(
      `SELECT item_name AS name, current_quantity AS qty, min_quantity AS min FROM factory_inventory
       WHERE company_id = ? AND min_quantity > 0 AND current_quantity <= min_quantity
       ORDER BY (min_quantity - current_quantity) DESC LIMIT 8`
    )
    .all(cid)
    .map((r) => ({ ...r, shortfall: r.min - r.qty }));
}

function transfersList(cid) {
  return db
    .prepare(
      `SELECT id, status, created_at FROM custody_transfers WHERE company_id = ? AND status IN ('pending_preparation','loading','discrepancy')
       ORDER BY id DESC LIMIT 6`
    )
    .all(cid);
}

function topDebtors(cid) {
  return getAllEnrichedShops(cid)
    .filter((s) => s.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 8)
    .map((s) => ({ shopId: s.id, name: s.name, balance: s.balance, overdue: !!s.isOverDebt }));
}

function pendingCollectionsList(cid) {
  return db
    .prepare(
      `SELECT c.id, c.amount, c.method, c.collected_at, s.name AS shop_name FROM collections c JOIN shops s ON s.id = c.shop_id
       WHERE c.company_id = ? AND c.status IN ('pending_accountant_confirmation','pending_verification') ORDER BY c.id DESC LIMIT 6`
    )
    .all(cid);
}

const LISTS = {
  warehouse: { lowStock: lowStockList, transfers: transfersList },
  accounting: { topDebtors, pendingCollections: pendingCollectionsList },
  vendors: { reorder: lowStockList },
};

function moduleOn(company, key) {
  return company.modules?.[key] !== false;
}

function canAccess(deptKey, user, company) {
  const dept = DEPARTMENTS[deptKey];
  if (!dept) return false;
  if (!dept.anyOf.some((p) => user.permissions.includes(p))) return false;
  if (dept.anyModule && company && !dept.anyModule.some((m) => moduleOn(company, m))) return false;
  return true;
}

function getDepartmentDashboard(companyId, deptKey) {
  const dept = DEPARTMENTS[deptKey];
  const fields = FIELD_ORDER.filter((key) => FIELDS[key].depts.includes(deptKey)).map((key) => {
    const def = FIELDS[key];
    const tracked = def.tracked !== false;
    const out = tracked ? def.compute(companyId) : { value: null };
    return {
      key,
      kind: def.kind,
      tone: def.tone || null,
      tracked,
      value: out.value,
      meta: out.meta || null,
      sharedWith: def.depts.filter((d) => d !== deptKey),
    };
  });
  const lists = Object.fromEntries(Object.entries(LISTS[deptKey]).map(([name, fn]) => [name, fn(companyId)]));
  return { department: deptKey, fields, lists, currency: getCompany(companyId)?.currency || null };
}

module.exports = { DEPARTMENTS, FIELDS, canAccess, getDepartmentDashboard };
