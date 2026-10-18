const { buildInventoryRouter } = require('../lib/inventoryRouter');

module.exports = buildInventoryRouter({
  table: 'car_inventory',
  warehouseLabel: 'مستودع السيارة',
  exportFilename: 'inventory-export.xlsx',
  sheetName: 'مستودع السيارة',
  sheetNameEn: 'Car warehouse',
  permission: 'manage_car_inventory',
});
