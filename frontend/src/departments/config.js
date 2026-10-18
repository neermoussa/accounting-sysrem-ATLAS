// Sidebar / dashboard organisation for the three departments.
//
// This file decides only HOW things are grouped and where a dashboard tile
// links to. Who may see a department is decided by the backend
// (GET /api/departments, lib/departments.js) and which fields a department
// shows is decided by the field registry there — a field listed for several
// departments is one shared value, not three copies.

// `items` are nav item `to` paths from App.jsx's navItems. A nav item not
// listed in any group falls into the last group, so a newly added page can
// never silently vanish from the sidebar.
export const NAV_GROUPS = [
  {
    key: 'sales',
    labelKey: 'dept.group.sales',
    items: ['/', '/day-plan', '/visit', '/waves', '/orders', '/rep-management-preview'],
  },
  {
    key: 'warehouse',
    dept: 'warehouse',
    to: '/warehouse',
    icon: 'warehouse',
    labelKey: 'dept.warehouse',
    items: ['/factory-inventory', '/inventory', '/custody-transfers', '/returns', '/products-master', '/manufacturing', '/manufacturing/floor'],
  },
  {
    key: 'accounting',
    dept: 'accounting',
    to: '/accounting',
    icon: 'ledger',
    labelKey: 'dept.accounting',
    items: ['/collections', '/uploads', '/ledger/accounts', '/ledger/entries', '/ledger/periods', '/ledger/opening-balances', '/sales/invoices', '/sales/credit-notes', '/sales/customers', '/receivables/receipts', '/receivables/cheques', '/receivables/reports', '/reports/financial', '/reports/budgets', '/reports/year-end', '/ledger/exchange-rates', '/reports/currency', '/purchasing', '/purchasing/suppliers', '/purchasing/reports', '/treasury', '/treasury/bank', '/purchasing/settings', '/stock', '/accounting/adjustments', '/payroll', '/ledger/posting-failures'],
  },
  {
    key: 'vendors',
    dept: 'vendors',
    to: '/vendors',
    icon: 'vendors',
    labelKey: 'dept.vendors',
    items: [],
  },
  {
    key: 'system',
    labelKey: 'dept.group.system',
    items: ['/statistics', '/whatsapp-bot', '/ai', '/settings'],
  },
];

export const DEPARTMENT_KEYS = ['warehouse', 'accounting', 'vendors'];

// Each field's label and the page a tile opens (if the user can reach it).
export const FIELD_META = {
  stockValue: { to: '/factory-inventory' },
  openOrders: { to: '/orders' },
  pendingReturns: { to: '/returns' },
  returnsToAdjust: { to: '/returns' },
  factoryLowStock: { to: '/factory-inventory' },
  carLowStock: { to: '/inventory' },
  openTransfers: { to: '/custody-transfers' },
  transferDiscrepancies: { to: '/custody-transfers' },
  pendingReplenish: { to: '/custody-transfers' },
  pendingProduction: { to: '/factory-inventory' },
  receivables: { to: '/collections' },
  overdueShops: { to: '/collections' },
  collectedTotal: { to: '/collections' },
  pendingCollections: { to: '/collections' },
  rejectedCollections: { to: '/collections' },
  activeVendors: { to: '/purchasing/suppliers' },
  incomingPurchases: { to: '/purchasing?tab=orders' },
  payables: { to: '/purchasing/reports?tab=aging' },
};
