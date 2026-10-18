const db = require('../db/init');
const { hashPassword } = require('./auth');
const { ALL_PERMISSION_KEYS, MANAGE_PERMISSIONS, setUserPermissions } = require('./permissions');
const { PRIVACY_POLICY_VERSION } = require('./legal');

// The full module catalog a company can toggle in Startup Setup. Every key
// here is what the frontend sidebar/route gating (see App.jsx) checks
// against `companies.modules_json` — a module missing from that JSON is
// treated as disabled, so this list is also the source of truth for what
// "all modules on" means for a brand-new company.
const MODULE_KEYS = [
  'reps', 'customers', 'warehouses', 'delivery', 'collections',
  'whatsapp', 'production', 'reports', 'ai',
];

function defaultModules() {
  return Object.fromEntries(MODULE_KEYS.map((k) => [k, true]));
}

// Per-company defaults — mirrors the single-tenant defaults this app used
// to seed once globally at db-init time, now applied once per company at
// creation instead. A company overwrites any of these later from Settings.
function defaultSettingsFor(company) {
  return {
    debt_threshold: '500',
    order_overdue_days: '14',
    attention_overdue_multiplier: '1.5',
    base_lat: '',
    base_lng: '',
    classification_window_days: '90',
    classification_sales_a_min: '',
    classification_sales_b_min: '',
    classification_regularity_cv_a_max: '',
    classification_regularity_cv_b_max: '',
    manager_whatsapp_number: '',
    whatsapp_customer_notify_enabled: '0',
    monthly_sales_target: '',
    usd_exchange_rate: '',
    usd_exchange_rate_updated_at: '',
    usd_exchange_rate_source: '',
    company_name: company.name,
    company_logo_url: company.logo_url || '',
    default_language: 'ar',
    map_default_layer: 'flat',
    map_default_zoom: '9',
    map_clustering_enabled: '1',
    sound_default_muted: '0',
    sound_volume: '1',
    sound_chime_preset: 'classic',
    inventory_default_min_quantity: '5',
    inventory_default_unit: 'kg',
    credit_limit_color_enabled: '1',
    payment_overdue_color_enabled: '0',
    payment_overdue_days: '30',
    overdue_new_order_policy: 'allow',
    return_auto_financial_adjustment: '0',
  };
}

function seedDefaultSettings(companyId, company) {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (company_id, key, value) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(defaultSettingsFor(company))) insert.run(companyId, k, v);
}

// Creates a brand-new company plus its first user (that company's manager,
// auto-approved with every permission — there's nobody else in the company
// yet to approve them, same bootstrap logic the old single-tenant register
// flow used for "the first account ever"). This is the ONLY way a company
// row is ever created — there is no seeded/default company anywhere else in
// this codebase.
// Not wrapped in a single db.transaction — setUserPermissions below runs its
// own internal transaction, and this thin sqlite shim (see db/init.js)
// doesn't support nesting BEGIN inside BEGIN. Each statement here is simple
// enough (and failure this early is rare enough) that sequential execution
// is an acceptable tradeoff, matching how the old single-tenant "first user"
// bootstrap in routes/auth.js worked before this file existed.
function createCompanyWithAdmin({ companyName, adminName, adminContact, adminPassword, currency }) {
  // Consent is required before this function is ever reached — see
  // routes/companies.js's POST / — so by the time a company row exists,
  // acceptance is always recorded. Stamped with the version actually shown
  // at the time (lib/legal.js), not just "accepted: true".
  const companyInfo = db
    .prepare(`INSERT INTO companies (name, currency, privacy_policy_accepted_at, privacy_policy_version) VALUES (?, ?, datetime('now'), ?)`)
    .run(companyName, currency || 'USD', PRIVACY_POLICY_VERSION);
  const companyId = companyInfo.lastInsertRowid;

  const userInfo = db
    .prepare(
      `INSERT INTO users (company_id, name, contact, password_hash, role, status, language)
       VALUES (?, ?, ?, ?, 'manager', 'approved', 'ar')`
    )
    .run(companyId, adminName, adminContact, hashPassword(adminPassword));
  const adminId = userInfo.lastInsertRowid;
  setUserPermissions(adminId, [...ALL_PERMISSION_KEYS, MANAGE_PERMISSIONS], adminId);

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  seedDefaultSettings(companyId, company);

  db.prepare(
    `INSERT INTO company_setup_state (company_id, current_step, completed_steps_json) VALUES (?, 'profile', '[]')`
  ).run(companyId);

  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  return { company, admin };
}

function getCompany(companyId) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) return null;
  return {
    ...company,
    branches: JSON.parse(company.branches_json || '[]'),
    modules: { ...defaultModulesForExisting(company), ...JSON.parse(company.modules_json || '{}') },
    documents_info: JSON.parse(company.documents_info_json || '{}'),
    whatsapp_messages_info: JSON.parse(company.whatsapp_messages_info_json || '{}'),
  };
}

// A company created before a given module existed shouldn't suddenly have
// it silently OFF just because modules_json predates that key — every
// module defaults to visible until a company explicitly turns it off.
function defaultModulesForExisting() {
  return defaultModules();
}

function listCompanies() {
  return db.prepare('SELECT * FROM companies ORDER BY created_at DESC').all().map((c) => getCompany(c.id));
}

function companyHasPostedEntries(companyId) {
  return !!db.prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND status IN ('posted','reversed') LIMIT 1").get(companyId);
}

function updateCompanyProfile(companyId, fields) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) return null;
  // The ledger stores every amount in minor units of the base currency
  // (companies.currency). Once anything is posted, changing it would silently
  // re-denominate the books, so it is refused (db/ledgerSchema.js has the
  // same rule as a trigger).
  const nextCurrency = fields.currency ?? company.currency;
  if (nextCurrency !== company.currency && companyHasPostedEntries(companyId)) {
    const err = new Error('لا يمكن تغيير عملة الشركة بعد ترحيل قيود محاسبية — العملة الأساسية للدفاتر ثابتة');
    err.status = 409;
    err.code = 'currency_locked';
    throw err;
  }
  const next = {
    name: fields.name ?? company.name,
    logo_url: fields.logo_url ?? company.logo_url,
    contact_phone: fields.contact_phone ?? company.contact_phone,
    contact_email: fields.contact_email ?? company.contact_email,
    address: fields.address ?? company.address,
    branches_json: fields.branches ? JSON.stringify(fields.branches) : company.branches_json,
    currency: fields.currency ?? company.currency,
    price_display_mode: fields.price_display_mode ?? company.price_display_mode,
    brand_color: fields.brand_color ?? company.brand_color,
    documents_info_json: fields.documents_info ? JSON.stringify(fields.documents_info) : company.documents_info_json,
    whatsapp_messages_info_json: fields.whatsapp_messages_info
      ? JSON.stringify(fields.whatsapp_messages_info)
      : company.whatsapp_messages_info_json,
    custody_model: fields.custody_model ?? company.custody_model,
  };
  db.prepare(
    `UPDATE companies SET name = ?, logo_url = ?, contact_phone = ?, contact_email = ?, address = ?,
     branches_json = ?, currency = ?, price_display_mode = ?, brand_color = ?, documents_info_json = ?,
     whatsapp_messages_info_json = ?, custody_model = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    next.name, next.logo_url, next.contact_phone, next.contact_email, next.address,
    next.branches_json, next.currency, next.price_display_mode, next.brand_color, next.documents_info_json,
    next.whatsapp_messages_info_json, next.custody_model, companyId
  );
  return getCompany(companyId);
}

function updateModules(companyId, modules) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) return null;
  const current = { ...defaultModules(), ...JSON.parse(company.modules_json || '{}') };
  // ledger_live is not a display toggle: it is only ever set by the go-live
  // backfill (lib/customerLedger.js executeGoLive), which posts the opening
  // balances in the same transaction. It can't be flipped from here.
  const { ledger_live: _ignored, ...requested } = modules || {};
  const next = { ...current, ...requested };
  db.prepare(`UPDATE companies SET modules_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(next),
    companyId
  );
  return getCompany(companyId);
}

function setSubscriptionStatus(companyId, status) {
  if (!['active', 'suspended'].includes(status)) throw new Error('invalid_status');
  db.prepare(`UPDATE companies SET subscription_status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    companyId
  );
  return getCompany(companyId);
}

function markSetupComplete(companyId) {
  db.prepare(`UPDATE companies SET setup_completed = 1, updated_at = datetime('now') WHERE id = ?`).run(companyId);
}

function getSetupState(companyId) {
  const row = db.prepare('SELECT * FROM company_setup_state WHERE company_id = ?').get(companyId);
  if (!row) return { current_step: 'profile', completed_steps: [] };
  return { current_step: row.current_step, completed_steps: JSON.parse(row.completed_steps_json || '[]') };
}

function saveSetupState(companyId, { currentStep, completedSteps }) {
  db.prepare(
    `INSERT INTO company_setup_state (company_id, current_step, completed_steps_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id) DO UPDATE SET current_step = excluded.current_step, completed_steps_json = excluded.completed_steps_json, updated_at = datetime('now')`
  ).run(companyId, currentStep, JSON.stringify(completedSteps || []));
  return getSetupState(companyId);
}

// Snapshot before a "major" config edit (module toggle, roles rewrite,
// custody model change) — pure audit trail, nothing reads it back
// automatically (a platform admin or company admin can inspect history).
function snapshotConfig(companyId, reason, actor) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) return;
  db.prepare(
    `INSERT INTO company_config_snapshots (company_id, snapshot_json, reason, created_by_id, created_by_name)
     VALUES (?, ?, ?, ?, ?)`
  ).run(companyId, JSON.stringify(company), reason || null, actor?.id ?? null, actor?.name ?? null);
}

module.exports = {
  MODULE_KEYS,
  defaultModules,
  createCompanyWithAdmin,
  getCompany,
  listCompanies,
  updateCompanyProfile,
  updateModules,
  setSubscriptionStatus,
  markSetupComplete,
  getSetupState,
  saveSetupState,
  snapshotConfig,
  seedDefaultSettings,
};
