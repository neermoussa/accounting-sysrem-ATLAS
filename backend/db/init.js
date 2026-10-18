require('../lib/clock'); // test-only clock override; no-op in production
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// DB_PATH env override exists solely so tests can point this module at a
// throwaway scratch SQLite file instead of the real dev database — normal
// app startup never sets it, so behavior is unchanged in every other case.
const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, 'data.sqlite');
const isNew = !fs.existsSync(DB_PATH);

const db = require('../lib/clock').attachSqlite(new DatabaseSync(DB_PATH));

// better-sqlite3 compatibility shims — node:sqlite has no .pragma()/.transaction()
// helpers of its own, so the rest of the codebase (routes, seed-demo.js) keeps
// calling them exactly as before against these thin wrappers.
db.pragma = (statement) => db.exec(`PRAGMA ${statement}`);
// BEGIN IMMEDIATE: take the write lock at the start (waiting up to the busy
// timeout), never a read that later upgrades to a write — in WAL mode that
// upgrade fails at once with SQLITE_BUSY_SNAPSHOT if another connection
// committed in between.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

// Empty database (new file, or a file with no tables): init.js builds the
// latest schema, so every migration is stamped as applied at the end.
const wasEmpty = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table'").get().c === 0;

db.pragma('journal_mode = WAL');
// Wait up to 5 s for another connection's write lock instead of failing at
// once with SQLITE_BUSY ("database is locked"): scripts (backup, migrate,
// dedupe), a second server process or a test connection can write the same
// file while this process writes (sweeps, requests).
db.pragma(`busy_timeout = ${require('./sqliteConfig').BUSY_TIMEOUT_MS}`);
db.pragma('foreign_keys = ON');

// ============================================================================
// Multi-tenant schema. Every table that holds a single company's operating
// data carries a `company_id` column, enforced NOT NULL wherever the table
// has its own top-level identity (shops, orders, users, ...) — a handful of
// pure line-item children (balances, shop_phone_aliases, import_batch_rows,
// inventory_count_rows, sessions, user_permissions) are scoped implicitly
// through their parent's already-scoped id instead of repeating the column,
// since they can only ever be reached by first looking up that parent.
//
// There is no seeded/default company anywhere in this file — a company only
// ever comes into existence through the Startup Setup flow (see
// lib/companies.js). `users.company_id` is nullable specifically so a
// platform-admin account (lib/permissions.js `is_platform_admin`) can exist
// without belonging to any single company.
// ============================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  logo_url TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  address TEXT,
  branches_json TEXT NOT NULL DEFAULT '[]',
  currency TEXT NOT NULL DEFAULT 'USD',
  price_display_mode TEXT NOT NULL DEFAULT 'with_tax',
  brand_color TEXT,
  documents_info_json TEXT NOT NULL DEFAULT '{}',
  whatsapp_messages_info_json TEXT NOT NULL DEFAULT '{}',
  modules_json TEXT NOT NULL DEFAULT '{}',
  custody_model TEXT NOT NULL DEFAULT 'vehicle' CHECK (custody_model IN ('vehicle', 'rep', 'mixed')),
  subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active', 'suspended')),
  setup_completed INTEGER NOT NULL DEFAULT 0,
  -- Consent for the anonymized market-intelligence aggregation (see
  -- lib/marketIntelligence.js) is captured at signup, not opt-in/opt-out
  -- later — routes/companies.js's POST / refuses to create a company
  -- without acceptedPrivacyPolicy:true in the request. Nullable only
  -- because it predates companies created before this feature existed.
  privacy_policy_accepted_at TEXT,
  privacy_policy_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Wizard progress — a company can save the Startup Setup flow as a draft and
-- come back to it. Deliberately separate from 'companies.setup_completed'
-- (a single flag) so the wizard UI knows exactly which step to resume on and
-- which steps were already filled in, without re-deriving that from the
-- presence/absence of rows in half a dozen other tables.
CREATE TABLE IF NOT EXISTS company_setup_state (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  current_step TEXT NOT NULL DEFAULT 'profile',
  completed_steps_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Snapshot of a company's full configuration taken right before a "major"
-- settings edit (module toggle, roles rewrite, custody model change) so an
-- admin can see/restore what changed — separate from data_restore_requests
-- below, which is about operating data, not configuration.
CREATE TABLE IF NOT EXISTS company_config_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  reason TEXT,
  created_by_id INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_company_config_snapshots_company ON company_config_snapshots(company_id, created_at DESC);

-- phone is nullable on purpose: a customer can be created and fully
-- operated (orders, visits entered manually) with no phone number at all.
-- SQLite's UNIQUE index treats every NULL as distinct, so this still blocks
-- two shops sharing the same non-null phone without blocking multiple
-- phone-less shops. Numbers beyond this single legacy field (multiple
-- phones/WhatsApp lines per shop, each independently OTP-verified) live in
-- shop_phones below; 'phone' is kept in sync with that table's primary
-- number so every place that already reads shop.phone keeps working.
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  owner_name TEXT,
  contact_person TEXT,
  email TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  notes TEXT,
  working_hours TEXT,
  business_type TEXT,
  region TEXT,
  branch TEXT,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  assigned_rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  custom_fields_json TEXT NOT NULL DEFAULT '{}',
  public_token TEXT,
  debt_threshold_override REAL,
  order_overdue_days_override INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  classification TEXT,
  classification_computed_at TEXT,
  debt_alert_active INTEGER NOT NULL DEFAULT 0,
  overdue_alert_active INTEGER NOT NULL DEFAULT 0,
  whatsapp_customer_notify_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_shops_company ON shops(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_public_token ON shops(public_token);
CREATE INDEX IF NOT EXISTS idx_shops_assigned_rep ON shops(assigned_rep_id);

-- Every phone/WhatsApp line a shop owns. The first one added becomes
-- primary automatically and is mirrored onto shops.phone; any later number
-- inherits the same messaging permissions (order confirmations, alerts)
-- unless explicitly excluded via permissions_json. Verification is via a
-- short OTP sent over the company's own connected WhatsApp session
-- (lib/whatsapp.js) — a number only counts as usable for notifications
-- once verified=1, either by OTP or by an authorized employee's manual
-- override after 3 failed attempts.
CREATE TABLE IF NOT EXISTS shop_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  verified_by TEXT,
  excluded_from_notify INTEGER NOT NULL DEFAULT 0,
  otp_code TEXT,
  otp_expires_at TEXT,
  otp_attempts INTEGER NOT NULL DEFAULT 0,
  otp_requested_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_shop_phones_shop ON shop_phones(shop_id);

-- Company-defined extra profile fields (per Startup Setup / Settings), e.g.
-- "رقم السجل التجاري" as a free text field. Values live in
-- shops.custom_fields_json keyed by this row's 'key'.
CREATE TABLE IF NOT EXISTS company_custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text', 'number', 'date', 'select')),
  options_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, key)
);

-- Shop-facing images (storefront/shelves) and documents (licenses, etc).
CREATE TABLE IF NOT EXISTS shop_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'document')),
  url TEXT NOT NULL,
  label TEXT,
  uploaded_by_id INTEGER REFERENCES users(id),
  uploaded_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shop_media_shop ON shop_media(shop_id);

-- Prospects not yet real customers. 'convert' copies the lead's data into a
-- new shop row and stamps converted_shop_id/converted_at — the lead record
-- itself is kept (not deleted) as a history of where the customer came from.
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  region TEXT,
  notes TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'converted', 'dropped')),
  assigned_rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_id INTEGER REFERENCES users(id),
  created_by_name TEXT,
  converted_shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  converted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company_id);

-- One row per rep reassignment, kept forever (never edited/deleted) as the
-- audit trail item 8 asks for: who had the customer before, who has it now,
-- why, and when.
CREATE TABLE IF NOT EXISTS shop_rep_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  from_rep_id INTEGER REFERENCES users(id),
  from_rep_name TEXT,
  to_rep_id INTEGER REFERENCES users(id),
  to_rep_name TEXT,
  reason TEXT,
  changed_by_id INTEGER REFERENCES users(id),
  changed_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shop_rep_transfers_shop ON shop_rep_transfers(shop_id);

-- Kept when two shop records for the same real customer are merged (item
-- 5) — the losing shop's id/name/phone are recorded against the surviving
-- shop so "why did this shop's order history jump" stays answerable.
CREATE TABLE IF NOT EXISTS shop_merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kept_shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  merged_shop_id INTEGER NOT NULL,
  merged_shop_name TEXT,
  merged_shop_phone TEXT,
  merged_by_id INTEGER REFERENCES users(id),
  merged_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  balance REAL NOT NULL,
  source_file TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_balances_shop ON balances(shop_id, report_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_balances_shop_date ON balances(shop_id, report_date);

CREATE TABLE IF NOT EXISTS shop_phone_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, phone)
);

-- rep_id is nullable (an office-entered order may have no rep at all) but
-- is stamped with req.user.id at creation time by whoever actually took
-- the order (routes/shops.js) — this is the one place "which rep made this
-- sale" is recorded, and everything rep-commission/scorecard-related reads
-- it from here rather than shops.assigned_rep_id (which can change later
-- and would misattribute past sales).
-- status defaults to 'approved' so every order created through the
-- original, still-untouched creation path (routes/shops.js, plain
-- office/rep entry) keeps behaving exactly as it always did — the richer
-- draft/pending_approval states are opt-in, only ever set explicitly by
-- the new lifecycle-aware paths (WhatsApp review, an auto-approve-off
-- company setting). source distinguishes those same three paths from the
-- spec: 'whatsapp' (only ever set when a whatsapp_orders row is approved
-- into a real order), 'rep_manual', or 'direct' (office/software entry).
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_date TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  total_value REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'processing', 'out_for_delivery', 'delivered', 'paid', 'returned', 'cancelled')
  ),
  source TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('whatsapp', 'rep_manual', 'direct')),
  approved_by_id INTEGER REFERENCES users(id),
  approved_by_name TEXT,
  approved_at TEXT,
  credit_limit_exceeded INTEGER NOT NULL DEFAULT 0,
  credit_override_reason TEXT,
  cancel_reason TEXT,
  return_reason TEXT,
  follow_up_of_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  delivered_at TEXT,
  paid_at TEXT,
  returned_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_rep ON orders(rep_id, order_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(company_id, status);

-- Every field-level change to an order (quantity/price/date/status/...),
-- with a real before/after pair — same audited-change pattern as
-- wave_point_changes, read by the order's own history view and by
-- whatever downstream screen needs "who changed this and when".
CREATE TABLE IF NOT EXISTS order_status_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  field TEXT,
  before_value TEXT,
  after_value TEXT,
  changed_by_id INTEGER REFERENCES users(id),
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_status_changes_order ON order_status_changes(order_id, changed_at);

-- One delivery event against an order — qty_delivered per item can be less
-- than what was ordered (partial delivery, item 8 of the spec); the
-- shortfall, if any, is what a follow-up order (orders.follow_up_of_order_id)
-- gets created from when the company setting for that is on.
CREATE TABLE IF NOT EXISTS order_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivered_items_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  -- Customer's e-signature captured at the point of delivery — same
  -- data-URL convention as visit_records.signature_data_url (Waves
  -- feature); never required, just stored when the delivery flow collects
  -- one.
  signature_data_url TEXT,
  delivered_by_id INTEGER REFERENCES users(id),
  delivered_by_name TEXT,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An inbound WhatsApp message that LOOKS like an order — never a real
-- order on its own (orders.source='whatsapp' rows only ever come from
-- approving one of these). shop_id is nullable: an unrecognized sender
-- phone still needs to show up somewhere for a human to match by hand.
CREATE TABLE IF NOT EXISTS whatsapp_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  from_phone TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'rejected')),
  assigned_rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_by_name TEXT,
  reviewed_at TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_orders_company ON whatsapp_orders(company_id, status);

-- ============================================================================
-- Automatic stock check + production requests: fires once an order becomes
-- 'approved' (lib/stockCheck.js). Car stock is checked first, then the
-- factory warehouse; a full shortfall becomes a production_requests row,
-- a car-only shortfall (warehouse can cover it) becomes a
-- warehouse_replenish_requests row instead.
-- ============================================================================

CREATE TABLE IF NOT EXISTS production_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  unit_key TEXT,
  requested_qty REAL NOT NULL,
  available_qty REAL NOT NULL DEFAULT 0,
  shortage_qty REAL NOT NULL,
  rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expected_delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending_processing' CHECK (
    status IN ('pending_processing', 'in_production', 'ready', 'fulfilled', 'cancelled')
  ),
  updated_by_id INTEGER REFERENCES users(id),
  updated_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_production_requests_company ON production_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_production_requests_order ON production_requests(order_id);

-- The item exists in the warehouse but the rep's car is short — this is a
-- "go load the van" task for the warehouse keeper, never a production
-- shortage.
CREATE TABLE IF NOT EXISTS warehouse_replenish_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  unit_key TEXT,
  requested_qty REAL NOT NULL,
  rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'prepared', 'delivered_to_car', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_warehouse_replenish_company ON warehouse_replenish_requests(company_id, status);

-- Prep/load timing policy: how many days before the delivery date an item
-- may be pulled from the warehouse and loaded onto a vehicle. A row scoped
-- to product_id is the most specific match, then category, then the
-- company-wide default (settings key 'default_prep_lead_time_days').
-- load_early=0 marks large/order-specific goods that must stay at the
-- warehouse/loading area until close to the delivery date rather than
-- riding around on the truck early; load_early=1 (staple/small items) can
-- go out with the very next load regardless of this item's own due date.
CREATE TABLE IF NOT EXISTS prep_lead_time_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  category TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 1,
  load_early INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prep_lead_time_company ON prep_lead_time_policies(company_id, product_id, category);

-- ============================================================================
-- Custody transfers (مناقلة): warehouse -> rep's vehicle custody, exactly
-- two stages, no intermediate warehouse. 'loading' is the pallet-staging
-- stage (item prepared_qty set by the warehouse keeper); the rep then
-- submits received_qty per item on arrival. companies.custody_model
-- (already existing: 'vehicle' shared / 'rep' separate-per-item /
-- 'mixed') decides how vehicle_id vs. rep_id attribute a transfer — actual
-- car stock quantities still live in the single existing car_inventory
-- pool (this app's established, company-wide car-stock model), so a
-- transfer's vehicle_id/rep_id are custody/accountability attribution,
-- not a separate per-holder inventory ledger.
-- ============================================================================

-- Two-phase custody transfer (warehouse keeper's stock -> a vehicle/rep's
-- custody). Internal status is the workflow's real state machine —
-- 'pending_preparation' (just created, no items staged yet) ->
-- 'loading' (items being staged; auto-entered on the first item) ->
-- 'discrepancy' (receipt confirmed with a mismatch, awaiting an authorized
-- reason/note) or straight to 'closed' (receipt matched exactly).
-- 'cancelled' is a dead-end from either of the first two. The UI never
-- shows these raw values — it maps each to its own display label instead
-- of reusing the API name, so a wording tweak never means an API change.
-- readied_at/readied_by_* record the separate "طبلية جاهزة" approval
-- inside the 'loading' state: once set, item quantities are locked and
-- can only be touched again by a holder of approve_custody_transfer_
-- readiness (the same permission that approved it in the first place),
-- which is exactly the "authorized user override" the spec calls for —
-- every such override still goes through the normal item-change audit
-- trail in custody_transfer_changes below.
CREATE TABLE IF NOT EXISTS custody_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_replenish_request_id INTEGER REFERENCES warehouse_replenish_requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending_preparation' CHECK (status IN ('pending_preparation', 'loading', 'discrepancy', 'closed', 'cancelled')),
  notes TEXT,
  prepared_by_id INTEGER REFERENCES users(id),
  prepared_by_name TEXT,
  readied_at TEXT,
  readied_by_id INTEGER REFERENCES users(id),
  readied_by_name TEXT,
  confirmed_by_id INTEGER REFERENCES users(id),
  confirmed_by_name TEXT,
  confirmed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custody_transfers_company ON custody_transfers(company_id, status);

-- received_qty/variance_qty stay NULL until the rep confirms. A non-zero
-- variance blocks this transfer's close (see lib/custodyTransfers.js) until
-- an authorized user fills discrepancy_reason/discrepancy_note — both
-- mandatory, never optional, on any item whose variance isn't exactly zero.
CREATE TABLE IF NOT EXISTS custody_transfer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_id INTEGER NOT NULL REFERENCES custody_transfers(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  unit_key TEXT,
  prepared_qty REAL NOT NULL DEFAULT 0,
  received_qty REAL,
  variance_qty REAL,
  discrepancy_reason TEXT,
  discrepancy_note TEXT,
  discrepancy_resolved_by_id INTEGER REFERENCES users(id),
  discrepancy_resolved_by_name TEXT,
  discrepancy_resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custody_transfer_items_transfer ON custody_transfer_items(transfer_id);

-- Every edit to the transfer or one of its items — same audited
-- before/after pattern as order_status_changes/wave_point_changes — so
-- "the original transfer as prepared" is always reconstructable even
-- after quantities were adjusted and discrepancies resolved.
CREATE TABLE IF NOT EXISTS custody_transfer_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_id INTEGER NOT NULL REFERENCES custody_transfers(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES custody_transfer_items(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  field TEXT,
  before_value TEXT,
  after_value TEXT,
  changed_by_id INTEGER REFERENCES users(id),
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custody_transfer_changes_transfer ON custody_transfer_changes(transfer_id, changed_at);

-- ============================================================================
-- Returns / damaged goods: a rep filing a return never touches the
-- customer's balance or inventory by itself — both only ever change once
-- an authorized reviewer approves the request AND each item has actually
-- been physically inspected (lib/returns.js). order_id is nullable:
-- damage can also be logged with no return request behind it at all
-- (found during a stock count, for instance).
-- ============================================================================

CREATE TABLE IF NOT EXISTS return_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'rejected')),
  requested_by_id INTEGER REFERENCES users(id),
  requested_by_name TEXT,
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_by_name TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  financial_adjustment_applied INTEGER NOT NULL DEFAULT 0,
  financial_adjustment_amount REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_return_requests_company ON return_requests(company_id, status);

-- inspection_status starts 'pending_inspection' and only the reviewer
-- (never the filing rep) moves it to 'valid' / 'needs_further_inspection'
-- / 'damaged' — inspected_qty is nullable until that inspection actually
-- happens. A mismatch between requested_qty and inspected_qty requires
-- discrepancy_reason, same mandatory-reason pattern as every other
-- variance in this app (custody transfers, order partial delivery).
-- restocked flags whether a 'valid' item's inspected_qty has already been
-- added back to car_inventory, so approving twice can never double-count.
CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  return_request_id INTEGER NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  unit_key TEXT,
  requested_qty REAL NOT NULL,
  unit_value REAL,
  inspection_status TEXT NOT NULL DEFAULT 'pending_inspection' CHECK (
    inspection_status IN ('pending_inspection', 'valid', 'needs_further_inspection', 'damaged')
  ),
  inspected_qty REAL,
  discrepancy_reason TEXT,
  inspection_notes TEXT,
  restocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_return_items_request ON return_items(return_request_id);

CREATE TABLE IF NOT EXISTS return_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  return_request_id INTEGER NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES return_items(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Same audited before/after pattern used throughout (order_status_changes,
-- wave_point_changes, custody_transfer_changes).
CREATE TABLE IF NOT EXISTS return_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  return_request_id INTEGER NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES return_items(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  field TEXT,
  before_value TEXT,
  after_value TEXT,
  changed_by_id INTEGER REFERENCES users(id),
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_return_changes_request ON return_changes(return_request_id, changed_at);

-- ============================================================================
-- Collections (تحصيل): cash and transfer only, per the spec's own final
-- decision — no other method exists here. Both methods are two-step, just
-- with different second actors: cash is rep-collects -> accountant
-- confirms received it from the rep; a transfer is rep-logs-it ->
-- responsible employee verifies it actually landed. Either way the
-- customer's balance (this app's dated-snapshot ledger, same one
-- lib/returns.js writes credits to) only moves once that second,
-- confirming step happens — never at the moment the rep first logs it.
-- ============================================================================

${require('./collectionsTable').COLLECTIONS_TABLE_SQL}

CREATE TABLE IF NOT EXISTS collection_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  field TEXT,
  before_value TEXT,
  after_value TEXT,
  changed_by_id INTEGER REFERENCES users(id),
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collection_changes_collection ON collection_changes(collection_id, changed_at);

-- A suggested reminder the system raises (overdue payment, credit-limit
-- breach) — never sent on its own. An employee reviews it here and either
-- sends it (stamping sent_at/sent_by) or dismisses it; there is no path
-- that calls sendToCustomer for this without that explicit human action.
CREATE TABLE IF NOT EXISTS payment_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  triggered_reason TEXT NOT NULL,
  suggested_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'sent', 'dismissed')),
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_by_name TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_reminders_company ON payment_reminders(company_id, status);

-- ============================================================================
-- WhatsApp bot (lib/whatsappBot.js): a simplified, template-free layer on top
-- of the existing whatsapp-web.js integration and whatsapp_orders staging
-- table. Every inbound/outbound message is logged here regardless of how it
-- was handled — this is the independent, permission-gated "secondary log"
-- the spec requires, separate from whatsapp_orders (which only ever holds
-- order-shaped messages).
-- ============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  from_phone TEXT,
  to_phone TEXT,
  body TEXT NOT NULL,
  intent TEXT,
  related_entity_type TEXT,
  related_entity_id INTEGER,
  -- Who produced this message: 'bot' (automatic reply/reminder/notice),
  -- 'employee' (a human sent it, e.g. approved statement/reminder), or NULL
  -- for a raw inbound customer message that hasn't been answered.
  handled_by TEXT CHECK (handled_by IN ('bot', 'employee') OR handled_by IS NULL),
  replied_by_id INTEGER REFERENCES users(id),
  replied_by_name TEXT,
  replied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_company ON whatsapp_messages(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_shop ON whatsapp_messages(shop_id, created_at);

-- Complaints: any message the bot classifies as a complaint auto-creates one
-- of these — never auto-resolved, always needs a human to close it.
CREATE TABLE IF NOT EXISTS whatsapp_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  assigned_to_id INTEGER REFERENCES users(id),
  resolved_by_id INTEGER REFERENCES users(id),
  resolved_by_name TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_tickets_company ON whatsapp_tickets(company_id, status);

-- Unclear/unanswered-message alerts. Global to the company (every permission
-- holder sees it) until any employee replies, at which point it resolves for
-- everyone — but each user can also delete it just for themselves before
-- that via whatsapp_message_alert_dismissals, without affecting anyone else.
CREATE TABLE IF NOT EXISTS whatsapp_message_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  from_phone TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('unrecognized', 'unanswered_1h')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_alerts_company ON whatsapp_message_alerts(company_id, status);

CREATE TABLE IF NOT EXISTS whatsapp_message_alert_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES whatsapp_message_alerts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(alert_id, user_id)
);

-- One row per shop per calendar day a visit reminder was actually sent —
-- pure idempotency guard for the periodic sweep, so re-running it within the
-- same day never double-sends.
CREATE TABLE IF NOT EXISTS whatsapp_visit_reminders_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  visit_date TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(shop_id, visit_date)
);

CREATE TABLE IF NOT EXISTS import_mapping (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  phone_column TEXT NOT NULL,
  balance_column TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  report_date TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  uploaded_by_id INTEGER REFERENCES users(id),
  uploaded_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_batches_company ON import_batches(company_id);

-- Separate from import_batches (the Amin daily-report flow's table) since
-- shop import is a single preview+commit action with its own row/created/
-- skipped counters, not the multi-step mapping/staging/commit lifecycle
-- import_batches models.
CREATE TABLE IF NOT EXISTS shop_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER,
  skipped_count INTEGER,
  status TEXT NOT NULL DEFAULT 'previewed',
  uploaded_by_id INTEGER REFERENCES users(id),
  uploaded_by_name TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shop_import_batches_uploaded ON shop_import_batches(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_import_batches_company ON shop_import_batches(company_id);

CREATE TABLE IF NOT EXISTS import_batch_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  phone_raw TEXT,
  balance_raw REAL,
  matched_shop_id INTEGER REFERENCES shops(id),
  status TEXT NOT NULL DEFAULT 'unmatched'
);
CREATE INDEX IF NOT EXISTS idx_batch_rows_batch ON import_batch_rows(batch_id);

CREATE TABLE IF NOT EXISTS settings (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (company_id, key)
);

-- A photographed invoice from the rep's Amin-app screen. order_id is set
-- once the extracted/manually-entered fields are confirmed and written to
-- orders (same table+shape a normal QuickOrderForm order would use) -- until
-- then the invoice exists but nothing has been counted as a sale yet.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  image_path TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  extracted_items_json TEXT,
  extracted_total REAL,
  extraction_method TEXT NOT NULL DEFAULT 'manual',
  reconciliation_status TEXT NOT NULL DEFAULT 'pending',
  reconciliation_diff REAL,
  reconciled_at TEXT,
  uploaded_by_id INTEGER REFERENCES users(id),
  uploaded_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_shop_date ON invoices(shop_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);

-- Persisted notification-center log, edge-triggered from the same
-- conditions the WhatsApp alert sweep watches (see lib/alertSweep.js,
-- lib/inventoryRouter.js) plus invoice-specific events — unlike the old
-- notifications route (which recomputed a live list on every request with
-- no way to mark anything read), every notification here is a discrete
-- inserted row so read/unread state has something real to attach to.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message_ar TEXT NOT NULL,
  message_en TEXT NOT NULL,
  link_path TEXT,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_company ON notifications(company_id);

-- sku/barcode are nullable+unique the same way shops.phone is: SQLite
-- treats every NULL as distinct in a UNIQUE index, so any number of
-- products can go without either while still blocking a real collision.
-- cost_price backs the minimum-profit floor (pricingEngine.js) — every
-- price/discount check compares the resolved sale price against it.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  amin_code TEXT,
  box_weight_grams REAL,
  sku TEXT,
  barcode TEXT,
  category TEXT,
  brand TEXT,
  description TEXT,
  image_url TEXT,
  cost_price REAL,
  base_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, name),
  UNIQUE(company_id, sku),
  UNIQUE(company_id, barcode)
);
CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id);

-- Every unit a product can be sold/counted in, each carrying its own
-- conversion factor back to the product's base unit (factor=1 row). A
-- carton of 24 cans, for instance, is one row {unit_key:'carton',
-- factor:24} alongside the base {unit_key:'can', factor:1} — converting X
-- cartons to cans (or vice versa) is then just X * factor_a / factor_b.
CREATE TABLE IF NOT EXISTS product_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  label TEXT NOT NULL,
  factor REAL NOT NULL,
  is_base INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, unit_key)
);
CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id);

-- One price list = one named set of per-product/per-unit prices, scoped to
-- a customer, a region, a sales channel, or 'general' (applies to
-- everyone not covered by a more specific list). Quantity breaks live at
-- the item level (price_list_items.min_quantity), currency at the list
-- level — lib/exchangeRate.js converts when an order's currency differs.
CREATE TABLE IF NOT EXISTS price_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  scope_type TEXT NOT NULL DEFAULT 'general' CHECK (scope_type IN ('customer', 'region', 'channel', 'general')),
  scope_value TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_lists_company ON price_lists(company_id, scope_type, scope_value);

CREATE TABLE IF NOT EXISTS price_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  min_quantity REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL,
  UNIQUE(price_list_id, product_id, unit_key, min_quantity)
);
CREATE INDEX IF NOT EXISTS idx_price_list_items_lookup ON price_list_items(price_list_id, product_id, unit_key);

-- One promotion row covers every discount shape in the spec: 'percent'
-- and 'fixed_amount' use 'value'; 'free_item' grants free_product_id
-- (defaulting to the same product) whenever the line qualifies at all;
-- 'buy_x_get_y' grants floor(qty / buy_qty) * get_qty free units of
-- free_product_id; 'mixed' combines a percent/fixed discount with a
-- buy_x_get_y on top, per mixed_config_json. min_profit_margin_pct is this
-- promotion's own floor (falls back to the company default setting when
-- null) — pricingEngine.js refuses to price a line under it.
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percent', 'fixed_amount', 'free_item', 'buy_x_get_y', 'mixed')),
  value REAL,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  category TEXT,
  buy_qty REAL,
  get_qty REAL,
  free_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  mixed_config_json TEXT,
  max_discount_amount REAL,
  min_profit_margin_pct REAL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  scope_type TEXT NOT NULL DEFAULT 'general' CHECK (scope_type IN ('customer', 'region', 'channel', 'general')),
  scope_value TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by_id INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promotions_company ON promotions(company_id, active);

-- A special/below-floor price a rep or manager wants to grant, held
-- pending until someone holding approve_special_prices signs off — order
-- creation only accepts a below-minimum-profit line when a matching
-- approved, unexpired request exists for that exact shop+product+price.
CREATE TABLE IF NOT EXISTS price_approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  requested_price REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by_id INTEGER REFERENCES users(id),
  requested_by_name TEXT,
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_by_name TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_approval_requests_lookup ON price_approval_requests(company_id, shop_id, product_id, status);

-- Every free/sample/gift unit that leaves stock at zero value, kept as its
-- own ledger (in addition to living inside the order's items_json as
-- is_free:true) purely so the free-goods report never has to re-parse
-- every order's JSON to answer "how much did we give away this month".
CREATE TABLE IF NOT EXISTS free_goods_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT,
  qty REAL NOT NULL,
  unit_key TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('promo', 'sample', 'gift')),
  promotion_id INTEGER REFERENCES promotions(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_by_id INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_free_goods_log_company ON free_goods_log(company_id, created_at);

-- 'company_id' is nullable on purpose: a platform-admin account (see
-- 'is_platform_admin' below) belongs to no single company. Every normal
-- company user always has it set — enforced in application code at account
-- creation (routes/auth.js, the Startup Setup user-invite step), since a
-- partial-NULL CHECK conditioned on another column isn't expressible as a
-- plain SQLite table constraint.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rep',
  status TEXT NOT NULL DEFAULT 'pending',
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'ar',
  region TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

-- One row per (user, period) — a rep's weekly and monthly targets are
-- independent numbers, not derived from each other.
CREATE TABLE IF NOT EXISTS sales_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly')),
  target_value REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, period)
);
CREATE INDEX IF NOT EXISTS idx_sales_targets_company ON sales_targets(company_id);

-- The richer goals system (daily/weekly/monthly × sales/collection/visits/
-- a specific product) lives here as its own table rather than reshaping
-- sales_targets above, which the existing Settings > الأهداف screen and
-- Statistics gauges already depend on in its simpler weekly/monthly-sales
-- form — this is purely additive. product_id is a real FK for
-- target_type='product' and a 0 sentinel otherwise (never NULL): SQLite
-- treats every NULL as distinct in a UNIQUE index, which would silently
-- let duplicate 'sales' targets pile up for the same user+period instead
-- of the single standing target the rest of this feature assumes.
CREATE TABLE IF NOT EXISTS rep_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  target_type TEXT NOT NULL DEFAULT 'sales' CHECK (target_type IN ('sales', 'collection', 'visits', 'product')),
  -- No FK here on purpose: 0 is a sentinel meaning "not a product target",
  -- not a real row reference, so a real FK would reject every non-product
  -- target with a bogus "products(id)=0 doesn't exist" constraint error.
  product_id INTEGER NOT NULL DEFAULT 0,
  target_value REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, period, target_type, product_id)
);
CREATE INDEX IF NOT EXISTS idx_rep_targets_company ON rep_targets(company_id, user_id);

-- One row per company — the commission formula (base % of a rep's own
-- attributed sales, plus a flat bonus once their target for
-- bonus_condition's period is met) is company-wide, editable only from
-- Settings, never per-rep.
CREATE TABLE IF NOT EXISTS commission_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  base_rate_pct REAL NOT NULL DEFAULT 0,
  bonus_amount REAL NOT NULL DEFAULT 0,
  bonus_condition TEXT NOT NULL DEFAULT 'monthly_target_met' CHECK (bonus_condition IN ('daily_target_met', 'weekly_target_met', 'monthly_target_met')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Check-in/out and route-start/end events. location_required snapshots the
-- company's attendance_location_required setting at the moment this event
-- was recorded, so a later settings change never rewrites the meaning of
-- past attendance rows; lat/lng are only ever required by the route layer
-- when that snapshot is 1.
CREATE TABLE IF NOT EXISTS rep_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('check_in', 'check_out', 'route_start', 'route_end')),
  lat REAL,
  lng REAL,
  location_required INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rep_attendance_user ON rep_attendance(user_id, recorded_at);

-- Route/telemetry points logged at whatever interval the client currently
-- polls at (no live GPS stream required — this is just storage for
-- periodic samples); activity classifies each point so a report can add up
-- driving time vs. selling time without re-deriving it from raw
-- coordinates every time.
CREATE TABLE IF NOT EXISTS rep_route_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  speed_kmh REAL,
  activity TEXT NOT NULL DEFAULT 'driving' CHECK (activity IN ('driving', 'stopped', 'selling')),
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rep_route_points_user ON rep_route_points(user_id, recorded_at);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_role TEXT NOT NULL DEFAULT 'all' CHECK (target_role IN ('all', 'reps')),
  created_by_id INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_announcements_company ON announcements(company_id, created_at);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id)
);

-- Both directions of the optional visit-quality rating are the same table,
-- distinguished by rated_by_type — a supervisor rating (rated_by_id = a
-- users.id) and a customer rating (rated_by_id NULL, since customers don't
-- have accounts) never collide and both roll up the same way per rep.
CREATE TABLE IF NOT EXISTS visit_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rated_by_type TEXT NOT NULL CHECK (rated_by_type IN ('supervisor', 'customer')),
  rated_by_id INTEGER REFERENCES users(id),
  rated_by_name TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visit_ratings_rep ON visit_ratings(rep_id, created_at);

-- Ad-hoc points a supervisor awards (e.g. "on-time all week", "cleared an
-- overdue balance") on top of the leaderboard's own computed
-- sales/collection/punctuality score — additive, never subtracted
-- automatically.
CREATE TABLE IF NOT EXISTS rep_points_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  reason TEXT,
  awarded_by_id INTEGER REFERENCES users(id),
  awarded_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rep_points_log_user ON rep_points_log(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'factory' CHECK (kind IN ('factory', 'car', 'other')),
  -- Free-text match against one of the names in companies.branches_json —
  -- same loose (name, not id) linkage shops.branch already uses, since
  -- branches themselves are just a JSON string array, not their own table.
  branch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_warehouses_company ON warehouses(company_id);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicles_company ON vehicles(company_id);

-- Many-to-many: a vehicle can be shared by more than one rep (shift-based),
-- and a rep can be tied to more than one vehicle.
CREATE TABLE IF NOT EXISTS vehicle_reps (
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (vehicle_id, user_id)
);

CREATE TABLE IF NOT EXISTS car_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  current_quantity REAL NOT NULL DEFAULT 0,
  min_quantity REAL NOT NULL DEFAULT 0,
  low_stock_alert_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, item_name)
);
CREATE INDEX IF NOT EXISTS idx_car_inventory_company ON car_inventory(company_id);

-- Independent from car_inventory on purpose: separate stock, separate
-- weekly count, separate low-stock alert state.
CREATE TABLE IF NOT EXISTS factory_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  current_quantity REAL NOT NULL DEFAULT 0,
  min_quantity REAL NOT NULL DEFAULT 0,
  low_stock_alert_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, item_name)
);
CREATE INDEX IF NOT EXISTS idx_factory_inventory_company ON factory_inventory(company_id);

CREATE TABLE IF NOT EXISTS shop_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('product', 'customer', 'reminder')),
  body TEXT NOT NULL,
  author_id INTEGER REFERENCES users(id),
  author_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by_id INTEGER REFERENCES users(id),
  resolved_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_notes_shop ON shop_notes(shop_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_notes_company ON shop_notes(company_id);

-- Generic record of sensitive edits/deletes (order edit, order delete, and
-- whatever else needs one later) — before/after are free-form JSON snapshots
-- rather than typed columns per entity, so one table and one screen cover
-- every action instead of a table-per-entity that'd need its own UI each time.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  shop_id INTEGER REFERENCES shops(id),
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_company ON audit_log(company_id);

-- Per-user, per-permission grants. This is the sole source of truth for
-- what a user can do — replaces the old fixed 4-role system entirely. A row
-- present means granted; absent means denied. No ON DELETE CASCADE gap here
-- (unlike audit_log/import_batch_rows) because these rows are owned by the
-- user, not a historical record independent of them.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by INTEGER REFERENCES users(id),
  PRIMARY KEY (user_id, permission)
);

-- Named, reusable permission sets. 'company_id IS NULL' rows are the
-- platform's built-in starting points, visible to every company as a quick
-- pick; a company creating its own custom role gets a row with its own
-- 'company_id' set, fully independent of every other company's roles.
CREATE TABLE IF NOT EXISTS permission_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_permission_templates_company ON permission_templates(company_id);

-- One row per physical stock count (jard) uploaded from an Excel file for
-- either warehouse — the confirmed header record. Row-level detail (what
-- was counted vs. expected, per item) lives in inventory_count_rows.
CREATE TABLE IF NOT EXISTS inventory_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse TEXT NOT NULL CHECK (warehouse IN ('car', 'factory')),
  filename TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  variance_count INTEGER NOT NULL DEFAULT 0,
  created_by_id INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_warehouse ON inventory_counts(warehouse, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_company ON inventory_counts(company_id);

CREATE TABLE IF NOT EXISTS inventory_count_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id INTEGER NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  matched_item_id INTEGER,
  expected_quantity REAL,
  counted_quantity REAL NOT NULL,
  variance REAL,
  variance_pct REAL,
  classification TEXT NOT NULL CHECK (classification IN ('matched', 'minor', 'major', 'unmatched')),
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_inventory_count_rows_count ON inventory_count_rows(count_id);

-- Manual overrides to the auto-generated day plan, per calendar date: 'add'
-- puts a shop on that date's route even though it wouldn't normally
-- qualify (e.g. a green/healthy shop), 'remove' takes an auto-qualifying
-- shop off that date's route without changing its actual status. One row
-- per (company, plan_date, shop_id) — a new override for the same triple
-- replaces the old one.
CREATE TABLE IF NOT EXISTS day_plan_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_date TEXT NOT NULL,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  created_by_id INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, plan_date, shop_id)
);
CREATE INDEX IF NOT EXISTS idx_day_plan_overrides_date ON day_plan_overrides(plan_date);

-- ============================================================================
-- Waves: a rep's recurring weekly schedule (one or more visit sessions per
-- day, e.g. a morning wave and an afternoon wave, each its own region/route)
-- plus the day-by-day materialized instances a supervisor edits without
-- touching the recurring template. day_of_week: 0=Sunday..6=Saturday.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wave_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  wave_number INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  region TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(rep_id, day_of_week, wave_number)
);
CREATE INDEX IF NOT EXISTS idx_wave_templates_rep ON wave_templates(company_id, rep_id, day_of_week);

CREATE TABLE IF NOT EXISTS wave_template_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wave_template_id INTEGER NOT NULL REFERENCES wave_templates(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(wave_template_id, shop_id)
);

-- One row per rep/day/wave-number actually lived through — materialized
-- (auto-built) from that weekday's wave_templates the first time anyone
-- asks for the day's report, then edited independently of the template
-- from then on, exactly like day_plan_overrides already does for the
-- older, non-wave day plan.
CREATE TABLE IF NOT EXISTS wave_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_date TEXT NOT NULL,
  wave_number INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
  started_at TEXT,
  ended_at TEXT,
  created_from_template_id INTEGER REFERENCES wave_templates(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(rep_id, plan_date, wave_number)
);
CREATE INDEX IF NOT EXISTS idx_wave_instances_rep_date ON wave_instances(company_id, rep_id, plan_date);

-- wave_instance_id is nullable: cancelling a point out of its wave (item 3
-- of the spec) detaches it — set to NULL, removed_at stamped — rather than
-- deleting the row, so it can either be reassigned to a different
-- wave/day (wave_instance_id set again) or left NULL as a genuinely
-- unscheduled point a supervisor still needs to see and act on. The
-- customer/shop and any order tied to it are never touched by this.
CREATE TABLE IF NOT EXISTS wave_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wave_instance_id INTEGER REFERENCES wave_instances(id) ON DELETE SET NULL,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'arrived', 'visited', 'order_taken')),
  not_visited_reason TEXT,
  removed_at TEXT,
  arrived_at TEXT,
  visited_at TEXT,
  order_taken_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wave_points_wave ON wave_points(wave_instance_id);
CREATE INDEX IF NOT EXISTS idx_wave_points_rep_unscheduled ON wave_points(company_id, rep_id, wave_instance_id);

-- Every point-level edit (add/remove/reorder/move/status change), with a
-- proper before/after pair — this is what the end-of-wave report's change
-- log (item 5) reads from, never re-derived from anything else.
CREATE TABLE IF NOT EXISTS wave_point_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wave_point_id INTEGER NOT NULL REFERENCES wave_points(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  field TEXT,
  before_value TEXT,
  after_value TEXT,
  changed_by_id INTEGER REFERENCES users(id),
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wave_point_changes_point ON wave_point_changes(wave_point_id, changed_at);

-- Company-defined visit form: freeform tasks/questions lists, kept as JSON
-- since their shape (a label plus, for questions, an answer type) has no
-- query need of its own — every read is "give me the whole form".
CREATE TABLE IF NOT EXISTS visit_form_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tasks_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The filled-in visit report for one wave_point. voice_note_text is text
-- only for now per the spec (speech-to-text is a later AI-section feature,
-- this column is where its output will eventually land unchanged).
CREATE TABLE IF NOT EXISTS visit_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wave_point_id INTEGER REFERENCES wave_points(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  form_template_id INTEGER REFERENCES visit_form_templates(id) ON DELETE SET NULL,
  result TEXT NOT NULL DEFAULT 'other' CHECK (result IN ('order_taken', 'no_order', 'shop_closed', 'refused', 'other')),
  refusal_reason TEXT,
  not_visited_reason TEXT,
  tasks_json TEXT NOT NULL DEFAULT '{}',
  answers_json TEXT NOT NULL DEFAULT '{}',
  voice_note_text TEXT,
  signature_data_url TEXT,
  lat REAL,
  lng REAL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visit_records_point ON visit_records(wave_point_id);
CREATE INDEX IF NOT EXISTS idx_visit_records_rep ON visit_records(company_id, rep_id, recorded_at);

CREATE TABLE IF NOT EXISTS visit_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  visit_record_id INTEGER NOT NULL REFERENCES visit_records(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('before', 'after')),
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Calls and follow-ups a rep logs against a customer, independent of a
-- scheduled wave point — follow_up_at is the auto-created reminder date
-- the spec asks for (item 7); a sweep/notification job reads reminded=0
-- rows whose follow_up_at has passed.
CREATE TABLE IF NOT EXISTS rep_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  call_type TEXT NOT NULL DEFAULT 'call' CHECK (call_type IN ('call', 'follow_up')),
  outcome TEXT,
  notes TEXT,
  follow_up_at TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rep_calls_rep ON rep_calls(company_id, rep_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rep_calls_followup ON rep_calls(follow_up_at, reminded);

-- ---- Platform Admin queues -------------------------------------------------
-- Every row below belongs to a company but is reviewed/approved only by a
-- platform-admin account (see routes/platformAdmin.js) — a company's own
-- manager can create the request but never flip its status themselves.

CREATE TABLE IF NOT EXISTS whatsapp_link_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requested_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by_id INTEGER REFERENCES users(id),
  requested_by_name TEXT,
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_link_requests_company ON whatsapp_link_requests(company_id);

CREATE TABLE IF NOT EXISTS data_restore_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by_id INTEGER REFERENCES users(id),
  requested_by_name TEXT,
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_data_restore_requests_company ON data_restore_requests(company_id);

-- A company's own uploaded sample, submitted for Platform Admin review
-- (routes/platformAdmin.js's generic reviewQueue). Only once approved can
-- it ever be selected as that company's active template for that
-- document_type (routes/documentTemplates.js) — approval never publishes
-- it to any other company, and it's never usable, even by its own
-- company, while still 'pending'.
CREATE TABLE IF NOT EXISTS document_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice', 'statement', 'delivery_note', 'receipt', 'report', 'whatsapp_message')),
  name TEXT NOT NULL,
  file_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by_id INTEGER REFERENCES users(id),
  submitted_by_name TEXT,
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_document_templates_company ON document_templates(company_id, document_type);

-- Per-company, per-document-type template choice — this is the ONLY
-- customization allowed at this stage (spec item 3: no free-form design).
-- Either a platform-provided layout (platform_template_key, validated
-- against lib/documentTemplates.js's fixed catalog) or the company's own
-- approved custom upload (custom_template_id, must be status='approved'
-- and match this document_type) — never both. brand_color is always
-- validated against the fixed platform palette, never a free hex value.
CREATE TABLE IF NOT EXISTS company_document_template_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice', 'statement', 'delivery_note', 'receipt', 'report', 'whatsapp_message')),
  template_source TEXT NOT NULL DEFAULT 'platform' CHECK (template_source IN ('platform', 'custom')),
  platform_template_key TEXT,
  custom_template_id INTEGER REFERENCES document_templates(id) ON DELETE SET NULL,
  brand_color TEXT NOT NULL DEFAULT '#0B6E4F',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, document_type)
);

-- Bot knowledge-base submissions: an employee's answer to a NEW customer
-- question the bot couldn't already answer — captured here as a proposal,
-- never live on its own. A company manager can only ever land a row here
-- (see routes/whatsappBot.js's answer-new-question), never directly into
-- knowledge_base — only Platform Admin (routes/platformAdmin.js) can
-- approve one into the live table below, optionally editing the wording
-- first (question/answer/keywords columns are what an approve can override).
CREATE TABLE IF NOT EXISTS kb_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by_id INTEGER REFERENCES users(id),
  submitted_by_name TEXT,
  reviewed_by_id INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  published_kb_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_submissions_company ON kb_submissions(company_id, status);

-- The live, bot-readable knowledge base — strictly per-company (no shared/
-- cross-company memory), and the ONLY way a row lands here is Platform
-- Admin approving a kb_submissions row. Never touched by a company user
-- directly, however many permissions they hold. keywords is a simple
-- comma-separated list used for the bot's plain substring matching — no ML/
-- embeddings involved, consistent with this whole feature's "simplified,
-- no external services" scope.
CREATE TABLE IF NOT EXISTS knowledge_base (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  source_submission_id INTEGER REFERENCES kb_submissions(id) ON DELETE SET NULL,
  approved_by_id INTEGER REFERENCES users(id),
  approved_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_company ON knowledge_base(company_id, status);

-- ============================================================================
-- Advisory AI layer (lib/aiRecommendations.js): a single unified table for
-- every kind of suggestion/alert this layer produces — product suggestions,
-- rule-based anomaly flags, stock-shortage forecasts, end-of-wave summaries.
-- Nothing in this feature ever executes a sensitive action on its own; every
-- row here is a proposal a human explicitly approves or rejects
-- (decision_status/decided_by/decision_reason), and that human decision is
-- kept for future tuning, never overwritten. severity is only meaningful for
-- anomalies; confidence is only meaningful for suggestions/forecasts — both
-- columns are nullable so each row only fills in what applies to its type.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'product_suggestion', 'anomaly_geofence', 'anomaly_discount',
    'anomaly_return_repeat', 'anomaly_delivery_mismatch', 'stock_forecast', 'wave_summary',
    'report_summary'
  )),
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  related_entity_type TEXT,
  related_entity_id INTEGER,
  severity TEXT CHECK (severity IN ('info', 'warning', 'critical') OR severity IS NULL),
  confidence REAL,
  reason TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  suggestion_json TEXT NOT NULL DEFAULT '{}',
  decision_status TEXT NOT NULL DEFAULT 'pending' CHECK (decision_status IN ('pending', 'approved', 'rejected')),
  decided_by_id INTEGER REFERENCES users(id),
  decided_by_name TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_recommendations_company ON ai_recommendations(company_id, type, decision_status);
CREATE INDEX IF NOT EXISTS idx_ai_recommendations_shop ON ai_recommendations(shop_id, type);

-- ============================================================================
-- Anonymized, aggregated market intelligence (lib/marketIntelligence.js) —
-- deliberately its OWN table with NO company_id, shop_id, user_id, customer
-- name/phone/address, or any other row-level identifier anywhere in this
-- schema. Every row is already a rolled-up count/average across multiple
-- companies (contributing_count) for one geography/period/metric — the
-- per-company source data used to compute it is read at aggregation time
-- and never written here. A row is only ever created once contributing_count
-- meets the k-anonymity floor (see MIN_CONTRIBUTORS in the lib), so a
-- reader can never work backward to a single company or customer.
-- ============================================================================

CREATE TABLE IF NOT EXISTS market_intelligence_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  geo_level TEXT NOT NULL CHECK (geo_level IN ('country', 'governorate', 'city', 'district')),
  geo_value TEXT NOT NULL,
  metric_type TEXT NOT NULL CHECK (metric_type IN (
    'top_products', 'avg_price', 'promotions', 'shortages', 'substitutes',
    'active_regions', 'order_seasonality', 'returns', 'damaged', 'complaint_reasons'
  )),
  product_name TEXT,
  contributing_count INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_market_intel_lookup ON market_intelligence_snapshots(period, geo_level, geo_value, metric_type);

-- Per-user saved filter presets for the dashboards/reports layer
-- (lib/reports.js, routes/reports.js) — scoped to the saving user, not
-- shared company-wide, since two people commonly want different default
-- views of the same report.
CREATE TABLE IF NOT EXISTS saved_report_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, report_key, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_report_filters_user ON saved_report_filters(user_id, report_key);

-- ============================================================================
-- Offline sync (lib/offlineSync.js): a rep's app queues operations locally
-- while disconnected and submits them as a batch on reconnect
-- (POST /api/sync/batch). Every operation is keyed by a CLIENT-GENERATED
-- idempotency_key — the same key arriving twice (a retried batch after a
-- flaky reconnect) returns the original cached result instead of applying
-- twice (spec item 5). client_id lets the client map its local record back
-- to the server-assigned id once applied.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  client_id TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('visit', 'order', 'collection', 'inventory_count', 'custody_transfer', 'delete', 'production_issue', 'production_output', 'production_wastage')),
  operation TEXT NOT NULL DEFAULT 'create' CHECK (operation IN ('create', 'update', 'delete')),
  base_version TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'pending_approval', 'conflict', 'error')),
  server_entity_id INTEGER,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_operations_user ON sync_operations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_operations_company_status ON sync_operations(company_id, status);

-- An update-type operation whose base_version (the client's last-known
-- server state) no longer matches the record's current state lands here
-- instead of silently overwriting or being silently dropped — BOTH the
-- client's intended change and the server's current state are preserved
-- until an authorized human picks one (or merges), per spec item 4.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sync_operation_id INTEGER NOT NULL REFERENCES sync_operations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  client_payload_json TEXT NOT NULL,
  server_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved_use_client', 'resolved_use_server', 'resolved_merged')),
  resolved_by_id INTEGER REFERENCES users(id),
  resolved_by_name TEXT,
  resolved_at TEXT,
  resolution_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_company ON sync_conflicts(company_id, status);

-- ============================================================================
-- Security + platform-ops + UX layer (lib/devices.js, lib/encryption.js,
-- routes/devices.js, routes/platformAdmin.js extensions, routes/search.js,
-- routes/supportTickets.js, lib/documentNumbering.js).
-- ============================================================================

-- A device a user has signed in from — the app-lock PIN/biometric itself is
-- necessarily device-native (this backend never sees or stores it), but
-- "which devices can this account use" and remote wipe are server state.
-- device_id is client-generated (persisted in the app's own local storage)
-- so the same physical device is recognized across re-installs of nothing
-- but this table's row.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  trusted INTEGER NOT NULL DEFAULT 1,
  wipe_requested INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  UNIQUE(user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);

-- Every login attempt, successful or not — the "failed login attempts"
-- monitoring the platform team's technical dashboard reads from. contact is
-- stored even when it never resolves to a real user (a wrong email is
-- itself part of what's worth watching for brute-force patterns).
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  success INTEGER NOT NULL,
  reason TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_contact ON login_attempts(contact, created_at);

-- Server-side error log — server.js's catch-all handler writes here in
-- addition to console.error, so Platform Admin's technical dashboard has
-- something durable to read instead of relying on log-tailing.
CREATE TABLE IF NOT EXISTS app_error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  level TEXT NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  path TEXT,
  stack TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_error_log_created ON app_error_log(created_at);

-- Support tickets: a company files one, Platform Admin sees and replies to
-- it — same "company submits, platform team owns the review queue" shape
-- as kb_submissions/document_templates elsewhere in this schema.
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  submitted_by_id INTEGER REFERENCES users(id),
  submitted_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_company ON support_tickets(company_id, status);

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id),
  author_name TEXT,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket ON support_ticket_replies(ticket_id, created_at);

-- Help-center content — Platform Admin managed, every company reads the
-- same list (platform-wide, not per-company).
CREATE TABLE IF NOT EXISTS training_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  released_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Customizable document numbering per company/document type — a company
-- can set its own prefix and zero-padding width; next_number increments
-- atomically each time lib/documentNumbering.js issues one.
CREATE TABLE IF NOT EXISTS document_number_sequences (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  padding INTEGER NOT NULL DEFAULT 5,
  next_number INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, document_type)
);
`);

// Kept as inline literals (not required from lib/permissions.js) to avoid a
// require cycle — lib/permissions.js itself requires this file for `db`.
// Platform-admin access is intentionally NOT one of these — it's the
// separate `users.is_platform_admin` flag, so it can never be granted
// through the normal per-company permission UI a company manager uses.
const ALL_PERMISSION_KEYS = [
  'view_app', 'manage_shops', 'import_amin', 'approve_import', 'add_orders',
  'delete_orders', 'manage_car_inventory', 'manage_factory_inventory',
  'view_statistics', 'export_data', 'manage_users', 'manage_settings',
  'view_audit_log', 'manage_products', 'view_customer_notes',
];

// Platform-wide starting-point role templates (company_id IS NULL) — every
// company sees these as quick picks in the Startup Setup roles step, and can
// still create its own fully independent templates alongside them.
const BUILTIN_TEMPLATES = [
  { name: 'مدير', permissions: ALL_PERMISSION_KEYS },
  { name: 'مندوب', permissions: ['view_app', 'add_orders', 'view_customer_notes', 'manage_car_inventory'] },
  { name: 'مسؤول استيراد', permissions: ['import_amin', 'approve_import'] },
  { name: 'أمين مستودع', permissions: ['manage_factory_inventory'] },
];
const existingBuiltinNames = new Set(
  db.prepare('SELECT name FROM permission_templates WHERE company_id IS NULL').all().map((r) => r.name)
);
const insertTemplate = db.prepare(
  'INSERT INTO permission_templates (company_id, name, permissions_json, is_builtin) VALUES (NULL, ?, ?, 1)'
);
for (const t of BUILTIN_TEMPLATES) {
  if (!existingBuiltinNames.has(t.name)) insertTemplate.run(t.name, JSON.stringify(t.permissions));
}

// Double-entry ledger (Prompt 1). Same statements as
// migrations/0002_ledger_core.js so fresh and upgraded databases match.
require('./ledgerSchema').applyLedgerSchema(db);
// Sales documents + customer sub-ledger (Prompt 2), same statements as
// migrations/0005_sales_documents.js.
require('./salesSchema').applySalesSchema(db);
// Receivables (Prompt 3), same statements as migrations/0007_receivables.js.
require('./receivablesSchema').applyReceivablesSchema(db);
// Financial reports (Prompt 4), same statements as migrations/0010_financial_reports.js.
require('./reportsSchema').applyReportsSchema(db);
require('./currencySchema').applyCurrencySchema(db);
require('./purchasingSchema').applyPurchasingSchema(db);
require('./treasurySchema').applyTreasurySchema(db);
require('./inventorySchema').applyInventorySchema(db);
require('./stockSchema').applyStockSchema(db);
require('./stockLotsSchema').applyStockLotsSchema(db);
require('./manufacturingSchema').applyManufacturingSchema(db);
require('./accountingExtrasSchema').applyAccountingExtrasSchema(db);
require('./payrollSchema').applyPayrollSchema(db);
require('./rolloverSchema').applyRolloverSchema(db);
// Analytics (Prompt 12a): fact tables + change-capture triggers — last, after every source table.
require('./factSchema').applyFactSchema(db);

if (wasEmpty) require('./migrationStatus').stampAll(db);
if (isNew) {
  console.log('[db] created new database at', DB_PATH);
}

module.exports = db;
