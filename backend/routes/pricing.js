const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const { priceLine } = require('../lib/pricingEngine');

const router = express.Router();

// ---------------------------------------------------------------------
// Price lists
// ---------------------------------------------------------------------

router.get('/price-lists', requireAnyPermission('view_app', 'manage_pricing'), (req, res) => {
  res.json(db.prepare('SELECT * FROM price_lists WHERE company_id = ? ORDER BY priority DESC, id DESC').all(req.companyId));
});

router.post('/price-lists', requirePermission('manage_pricing'), (req, res) => {
  const { name, currency, scope_type, scope_value, priority } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
  const info = db
    .prepare('INSERT INTO price_lists (company_id, name, currency, scope_type, scope_value, priority) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, name.trim(), currency || 'USD', scope_type || 'general', scope_value ?? null, priority || 0);
  res.status(201).json(db.prepare('SELECT * FROM price_lists WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/price-lists/:id', requirePermission('manage_pricing'), (req, res) => {
  const list = db.prepare('SELECT * FROM price_lists WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!list) return res.status(404).json({ error: 'not_found' });
  const { name, currency, scope_type, scope_value, priority, active } = req.body || {};
  db.prepare(
    'UPDATE price_lists SET name = ?, currency = ?, scope_type = ?, scope_value = ?, priority = ?, active = ? WHERE id = ?'
  ).run(
    name ?? list.name,
    currency ?? list.currency,
    scope_type ?? list.scope_type,
    scope_value === undefined ? list.scope_value : scope_value,
    priority ?? list.priority,
    active === undefined ? list.active : active ? 1 : 0,
    list.id
  );
  res.json(db.prepare('SELECT * FROM price_lists WHERE id = ?').get(list.id));
});

router.delete('/price-lists/:id', requirePermission('manage_pricing'), (req, res) => {
  const list = db.prepare('SELECT id FROM price_lists WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!list) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM price_lists WHERE id = ?').run(list.id);
  res.status(204).end();
});

router.get('/price-lists/:id/items', requireAnyPermission('view_app', 'manage_pricing'), (req, res) => {
  const list = db.prepare('SELECT id FROM price_lists WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!list) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM price_list_items WHERE price_list_id = ? ORDER BY product_id, unit_key, min_quantity').all(list.id));
});

router.post('/price-lists/:id/items', requirePermission('manage_pricing'), (req, res) => {
  const list = db.prepare('SELECT id FROM price_lists WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!list) return res.status(404).json({ error: 'not_found' });
  const { product_id, unit_key, min_quantity, price } = req.body || {};
  if (!product_id || !unit_key || price == null) return res.status(400).json({ error: 'product_id_unit_key_price_required' });
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND company_id = ?').get(product_id, req.companyId);
  if (!product) return res.status(400).json({ error: 'product_not_found' });
  const info = db
    .prepare(
      `INSERT INTO price_list_items (company_id, price_list_id, product_id, unit_key, min_quantity, price) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(price_list_id, product_id, unit_key, min_quantity) DO UPDATE SET price = excluded.price`
    )
    .run(req.companyId, list.id, product_id, unit_key, min_quantity || 0, price);
  res.status(201).json(db.prepare('SELECT * FROM price_list_items WHERE price_list_id = ? AND product_id = ? AND unit_key = ? AND min_quantity = ?').get(list.id, product_id, unit_key, min_quantity || 0));
});

router.delete('/price-lists/:id/items/:itemId', requirePermission('manage_pricing'), (req, res) => {
  const item = db.prepare('SELECT * FROM price_list_items WHERE id = ? AND price_list_id = ? AND company_id = ?').get(req.params.itemId, req.params.id, req.companyId);
  if (!item) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM price_list_items WHERE id = ?').run(item.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------

router.get('/promotions', requireAnyPermission('view_app', 'manage_pricing'), (req, res) => {
  res.json(db.prepare('SELECT * FROM promotions WHERE company_id = ? ORDER BY id DESC').all(req.companyId));
});

router.post('/promotions', requirePermission('manage_pricing'), (req, res) => {
  const body = req.body || {};
  if (!body.name?.trim()) return res.status(400).json({ error: 'name_required' });
  if (!['percent', 'fixed_amount', 'free_item', 'buy_x_get_y', 'mixed'].includes(body.type)) {
    return res.status(400).json({ error: 'invalid_type' });
  }
  const info = db
    .prepare(
      `INSERT INTO promotions (
         company_id, name, type, value, product_id, category, buy_qty, get_qty, free_product_id,
         mixed_config_json, max_discount_amount, min_profit_margin_pct, requires_approval,
         starts_at, ends_at, scope_type, scope_value, created_by_id, created_by_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.companyId,
      body.name.trim(),
      body.type,
      body.value ?? null,
      body.product_id ?? null,
      body.category || null,
      body.buy_qty ?? null,
      body.get_qty ?? null,
      body.free_product_id ?? null,
      body.mixed_config ? JSON.stringify(body.mixed_config) : null,
      body.max_discount_amount ?? null,
      body.min_profit_margin_pct ?? null,
      body.requires_approval ? 1 : 0,
      body.starts_at || null,
      body.ends_at || null,
      body.scope_type || 'general',
      body.scope_value ?? null,
      req.user.id,
      req.user.name
    );
  res.status(201).json(db.prepare('SELECT * FROM promotions WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/promotions/:id', requirePermission('manage_pricing'), (req, res) => {
  const promo = db.prepare('SELECT * FROM promotions WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!promo) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  db.prepare(
    `UPDATE promotions SET name = ?, value = ?, buy_qty = ?, get_qty = ?, free_product_id = ?, max_discount_amount = ?,
     min_profit_margin_pct = ?, requires_approval = ?, starts_at = ?, ends_at = ?, active = ? WHERE id = ?`
  ).run(
    b.name ?? promo.name,
    b.value === undefined ? promo.value : b.value,
    b.buy_qty === undefined ? promo.buy_qty : b.buy_qty,
    b.get_qty === undefined ? promo.get_qty : b.get_qty,
    b.free_product_id === undefined ? promo.free_product_id : b.free_product_id,
    b.max_discount_amount === undefined ? promo.max_discount_amount : b.max_discount_amount,
    b.min_profit_margin_pct === undefined ? promo.min_profit_margin_pct : b.min_profit_margin_pct,
    b.requires_approval === undefined ? promo.requires_approval : b.requires_approval ? 1 : 0,
    b.starts_at === undefined ? promo.starts_at : b.starts_at,
    b.ends_at === undefined ? promo.ends_at : b.ends_at,
    b.active === undefined ? promo.active : b.active ? 1 : 0,
    promo.id
  );
  res.json(db.prepare('SELECT * FROM promotions WHERE id = ?').get(promo.id));
});

router.delete('/promotions/:id', requirePermission('manage_pricing'), (req, res) => {
  const promo = db.prepare('SELECT id FROM promotions WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!promo) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM promotions WHERE id = ?').run(promo.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Quote: price a prospective set of order lines WITHOUT saving anything.
// Same engine the actual order-creation route (routes/shops.js) runs at
// save time, so a quote and the resulting order can never disagree.
// ---------------------------------------------------------------------

router.post('/quote', requireAnyPermission('view_app', 'add_orders'), (req, res) => {
  const { shopId, channel, currency, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items_required' });
  const shop = shopId ? db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId) : null;
  const region = shop?.region || null;

  const lines = items.map((it) =>
    priceLine(req.companyId, {
      productId: it.productId,
      unitKey: it.unitKey,
      qty: Number(it.qty),
      shopId: shop?.id,
      region,
      channel: channel || null,
      currency: currency || null,
    })
  );
  const blocked = lines.some((l) => l.blocked);
  const total = blocked ? null : lines.reduce((sum, l) => sum + l.lineTotal, 0);
  res.json({ lines, blocked, total });
});

// ---------------------------------------------------------------------
// Special-price approval requests
// ---------------------------------------------------------------------

router.get('/price-approval-requests', requireAnyPermission('manage_pricing', 'approve_special_prices', 'add_orders'), (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM price_approval_requests WHERE company_id = ? AND status = ? ORDER BY id DESC').all(req.companyId, status)
    : db.prepare('SELECT * FROM price_approval_requests WHERE company_id = ? ORDER BY id DESC').all(req.companyId);
  res.json(rows);
});

router.post('/price-approval-requests', requirePermission('add_orders'), (req, res) => {
  const { shopId, productId, requestedPrice, reason } = req.body || {};
  if (!shopId || !productId || requestedPrice == null) return res.status(400).json({ error: 'shopId_productId_requestedPrice_required' });
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(shopId, req.companyId);
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND company_id = ?').get(productId, req.companyId);
  if (!shop || !product) return res.status(404).json({ error: 'not_found' });
  const info = db
    .prepare(
      `INSERT INTO price_approval_requests (company_id, shop_id, product_id, requested_price, reason, requested_by_id, requested_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, shopId, productId, requestedPrice, reason || null, req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM price_approval_requests WHERE id = ?').get(info.lastInsertRowid));
});

function reviewRequest(status) {
  return (req, res) => {
    const request = db.prepare('SELECT * FROM price_approval_requests WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
    if (!request) return res.status(404).json({ error: 'not_found' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'already_reviewed' });
    db.prepare("UPDATE price_approval_requests SET status = ?, reviewed_by_id = ?, reviewed_by_name = ?, reviewed_at = datetime('now') WHERE id = ?").run(
      status,
      req.user.id,
      req.user.name,
      request.id
    );
    res.json(db.prepare('SELECT * FROM price_approval_requests WHERE id = ?').get(request.id));
  };
}

router.post('/price-approval-requests/:id/approve', requirePermission('approve_special_prices'), reviewRequest('approved'));
router.post('/price-approval-requests/:id/reject', requirePermission('approve_special_prices'), reviewRequest('rejected'));

// ---------------------------------------------------------------------
// Free goods (promo/sample/gift) report
// ---------------------------------------------------------------------

router.get('/free-goods-report', requirePermission('view_statistics'), (req, res) => {
  const { from, to, reason, productId } = req.query;
  let sql = 'SELECT * FROM free_goods_log WHERE company_id = ?';
  const params = [req.companyId];
  if (from) {
    sql += ' AND created_at >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND created_at <= ?';
    params.push(`${to} 23:59:59`);
  }
  if (reason) {
    sql += ' AND reason = ?';
    params.push(reason);
  }
  if (productId) {
    sql += ' AND product_id = ?';
    params.push(productId);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  const totalQtyByReason = rows.reduce((acc, r) => {
    acc[r.reason] = (acc[r.reason] || 0) + r.qty;
    return acc;
  }, {});
  res.json({ rows, totalQtyByReason, count: rows.length });
});

module.exports = router;
