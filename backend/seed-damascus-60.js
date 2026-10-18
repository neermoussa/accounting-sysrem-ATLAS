// Loads 60 preview-only shops spread across Damascus city with real-ish
// names, phones, addresses, GPS spaced ~2km apart (so they don't stack on
// the map), and a deliberate status mix (10 red / 15 yellow / 35 green) —
// for testing the map, day-plan routing, and statistics pages before real
// data is imported. Safe to run more than once — it wipes prior demo data.
// Run with: node seed-damascus-60.js
const db = require('./db/init');

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(randBetween(min, max + 1));
}

function pick(arr, i) {
  return arr[i % arr.length];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Real Damascus city neighborhoods, used only to label addresses by
// nearest-anchor once points are placed (see below) — not as tight
// clusters, since clustering directly contradicts the ~2km spacing goal.
const NEIGHBORHOODS = [
  ['باب توما', 33.5131, 36.3081],
  ['الميدان', 33.4934, 36.2934],
  ['المزة', 33.5024, 36.2578],
  ['مزة 86', 33.4917, 36.2483],
  ['كفرسوسة', 33.4886, 36.2775],
  ['المالكي', 33.5169, 36.2822],
  ['أبو رمانة', 33.5183, 36.2892],
  ['الصالحية', 33.5211, 36.2967],
  ['المهاجرين', 33.5289, 36.2942],
  ['ركن الدين', 33.5361, 36.2986],
  ['القصاع', 33.5164, 36.3167],
  ['الشعلان', 33.5158, 36.2989],
  ['العدوي', 33.5039, 36.2867],
  ['الزاهرة', 33.4839, 36.3253],
  ['القابون', 33.5364, 36.3269],
  ['برزة', 33.5522, 36.3272],
  ['دمر', 33.5297, 36.2258],
  ['القدم', 33.4658, 36.2792],
  ['العسالي', 33.4761, 36.2914],
  ['التضامن', 33.4715, 36.3086],
];

// ~20km x ~18.5km — comfortably above the ~208km² a hex-packing of 60
// non-overlapping 1km-radius disks needs, so rejection sampling can hit
// the 2km target for nearly all 60 points without much relaxation.
const BOUNDS = { latMin: 33.42, latMax: 33.60, lngMin: 36.18, lngMax: 36.38 };
const MIN_SPACING_KM = 2;
const MAX_ATTEMPTS_PER_POINT = 800;

function nearestNeighborhood(pt) {
  let best = NEIGHBORHOODS[0];
  let bestDist = Infinity;
  for (const nb of NEIGHBORHOODS) {
    const d = haversineKm(pt, { lat: nb[1], lng: nb[2] });
    if (d < bestDist) {
      bestDist = d;
      best = nb;
    }
  }
  return best[0];
}

// Rejection sampling for ~2km minimum spacing, relaxing the target
// gradually if the box gets crowded near the end so it always terminates.
function placePoints(count) {
  const points = [];
  let minSpacing = MIN_SPACING_KM;
  while (points.length < count) {
    let placed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_POINT; attempt++) {
      const candidate = {
        lat: randBetween(BOUNDS.latMin, BOUNDS.latMax),
        lng: randBetween(BOUNDS.lngMin, BOUNDS.lngMax),
      };
      const tooClose = points.some((p) => haversineKm(p, candidate) < minSpacing);
      if (!tooClose) {
        points.push(candidate);
        placed = true;
        break;
      }
    }
    if (!placed) minSpacing *= 0.97; // relax gradually and keep going
  }
  return points;
}

const SHOP_COUNT = 60;
const RED_COUNT = 10;
const YELLOW_COUNT = 15;
const GREEN_COUNT = SHOP_COUNT - RED_COUNT - YELLOW_COUNT; // 35

const OWNER_NAMES = ['خالد', 'ياسر', 'فراس', 'الوليد', 'سامر', 'عدنان', 'نضال', 'بشار'];
const PRODUCTS = ['لوز', 'فستق حلبي', 'كاجو', 'بندق', 'فول سوداني', 'عين جمل', 'بزر دوار الشمس', 'مكسرات مشكلة'];

function nameFor(neighborhood, i) {
  const templates = [
    `محل ${neighborhood} للمكسرات`,
    `سوبر ماركت ${neighborhood}`,
    `بقالة أبو ${pick(OWNER_NAMES, i)} - ${neighborhood}`,
    `مكسرات الشام - ${neighborhood}`,
  ];
  return pick(templates, i);
}

// balance > 500 (global debt_threshold default) => red, regardless of order recency.
// balance <= 500 and no order in > 14 days (global order_overdue_days default,
// since each seeded shop only gets one order so there's no per-shop average to use
// instead) => yellow. Anything else => green. Mirrors backend/lib/status.js exactly.
function statusFields(status) {
  if (status === 'red') {
    return { balance: Math.round(randBetween(520, 1400)), orderDaysAgo: randInt(0, 40) };
  }
  if (status === 'yellow') {
    return { balance: Math.round(randBetween(0, 480)), orderDaysAgo: randInt(15, 50) };
  }
  return { balance: Math.round(randBetween(0, 480)), orderDaysAgo: randInt(0, 13) };
}

const statusPlan = shuffle([
  ...Array(RED_COUNT).fill('red'),
  ...Array(YELLOW_COUNT).fill('yellow'),
  ...Array(GREEN_COUNT).fill('green'),
]);

// Reusable by other seed scripts that want the same 60 realistically-spaced
// Damascus shops but their own order/balance history instead of this file's
// single-random-order version — e.g. seed-full-week.js builds a week of
// orders and derives balances from them rather than assigning either at random.
function buildShopLocations() {
  const points = placePoints(SHOP_COUNT);
  return points.map((pt, i) => {
    const neighborhood = nearestNeighborhood(pt);
    return {
      name: nameFor(neighborhood, i),
      phone: `0966${String(100001 + i).padStart(6, '0')}`,
      address: `دمشق - ${neighborhood}`,
      lat: pt.lat,
      lng: pt.lng,
    };
  });
}

if (require.main === module) {
  runStandaloneSeed();
}

function runStandaloneSeed() {
  const placedPoints = placePoints(SHOP_COUNT);

  const shops = placedPoints.map((pt, i) => {
    const neighborhood = nearestNeighborhood(pt);
    const { balance, orderDaysAgo } = statusFields(statusPlan[i]);
    return {
      name: nameFor(neighborhood, i),
      phone: `0966${String(100001 + i).padStart(6, '0')}`,
      address: `دمشق - ${neighborhood}`,
      lat: pt.lat,
      lng: pt.lng,
      balance,
      orderDaysAgo,
      product: pick(PRODUCTS, i),
      qty: randInt(2, 14),
      total: Math.round(randBetween(80, 500)),
    };
  });

  seedStandalone(shops);
}

function seedStandalone(shops) {
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
    insertBalance.run(shopId, today, s.balance, 'seed-damascus-60.js');
  }
});

  reset();
  seed();

  console.log(`Seeded ${shops.length} demo shops across Damascus (~${MIN_SPACING_KM}km+ apart).`);
  console.log(`Status mix: ${RED_COUNT} red, ${YELLOW_COUNT} yellow, ${GREEN_COUNT} green.`);
  console.log('Run again anytime to reset back to this preview state.');
}

module.exports = { buildShopLocations };
