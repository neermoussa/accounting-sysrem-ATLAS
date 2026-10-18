// Fills in every remaining gap seed-full-week.js / seed-monthly-history.js
// don't cover, purely for demo/screenshot purposes before a presentation:
// products master (27 materials with box weights), shop notes (reminder/
// product/customer), notifications of every type, audit log entries, sales
// targets, a second demo user account, and Amin/shop import history rows.
// Run AFTER seed-full-week.js and seed-monthly-history.js:
//   node seed-full-week.js && node seed-monthly-history.js && node seed-atlas-demo-full.js
const db = require('./db/init');
const { hashPassword } = require('./lib/auth');
const { createNotification } = require('./lib/notify');

// SQLite-datetime format ("YYYY-MM-DD HH:MM:SS", no T/Z) — matches what
// every real row in this app gets from the DB's own `datetime('now')`
// defaults, which is what the frontend's date parsers (e.g.
// UploadHistoryTable's formatUploadedAt) expect. A plain ISO string here
// renders as "NaN/NaN/NaN" once the frontend appends its own 'Z'.
function daysAgo(n, hour = 10) {
  const d = new Date(Date.now() - n * 86400000);
  d.setHours(hour, 0, 0, 0);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Same 27 materials as seed-inventory.js / seed-full-week.js, with a
// plausible box weight in grams for the products-master reference cards.
const PRODUCTS = [
  ['بزر دوار شمس غبرة ملح', 'كغ', 'AM-001', 25000],
  ['بزر دوار شمس مالح', 'كغ', 'AM-002', 25000],
  ['بزر مصري حية ناعمة', 'كغ', 'AM-003', 20000],
  ['بزر قرع وسط', 'كغ', 'AM-004', 15000],
  ['بزر كوسا', 'كغ', 'AM-005', 15000],
  ['بزر كوسا مدخنة', 'كغ', 'AM-006', 15000],
  ['بزر اسود بلدي', 'كغ', 'AM-007', 20000],
  ['بزر أفغاني مسلوق', 'كغ', 'AM-008', 20000],
  ['بزر جبس اشقر', 'كغ', 'AM-009', 18000],
  ['فستق لميع', 'كغ', 'AM-010', 10000],
  ['فستق مالح', 'كغ', 'AM-011', 10000],
  ['فستق مدخن', 'كغ', 'AM-012', 10000],
  ['قضامة سكرية', 'كغ', 'AM-013', 12000],
  ['قضامة مالحة مغبرة', 'كغ', 'AM-014', 12000],
  ['كريك جبنة', 'كغ', 'AM-015', 8000],
  ['كريك كتشب', 'كغ', 'AM-016', 8000],
  ['كناكر سادة', 'كغ', 'AM-017', 8000],
  ['كاجو سادة 240', 'كغ', 'AM-018', 10000],
  ['لوز', 'كغ', 'AM-019', 20000],
  ['لوز ملبس', 'كغ', 'AM-020', 12000],
  ['فستق حلبي فندق', 'كغ', 'AM-021', 10000],
  ['تخليطة ممتازة', 'كغ', 'AM-022', 15000],
  ['تخليطة قلوبات', 'كغ', 'AM-023', 15000],
  ['ذرة', 'كغ', 'AM-024', 15000],
  ['شيبس أطلس نوتس 2.5 كغ', 'كرتونة', 'AM-025', 2500],
  ['تخليطة أطلس نوتس مركزة', 'كغ', 'AM-026', 15000],
  ['تخليطة أطلس نوتس كريك', 'كغ', 'AM-027', 15000],
];

const insertProduct = db.prepare(
  'INSERT INTO products (name, unit, amin_code, box_weight_grams, active, sort_order) VALUES (?, ?, ?, ?, 1, ?) ' +
  'ON CONFLICT(name) DO UPDATE SET unit=excluded.unit, amin_code=excluded.amin_code, box_weight_grams=excluded.box_weight_grams'
);
const linkInventory = db.prepare('UPDATE car_inventory SET product_id = ? WHERE item_name = ?');
const linkFactory = db.prepare('UPDATE factory_inventory SET product_id = ? WHERE item_name = ?');

const seedProducts = db.transaction(() => {
  PRODUCTS.forEach(([name, unit, code, grams], i) => {
    insertProduct.run(name, unit, code, grams, i + 1);
    const row = db.prepare('SELECT id FROM products WHERE name = ?').get(name);
    linkInventory.run(row.id, name);
    linkFactory.run(row.id, name);
  });
});
seedProducts();
console.log(`Products master: ${PRODUCTS.length} materials seeded with box weights and linked to inventory.`);

// ---- Shop notes: reminder / product / customer on a handful of real shops ----
const shops = db.prepare('SELECT id, name FROM shops ORDER BY id').all();
const manager = db.prepare("SELECT id, name FROM users WHERE role = 'manager' ORDER BY id LIMIT 1").get();
const authorId = manager?.id || null;
const authorName = manager?.name || 'Atlas Manager';

const insertNote = db.prepare(
  'INSERT INTO shop_notes (shop_id, type, body, author_id, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
db.prepare("DELETE FROM shop_notes").run();
if (shops.length >= 3) {
  insertNote.run(shops[0].id, 'reminder', 'تواصل مع المحل بخصوص موعد الدفعة القادمة قبل نهاية الأسبوع.', authorId, authorName, daysAgo(1));
  insertNote.run(shops[0].id, 'customer', 'صاحب المحل بيفضل التسليم الصبح باكر قبل الساعة 9.', authorId, authorName, daysAgo(3));
  insertNote.run(shops[1].id, 'product', 'طلب كمية إضافية من الكاجو المالح للموسم الجاي.', authorId, authorName, daysAgo(2));
  insertNote.run(shops[2].id, 'reminder', 'المحل طلب فاتورة تفصيلية بالفاكس قبل التسليم القادم.', authorId, authorName, daysAgo(5));
}
console.log('Shop notes: reminder/product/customer examples seeded.');

// ---- Notifications: one of every type, unread ----
db.prepare('DELETE FROM notifications').run();
const debtShop = db.prepare(
  `SELECT s.id, s.name, b.balance FROM shops s
   JOIN balances b ON b.shop_id = s.id
   WHERE b.balance > 500 ORDER BY b.balance DESC LIMIT 1`
).get();
const overdueShop = shops[Math.min(5, shops.length - 1)];
const lowStockItem = db.prepare('SELECT id, item_name FROM car_inventory WHERE current_quantity < min_quantity LIMIT 1').get()
  || db.prepare('SELECT id, item_name FROM car_inventory LIMIT 1').get();

if (debtShop) {
  createNotification({
    type: 'debt',
    message_ar: `رصيد مستحق على ${debtShop.name}: ${Math.round(debtShop.balance).toLocaleString('ar-SY')} $`,
    message_en: `Outstanding balance on ${debtShop.name}: ${Math.round(debtShop.balance).toLocaleString('en-US')} $`,
    link_path: `/?shop=${debtShop.id}`,
    entity_type: 'shop',
    entity_id: debtShop.id,
  });
}
if (overdueShop) {
  createNotification({
    type: 'overdue',
    message_ar: `${overdueShop.name} تجاوز موعد الزيارة المعتاد.`,
    message_en: `${overdueShop.name} is overdue for its usual visit.`,
    link_path: `/?shop=${overdueShop.id}`,
    entity_type: 'shop',
    entity_id: overdueShop.id,
  });
}
if (lowStockItem) {
  createNotification({
    type: 'low_stock',
    message_ar: `مخزون ${lowStockItem.item_name} بمستودع السيارة تحت الحد الأدنى.`,
    message_en: `${lowStockItem.item_name} stock in the van is below its minimum.`,
    link_path: '/inventory',
    entity_type: 'car_inventory',
    entity_id: lowStockItem.id,
  });
}
createNotification({
  type: 'import',
  message_ar: 'تم استيراد ملف أرصدة جديد (45 سطر، 42 تم ربطهم تلقائيًا).',
  message_en: 'A new balances file was imported (45 rows, 42 auto-matched).',
  link_path: '/uploads',
  entity_type: 'import_batch',
  entity_id: 1,
});
createNotification({
  type: 'invoice_processed',
  message_ar: shops[3] ? `تمت معالجة فاتورة ${shops[3].name} بنجاح.` : 'تمت معالجة فاتورة بنجاح.',
  message_en: shops[3] ? `Invoice for ${shops[3].name} processed successfully.` : 'An invoice was processed successfully.',
  link_path: shops[3] ? `/?shop=${shops[3].id}` : '/',
  entity_type: 'invoice',
  entity_id: 1,
});
createNotification({
  type: 'invoice_mismatch',
  message_ar: shops[4] ? `شبهة خطأ بفاتورة ${shops[4].name} — المجموع لا يطابق الأصناف الممسوحة.` : 'شبهة خطأ بفاتورة ممسوحة.',
  message_en: shops[4] ? `Possible mismatch on ${shops[4].name}'s invoice — total doesn't match the scanned items.` : 'Possible invoice mismatch detected.',
  link_path: shops[4] ? `/?shop=${shops[4].id}` : '/',
  entity_type: 'invoice',
  entity_id: 2,
});
console.log('Notifications: one of every type (debt, overdue, low_stock, import, invoice_processed, invoice_mismatch) seeded.');

// ---- Audit log: a few real-looking entries ----
db.prepare('DELETE FROM audit_log').run();
const insertAudit = db.prepare(
  'INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, shop_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
if (shops.length >= 2) {
  insertAudit.run(authorId, authorName, 'order_edit', 'order', 1, shops[0].id,
    JSON.stringify({ total_value: 420 }), JSON.stringify({ total_value: 460 }), daysAgo(1));
  insertAudit.run(authorId, authorName, 'shop_update', 'shop', shops[1].id, shops[1].id,
    JSON.stringify({ phone: '0999000001' }), JSON.stringify({ phone: '0999000099' }), daysAgo(2));
  insertAudit.run(authorId, authorName, 'order_delete', 'order', 2, shops[0].id,
    JSON.stringify({ total_value: 150 }), null, daysAgo(4));
  insertAudit.run(authorId, authorName, 'permission_grant', 'user', authorId, null,
    null, JSON.stringify({ permission: 'manage_products' }), daysAgo(6));
}
console.log('Audit log: sample entries seeded.');

// ---- Sales targets: weekly + monthly for the manager ----
db.prepare('DELETE FROM sales_targets').run();
const insertTarget = db.prepare(
  'INSERT INTO sales_targets (user_id, period, target_value, updated_at) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(user_id, period) DO UPDATE SET target_value = excluded.target_value'
);
// ---- A second demo user account, so user/permission lists show more than
// one row. Also the rep whose weekly/monthly targets Statistics > Overview
// reads by default (lib/targets.js defaultRepId() picks the first approved
// 'rep' account) — targets must land on THIS user, not the manager, or the
// Overview tab's progress rings stay unset. ----
const REP_CONTACT = 'rep@atlas.local';
const existingRep = db.prepare('SELECT id FROM users WHERE contact = ?').get(REP_CONTACT);
let repId;
if (existingRep) {
  repId = existingRep.id;
  db.prepare('UPDATE users SET name = ?, password_hash = ?, role = ?, status = ? WHERE id = ?').run(
    'Rami Rep', hashPassword('Atlas1234!'), 'rep', 'approved', repId
  );
} else {
  const info = db.prepare(
    'INSERT INTO users (name, contact, password_hash, role, status, language) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('Rami Rep', REP_CONTACT, hashPassword('Atlas1234!'), 'rep', 'approved', 'ar');
  repId = info.lastInsertRowid;
}
const { setUserPermissions } = require('./lib/permissions');
setUserPermissions(repId, ['view_app', 'manage_car_inventory'], authorId || repId);
console.log(`Second demo account ready: ${REP_CONTACT} / Atlas1234! (role: rep).`);

insertTarget.run(repId, 'weekly', 25000, daysAgo(0));
insertTarget.run(repId, 'monthly', 20000, daysAgo(0));
console.log('Sales targets: weekly (25,000$) and monthly (20,000$) seeded on the rep account.');

// ---- Import history: Amin daily-report batches + a shop-import batch ----
db.prepare('DELETE FROM import_batches').run();
db.prepare('DELETE FROM shop_import_batches').run();
const insertBatch = db.prepare(
  'INSERT INTO import_batches (filename, report_date, uploaded_at, status, uploaded_by_id, uploaded_by_name) VALUES (?, ?, ?, ?, ?, ?)'
);
insertBatch.run('امين_تقرير_٢٥-١١.xlsx', daysAgo(1).slice(0, 10), daysAgo(1), 'committed', authorId, authorName);
insertBatch.run('امين_تقرير_٢٤-١١.xlsx', daysAgo(2).slice(0, 10), daysAgo(2), 'committed', authorId, authorName);
insertBatch.run('امين_تقرير_٢٣-١١.xlsx', daysAgo(3).slice(0, 10), daysAgo(3), 'committed', authorId, authorName);

const insertShopBatch = db.prepare(
  'INSERT INTO shop_import_batches (filename, row_count, created_count, skipped_count, status, uploaded_by_id, uploaded_by_name, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
insertShopBatch.run('محلات_جديدة.xlsx', 12, 10, 2, 'committed', authorId, authorName, daysAgo(5));
console.log('Import history: 3 Amin report batches + 1 shop-import batch seeded.');

// ---- Invoices: confirmed (order_id set) photographed invoices across the
// last 3 days, so Statistics > Daily Invoices isn't empty on any of them. ----
db.prepare('DELETE FROM invoices').run();
const insertInvoice = db.prepare(
  `INSERT INTO invoices (shop_id, order_id, image_path, invoice_date, extraction_method, reconciliation_status, uploaded_by_id, uploaded_by_name, created_at)
   VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?)`
);
const STATUSES = ['matched', 'matched', 'matched', 'mismatch', 'pending'];
let invoiceCount = 0;
for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
  const date = daysAgo(dayOffset).slice(0, 10);
  const dayOrders = db.prepare('SELECT id, shop_id FROM orders WHERE order_date = ? LIMIT 6').all(date);
  dayOrders.forEach((o, i) => {
    insertInvoice.run(
      o.shop_id, o.id, `uploads/invoices/demo-${date}-${o.id}.jpg`, date,
      STATUSES[i % STATUSES.length], authorId, authorName,
      `${date} ${String(9 + i).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`
    );
    invoiceCount++;
  });
}
console.log(`Invoices: ${invoiceCount} confirmed invoices seeded across the last 3 days.`);

console.log('\nDone. Re-run anytime: node seed-atlas-demo-full.js');
