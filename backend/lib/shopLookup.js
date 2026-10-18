const db = require('../db/init');
const { normalizePhone } = require('./phone');

// Matches a normalized phone against both shops.phone and shop_phone_aliases —
// the same logic the Amin import uses to link a report row to an existing
// shop, reused here so manual/bulk shop creation can't silently create a
// duplicate customer under a differently-formatted phone number.
function findShopByPhone(companyId, normalizedPhone) {
  if (!companyId) throw new Error('findShopByPhone requires a companyId');
  if (!normalizedPhone) return null;

  const allShops = db.prepare('SELECT * FROM shops WHERE company_id = ?').all(companyId);
  const exact = allShops.find((s) => normalizePhone(s.phone) === normalizedPhone);
  if (exact) return exact;

  const alias = db
    .prepare('SELECT * FROM shop_phone_aliases WHERE company_id = ? AND phone = ?')
    .get(companyId, normalizedPhone);
  if (alias) return db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(alias.shop_id, companyId);

  return null;
}

module.exports = { findShopByPhone };
