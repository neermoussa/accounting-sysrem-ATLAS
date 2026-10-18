// Full demo tenant for manual QA / "try everything" walkthroughs: a real
// company (so it passes the multi-tenant Startup Setup gate — setup_completed
// is stamped 1 explicitly, see App.jsx's redirect check), 5 approved reps
// with a realistic field-rep permission set, 60 shops spread across Damascus
// with real-looking details (phone/address/owner/coords) assigned round-robin
// across the 5 reps, a week of order history per shop (so balances/status
// colors on the map are earned, not random), and today's wave/day-plan for
// every rep with real wave_points so Waves/Visit Mode has something to open
// immediately. Safe to run more than once — always wipes and rebuilds this
// one demo company only (never touches any other company's data).
// Run with: node seed-demo-company.js
const db = require('./db/init');
const { createCompanyWithAdmin } = require('./lib/companies');
const { setUserPermissions } = require('./lib/permissions');
const { hashPassword } = require('./lib/auth');

const COMPANY_NAME = 'أطلس - نسخة تجريبية';
const MANAGER_CONTACT = 'manager@demo.atlas';
const DEMO_PASSWORD = 'Demo1234!';

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

const NEIGHBORHOODS = [
  ['باب توما', 33.5131, 36.3081], ['الميدان', 33.4934, 36.2934], ['المزة', 33.5024, 36.2578],
  ['مزة 86', 33.4917, 36.2483], ['كفرسوسة', 33.4886, 36.2775], ['المالكي', 33.5169, 36.2822],
  ['أبو رمانة', 33.5183, 36.2892], ['الصالحية', 33.5211, 36.2967], ['المهاجرين', 33.5289, 36.2942],
  ['ركن الدين', 33.5361, 36.2986], ['القصاع', 33.5164, 36.3167], ['الشعلان', 33.5158, 36.2989],
  ['العدوي', 33.5039, 36.2867], ['الزاهرة', 33.4839, 36.3253], ['القابون', 33.5364, 36.3269],
  ['برزة', 33.5522, 36.3272], ['دمر', 33.5297, 36.2258], ['القدم', 33.4658, 36.2792],
  ['العسالي', 33.4761, 36.2914], ['التضامن', 33.4715, 36.3086],
];
const BOUNDS = { latMin: 33.42, latMax: 33.60, lngMin: 36.18, lngMax: 36.38 };
const MIN_SPACING_KM = 1.2;
const SHOP_COUNT = 60;
const REP_COUNT = 5;

function nearestNeighborhood(pt) {
  let best = NEIGHBORHOODS[0];
  let bestDist = Infinity;
  for (const nb of NEIGHBORHOODS) {
    const d = haversineKm(pt, { lat: nb[1], lng: nb[2] });
    if (d < bestDist) { bestDist = d; best = nb; }
  }
  return best[0];
}

function placePoints(count) {
  const points = [];
  let minSpacing = MIN_SPACING_KM;
  while (points.length < count) {
    let placed = false;
    for (let attempt = 0; attempt < 800; attempt++) {
      const candidate = { lat: randBetween(BOUNDS.latMin, BOUNDS.latMax), lng: randBetween(BOUNDS.lngMin, BOUNDS.lngMax) };
      if (!points.some((p) => haversineKm(p, candidate) < minSpacing)) {
        points.push(candidate);
        placed = true;
        break;
      }
    }
    if (!placed) minSpacing *= 0.97;
  }
  return points;
}

const OWNER_NAMES = ['خالد', 'ياسر', 'فراس', 'الوليد', 'سامر', 'عدنان', 'نضال', 'بشار', 'ايهم', 'رامي'];
const BUSINESS_TYPES = ['بقالة', 'سوبر ماركت', 'محل مكسرات', 'مواد غذائية'];
const PRODUCTS = ['لوز', 'فستق حلبي', 'كاجو', 'بندق', 'فول سوداني', 'عين جمل', 'بزر دوار الشمس', 'مكسرات مشكلة'];
const REP_NAMES = ['محمد المندوب', 'أحمد المندوب', 'يوسف المندوب', 'كريم المندوب', 'وائل المندوب'];

function shopName(neighborhood, i) {
  const templates = [
    `محل ${neighborhood} للمكسرات`,
    `سوبر ماركت ${neighborhood}`,
    `بقالة أبو ${pick(OWNER_NAMES, i)} - ${neighborhood}`,
    `مكسرات الشام - ${neighborhood}`,
  ];
  return pick(templates, i);
}

console.log(`\n=== Seeding demo company: ${COMPANY_NAME} ===\n`);

// ---- 0) Wipe any prior run of this same demo company (by manager contact) ----
const priorManager = db.prepare('SELECT company_id FROM users WHERE contact = ?').get(MANAGER_CONTACT);
if (priorManager?.company_id) {
  // Posted journal entries are immutable (db/ledgerSchema.js triggers), so a
  // company that has them can never be wiped — say so instead of failing
  // with a raw trigger error.
  if (db.prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND status <> 'draft' LIMIT 1").get(priorManager.company_id)) {
    console.error('The demo company has posted journal entries and cannot be wiped. Delete db/data.sqlite* (dev only) to start over.');
    process.exit(1);
  }
  db.prepare('DELETE FROM companies WHERE id = ?').run(priorManager.company_id); // ON DELETE CASCADE clears everything else
  console.log(`Wiped prior demo company (id ${priorManager.company_id}) before rebuilding.`);
}

// ---- 1) Company + manager (createCompanyWithAdmin grants the manager every permission) ----
const { company, admin } = createCompanyWithAdmin({
  companyName: COMPANY_NAME,
  adminName: 'مديرة أطلس التجريبية',
  adminContact: MANAGER_CONTACT,
  adminPassword: DEMO_PASSWORD,
  currency: 'USD',
});
const companyId = company.id;
// Skip the Startup Setup wizard gate (App.jsx redirects there otherwise) —
// this demo tenant is meant to open straight into the real app.
db.prepare('UPDATE companies SET setup_completed = 1 WHERE id = ?').run(companyId);
console.log(`Company created: ${COMPANY_NAME} (id ${companyId})`);
console.log(`Manager login: ${MANAGER_CONTACT} / ${DEMO_PASSWORD}`);

// ---- 2) 5 reps, each a real field-rep permission set ----
const REP_PERMISSIONS = [
  'view_app', 'add_orders', 'record_deliveries', 'manage_car_inventory',
  'request_returns', 'record_collections', 'respond_whatsapp_alerts', 'view_ai_recommendations',
];
const insertUser = db.prepare(
  `INSERT INTO users (company_id, name, contact, password_hash, role, status, language) VALUES (?, ?, ?, ?, 'rep', 'approved', 'ar')`
);
const reps = [];
for (let i = 0; i < REP_COUNT; i++) {
  const contact = `rep${i + 1}@demo.atlas`;
  const info = insertUser.run(companyId, REP_NAMES[i], contact, hashPassword(DEMO_PASSWORD));
  const repId = info.lastInsertRowid;
  setUserPermissions(repId, REP_PERMISSIONS, admin.id);
  reps.push({ id: repId, name: REP_NAMES[i], contact });
  console.log(`Rep ${i + 1} login: ${contact} / ${DEMO_PASSWORD}`);
}

// ---- 3) 60 shops across Damascus, real-looking details, round-robin assigned to the 5 reps ----
const points = placePoints(SHOP_COUNT);
const insertShop = db.prepare(
  `INSERT INTO shops (company_id, name, phone, owner_name, address, lat, lng, business_type, region, assigned_rep_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertOrder = db.prepare(
  `INSERT INTO orders (company_id, shop_id, rep_id, order_date, items_json, total_value, status, source) VALUES (?, ?, ?, ?, ?, ?, 'approved', 'rep_manual')`
);
const insertBalance = db.prepare(`INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, ?, ?, ?)`);

const shops = [];
const seedShopsAndOrders = db.transaction(() => {
  points.forEach((pt, i) => {
    const neighborhood = nearestNeighborhood(pt);
    const rep = reps[i % REP_COUNT];
    const info = insertShop.run(
      companyId,
      shopName(neighborhood, i),
      `0966${String(100001 + i).padStart(6, '0')}`,
      `أبو ${pick(OWNER_NAMES, i)}`,
      `دمشق - ${neighborhood}`,
      pt.lat, pt.lng,
      pick(BUSINESS_TYPES, i),
      neighborhood,
      rep.id
    );
    const shopId = info.lastInsertRowid;
    shops.push({ id: shopId, name: shopName(neighborhood, i), repId: rep.id, lat: pt.lat, lng: pt.lng });

    // 2-4 orders across the last 10 days, so statistics/balances aren't empty.
    const orderCount = randInt(2, 4);
    let weekTotal = 0;
    for (let o = 0; o < orderCount; o++) {
      const lineCount = randInt(1, 3);
      const items = shuffle(PRODUCTS).slice(0, lineCount).map((p) => ({ product_name: p, qty: randInt(1, 8) }));
      const total = Math.round(items.reduce((s, it) => s + it.qty * randInt(15, 55), 0));
      weekTotal += total;
      insertOrder.run(companyId, shopId, rep.id, daysAgo(randInt(0, 9)), JSON.stringify(items), total);
    }
    // Deliberate status mix: every 6th shop ends up in debt (red), every 4th
    // stale/overdue (yellow), the rest healthy (green) — mirrors status.js.
    let balance;
    if (i % 6 === 0) balance = Math.round(Math.max(weekTotal * randBetween(1.1, 1.8), 650));
    else if (i % 4 === 0) balance = Math.round(weekTotal * randBetween(0.1, 0.3));
    else balance = Math.round(weekTotal * randBetween(0.15, 0.5));
    insertBalance.run(shopId, daysAgo(0), balance, 'seed-demo-company.js');
  });
});
seedShopsAndOrders();
console.log(`Shops: ${shops.length} seeded across Damascus (real coords, addresses, owners), assigned round-robin to the ${REP_COUNT} reps.`);
console.log(`Orders: ${shops.length * 3} (avg) seeded across the last 10 days, balances derived from each shop's own order total.`);

// ---- 4) Today's wave/day-plan per rep, with real wave_points so Waves/Visit
// Mode opens with something immediately — 8-10 of that rep's own shops. ----
const insertWave = db.prepare(
  `INSERT INTO wave_instances (company_id, rep_id, plan_date, wave_number, label, region, status) VALUES (?, ?, ?, 1, ?, ?, 'not_started')`
);
const insertPoint = db.prepare(
  `INSERT INTO wave_points (company_id, rep_id, wave_instance_id, shop_id, sequence, status) VALUES (?, ?, ?, ?, ?, 'not_started')`
);
const today = daysAgo(0);
const seedWaves = db.transaction(() => {
  reps.forEach((rep) => {
    const repShops = shops.filter((s) => s.repId === rep.id);
    const waveShops = shuffle(repShops).slice(0, Math.min(9, repShops.length));
    const waveInfo = insertWave.run(companyId, rep.id, today, 'اللفة الصباحية', 'دمشق');
    const waveId = waveInfo.lastInsertRowid;
    waveShops.forEach((shop, seq) => {
      insertPoint.run(companyId, rep.id, waveId, shop.id, seq + 1);
    });
  });
});
seedWaves();
console.log(`Waves: today's (${today}) day-plan seeded for all ${REP_COUNT} reps, ~9 stops each.`);

// ---- 5) A couple of collections per rep, mixed statuses, so Collections has data too ----
const insertCollection = db.prepare(
  `INSERT INTO collections (company_id, shop_id, rep_id, method, amount, status, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const COLLECTION_STATUSES = ['pending_accountant_confirmation', 'confirmed', 'confirmed'];
const seedCollections = db.transaction(() => {
  reps.forEach((rep) => {
    const repShops = shuffle(shops.filter((s) => s.repId === rep.id)).slice(0, 2);
    repShops.forEach((shop, i) => {
      insertCollection.run(
        companyId, shop.id, rep.id,
        i % 2 === 0 ? 'cash' : 'transfer',
        Math.round(randBetween(50, 400)),
        pick(COLLECTION_STATUSES, i),
        `${daysAgo(randInt(0, 3))} ${String(randInt(9, 17)).padStart(2, '0')}:00:00`
      );
    });
  });
});
seedCollections();
console.log(`Collections: 2 per rep seeded (mixed pending/confirmed).`);

console.log(`\n=== Done. Log in as manager (${MANAGER_CONTACT}) or any rep (rep1..rep5@demo.atlas), password: ${DEMO_PASSWORD} ===`);
console.log('Run again anytime to reset this demo company back to this state: node seed-demo-company.js\n');
