// The app's page table. One entry per line on purpose: tools/split-departments.js
// builds each department's separate project by keeping only the lines whose
// `id` belongs to that department (and the imports they still use), so keep
// this file's one-entry-per-line shape.
//
// `nav`   = the sidebar link (omit for routes with no link)
// `route` = who may open the page. Both gates are kept exactly as they were
//           in App.jsx: nav and route permissions differ on a few pages.
import UploadsPage from './pages/UploadsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import StatisticsPage from './pages/StatisticsPage.jsx';
import OrdersPage from './pages/OrdersPage.jsx';
import CollectionsPage from './pages/CollectionsPage.jsx';
import ReturnsPage from './pages/ReturnsPage.jsx';
import ChartOfAccountsPage from './pages/ledger/ChartOfAccountsPage.jsx';
import JournalEntriesPage from './pages/ledger/JournalEntriesPage.jsx';
import FiscalPeriodsPage from './pages/ledger/FiscalPeriodsPage.jsx';
import OpeningBalancesPage from './pages/ledger/OpeningBalancesPage.jsx';
import SalesInvoicesPage from './pages/ledger/SalesInvoicesPage.jsx';
import CreditNotesPage from './pages/ledger/CreditNotesPage.jsx';
import CustomerLedgerPage from './pages/ledger/CustomerLedgerPage.jsx';
import ReceiptsPage from './pages/ledger/ReceiptsPage.jsx';
import ChequesPage from './pages/ledger/ChequesPage.jsx';
import ReceivablesReportsPage from './pages/ledger/ReceivablesReportsPage.jsx';
import FinancialReportsPage from './pages/ledger/FinancialReportsPage.jsx';
import BudgetsPage from './pages/ledger/BudgetsPage.jsx';
import YearEndPage from './pages/ledger/YearEndPage.jsx';
import ExchangeRatesPage from './pages/ledger/ExchangeRatesPage.jsx';
import CurrencyReportsPage from './pages/ledger/CurrencyReportsPage.jsx';
import PurchasingPage from './pages/purchasing/PurchasingPage.jsx';
import SuppliersPage from './pages/purchasing/SuppliersPage.jsx';
import PayablesReportsPage from './pages/purchasing/PayablesReportsPage.jsx';
import TreasuryPage from './pages/treasury/TreasuryPage.jsx';
import ControlsSettingsPage from './pages/purchasing/ControlsSettingsPage.jsx';
import StockPage from './pages/stock/StockPage.jsx';
import ManufacturingPage from './pages/manufacturing/ManufacturingPage.jsx';
import AdjustmentsPage from './pages/accounting/AdjustmentsPage.jsx';
import PayrollPage from './pages/payroll/PayrollPage.jsx';
import PostingFailuresPage from './pages/ledger/PostingFailuresPage.jsx';
import ReadyReportsPage from './pages/analytics/ReadyReportsPage.jsx';
import ReportBuilderPage from './pages/analytics/ReportBuilderPage.jsx';
import FloorPage from './pages/manufacturing/FloorPage.jsx';
import BankReconciliationPage from './pages/treasury/BankReconciliationPage.jsx';

// Shells that only the full Atlas app (not a department app) renders.
export const FULL_ONLY = {};

export const APP_ROUTES = [
  { id: 'uploads', Component: UploadsPage, nav: { to: '/uploads', labelKey: 'nav.uploads', anyOf: ['import_amin', 'manage_shops'], icon: 'upload' }, route: { anyOf: ['import_amin', 'manage_shops'] } },
  { id: 'orders', Component: OrdersPage, nav: { to: '/orders', labelKey: 'nav.orders', anyOf: ['view_app', 'approve_orders', 'record_deliveries', 'add_orders', 'delete_orders'], icon: 'box' }, route: { anyOf: ['view_app', 'approve_orders', 'record_deliveries', 'add_orders', 'delete_orders'] } },
  { id: 'collections', Component: CollectionsPage, nav: { to: '/collections', labelKey: 'nav.collections', anyOf: ['view_app', 'record_collections', 'confirm_collections', 'send_payment_reminders', 'view_statistics'], icon: 'stats', module: 'collections' }, route: { anyOf: ['view_app', 'record_collections', 'confirm_collections', 'send_payment_reminders', 'view_statistics'], module: 'collections' } },
  { id: 'returns', Component: ReturnsPage, nav: { to: '/returns', labelKey: 'nav.returns', anyOf: ['view_app', 'request_returns', 'approve_returns'], icon: 'swap' }, route: { anyOf: ['view_app', 'request_returns', 'approve_returns'] } },
  { id: 'ledger-accounts', Component: ChartOfAccountsPage, nav: { to: '/ledger/accounts', labelKey: 'nav.ledgerAccounts', anyOf: ['view_ledger', 'manage_accounts', 'post_journal_entries', 'reverse_journal_entries', 'manage_fiscal_periods', 'lock_fiscal_periods', 'manage_opening_balances'], icon: 'ledger' }, route: { anyOf: ['view_ledger', 'manage_accounts', 'post_journal_entries', 'reverse_journal_entries', 'manage_fiscal_periods', 'lock_fiscal_periods', 'manage_opening_balances'] } },
  { id: 'ledger-entries', Component: JournalEntriesPage, nav: { to: '/ledger/entries', labelKey: 'nav.ledgerEntries', permission: 'view_ledger', icon: 'audit' }, route: { permission: 'view_ledger' } },
  { id: 'ledger-periods', Component: FiscalPeriodsPage, nav: { to: '/ledger/periods', labelKey: 'nav.ledgerPeriods', anyOf: ['view_ledger', 'manage_fiscal_periods', 'lock_fiscal_periods'], icon: 'shield' }, route: { anyOf: ['view_ledger', 'manage_fiscal_periods', 'lock_fiscal_periods'] } },
  { id: 'ledger-opening', Component: OpeningBalancesPage, nav: { to: '/ledger/opening-balances', labelKey: 'nav.ledgerOpening', anyOf: ['view_ledger', 'manage_opening_balances'], icon: 'import' }, route: { anyOf: ['view_ledger', 'manage_opening_balances'] } },
  { id: 'sales-invoices', Component: SalesInvoicesPage, nav: { to: '/sales/invoices', labelKey: 'nav.salesInvoices', anyOf: ['view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'], icon: 'box' }, route: { anyOf: ['view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'] } },
  { id: 'sales-credit-notes', Component: CreditNotesPage, nav: { to: '/sales/credit-notes', labelKey: 'nav.creditNotes', anyOf: ['view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'], icon: 'swap' }, route: { anyOf: ['view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'] } },
  { id: 'sales-customers', Component: CustomerLedgerPage, nav: { to: '/sales/customers', labelKey: 'nav.customerLedger', anyOf: ['view_ledger', 'view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'], icon: 'users' }, route: { anyOf: ['view_ledger', 'view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'] } },
  { id: 'receivables-receipts', Component: ReceiptsPage, nav: { to: '/receivables/receipts', labelKey: 'nav.receipts', anyOf: ['view_receivables', 'manage_receipts', 'view_ledger'], icon: 'stats' }, route: { anyOf: ['view_receivables', 'manage_receipts', 'view_ledger'] } },
  { id: 'receivables-cheques', Component: ChequesPage, nav: { to: '/receivables/cheques', labelKey: 'nav.cheques', anyOf: ['view_receivables', 'manage_receipts', 'view_ledger'], icon: 'shield' }, route: { anyOf: ['view_receivables', 'manage_receipts', 'view_ledger'] } },
  { id: 'receivables-reports', Component: ReceivablesReportsPage, nav: { to: '/receivables/reports', labelKey: 'nav.receivablesReports', anyOf: ['view_receivables', 'manage_receipts', 'view_ledger'], icon: 'stats' }, route: { anyOf: ['view_receivables', 'manage_receipts', 'view_ledger'] } },
  { id: 'purchasing', Component: PurchasingPage, nav: { to: '/purchasing', labelKey: 'nav.purchasing', anyOf: ['view_purchases', 'manage_suppliers', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch'], icon: 'box' }, route: { anyOf: ['view_purchases', 'manage_suppliers', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch'] } },
  { id: 'suppliers', Component: SuppliersPage, nav: { to: '/purchasing/suppliers', labelKey: 'nav.suppliers', anyOf: ['view_purchases', 'manage_suppliers', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch'], icon: 'users' }, route: { anyOf: ['view_purchases', 'manage_suppliers', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch'] } },
  { id: 'payables-reports', Component: PayablesReportsPage, nav: { to: '/purchasing/reports', labelKey: 'nav.payablesReports', anyOf: ['view_purchases', 'manage_suppliers', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch'], icon: 'stats' }, route: { anyOf: ['view_purchases', 'manage_suppliers', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch'] } },
  { id: 'treasury', Component: TreasuryPage, nav: { to: '/treasury', labelKey: 'nav.treasury', anyOf: ['view_treasury', 'manage_cash_boxes', 'create_vouchers', 'approve_vouchers', 'manage_cheques', 'reconcile_bank'], icon: 'swap' }, route: { anyOf: ['view_treasury', 'manage_cash_boxes', 'create_vouchers', 'approve_vouchers', 'manage_cheques', 'reconcile_bank'] } },
  { id: 'bank-reconciliation', Component: BankReconciliationPage, nav: { to: '/treasury/bank', labelKey: 'nav.bankReconciliation', anyOf: ['view_treasury', 'manage_cash_boxes', 'create_vouchers', 'approve_vouchers', 'manage_cheques', 'reconcile_bank'], icon: 'stats' }, route: { anyOf: ['view_treasury', 'manage_cash_boxes', 'create_vouchers', 'approve_vouchers', 'manage_cheques', 'reconcile_bank'] } },
  { id: 'controls-settings', Component: ControlsSettingsPage, nav: { to: '/purchasing/settings', labelKey: 'nav.controls', anyOf: ['manage_settings', 'approve_purchase_orders', 'view_purchases', 'view_treasury'], icon: 'shield' }, route: { anyOf: ['manage_settings', 'approve_purchase_orders', 'view_purchases', 'view_treasury'] } },
  { id: 'ready-reports', Component: ReadyReportsPage, nav: { to: '/reports/ready', labelKey: 'nav.readyReports', anyOf: ['view_financial_reports'], icon: 'ledger' }, route: { anyOf: ['view_financial_reports'] } },
  { id: 'report-builder', Component: ReportBuilderPage, nav: { to: '/reports/builder', labelKey: 'nav.reportBuilder', anyOf: ['view_financial_reports'], icon: 'stats' }, route: { anyOf: ['view_financial_reports'] } },
  { id: 'posting-failures', Component: PostingFailuresPage, nav: { to: '/ledger/posting-failures', labelKey: 'nav.postingFailures', anyOf: ['view_ledger', 'post_journal_entries', 'manage_fiscal_periods'], icon: 'ledger' }, route: { anyOf: ['view_ledger', 'post_journal_entries', 'manage_fiscal_periods'] } },
  { id: 'payroll', Component: PayrollPage, nav: { to: '/payroll', labelKey: 'nav.payroll', anyOf: ['manage_payroll_intake', 'approve_payroll_posting'], icon: 'ledger' }, route: { anyOf: ['manage_payroll_intake', 'approve_payroll_posting'] } },
  { id: 'adjustments', Component: AdjustmentsPage, nav: { to: '/accounting/adjustments', labelKey: 'nav.adjustments', anyOf: ['manage_fixed_assets', 'manage_tax_codes', 'manage_recurring_entries'], icon: 'ledger' }, route: { anyOf: ['manage_fixed_assets', 'manage_tax_codes', 'manage_recurring_entries'] } },
  { id: 'manufacturing', Component: ManufacturingPage, nav: { to: '/manufacturing', labelKey: 'nav.manufacturing', anyOf: ['view_manufacturing', 'manage_recipes', 'plan_production', 'manage_production_orders', 'record_production', 'approve_production_qc', 'manage_production_costs'], icon: 'box' }, route: { anyOf: ['view_manufacturing', 'manage_recipes', 'plan_production', 'manage_production_orders', 'record_production', 'approve_production_qc', 'manage_production_costs'] } },
  { id: 'manufacturing-floor', Component: FloorPage, nav: { to: '/manufacturing/floor', labelKey: 'nav.manufacturingFloor', anyOf: ['record_production'], icon: 'box' }, route: { anyOf: ['record_production'] } },
  { id: 'stock-ledger', Component: StockPage, nav: { to: '/stock', labelKey: 'nav.stock', anyOf: ['view_stock_valuation', 'manage_stock_ledger'], icon: 'box' }, route: { anyOf: ['view_stock_valuation', 'manage_stock_ledger'] } },
  { id: 'exchange-rates', Component: ExchangeRatesPage, nav: { to: '/ledger/exchange-rates', labelKey: 'nav.exchangeRates', anyOf: ['manage_exchange_rates', 'view_ledger', 'view_financial_reports'], icon: 'swap' }, route: { anyOf: ['manage_exchange_rates', 'view_ledger', 'view_financial_reports'] } },
  { id: 'currency-reports', Component: CurrencyReportsPage, nav: { to: '/reports/currency', labelKey: 'nav.currencyReports', anyOf: ['run_fx_revaluation', 'view_ledger', 'view_financial_reports', 'view_receivables'], icon: 'stats' }, route: { anyOf: ['run_fx_revaluation', 'view_ledger', 'view_financial_reports', 'view_receivables'] } },
  { id: 'financial-reports', Component: FinancialReportsPage, nav: { to: '/reports/financial', labelKey: 'nav.financialReports', anyOf: ['view_financial_reports', 'view_ledger'], icon: 'stats' }, route: { anyOf: ['view_financial_reports', 'view_ledger'] } },
  { id: 'budgets', Component: BudgetsPage, nav: { to: '/reports/budgets', labelKey: 'nav.budgets', anyOf: ['manage_budgets', 'view_financial_reports', 'view_ledger'], icon: 'ledger' }, route: { anyOf: ['manage_budgets', 'view_financial_reports', 'view_ledger'] } },
  { id: 'year-end', Component: YearEndPage, nav: { to: '/reports/year-end', labelKey: 'nav.yearEnd', anyOf: ['run_year_end_close', 'view_financial_reports', 'view_ledger'], icon: 'shield' }, route: { anyOf: ['run_year_end_close', 'view_financial_reports', 'view_ledger'] } },
  { id: 'statistics', Component: StatisticsPage, nav: { to: '/statistics', labelKey: 'nav.statistics', permission: 'view_statistics', icon: 'stats', module: 'reports' }, route: { permission: 'view_statistics', module: 'reports' } },
  { id: 'settings', Component: SettingsPage, nav: { to: '/settings', labelKey: 'nav.settings', anyOf: ['manage_settings', 'manage_users', 'manage_permissions', 'view_audit_log'], icon: 'settings' }, route: { anyOf: ['manage_settings', 'manage_users', 'manage_permissions', 'view_audit_log'] } },
];
