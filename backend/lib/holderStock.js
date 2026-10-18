// backend/lib/holderStock.js
//
// The one way flows add to / set a holder's stock row (factory_inventory or
// car_inventory): matched by PRODUCT, never by item name, so a renamed
// product can never create a second row (unique index: one row per
// product per holder — db/inventorySchema.js). A legacy row with the same
// name and no product gets the product attached instead of a twin.

const db = require('../db/init');

const TABLES = new Set(['factory_inventory', 'car_inventory']);

// mode 'add' (qty added) | 'set' (qty becomes the value). Returns the row.
function applyQty(table, companyId, productId, itemName, qty, { mode = 'add' } = {}) {
  if (!TABLES.has(table)) throw new Error(`unknown stock table ${table}`);
  let row = productId ? db.prepare(`SELECT * FROM ${table} WHERE company_id = ? AND product_id = ?`).get(companyId, productId) : null;
  if (!row && itemName) {
    const byName = db.prepare(`SELECT * FROM ${table} WHERE company_id = ? AND item_name = ?`).get(companyId, itemName);
    if (byName && (!byName.product_id || !productId || byName.product_id === productId)) {
      row = byName;
      if (productId && !byName.product_id) db.prepare(`UPDATE ${table} SET product_id = ? WHERE id = ?`).run(productId, byName.id);
    }
  }
  if (row) {
    db.prepare(`UPDATE ${table} SET current_quantity = ${mode === 'set' ? '?' : 'current_quantity + ?'}, updated_at = datetime('now') WHERE id = ?`).run(qty, row.id);
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id);
  }
  let name = itemName || (productId ? db.prepare('SELECT name FROM products WHERE id = ?').get(productId)?.name : null) || `#${productId}`;
  if (db.prepare(`SELECT 1 FROM ${table} WHERE company_id = ? AND item_name = ?`).get(companyId, name)) name = `${name} #${productId}`;
  const id = db.prepare(`INSERT INTO ${table} (company_id, item_name, product_id, current_quantity) VALUES (?, ?, ?, ?)`).run(companyId, name, productId || null, qty).lastInsertRowid;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

module.exports = { applyQty };
