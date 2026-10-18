const db = require('../db/init');

// The full catalog of grantable permissions. This — plus per-user rows in
// user_permissions — is the sole source of truth for what a user can do.
// There is no more fixed role: every permission below is toggled per user
// independently by whoever holds `manage_permissions`.
const PERMISSIONS = {
  view_app: 'عرض الخريطة والتطبيق',
  manage_shops: 'إضافة/تعديل/حذف محل',
  import_amin: 'رفع ملف الأمين',
  approve_import: 'الموافقة على مراجعة الاستيراد',
  add_orders: 'إضافة/تعديل طلب',
  delete_orders: 'حذف طلب',
  manage_car_inventory: 'مخزون السيارة',
  manage_factory_inventory: 'مخزون المعمل',
  view_statistics: 'عرض الإحصائيات',
  export_data: 'تصدير البيانات (Excel)',
  manage_users: 'إدارة المستخدمين (الموافقة/الرفض)',
  manage_settings: 'تعديل الإعدادات',
  view_audit_log: 'سجل النشاط',
  manage_products: 'إدارة المنتجات',
  view_customer_notes: 'عرض ملاحظات العملاء',
  manage_leads: 'إدارة العملاء المحتملين (Leads)',
  reassign_shops: 'توزيع/نقل العملاء بين المندوبين',
  manage_pricing: 'إدارة قوائم الأسعار والعروض',
  approve_special_prices: 'اعتماد الأسعار الخاصة (تحت حد الربح الأدنى)',
  manage_rep_targets: 'إدارة أهداف وعمولات المندوبين',
  view_commissions: 'عرض كشف العمولة',
  manage_announcements: 'إرسال الإعلانات والتعليمات',
  rate_visits: 'تقييم جودة الزيارة (المشرف)',
  manage_waves: 'إدارة اللفات وخطة المندوبين',
  approve_orders: 'اعتماد الطلبات (من بانتظار الموافقة لمعتمد)',
  record_deliveries: 'تسجيل تسليم الطلبات (كامل/جزئي)',
  manage_production_requests: 'معالجة طلبات الإنتاج',
  manage_replenish_requests: 'تجهيز وتزويد السيارة من المستودع',
  create_custody_transfers: 'إنشاء مناقلة عهدة جديدة',
  manage_custody_transfer_items: 'إضافة/تعديل أصناف مناقلة العهدة',
  approve_custody_transfer_readiness: 'اعتماد جاهزية مناقلة العهدة (الطبلية)',
  confirm_custody_transfer_receipt: 'تأكيد استلام مناقلة العهدة (المندوب)',
  resolve_transfer_discrepancy: 'معالجة فروقات المناقلة',
  request_returns: 'تقديم طلبات مرتجع/تالف',
  approve_returns: 'الموافقة على المرتجعات وفحصها',
  apply_return_financial_adjustment: 'تطبيق التعديل المالي للمرتجع على رصيد الزبون',
  record_collections: 'تسجيل القبض (نقدًا/حوالة)',
  confirm_collections: 'تأكيد استلام القبض (المحاسب) أو تحقق الحوالة',
  send_payment_reminders: 'مراجعة وإرسال تذكيرات الدفع',
  view_whatsapp_log: 'عرض سجل محادثات واتساب الكامل',
  manage_whatsapp_tickets: 'إدارة شكاوى واتساب',
  respond_whatsapp_alerts: 'استلام تنبيهات رسائل واتساب غير المفهومة/غير المجاب عنها',
  send_account_statements: 'اعتماد وإرسال كشف الحساب عبر واتساب',
  suggest_kb_entries: 'الرد على أسئلة العملاء الجديدة واقتراحها لقاعدة المعرفة',
  view_ai_recommendations: 'عرض توصيات وتنبيهات الذكاء الاصطناعي',
  decide_ai_recommendations: 'الموافقة على توصيات الذكاء الاصطناعي أو رفضها',
  approve_offline_sync: 'الموافقة على عمليات المزامنة الحساسة ومعالجة تعارضاتها',
  view_vendors: 'عرض لوحة الموردين',
  view_ledger: 'عرض دفتر الأستاذ والقيود المحاسبية',
  manage_accounts: 'إدارة دليل الحسابات ومراكز الكلفة والمشاريع',
  post_journal_entries: 'إنشاء وترحيل القيود المحاسبية',
  reverse_journal_entries: 'عكس القيود المرحّلة',
  manage_fiscal_periods: 'إغلاق وإعادة فتح الفترات المالية',
  lock_fiscal_periods: 'قفل الفترات المالية نهائيًا',
  manage_opening_balances: 'إدخال الأرصدة الافتتاحية',
  view_sales_invoices: 'عرض فواتير المبيعات وإشعارات الدائن',
  create_sales_invoices: 'إنشاء وتعديل مسودات فواتير المبيعات',
  post_sales_invoices: 'ترحيل فواتير المبيعات',
  create_credit_notes: 'إصدار إشعارات دائن للمبيعات',
  view_receivables: 'عرض الذمم المدينة (أعمار الديون، التوقعات، المطابقة)',
  manage_receipts: 'إدارة سندات القبض وتخصيصها والشيكات الواردة',
  override_credit_limit: 'تجاوز الحد الائتماني للزبون (مع ذكر السبب)',
  view_financial_reports: 'عرض التقارير المالية (الميزانية، الأرباح والخسائر، التدفقات النقدية)',
  manage_budgets: 'إدارة الموازنات التقديرية',
  run_year_end_close: 'إقفال السنة المالية ونقل النتيجة إلى الأرباح المحتجزة',
  manage_exchange_rates: 'إدخال أسعار الصرف اليومية (يدوي) وعرض سجلها',
  override_exchange_rate: 'تجاوز سعر الصرف لمستند معيّن (فاتورة، سند قبض، تخصيص)',
  run_fx_revaluation: 'إعادة تقييم الأرصدة بالعملات الأجنبية في نهاية الفترة',
  view_purchases: 'عرض المشتريات والموردين وتقارير الذمم الدائنة',
  create_purchase_requests: 'إنشاء طلبات الشراء وعروض الأسعار وأوامر الشراء',
  approve_purchase_orders: 'اعتماد طلبات وأوامر الشراء',
  receive_goods: 'استلام البضاعة من الموردين',
  post_supplier_invoices: 'ترحيل فواتير الموردين وإشعارات المدين',
  make_supplier_payments: 'دفعات الموردين',
  approve_purchase_mismatch: 'الموافقة على فروقات المطابقة الثلاثية (أمر/استلام/فاتورة)',
  manage_suppliers: 'إدارة بطاقات الموردين',
  view_treasury: 'عرض الخزينة (الصناديق والبنوك والسندات والشيكات والتقارير)',
  manage_cash_boxes: 'إدارة الصناديق والحسابات البنكية وصلاحيات الوصول إليها',
  create_vouchers: 'إنشاء سندات القبض والصرف والمصاريف والتحويلات',
  approve_vouchers: 'اعتماد وترحيل وعكس سندات الخزينة وتسليم نقدية المندوبين',
  manage_cheques: 'إدارة الشيكات الصادرة والواردة (إصدار، تحصيل، ارتداد، إلغاء)',
  reconcile_bank: 'استيراد كشوف البنك ومطابقتها',
  view_stock_valuation: 'عرض تقييم المخزون وحركاته وتقرير المطابقة',
  manage_stock_ledger: 'تفعيل دفتر المخزون وطرق التقييم والتسويات',
  manage_stock_counts: 'إنشاء وعدّ مستندات جرد المخزون',
  approve_stock_counts: 'اعتماد فروقات الجرد وترحيلها',
  post_stock_wastage: 'ترحيل التالف والهدر والفقد وإعادة التعبئة',
  manage_lots: 'إدارة الدفعات وتواريخ الصلاحية والحجر والسحب',
  view_manufacturing: 'عرض التصنيع (الوصفات، الخطط، أوامر الإنتاج، التكاليف والتقارير)',
  manage_recipes: 'إدارة الوصفات وإصداراتها ومسببات الحساسية وفحوص الجودة',
  plan_production: 'تخطيط الإنتاج واحتياجات المواد',
  manage_production_orders: 'إصدار أوامر الإنتاج وإغلاقها ورفض الدفعات',
  record_production: 'تسجيل صرف المواد والإنتاج الفعلي والهدر في الورشة',
  approve_production_qc: 'تسجيل نتائج فحص الجودة واعتماد الدفعات',
  manage_production_costs: 'إدارة أسعار وتكاليف الإنتاج المؤرخة',
  manage_payroll_intake: 'استيراد الرواتب من برنامج الموارد البشرية وإدارة السلف وأسعار تكلفة العمل',
  approve_payroll_posting: 'ترحيل استحقاق الرواتب وإعادة فتحه وإنشاء دفعات الرواتب',
  manage_fixed_assets: 'إدارة الأصول الثابتة والإهلاك والاستبعاد',
  manage_tax_codes: 'إدارة رموز الضريبة ونسبها وتقرير الضريبة',
  manage_recurring_entries: 'إدارة القيود الدورية والاستحقاقات والمصروفات المدفوعة مقدمًا',
};

// The meta-permission: whoever holds it can grant/revoke any permission
// (including this one) from any user. Kept out of PERMISSIONS/templates on
// purpose so it never gets handed out as a side effect of applying a
// template — it's only ever granted one explicit toggle at a time from the
// permissions screen itself.
const MANAGE_PERMISSIONS = 'manage_permissions';
const MANAGE_PERMISSIONS_LABEL = 'إدارة الصلاحيات (يملك كل الصلاحيات ويتحكم بصلاحيات الجميع)';

const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS);

function isValidPermission(permission) {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, permission);
}

function getUserPermissions(userId) {
  return db
    .prepare('SELECT permission FROM user_permissions WHERE user_id = ?')
    .all(userId)
    .map((r) => r.permission);
}

function userHasPermission(userId, permission) {
  return !!db
    .prepare('SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?')
    .get(userId, permission);
}

// Full replace of a user's permission set. `permissions` may include
// MANAGE_PERMISSIONS or not — callers decide; this function itself applies
// no policy (the last-holder safety net lives in the route handler, where
// it can return a proper error instead of silently refusing).
function setUserPermissions(userId, permissions, grantedBy) {
  const unique = [...new Set(permissions)];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, ?)'
    );
    for (const p of unique) insert.run(userId, p, grantedBy ?? null);
  });
  tx();
}

function grantPermission(userId, permission, grantedBy) {
  db.prepare(
    `INSERT INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, ?)
     ON CONFLICT(user_id, permission) DO UPDATE SET granted_by = excluded.granted_by, granted_at = datetime('now')`
  ).run(userId, permission, grantedBy ?? null);
}

function revokePermission(userId, permission) {
  db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?').run(userId, permission);
}

// Scoped to one company on purpose — the "don't strip the last holder of
// manage_permissions" safety net must never count another company's users,
// or an admin here could be blocked (or not) by something happening in a
// completely unrelated company.
function countHoldersOf(permission, companyId) {
  return db
    .prepare(
      `SELECT COUNT(*) c FROM user_permissions up
       JOIN users u ON u.id = up.user_id
       WHERE up.permission = ? AND u.company_id = ?`
    )
    .get(permission, companyId).c;
}

// Templates visible to a company: the platform's built-ins (company_id IS
// NULL) plus that company's own custom roles — never another company's.
function getTemplates(companyId) {
  return db
    .prepare('SELECT * FROM permission_templates WHERE company_id IS NULL OR company_id = ? ORDER BY is_builtin DESC, name COLLATE NOCASE')
    .all(companyId)
    .map((t) => ({ ...t, permissions: JSON.parse(t.permissions_json) }));
}

module.exports = {
  PERMISSIONS,
  MANAGE_PERMISSIONS,
  MANAGE_PERMISSIONS_LABEL,
  ALL_PERMISSION_KEYS,
  isValidPermission,
  getUserPermissions,
  userHasPermission,
  setUserPermissions,
  grantPermission,
  revokePermission,
  countHoldersOf,
  getTemplates,
};
