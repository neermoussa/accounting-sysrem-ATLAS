// Reset only local user accounts and their account-scoped records.
// Business data (shops, orders, balances, inventory, products, notifications) is untouched.
// Run deliberately with: node reset-user-accounts.js --confirm
const db = require('./db/init');

if (!process.argv.includes('--confirm')) {
  console.error('Nothing changed. Re-run with: node reset-user-accounts.js --confirm');
  process.exit(1);
}

const businessCountsBefore = {
  shops: db.prepare('SELECT COUNT(*) c FROM shops').get().c,
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  balances: db.prepare('SELECT COUNT(*) c FROM balances').get().c,
  carInventory: db.prepare('SELECT COUNT(*) c FROM car_inventory').get().c,
  factoryInventory: db.prepare('SELECT COUNT(*) c FROM factory_inventory').get().c,
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
};

const reset = db.transaction(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM sales_targets').run();
  db.prepare('DELETE FROM user_permissions').run();
  db.prepare('DELETE FROM users').run();
});
reset();

const businessCountsAfter = {
  shops: db.prepare('SELECT COUNT(*) c FROM shops').get().c,
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  balances: db.prepare('SELECT COUNT(*) c FROM balances').get().c,
  carInventory: db.prepare('SELECT COUNT(*) c FROM car_inventory').get().c,
  factoryInventory: db.prepare('SELECT COUNT(*) c FROM factory_inventory').get().c,
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
};

if (JSON.stringify(businessCountsBefore) !== JSON.stringify(businessCountsAfter)) {
  throw new Error('Safety check failed: business record counts changed.');
}

console.log('User accounts, sessions, permissions, and sales targets were reset.');
console.log('Business data was preserved:', JSON.stringify(businessCountsAfter));
console.log('The next registered account will be approved automatically as the Atlas manager.');
