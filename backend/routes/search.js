const express = require('express');
const db = require('../db/init');
const { requireCompany, requireAnyPermission } = require('../middleware/auth');

const router = express.Router();
router.use(requireCompany);

// One query, every data type at once — spec item 4's "شامل" (comprehensive)
// requirement. Kept simple (LIKE, no external search engine) but genuinely
// spans multiple tables in one call rather than the caller hitting several
// endpoints and merging client-side.
router.get('/', requireAnyPermission('view_app', 'view_statistics'), (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ shops: [], products: [], orders: [] });
  const like = `%${q}%`;

  const shops = db
    .prepare(
      `SELECT id, name, phone, contact_person, region FROM shops
       WHERE company_id = ? AND (name LIKE ? OR phone LIKE ? OR contact_person LIKE ?)
       ORDER BY name COLLATE NOCASE LIMIT 15`
    )
    .all(req.companyId, like, like, like);

  const products = db
    .prepare(
      `SELECT id, name, sku, barcode, category, base_price FROM products
       WHERE company_id = ? AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?)
       ORDER BY name COLLATE NOCASE LIMIT 15`
    )
    .all(req.companyId, like, like, like);

  // Orders matched by id (numeric query) or by their shop's name — lets
  // "search everything" also surface a specific order from a customer name.
  const orderIdMatch = /^\d+$/.test(q) ? Number(q) : null;
  const orders = db
    .prepare(
      `SELECT o.id, o.order_date, o.total_value, o.status, s.name as shop_name FROM orders o JOIN shops s ON s.id = o.shop_id
       WHERE o.company_id = ? AND o.deleted_at IS NULL AND (o.id = ? OR s.name LIKE ?)
       ORDER BY o.order_date DESC LIMIT 15`
    )
    .all(req.companyId, orderIdMatch ?? -1, like);

  res.json({ shops, products, orders });
});

module.exports = router;
