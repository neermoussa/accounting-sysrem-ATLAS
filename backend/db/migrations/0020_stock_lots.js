// backend/db/migrations/0020_stock_lots.js
//
// Prompt 8b. Additive: lots, lot balances, product stock settings, stock
// count and wastage / repacking documents (db/stockLotsSchema.js), and the
// stock count / wastage permissions for manage_permissions holders.

const { applyStockLotsSchema } = require('../stockLotsSchema');

const PERMS = ['manage_stock_counts', 'approve_stock_counts', 'post_stock_wastage', 'manage_lots'];

module.exports.up = function up(db) {
  applyStockLotsSchema(db);
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
