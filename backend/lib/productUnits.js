const db = require('../db/init');

// Common presets a company can pick from when adding a unit to a product —
// purely a UI convenience list; unit_key/label can be anything.
const UNIT_PRESETS = [
  { key: 'piece', label: 'حبة' },
  { key: 'dozen', label: 'دزينة' },
  { key: 'carton', label: 'كرتونة' },
  { key: 'kg', label: 'كغ' },
  { key: 'g', label: 'غ' },
  { key: 'can', label: 'علبة' },
  { key: 'liter', label: 'ليتر' },
  { key: 'ton', label: 'طن' },
];

function getUnits(productId) {
  return db.prepare('SELECT * FROM product_units WHERE product_id = ? ORDER BY is_base DESC, id ASC').all(productId);
}

function addUnit(companyId, productId, { unit_key, label, factor, is_base }) {
  if (!unit_key || !label) throw Object.assign(new Error('unit_key_and_label_required'), { status: 400 });
  const factorNum = Number(factor);
  if (!(factorNum > 0)) throw Object.assign(new Error('factor_must_be_positive'), { status: 400 });
  const tx = db.transaction(() => {
    if (is_base) {
      // Only one base unit per product — demote any previous one and
      // rescale every other unit's factor so ratios between units stay
      // correct relative to the new base (factor 1).
      const prevBase = db.prepare('SELECT * FROM product_units WHERE product_id = ? AND is_base = 1').get(productId);
      if (prevBase && prevBase.factor !== factorNum) {
        const scale = prevBase.factor / factorNum;
        db.prepare('UPDATE product_units SET factor = factor * ? WHERE product_id = ? AND id != ?').run(scale, productId, prevBase.id);
      }
      db.prepare('UPDATE product_units SET is_base = 0 WHERE product_id = ?').run(productId);
    }
    return db
      .prepare(
        `INSERT INTO product_units (company_id, product_id, unit_key, label, factor, is_base)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id, unit_key) DO UPDATE SET label = excluded.label, factor = excluded.factor, is_base = excluded.is_base`
      )
      .run(companyId, productId, unit_key, label, factorNum, is_base ? 1 : 0);
  });
  tx();
  return getUnits(productId);
}

function removeUnit(productId, unitId) {
  db.prepare('DELETE FROM product_units WHERE id = ? AND product_id = ?').run(unitId, productId);
}

// Converts a quantity from one of the product's units to another. Both
// units must exist on the product; conversion always goes through the
// shared base-unit factor (qty * factor_from / factor_to), so any two
// units on the same product convert correctly regardless of which one is
// the base.
function convert(productId, qty, fromUnitKey, toUnitKey) {
  const units = getUnits(productId);
  const from = units.find((u) => u.unit_key === fromUnitKey);
  const to = units.find((u) => u.unit_key === toUnitKey);
  if (!from || !to) throw Object.assign(new Error('unknown_unit_for_product'), { status: 400 });
  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum)) throw Object.assign(new Error('invalid_quantity'), { status: 400 });
  return (qtyNum * from.factor) / to.factor;
}

function toBaseQty(productId, qty, unitKey) {
  const units = getUnits(productId);
  const base = units.find((u) => u.is_base) || units.find((u) => u.factor === 1);
  if (!base) return Number(qty);
  return convert(productId, qty, unitKey, base.unit_key);
}

module.exports = { UNIT_PRESETS, getUnits, addUnit, removeUnit, convert, toBaseQty };
