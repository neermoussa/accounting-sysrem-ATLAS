// Optional: loads 12 preview-only shops (real coordinates across Damascus,
// Rif Dimashq, and Daraa) plus sample balances/orders so the UI isn't empty
// on a first run. Safe to run more than once — it wipes prior demo data
// first. Run with: node seed-demo.js
const db = require('./db/init');

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

const shops = [
  { name: 'محل المزة للمكسرات', phone: '0933100001', address: 'دمشق - المزة', lat: 33.5024, lng: 36.2578, balance: 650, orderDaysAgo: 4, product: 'لوز', qty: 10, total: 300 },
  { name: 'محل باب توما للمكسرات', phone: '0933100002', address: 'دمشق - باب توما', lat: 33.5131, lng: 36.3081, balance: 200, orderDaysAgo: 25, product: 'كاجو', qty: 5, total: 180 },
  { name: 'محل الميدان للمكسرات', phone: '0933100003', address: 'دمشق - الميدان', lat: 33.4934, lng: 36.2934, balance: 80, orderDaysAgo: 3, product: 'فستق حلبي', qty: 8, total: 420 },
  { name: 'محل دوما للمكسرات', phone: '0944200001', address: 'ريف دمشق - دوما', lat: 33.5730, lng: 36.4025, balance: 120, orderDaysAgo: 5, product: 'عين جمل', qty: 6, total: 250 },
  { name: 'محل جرمانا للمكسرات', phone: '0944200002', address: 'ريف دمشق - جرمانا', lat: 33.4831, lng: 36.3389, balance: 720, orderDaysAgo: 6, product: 'بندق', qty: 9, total: 310 },
  { name: 'محل الزبداني للمكسرات', phone: '0944200003', address: 'ريف دمشق - الزبداني', lat: 33.7256, lng: 36.1067, balance: 150, orderDaysAgo: 30, product: 'فول سوداني', qty: 4, total: 120 },
  { name: 'محل التل للمكسرات', phone: '0944200004', address: 'ريف دمشق - التل', lat: 33.6089, lng: 36.3872, balance: 90, orderDaysAgo: 2, product: 'مكسرات مشكلة', qty: 3, total: 150 },
  { name: 'محل قطنا للمكسرات', phone: '0944200005', address: 'ريف دمشق - قطنا', lat: 33.4364, lng: 36.0653, balance: 60, orderDaysAgo: 4, product: 'بزر دوار الشمس', qty: 7, total: 95 },
  { name: 'محل درعا البلد للمكسرات', phone: '0955300001', address: 'درعا - المدينة', lat: 32.6189, lng: 36.1021, balance: 800, orderDaysAgo: 3, product: 'لوز', qty: 12, total: 360 },
  { name: 'محل نوى للمكسرات', phone: '0955300002', address: 'درعا - نوى', lat: 32.8886, lng: 36.0439, balance: 100, orderDaysAgo: 20, product: 'كاجو', qty: 5, total: 170 },
  { name: 'محل الصنمين للمكسرات', phone: '0955300003', address: 'درعا - الصنمين', lat: 33.0656, lng: 36.1811, balance: 610, orderDaysAgo: 4, product: 'فستق حلبي', qty: 6, total: 280 },
  { name: 'محل بصرى الشام للمكسرات', phone: '0955300004', address: 'درعا - بصرى الشام', lat: 32.5169, lng: 36.4814, balance: 70, orderDaysAgo: 6, product: 'عين جمل', qty: 5, total: 140 },
];

const reset = db.transaction(() => {
  db.prepare('DELETE FROM orders').run();
  db.prepare('DELETE FROM balances').run();
  db.prepare('DELETE FROM shop_phone_aliases').run();
  db.prepare('DELETE FROM import_batch_rows').run();
  db.prepare('DELETE FROM import_batches').run();
  db.prepare('DELETE FROM shops').run();
});

const insertShop = db.prepare(
  `INSERT INTO shops (name, phone, address, lat, lng) VALUES (?, ?, ?, ?, ?)`
);
const insertOrder = db.prepare(
  `INSERT INTO orders (shop_id, order_date, items_json, total_value) VALUES (?, ?, ?, ?)`
);
const insertBalance = db.prepare(
  `INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, ?, ?, ?)`
);

const seed = db.transaction(() => {
  const today = daysAgo(0);
  for (const s of shops) {
    const { lastInsertRowid: shopId } = insertShop.run(s.name, s.phone, s.address, s.lat, s.lng);
    insertOrder.run(
      shopId,
      daysAgo(s.orderDaysAgo),
      JSON.stringify([{ product_name: s.product, qty: s.qty }]),
      s.total
    );
    insertBalance.run(shopId, today, s.balance, 'seed-demo.js');
  }
});

reset();
seed();

console.log(`Seeded ${shops.length} demo shops (Damascus / Rif Dimashq / Daraa) with sample orders and balances.`);
console.log('Run again anytime to reset back to this preview state.');
