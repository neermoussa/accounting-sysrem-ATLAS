// Additive preview data for Atlas manager dashboard and map testing.
// It never wipes unrelated records. Run with `node seed-atlas-preview.js`.
// Remove only these preview records later with `node seed-atlas-preview.js --reset`.
const db = require('./db/init');

const PHONE_PREFIX = '099900';
const SHOP_NAMES = [
  ['متجر المزة المركزي', 'MZ01', 33.5085, 36.2464, 1820],
  ['أسواق النخبة - أبو رمانة', 'AR02', 33.5155, 36.2856, 760],
  ['مركز الشام التجاري', 'SH03', 33.5132, 36.2921, 3480],
  ['متجر الياسمين', 'YA04', 33.5053, 36.2748, 0],
  ['أسواق القصر', 'QS05', 33.5221, 36.3112, 1240],
  ['ميني ماركت الروضة', 'RW06', 33.5016, 36.2928, 2180],
  ['متجر الفيحاء', 'FH07', 33.5354, 36.3012, 520],
  ['أسواق الندى', 'ND08', 33.4963, 36.2607, 2960],
];
const PRODUCTS = [
  ['زيت دوار الشمس 1 لتر', 'قطعة', 6, 20, 58, 0],
  ['أرز بسمتي 5 كغ', 'كيس', 8, 15, 42, 0],
  ['سكر أبيض 1 كغ', 'كغ', 46, 20, 95, 1],
  ['مكسرات مشكلة Atlas', 'كغ', 18, 10, 130, 1],
  ['شيبس Atlas العائلي', 'كرتونة', 4, 12, 88, 0],
];

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function run() {
  const reset = process.argv.includes('--reset');
  const transaction = db.transaction(() => {
    const seededShops = db.prepare(`SELECT id FROM shops WHERE phone LIKE '${PHONE_PREFIX}%'`).all();
    if (reset) {
      for (const shop of seededShops) db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
      db.prepare("DELETE FROM car_inventory WHERE item_name LIKE 'ATLAS_PREVIEW::%'").run();
      db.prepare("DELETE FROM factory_inventory WHERE item_name LIKE 'ATLAS_PREVIEW::%'").run();
      db.prepare("DELETE FROM products WHERE name LIKE 'ATLAS_PREVIEW::%'").run();
      return { shops: seededShops.length, orders: 0 };
    }

    const insertShop = db.prepare('INSERT OR IGNORE INTO shops (name, phone, address, lat, lng, notes) VALUES (?, ?, ?, ?, ?, ?)');
    const insertBalance = db.prepare('INSERT OR IGNORE INTO balances (shop_id, report_date, balance, source_file) VALUES (?, ?, ?, ?)');
    const insertOrder = db.prepare('INSERT INTO orders (shop_id, order_date, items_json, total_value, created_at) VALUES (?, ?, ?, ?, ?)');
    const findShop = db.prepare('SELECT id FROM shops WHERE phone = ?');
    const shopIds = [];
    for (const [name, code, lat, lng, balance] of SHOP_NAMES) {
      const phone = `${PHONE_PREFIX}${code}`;
      insertShop.run(name, phone, 'دمشق — بيانات تشغيلية للمعاينة', lat, lng, 'سجل اختبار قابل للإزالة من seed-atlas-preview');
      const shop = findShop.get(phone);
      shopIds.push({ ...shop, name, balance });
      insertBalance.run(shop.id, dateOffset(0), balance, 'atlas-preview');
    }

    const productIds = [];
    const insertProduct = db.prepare('INSERT OR IGNORE INTO products (name, unit, active, sort_order) VALUES (?, ?, 1, ?)');
    const findProduct = db.prepare('SELECT id FROM products WHERE name = ?');
    const insertCar = db.prepare('INSERT OR REPLACE INTO car_inventory (item_name, product_id, current_quantity, min_quantity) VALUES (?, ?, ?, ?)');
    const insertFactory = db.prepare('INSERT OR REPLACE INTO factory_inventory (item_name, product_id, current_quantity, min_quantity) VALUES (?, ?, ?, ?)');
    PRODUCTS.forEach(([name, unit, carQty, carMin, factoryQty, low]) => {
      const previewName = `ATLAS_PREVIEW::${name}`;
      insertProduct.run(previewName, unit, 900);
      const product = findProduct.get(previewName);
      productIds.push(product.id);
      insertCar.run(previewName, product.id, carQty, carMin);
      insertFactory.run(previewName, product.id, low ? 5 : factoryQty, low ? 18 : 30);
    });

    for (let index = 0; index < shopIds.length; index += 1) {
      const shop = shopIds[index];
      for (let orderIndex = 0; orderIndex < 3; orderIndex += 1) {
        const productId = productIds[(index + orderIndex) % productIds.length];
        const total = 420 + index * 115 + orderIndex * 185;
        const day = index + orderIndex;
        const orderDate = dateOffset(day);
        insertOrder.run(shop.id, orderDate, JSON.stringify([{ product_id: productId, product_name: PRODUCTS[(index + orderIndex) % PRODUCTS.length][0], unit: 'قطعة', qty: 1 + orderIndex }]), total, `${orderDate} 10:30:00`);
      }
    }
    return { shops: shopIds.length, orders: shopIds.length * 3 };
  });

  const result = transaction();
  console.log(reset ? `Removed ${result.shops} Atlas preview shops and cascaded records.` : `Added ${result.shops} Atlas preview shops and ${result.orders} preview orders with balances and inventory.`);
}

run();
