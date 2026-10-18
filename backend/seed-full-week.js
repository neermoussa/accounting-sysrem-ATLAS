// Comprehensive, internally-consistent demo dataset covering a full past
// week of real activity — shops, inventory, orders, and balances all derived
// from the SAME underlying week of orders (balances are never assigned as
// separate random numbers; they're computed from what was actually ordered).
// Safe to run more than once — it wipes prior shops/orders/balances/inventory
// first. Run with: node seed-full-week.js
const db = require('./db/init');
const { buildShopLocations } = require('./seed-damascus-60');
const { evaluateInventoryAlert } = require('./lib/inventoryRouter');

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function randBetween(min, max) {
  return min + Math.random() * (max - min);
}
function randInt(min, max) {
  return Math.floor(randBetween(min, max + 1));
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickWeighted(pool) {
  return pool[randInt(0, pool.length - 1)];
}

// Same 27 real raw-material items as seed-inventory.js — [name, carQty, carMin, factoryQty, factoryMin].
const INVENTORY_ITEMS = [
  ['بزر دوار شمس غبرة ملح', 60, 15, 220, 60],
  ['بزر دوار شمس مالح', 70, 15, 260, 60],
  ['بزر مصري حية ناعمة', 45, 12, 180, 50],
  ['بزر قرع وسط', 35, 10, 140, 40],
  ['بزر كوسا', 40, 10, 160, 40],
  ['بزر كوسا مدخنة', 7, 14, 20, 50],
  ['بزر اسود بلدي', 30, 8, 120, 35],
  ['بزر أفغاني مسلوق', 25, 8, 100, 30],
  ['بزر جبس اشقر', 5, 12, 15, 40],
  ['فستق لميع', 20, 6, 90, 25],
  ['فستق مالح', 22, 6, 95, 25],
  ['فستق مدخن', 18, 6, 80, 25],
  ['قضامة سكرية', 28, 8, 110, 30],
  ['قضامة مالحة مغبرة', 26, 8, 105, 30],
  ['كريك جبنة', 15, 6, 60, 20],
  ['كريك كتشب', 4, 10, 12, 35],
  ['كناكر سادة', 18, 6, 70, 20],
  ['كاجو سادة 240', 50, 12, 200, 55],
  ['لوز', 90, 20, 350, 90],
  ['لوز ملبس', 24, 8, 95, 28],
  ['فستق حلبي فندق', 55, 14, 210, 60],
  ['تخليطة ممتازة', 40, 10, 160, 45],
  ['تخليطة قلوبات', 35, 10, 140, 40],
  ['ذرة', 20, 6, 85, 25],
  ['شيبس أطلس نوتس 2.5 كغ', 6, 15, 18, 45],
  ['تخليطة أطلس نوتس مركزة', 30, 8, 120, 35],
  ['تخليطة أطلس نوتس كريك', 28, 8, 115, 35],
];

// Plausible per-unit price for each item, in the same currency scale the
// app's existing balances already use (hundreds to low thousands per order).
const ITEM_PRICES = {
  'بزر دوار شمس غبرة ملح': 18, 'بزر دوار شمس مالح': 18, 'بزر مصري حية ناعمة': 20,
  'بزر قرع وسط': 35, 'بزر كوسا': 30, 'بزر كوسا مدخنة': 32, 'بزر اسود بلدي': 16,
  'بزر أفغاني مسلوق': 22, 'بزر جبس اشقر': 19, 'فستق لميع': 55, 'فستق مالح': 52,
  'فستق مدخن': 54, 'قضامة سكرية': 28, 'قضامة مالحة مغبرة': 27, 'كريك جبنة': 24,
  'كريك كتشب': 24, 'كناكر سادة': 22, 'كاجو سادة 240': 48, 'لوز': 45, 'لوز ملبس': 42,
  'فستق حلبي فندق': 58, 'تخليطة ممتازة': 38, 'تخليطة قلوبات': 36, 'ذرة': 15,
  'شيبس أطلس نوتس 2.5 كغ': 60, 'تخليطة أطلس نوتس مركزة': 34, 'تخليطة أطلس نوتس كريك': 33,
};

const ITEM_NAMES = INVENTORY_ITEMS.map((i) => i[0]);

function buildOrderItems() {
  const lineCount = randInt(1, 2);
  const chosen = shuffle(ITEM_NAMES).slice(0, lineCount);
  const items = chosen.map((name) => ({ product_name: name, qty: randInt(1, 6) }));
  const total = Math.round(items.reduce((sum, it) => sum + it.qty * ITEM_PRICES[it.product_name], 0));
  return { items, total };
}

// ---- 1) Shops: fresh 60, same generator as seed-damascus-60.js (real-ish
// Damascus coordinates ~2km apart, every one of them positioned). ----
const shopLocations = buildShopLocations();

// ---- 2) Assign each shop a weekly-activity role up front, so the resulting
// order history naturally produces a realistic status mix instead of forcing
// balance/overdue flags after the fact. ----
const shuffledIdx = shuffle(shopLocations.map((_, i) => i));
const DEBT_COUNT = 10; // will end the week with balance > debt threshold (red)
const STALE_COUNT = 12; // no order at all this week, only an old one (overdue -> yellow)
const ACTIVE_COUNT = 15; // order 2-5x this week (repeat customers)
// remaining shops (23) order 0-2x this week at normal weight

const roleByIdx = {};
shuffledIdx.slice(0, DEBT_COUNT).forEach((i) => (roleByIdx[i] = 'debt'));
shuffledIdx.slice(DEBT_COUNT, DEBT_COUNT + STALE_COUNT).forEach((i) => (roleByIdx[i] = 'stale'));
shuffledIdx.slice(DEBT_COUNT + STALE_COUNT, DEBT_COUNT + STALE_COUNT + ACTIVE_COUNT).forEach(
  (i) => (roleByIdx[i] = 'active')
);
shuffledIdx.slice(DEBT_COUNT + STALE_COUNT + ACTIVE_COUNT).forEach((i) => (roleByIdx[i] = 'normal'));

const weightedWeeklyPool = [];
shopLocations.forEach((_, i) => {
  const role = roleByIdx[i];
  if (role === 'stale') return; // excluded from this week's order pool entirely
  const weight = role === 'debt' || role === 'active' ? 3 : 1;
  for (let w = 0; w < weight; w++) weightedWeeklyPool.push(i);
});

// ---- 3) Generate 7 days of orders (oldest to newest), 5-15/day, no shop
// ordering twice on the same day. ----
const ordersByShop = {}; // shopIdx -> [{order_date, items, total}]
for (let dayOffset = 6; dayOffset >= 0; dayOffset--) {
  const date = daysAgo(dayOffset);
  const ordersToday = randInt(5, 15);
  const usedToday = new Set();
  let attempts = 0;
  let placed = 0;
  while (placed < ordersToday && attempts < ordersToday * 20) {
    attempts++;
    const shopIdx = pickWeighted(weightedWeeklyPool);
    if (usedToday.has(shopIdx)) continue;
    usedToday.add(shopIdx);
    const { items, total } = buildOrderItems();
    (ordersByShop[shopIdx] ||= []).push({ order_date: date, items, total });
    placed++;
  }
}

// Debt shops must have at least one order this week to base their arrears on.
shuffledIdx.slice(0, DEBT_COUNT).forEach((i) => {
  if (!ordersByShop[i]) {
    const { items, total } = buildOrderItems();
    ordersByShop[i] = [{ order_date: daysAgo(randInt(0, 6)), items, total }];
  }
});

// Stale shops: exactly one order, well outside the week (20-45 days ago) —
// old enough to trip the default 14-day overdue threshold.
shuffledIdx.slice(DEBT_COUNT, DEBT_COUNT + STALE_COUNT).forEach((i) => {
  const { items, total } = buildOrderItems();
  ordersByShop[i] = [{ order_date: daysAgo(randInt(20, 45)), items, total }];
});

// ---- 4) Balances derived from each shop's own order history — never a
// separate random number. ----
const balanceByShop = {};
shopLocations.forEach((_, i) => {
  const orders = ordersByShop[i] || [];
  const role = roleByIdx[i];
  const weekTotal = orders.reduce((s, o) => s + o.total, 0);
  if (role === 'debt') {
    balanceByShop[i] = Math.round(Math.max(weekTotal * randBetween(1.05, 1.6), 650));
  } else if (weekTotal > 0) {
    balanceByShop[i] = Math.round(weekTotal * randBetween(0.15, 0.6));
  } else {
    balanceByShop[i] = 0;
  }
});

// ---- 5) Inventory depletion driven by what was actually sold this week —
// items ordered more often deplete more, matching a real week of usage. ----
const consumedByItem = {};
Object.values(ordersByShop)
  .flat()
  .forEach((o) => o.items.forEach((it) => (consumedByItem[it.product_name] = (consumedByItem[it.product_name] || 0) + it.qty)));

// ---- Write everything ----
const reset = db.transaction(() => {
  db.prepare('DELETE FROM orders').run();
  db.prepare('DELETE FROM balances').run();
  db.prepare('DELETE FROM shop_phone_aliases').run();
  db.prepare('DELETE FROM import_batch_rows').run();
  db.prepare('DELETE FROM import_batches').run();
  db.prepare('DELETE FROM shops').run();
  db.prepare('DELETE FROM car_inventory').run();
  db.prepare('DELETE FROM factory_inventory').run();
});

const insertShop = db.prepare(`INSERT INTO shops (name, phone, address, lat, lng) VALUES (?, ?, ?, ?, ?)`);
const insertOrder = db.prepare(
  `INSERT INTO orders (shop_id, order_date, items_json, total_value) VALUES (?, ?, ?, ?)`
);
const insertBalance = db.prepare(
  `INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, ?, ?, ?)`
);
const insertCar = db.prepare('INSERT INTO car_inventory (item_name, current_quantity, min_quantity) VALUES (?, ?, ?)');
const insertFactory = db.prepare('INSERT INTO factory_inventory (item_name, current_quantity, min_quantity) VALUES (?, ?, ?)');

const seed = db.transaction(() => {
  const today = daysAgo(0);
  const shopIds = [];
  shopLocations.forEach((s, i) => {
    const { lastInsertRowid: shopId } = insertShop.run(s.name, s.phone, s.address, s.lat, s.lng);
    shopIds.push(shopId);
    for (const o of ordersByShop[i] || []) {
      insertOrder.run(shopId, o.order_date, JSON.stringify(o.items), o.total);
    }
    insertBalance.run(shopId, today, balanceByShop[i], 'seed-full-week.js');
  });

  const carIds = [];
  const factoryIds = [];
  for (const [name, carQty, carMin, factoryQty, factoryMin] of INVENTORY_ITEMS) {
    const consumed = consumedByItem[name] || 0;
    // The car gets restocked from the factory a couple of times during the
    // week, so its net depletion is a fraction of raw weekly consumption,
    // not the full amount — otherwise every popular item would hit zero.
    const netCarDrawdown = Math.round(consumed * randBetween(0.3, 0.55));
    const newCarQty = Math.max(0, carQty - netCarDrawdown);
    const factoryDrawdown = Math.round(consumed * randBetween(0.4, 0.7)) + randInt(0, 6);
    const newFactoryQty = Math.max(0, factoryQty - factoryDrawdown);
    const car = insertCar.run(name, newCarQty, carMin);
    const factory = insertFactory.run(name, newFactoryQty, factoryMin);
    carIds.push(car.lastInsertRowid);
    factoryIds.push(factory.lastInsertRowid);
  }
  return { shopIds, carIds, factoryIds };
});

async function run() {
  reset();
  const { carIds, factoryIds } = seed();

  for (const id of carIds) {
    const item = db.prepare('SELECT * FROM car_inventory WHERE id = ?').get(id);
    await evaluateInventoryAlert({ table: 'car_inventory', warehouseLabel: 'مستودع السيارة', item });
  }
  for (const id of factoryIds) {
    const item = db.prepare('SELECT * FROM factory_inventory WHERE id = ?').get(id);
    await evaluateInventoryAlert({ table: 'factory_inventory', warehouseLabel: 'مستودع المعمل', item });
  }

  const totalOrders = Object.values(ordersByShop).reduce((s, arr) => s + arr.length, 0);
  const debtCount = Object.entries(balanceByShop).filter(([, b]) => b > 500).length;
  console.log(`Seeded ${shopLocations.length} shops (all positioned), ${totalOrders} orders across the past 7 days.`);
  console.log(`Balances: ${debtCount} shops ended the week over the 500 debt threshold (computed from their own orders).`);
  console.log(`Stale/overdue shops (no order in the last 7 days): ${STALE_COUNT}.`);
  console.log(`Inventory: 27 items loaded into both warehouses, depleted by this week's actual order quantities.`);
  console.log('Run again anytime to reset back to this dataset.');
}

run();
