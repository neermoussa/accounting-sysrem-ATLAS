const { buildInventoryRouter } = require('../lib/inventoryRouter');

module.exports = buildInventoryRouter({
  table: 'factory_inventory',
  warehouseLabel: 'مستودع المعمل',
  exportFilename: 'factory-inventory-export.xlsx',
  sheetName: 'مستودع المعمل',
  sheetNameEn: 'Factory warehouse',
  permission: 'manage_factory_inventory',
});
