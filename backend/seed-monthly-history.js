// Backfills orders across the 11 months before the current one, on top of
// whatever seed-full-week.js already created for the current week — gives
// the Statistics > Overview monthly-sales table/chart real month-to-month
// variation to render (one-shot manual script, not part of the app).
const db = require('./db/init');

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

const shops = db.prepare('SELECT id, name FROM shops').all();
const products = db.prepare('SELECT id, name, unit FROM products WHERE active = 1').all();

if (shops.length === 0 || products.length === 0) {
  console.log('No shops/products found — run seed-full-week.js first.');
  process.exit(1);
}

const insertOrder = db.prepare(
  'INSERT INTO orders (shop_id, order_date, items_json, total_value, created_at) VALUES (?, ?, ?, ?, ?)'
);

const now = new Date();
let totalInserted = 0;

// One deliberately-highest month (5 months back) so the Overview's
// "highest ever" highlight has something real to point at.
const RECORD_MONTH_OFFSET = 5;

for (let monthsAgo = 1; monthsAgo <= 11; monthsAgo++) {
  const monthDate = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const isRecordMonth = monthsAgo === RECORD_MONTH_OFFSET;
  const orderCount = isRecordMonth ? randInt(55, 65) : randInt(15, 35);

  for (let i = 0; i < orderCount; i++) {
    const shop = shops[randInt(0, shops.length - 1)];
    const day = randInt(1, daysInMonth);
    const orderDate = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const itemCount = randInt(1, 3);
    const items = [];
    for (let j = 0; j < itemCount; j++) {
      const product = products[randInt(0, products.length - 1)];
      const qty = Math.round(randBetween(2, 25) * 10) / 10;
      items.push({ product_id: product.id, product_name: product.name, unit: product.unit, qty, enteredQty: qty, enteredUnit: 'kg' });
    }
    const totalValue = Math.round(randBetween(isRecordMonth ? 400 : 150, isRecordMonth ? 1800 : 900));
    const createdAt = `${orderDate} ${String(randInt(8, 18)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`;
    insertOrder.run(shop.id, orderDate, JSON.stringify(items), totalValue, createdAt);
    totalInserted++;
  }
}

console.log(`Inserted ${totalInserted} historical orders across the past 11 months (record month: ${RECORD_MONTH_OFFSET} months ago).`);
