// backend/db/manufacturingSchema.js
//
// Prompt 9 — manufacturing for nuts and mixes (lib/manufacturing.js):
//  - recipes and immutable versions (multi-level: a component may itself
//    have a recipe), components with quantity per batch and loss per stage
//    (sorting / roasting / mixing ...), packaging and label components,
//    by-products and secondary products;
//  - effective-dated cost inputs (materials, labour, energy, overhead with
//    an allocation basis, by-product values) for theoretical costing now
//    and automatic costing later (Prompt 16);
//  - production plans (with allergen sequencing and sanitation steps), MRP,
//    production orders (reservation, lot-picked FEFO issue, output,
//    wastage, rework, by-products, quality checks, receipt into a new lot,
//    costing and journal entries);
//  - product allergens and quality-check definitions.
// No new columns on existing tables (products API stays byte-identical).
// Applied by db/init.js and db/migrations/0022_manufacturing.js.

const MANUFACTURING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS product_allergens (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  allergen TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'contains' CHECK (level IN ('contains', 'may_contain')),
  PRIMARY KEY (product_id, allergen)
);

CREATE TABLE IF NOT EXISTS mfg_recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, product_id)
);

-- A version is immutable once a production order used it (locked_at).
CREATE TABLE IF NOT EXISTS mfg_recipe_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES mfg_recipes(id),
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  batch_output_qty REAL NOT NULL CHECK (batch_output_qty > 0),
  output_kg_per_unit REAL NOT NULL DEFAULT 1 CHECK (output_kg_per_unit > 0),
  labour_hours_per_batch REAL NOT NULL DEFAULT 0,
  machine_hours_per_batch REAL NOT NULL DEFAULT 0,
  shelf_life_days INTEGER,
  notes TEXT,
  copied_from_id INTEGER REFERENCES mfg_recipe_versions(id),
  locked_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (recipe_id, version_no)
);

CREATE TABLE IF NOT EXISTS mfg_recipe_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES mfg_recipe_versions(id),
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL DEFAULT 'material' CHECK (kind IN ('material', 'packaging', 'label')),
  qty_per_batch REAL NOT NULL CHECK (qty_per_batch > 0),
  notes TEXT,
  UNIQUE (version_id, line_no)
);

-- Expected loss per processing stage, basis points of the input.
CREATE TABLE IF NOT EXISTS mfg_component_losses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES mfg_recipe_components(id),
  stage TEXT NOT NULL,
  loss_bp INTEGER NOT NULL CHECK (loss_bp >= 0 AND loss_bp < 10000),
  UNIQUE (component_id, stage)
);

CREATE TABLE IF NOT EXISTS mfg_recipe_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES mfg_recipe_versions(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL DEFAULT 'byproduct' CHECK (kind IN ('byproduct', 'secondary')),
  qty_per_batch REAL NOT NULL CHECK (qty_per_batch > 0),
  UNIQUE (version_id, product_id)
);

-- Effective-dated cost inputs. Insert-only: a change is a new row with a
-- later effective_from; a row an order was costed with cannot be deleted.
--   material  (product, per unit)        theoretical / standard price
--   labour    (per hour)
--   energy    (per kg | hour | batch)
--   overhead  (per kg | hour | batch)    the allocation basis
--   byproduct (product, per unit)        value credited to the batch
CREATE TABLE IF NOT EXISTS mfg_cost_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('material', 'labour', 'energy', 'overhead', 'byproduct')),
  basis TEXT NOT NULL CHECK (basis IN ('unit', 'hour', 'kg', 'batch')),
  product_id INTEGER REFERENCES products(id),
  rate_minor INTEGER NOT NULL CHECK (rate_minor >= 0),
  effective_from TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfg_cost_rates ON mfg_cost_rates(company_id, kind, IFNULL(product_id, 0), effective_from);

CREATE TABLE IF NOT EXISTS mfg_qc_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pass_fail' CHECK (kind IN ('range', 'pass_fail')),
  min_value REAL,
  max_value REAL,
  unit TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mfg_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_number TEXT,
  plan_date TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  notes TEXT,
  sequence_override_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lines in production sequence; 'sanitation' lines separate products whose
-- allergens conflict.
CREATE TABLE IF NOT EXISTS mfg_plan_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES mfg_plans(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'production' CHECK (kind IN ('production', 'sanitation')),
  product_id INTEGER REFERENCES products(id),
  qty REAL,
  notes TEXT,
  UNIQUE (plan_id, seq)
);

CREATE TABLE IF NOT EXISTS mfg_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_number TEXT,
  plan_id INTEGER REFERENCES mfg_plans(id),
  plan_line_id INTEGER REFERENCES mfg_plan_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  version_id INTEGER NOT NULL REFERENCES mfg_recipe_versions(id),
  batches REAL NOT NULL CHECK (batches > 0),
  planned_qty REAL NOT NULL,
  holder_id INTEGER NOT NULL REFERENCES stock_holders(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'in_progress', 'closed', 'rejected', 'cancelled')),
  qc_status TEXT NOT NULL DEFAULT 'not_required' CHECK (qc_status IN ('not_required', 'pending', 'passed', 'failed')),
  planned_date TEXT,
  production_date TEXT,
  labour_hours REAL,
  machine_hours REAL,
  output_lot_id INTEGER REFERENCES stock_lots(id),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  cost_json TEXT,
  reject_reason TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mfg_orders_company ON mfg_orders(company_id, status);

-- Material requirement of an order (reservation = required - issued + returned while open).
CREATE TABLE IF NOT EXISTS mfg_order_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES mfg_orders(id),
  component_id INTEGER REFERENCES mfg_recipe_components(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL DEFAULT 'material',
  required_qty REAL NOT NULL,
  issued_qty REAL NOT NULL DEFAULT 0,
  returned_qty REAL NOT NULL DEFAULT 0,
  issued_value_minor INTEGER NOT NULL DEFAULT 0,
  returned_value_minor INTEGER NOT NULL DEFAULT 0,
  UNIQUE (order_id, product_id)
);

-- Everything recorded on an order (issue, return, output, by-product,
-- wastage, rework); client_key makes offline-synced records idempotent.
CREATE TABLE IF NOT EXISTS mfg_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES mfg_orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'return', 'output', 'byproduct', 'wastage', 'rework')),
  product_id INTEGER REFERENCES products(id),
  qty REAL NOT NULL,
  stage TEXT,
  lot_id INTEGER REFERENCES stock_lots(id),
  value_minor INTEGER,
  notes TEXT,
  client_key TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfg_order_events_client ON mfg_order_events(company_id, client_key) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS mfg_qc_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES mfg_orders(id),
  check_id INTEGER NOT NULL REFERENCES mfg_qc_checks(id),
  value_num REAL,
  passed INTEGER NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, check_id)
);

-- A production order raised from an existing production request (order
-- shortage, lib/stockCheck.js): one order per request (UNIQUE); the link is
-- removed when that order is cancelled, freeing the request.
CREATE TABLE IF NOT EXISTS mfg_order_requests (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  production_request_id INTEGER NOT NULL UNIQUE REFERENCES production_requests(id),
  order_id INTEGER NOT NULL REFERENCES mfg_orders(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The cost of a closed order, line by line, with the rate row used.
CREATE TABLE IF NOT EXISTS mfg_order_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES mfg_orders(id),
  kind TEXT NOT NULL,
  basis TEXT,
  basis_qty REAL,
  rate_id INTEGER REFERENCES mfg_cost_rates(id),
  rate_minor INTEGER,
  amount_minor INTEGER NOT NULL
);

-- The theoretical cost of a closed order, fixed when it closes (one row per
-- price basis), so the cost-variance report of a closed period does not move
-- when a later purchase changes prices. source: 'close' (taken at close) or
-- 'migration' (orders closed before migration 0030, taken when it ran).
CREATE TABLE IF NOT EXISTS mfg_order_theoretical_costs (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES mfg_orders(id),
  basis TEXT NOT NULL CHECK (basis IN ('latest', 'average', 'standard')),
  cost_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('close', 'migration')),
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (order_id, basis)
);
`;

function applyManufacturingSchema(db) {
  db.exec(MANUFACTURING_SCHEMA_SQL);
}

module.exports = { applyManufacturingSchema, MANUFACTURING_SCHEMA_SQL };
