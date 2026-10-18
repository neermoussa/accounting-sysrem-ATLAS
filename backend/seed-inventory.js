// Loads the 27 real raw-material items into BOTH car_inventory and
// factory_inventory, with independent starting quantity + minimum threshold
// per warehouse (they're deliberately not always equal — a car stocks far
// less than the factory). 4 items start below their minimum in both
// warehouses on purpose, to exercise the low-stock alert path end to end.
// Safe to run more than once — it wipes prior inventory rows first.
// Run with: node seed-inventory.js
const db = require('./db/init');
const { evaluateInventoryAlert } = require('./lib/inventoryRouter');

// [name, carQty, carMin, factoryQty, factoryMin]
// The 4 marked LOW start under their minimum in both warehouses.
const ITEMS = [
  ['بزر دوار شمس غبرة ملح', 60, 15, 220, 60],
  ['بزر دوار شمس مالح', 70, 15, 260, 60],
  ['بزر مصري حية ناعمة', 45, 12, 180, 50],
  ['بزر قرع وسط', 35, 10, 140, 40],
  ['بزر كوسا', 40, 10, 160, 40],
  ['بزر كوسا مدخنة', 7, 14, 20, 50], // LOW
  ['بزر اسود بلدي', 30, 8, 120, 35],
  ['بزر أفغاني مسلوق', 25, 8, 100, 30],
  ['بزر جبس اشقر', 5, 12, 15, 40], // LOW
  ['فستق لميع', 20, 6, 90, 25],
  ['فستق مالح', 22, 6, 95, 25],
  ['فستق مدخن', 18, 6, 80, 25],
  ['قضامة سكرية', 28, 8, 110, 30],
  ['قضامة مالحة مغبرة', 26, 8, 105, 30],
  ['كريك جبنة', 15, 6, 60, 20],
  ['كريك كتشب', 4, 10, 12, 35], // LOW
  ['كناكر سادة', 18, 6, 70, 20],
  ['كاجو سادة 240', 50, 12, 200, 55],
  ['لوز', 90, 20, 350, 90],
  ['لوز ملبس', 24, 8, 95, 28],
  ['فستق حلبي فندق', 55, 14, 210, 60],
  ['تخليطة ممتازة', 40, 10, 160, 45],
  ['تخليطة قلوبات', 35, 10, 140, 40],
  ['ذرة', 20, 6, 85, 25],
  ['شيبس أطلس نوتس 2.5 كغ', 6, 15, 18, 45], // LOW
  ['تخليطة أطلس نوتس مركزة', 30, 8, 120, 35],
  ['تخليطة أطلس نوتس كريك', 28, 8, 115, 35],
];

const reset = db.transaction(() => {
  db.prepare('DELETE FROM car_inventory').run();
  db.prepare('DELETE FROM factory_inventory').run();
});

const insertCar = db.prepare(
  'INSERT INTO car_inventory (item_name, current_quantity, min_quantity) VALUES (?, ?, ?)'
);
const insertFactory = db.prepare(
  'INSERT INTO factory_inventory (item_name, current_quantity, min_quantity) VALUES (?, ?, ?)'
);

const seed = db.transaction(() => {
  const rows = { car: [], factory: [] };
  for (const [name, carQty, carMin, factoryQty, factoryMin] of ITEMS) {
    const car = insertCar.run(name, carQty, carMin);
    const factory = insertFactory.run(name, factoryQty, factoryMin);
    rows.car.push(car.lastInsertRowid);
    rows.factory.push(factory.lastInsertRowid);
  }
  return rows;
});

async function run() {
  reset();
  const { car: carIds, factory: factoryIds } = seed();

  // Fire the exact same alert-evaluation path a real quantity update would —
  // this is what attempts the WhatsApp send and flips low_stock_alert_active
  // for whichever items actually started below their threshold.
  for (const id of carIds) {
    const item = db.prepare('SELECT * FROM car_inventory WHERE id = ?').get(id);
    await evaluateInventoryAlert({ table: 'car_inventory', warehouseLabel: 'مستودع السيارة', item });
  }
  for (const id of factoryIds) {
    const item = db.prepare('SELECT * FROM factory_inventory WHERE id = ?').get(id);
    await evaluateInventoryAlert({ table: 'factory_inventory', warehouseLabel: 'مستودع المعمل', item });
  }

  const carLow = db.prepare('SELECT item_name FROM car_inventory WHERE current_quantity <= min_quantity').all();
  const factoryLow = db
    .prepare('SELECT item_name FROM factory_inventory WHERE current_quantity <= min_quantity')
    .all();

  console.log(`Seeded ${ITEMS.length} raw materials into both car_inventory and factory_inventory.`);
  console.log(`Below-threshold in car warehouse (${carLow.length}):`, carLow.map((r) => r.item_name));
  console.log(`Below-threshold in factory warehouse (${factoryLow.length}):`, factoryLow.map((r) => r.item_name));
  console.log('Run again anytime to reset back to this preview state.');
}

run();
