// backend/lib/analytics/query.js
//
// Prompt 12b — ONE query spec for the Report Builder (and, in 12c, for the
// natural-language questions). A spec is plain JSON:
//
//   { source: 'sales',                        // a fact table from CATALOG
//     measures: ['net', 'qty'],               // 1..10 catalog measures
//     calcs: [{ key: 'margin_pct', label: 'هامش %', expr: '(net - cost) / net * 100', format: 'percent' }],
//     dimensions: ['branch', 'month'],        // 0..3 catalog dimensions
//     filters: [{ dim: 'branch', op: 'in', values: [3, null] }],
//     period: { from: '2026-01-01', to: '2026-03-31' } | { preset: 'last_month' } | { preset: 'last_n_days', n: 30 },
//     compare: null | 'previous_period' | 'previous_year',
//     sort: { by: 'net', dir: 'desc' }, limit: 1000,
//     includeClosing: false }                 // journal only
//
// validate() checks it against the catalog (whitelist: nothing from the
// client ever becomes SQL text — only catalog column names and bound
// values), resolves the period against the given "now", checks every id
// against the company (tenantRefs) and enforces the permissions INSIDE the
// engine: the builder itself needs view_financial_reports, payroll data the
// payroll permissions, cost data (unit costs, margins, stock and production
// values, purchase prices) view_costs. execute() is pure (dbh, companyId,
// spec) so it runs on the worker's read-only connection.

// tenantRefs opens the main (read-write) connection: loaded lazily, only by
// validate() / drill() on the main thread — never inside the report worker.
const refs = () => require('../tenantRefs');
const E = require('./expr');
const { ReportError, label } = require('./reports');

const fail = (code, message, status = 400) => { throw new ReportError(code, message, status); };

const PAYROLL_PERMS = ['manage_payroll_intake', 'approve_payroll_posting'];
const REPORTS_PERM = 'view_financial_reports';
const COSTS_PERM = 'view_costs';

// ---------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------
// dim:     { col, kind? (tenantRefs kind for ids), labelAs? (label() dim), text? }
// measure: { sql (aggregate over catalog columns only), type: money | number, needs? }
const d = (col, kind, labelAs) => ({ col, kind, labelAs: labelAs || kind });
const t = (col) => ({ col, text: true });
const sum = (col, type = 'money', needs) => ({ sql: `COALESCE(SUM(${col}), 0)`, type, needs });
const L = (ar, en) => ({ label_ar: ar, label_en: en });

const CATALOG = {
  sales: {
    ...L('المبيعات', 'Sales'), table: 'fact_sales_lines', date: 'doc_date', drill: 'sales',
    dims: { item: { ...d('product_id', 'product', 'item'), ...L('المادة', 'Item') }, customer: { ...d('customer_id', 'shop', 'customer'), ...L('الزبون', 'Customer') }, branch: { ...d('branch_id', 'branch'), ...L('الفرع', 'Branch') }, rep: { ...d('rep_id', 'user', 'rep'), ...L('المندوب', 'Rep') }, region: { ...t('region'), ...L('المنطقة', 'Region') }, category: { ...t('category'), ...L('الفئة', 'Category') }, channel: { ...t('channel'), ...L('القناة', 'Channel') }, warehouse: { ...d('warehouse_id', 'warehouse'), ...L('المستودع', 'Warehouse') }, month: { ...t('ym'), ...L('الشهر', 'Month') }, currency: { ...t('currency_code'), ...L('العملة', 'Currency') }, doc_type: { ...t('doc_type'), ...L('نوع المستند', 'Document type') } },
    measures: { net: { ...sum('net_base_minor'), ...L('صافي المبيعات', 'Net sales') }, qty: { ...sum('qty', 'number'), ...L('الكمية', 'Qty') }, cost: { ...sum('cost_base_minor', 'money', 'costs'), ...L('التكلفة', 'Cost') }, margin: { sql: 'COALESCE(SUM(net_base_minor), 0) - COALESCE(SUM(cost_base_minor), 0)', type: 'money', needs: 'costs', ...L('الهامش', 'Margin') }, documents: { sql: "COUNT(DISTINCT doc_type || ':' || doc_id)", type: 'number', ...L('المستندات', 'Documents') }, lines: { sql: 'COUNT(*)', type: 'number', ...L('السطور', 'Lines') } },
  },
  purchases: {
    ...L('المشتريات', 'Purchases'), table: 'fact_purchase_lines', date: 'doc_date', drill: 'purchases', needs: 'costs',
    dims: { supplier: { ...d('supplier_id', 'supplier'), ...L('المورد', 'Supplier') }, item: { ...d('product_id', 'product', 'item'), ...L('المادة', 'Item') }, category: { ...t('category'), ...L('الفئة', 'Category') }, kind: { ...t('kind'), ...L('النوع', 'Kind') }, account: { ...d('expense_account_id', 'account'), ...L('الحساب', 'Account') }, month: { ...t('ym'), ...L('الشهر', 'Month') }, currency: { ...t('currency_code'), ...L('العملة', 'Currency') } },
    measures: { net: { ...sum('net_base_minor'), ...L('صافي المشتريات', 'Net purchases') }, qty: { ...sum('qty', 'number'), ...L('الكمية', 'Qty') }, documents: { sql: "COUNT(DISTINCT doc_type || ':' || doc_id)", type: 'number', ...L('المستندات', 'Documents') }, lines: { sql: 'COUNT(*)', type: 'number', ...L('السطور', 'Lines') } },
  },
  journal: {
    ...L('القيود (دفتر الأستاذ)', 'Journal (ledger)'), table: 'fact_journal_lines', date: 'entry_date', drill: 'journal', closing: true,
    dims: { account: { ...d('account_id', 'account'), ...L('الحساب', 'Account') }, account_type: { ...t('account_type'), ...L('نوع الحساب', 'Account type') }, report_class: { ...t('report_class'), ...L('تصنيف التقارير', 'Report class') }, branch: { ...d('branch_id', 'branch'), ...L('الفرع', 'Branch') }, cost_center: { ...d('cost_center_id', 'cost_center'), ...L('مركز الكلفة', 'Cost center') }, project: { ...d('project_id', 'project'), ...L('المشروع', 'Project') }, month: { ...t('ym'), ...L('الشهر', 'Month') }, source_type: { ...t('source_type'), ...L('المصدر', 'Source') }, currency: { ...t('currency_code'), ...L('العملة', 'Currency') } },
    measures: { debit: { ...sum('debit_minor'), ...L('مدين', 'Debit') }, credit: { ...sum('credit_minor'), ...L('دائن', 'Credit') }, net_debit: { sql: 'COALESCE(SUM(debit_minor - credit_minor), 0)', type: 'money', ...L('الرصيد المدين', 'Net debit') }, net_credit: { sql: 'COALESCE(SUM(credit_minor - debit_minor), 0)', type: 'money', ...L('الرصيد الدائن', 'Net credit') }, lines: { sql: 'COUNT(*)', type: 'number', ...L('السطور', 'Lines') } },
  },
  expenses: {
    ...L('المصاريف', 'Expenses'), table: 'fact_expenses', date: 'entry_date', drill: 'expenses',
    dims: { account: { ...d('account_id', 'account'), ...L('الحساب', 'Account') }, cost_center: { ...d('cost_center_id', 'cost_center'), ...L('مركز الكلفة', 'Cost center') }, project: { ...d('project_id', 'project'), ...L('المشروع', 'Project') }, supplier: { ...d('supplier_id', 'supplier'), ...L('المورد', 'Supplier') }, branch: { ...d('branch_id', 'branch'), ...L('الفرع', 'Branch') }, employee: { ...d('employee_id', 'user', 'employee'), needs: 'payroll', ...L('الموظف', 'Employee') }, month: { ...t('ym'), ...L('الشهر', 'Month') } },
    measures: { amount: { ...sum('amount_minor'), ...L('المبلغ', 'Amount') }, lines: { sql: 'COUNT(*)', type: 'number', ...L('السطور', 'Lines') } },
  },
  receivables: {
    ...L('الذمم المدينة', 'Receivables'), table: 'fact_receivables', date: 'entry_date', drill: 'receivables',
    dims: { customer: { ...d('customer_id', 'shop', 'customer'), ...L('الزبون', 'Customer') }, region: { ...t('region'), ...L('المنطقة', 'Region') }, rep: { ...d('rep_id', 'user', 'rep'), ...L('المندوب', 'Rep') }, method: { ...t('method'), ...L('طريقة الدفع', 'Method') }, source_type: { ...t('source_type'), ...L('المصدر', 'Source') }, month: { ...t('ym'), ...L('الشهر', 'Month') } },
    measures: { debit: { ...sum('debit_minor'), ...L('مدين (مبيعات وأرصدة)', 'Debit') }, credit: { ...sum('credit_minor'), ...L('دائن (تحصيلات وإشعارات)', 'Credit') }, net: { sql: 'COALESCE(SUM(debit_minor - credit_minor), 0)', type: 'money', ...L('صافي الحركة', 'Net change') }, lines: { sql: 'COUNT(*)', type: 'number', ...L('السطور', 'Lines') } },
  },
  payables: {
    ...L('الذمم الدائنة', 'Payables'), table: 'fact_payables', date: 'entry_date', drill: 'payables', needs: 'costs',
    dims: { supplier: { ...d('supplier_id', 'supplier'), ...L('المورد', 'Supplier') }, source_type: { ...t('source_type'), ...L('المصدر', 'Source') }, month: { ...t('ym'), ...L('الشهر', 'Month') } },
    measures: { debit: { ...sum('debit_minor'), ...L('مدين (دفعات)', 'Debit') }, credit: { ...sum('credit_minor'), ...L('دائن (فواتير)', 'Credit') }, net: { sql: 'COALESCE(SUM(credit_minor - debit_minor), 0)', type: 'money', ...L('صافي الحركة', 'Net change') }, lines: { sql: 'COUNT(*)', type: 'number', ...L('السطور', 'Lines') } },
  },
  inventory: {
    ...L('حركة المخزون', 'Stock movements'), table: 'fact_inventory_moves', date: 'move_date', drill: 'inventory',
    dims: { item: { ...d('product_id', 'product', 'item'), ...L('المادة', 'Item') }, category: { ...t('category'), ...L('الفئة', 'Category') }, warehouse: { ...d('warehouse_id', 'warehouse'), ...L('المستودع', 'Warehouse') }, holder_kind: { ...t('holder_kind'), ...L('نوع الحائز', 'Holder kind') }, move_type: { ...t('move_type'), ...L('نوع الحركة', 'Move type') }, month: { ...t('ym'), ...L('الشهر', 'Month') } },
    measures: { qty: { ...sum('qty', 'number'), ...L('الكمية', 'Qty') }, value: { ...sum('value_minor', 'money', 'costs'), ...L('القيمة', 'Value') }, moves: { sql: 'COUNT(*)', type: 'number', ...L('الحركات', 'Moves') } },
  },
  production: {
    ...L('الإنتاج', 'Production'), table: 'fact_production_batches', date: 'production_date', drill: 'production',
    dims: { item: { ...d('product_id', 'product', 'item'), ...L('المنتج', 'Product') }, category: { ...t('category'), ...L('الفئة', 'Category') }, status: { ...t('status'), ...L('الحالة', 'Status') }, month: { ...t('ym'), ...L('الشهر', 'Month') } },
    measures: { orders: { sql: 'COUNT(*)', type: 'number', ...L('أوامر الإنتاج', 'Orders') }, batches: { ...sum('batches', 'number'), ...L('الدفعات', 'Batches') }, expected_units: { ...sum('expected_units', 'number'), ...L('الوحدات المتوقعة', 'Expected units') }, actual_units: { ...sum('actual_units', 'number'), ...L('الوحدات الفعلية', 'Actual units') }, actual_kg: { ...sum('actual_kg', 'number'), ...L('الكيلوغرامات', 'Kg') }, materials: { ...sum('materials_minor', 'money', 'costs'), ...L('المواد', 'Materials') }, labour: { ...sum('labour_minor', 'money', 'costs'), ...L('العمل', 'Labour') }, overhead: { sql: 'COALESCE(SUM(overhead_minor + energy_minor), 0)', type: 'money', needs: 'costs', ...L('غير المباشرة والطاقة', 'Overhead + energy') }, fg_value: { ...sum('fg_value_minor', 'money', 'costs'), ...L('قيمة الإنتاج التام', 'Finished goods value') }, abnormal_loss: { ...sum('abnormal_loss_minor', 'money', 'costs'), ...L('الفاقد غير الطبيعي', 'Abnormal loss') } },
  },
  payroll: {
    ...L('الرواتب', 'Payroll'), table: 'fact_payroll', date: 'period', monthly: true, drill: 'payroll', needs: 'payroll',
    dims: { department: { ...t('department'), ...L('القسم', 'Department') }, cost_center: { ...d('cost_center_id', 'cost_center'), ...L('مركز الكلفة', 'Cost center') }, currency: { ...t('currency_code'), ...L('العملة', 'Currency') }, month: { ...t('period'), ...L('الشهر', 'Month') } },
    measures: { gross: { ...sum('gross_base_minor'), ...L('الإجمالي', 'Gross') }, employer: { ...sum('employer_base_minor'), ...L('مساهمة صاحب العمل', 'Employer') }, deductions: { ...sum('deductions_base_minor'), ...L('الاستقطاعات', 'Deductions') }, net: { ...sum('net_base_minor'), ...L('الصافي', 'Net') }, headcount: { ...sum('headcount', 'number'), ...L('عدد الموظفين', 'Headcount') } },
  },
};

// Columns of each fact table that are cost or payroll data (stripped from
// drill rows for users without the permission).
const COST_COLUMNS = { fact_sales_lines: ['cost_base_minor'], fact_inventory_moves: ['value_minor'], fact_production_batches: ['materials_minor', 'labour_minor', 'energy_minor', 'overhead_minor', 'byproduct_credit_minor', 'abnormal_loss_minor', 'written_off_minor', 'fg_value_minor', 'theoretical_minor'] };
const PAYROLL_COLUMNS = { fact_expenses: ['employee_id'] };

// ---------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------
function access(permissions) {
  const p = new Set(permissions || []);
  return { reports: p.has(REPORTS_PERM), costs: p.has(COSTS_PERM), payroll: PAYROLL_PERMS.some((x) => p.has(x)) };
}
const NEED_MSG = { costs: 'بيانات التكلفة تحتاج صلاحية عرض التكاليف', payroll: 'بيانات الرواتب تحتاج صلاحيات الرواتب' };
function requireNeed(acc, need, what) {
  if (need && !acc[need]) fail(`forbidden_${need}`, `${NEED_MSG[need]} (${what})`, 403);
}
// What the spec needs (the union), e.g. to decide who may receive it.
function specNeeds(spec) {
  const src = CATALOG[spec.source];
  const needs = new Set();
  if (!src) return needs;
  if (src.needs) needs.add(src.needs);
  for (const m of spec.measures || []) if (src.measures[m]?.needs) needs.add(src.measures[m].needs);
  for (const k of [...(spec.dimensions || []), ...(spec.filters || []).map((f) => f.dim)]) if (src.dims[k]?.needs) needs.add(src.dims[k].needs);
  return needs;
}

// Catalog as the user may see it (the builder screen and 12c's mapper).
function catalogFor(permissions) {
  const acc = access(permissions);
  const ok = (need) => !need || acc[need];
  return Object.entries(CATALOG).filter(([, s]) => ok(s.needs)).map(([key, s]) => ({
    key, label_ar: s.label_ar, label_en: s.label_en, closing: !!s.closing,
    dimensions: Object.entries(s.dims).filter(([, x]) => ok(x.needs)).map(([k, x]) => ({ key: k, label_ar: x.label_ar, label_en: x.label_en, kind: x.kind || null })),
    measures: Object.entries(s.measures).filter(([, x]) => ok(x.needs)).map(([k, x]) => ({ key: k, label_ar: x.label_ar, label_en: x.label_en, type: x.type })),
  }));
}

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const iso = (dt) => dt.toISOString().slice(0, 10);
const D = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const x = D(s); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const monthStart = (y, m) => iso(new Date(Date.UTC(y, m, 1)));
const monthEnd = (y, m) => iso(new Date(Date.UTC(y, m + 1, 0)));
const ymOf = (s) => [Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1];
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000);
// Shift a date by whole months, clamping to the month's last day (31 Mar - 1 month = 28/29 Feb).
function addMonths(s, n) {
  const [y, m] = ymOf(s);
  const day = Number(s.slice(8, 10));
  const target = new Date(Date.UTC(y, m + n, 1));
  const last = Number(monthEnd(target.getUTCFullYear(), target.getUTCMonth()).slice(8, 10));
  return iso(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last))));
}

const PRESETS = ['this_month', 'last_month', 'mtd', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'ytd', 'last_n_days'];
function resolvePeriod(period, now) {
  if (!isDate(now)) fail('invalid_now', 'تاريخ اليوم غير صالح', 500);
  if (!period || typeof period !== 'object' || Array.isArray(period)) fail('invalid_period', 'حدد الفترة');
  const [y, m] = ymOf(now);
  if (period.preset !== undefined) {
    const q = Math.floor(m / 3) * 3;
    switch (period.preset) {
      case 'this_month': return { from: monthStart(y, m), to: monthEnd(y, m) };
      case 'mtd': return { from: monthStart(y, m), to: now };
      case 'last_month': return { from: monthStart(y, m - 1), to: monthEnd(y, m - 1) };
      case 'this_quarter': return { from: monthStart(y, q), to: monthEnd(y, q + 2) };
      case 'last_quarter': return { from: monthStart(y, q - 3), to: monthEnd(y, q - 1) };
      case 'this_year': return { from: `${y}-01-01`, to: `${y}-12-31` };
      case 'ytd': return { from: `${y}-01-01`, to: now };
      case 'last_year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
      case 'last_n_days': {
        const n = Number(period.n);
        if (!Number.isInteger(n) || n < 1 || n > 366) fail('invalid_period', 'عدد الأيام بين 1 و366');
        return { from: addDays(now, -(n - 1)), to: now };
      }
      default: fail('invalid_period', `فترة غير معروفة: ${String(period.preset).slice(0, 30)}`);
    }
  }
  const { from, to } = period;
  if (!isDate(from) || !isDate(to) || from > to) fail('invalid_period', 'الفترة غير صالحة');
  if (daysBetween(from, to) > 3700) fail('invalid_period', 'الفترة أطول من عشر سنوات');
  return { from, to };
}
// The comparison period: previous_year = the same dates a year earlier;
// previous_period = the same number of whole months before (when the
// period is whole months), else the same number of days just before.
function comparePeriod({ from, to }, mode) {
  if (!mode) return null;
  if (mode === 'previous_year') return { from: addMonths(from, -12), to: addMonths(to, -12) };
  const wholeMonths = from.slice(8) === '01' && to === monthEnd(...ymOf(to));
  if (wholeMonths) {
    const [fy, fm] = ymOf(from);
    const [ty, tm] = ymOf(to);
    const n = (ty - fy) * 12 + (tm - fm) + 1;
    return { from: addMonths(from, -n), to: monthEnd(...ymOf(addMonths(from, -1))) };
  }
  const n = daysBetween(from, to) + 1;
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------
const SPEC_KEYS = new Set(['source', 'measures', 'calcs', 'dimensions', 'filters', 'period', 'compare', 'sort', 'limit', 'includeClosing']);
const LIMITS = { measures: 10, calcs: 5, dimensions: 3, filters: 10, values: 200, rows: 5000, json: 10000 };
const isPlain = (o) => o && typeof o === 'object' && !Array.isArray(o);
const str = (v, max) => typeof v === 'string' && v.length <= max;

// Returns the normalized spec (period resolved). ctx: { companyId, permissions, now }.
function validate(input, ctx) {
  const acc = access(ctx.permissions);
  if (!acc.reports) fail('forbidden_reports', 'منشئ التقارير يحتاج صلاحية عرض التقارير المالية', 403);
  let spec = input;
  if (typeof spec === 'string') { try { spec = JSON.parse(spec); } catch { fail('invalid_spec', 'مواصفات التقرير ليست JSON صالحًا'); } }
  if (!isPlain(spec)) fail('invalid_spec', 'مواصفات التقرير غير صالحة');
  if (JSON.stringify(spec).length > LIMITS.json) fail('invalid_spec', 'مواصفات التقرير أكبر من المسموح');
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) fail('invalid_spec', `حقل غير معروف في المواصفات: ${String(k).slice(0, 30)}`);
  const src = Object.prototype.hasOwnProperty.call(CATALOG, spec.source) ? CATALOG[spec.source] : null;
  if (!src) fail('invalid_source', 'مصدر البيانات غير معروف');
  requireNeed(acc, src.needs, src.label_ar);

  const measures = spec.measures;
  if (!Array.isArray(measures) || !measures.length || measures.length > LIMITS.measures) fail('invalid_measures', `اختر من 1 إلى ${LIMITS.measures} مقاييس`);
  for (const m of measures) {
    if (typeof m !== 'string' || !Object.prototype.hasOwnProperty.call(src.measures, m)) fail('invalid_measure', `مقياس غير معروف: ${String(m).slice(0, 30)}`);
    requireNeed(acc, src.measures[m].needs, src.measures[m].label_ar);
  }
  if (new Set(measures).size !== measures.length) fail('invalid_measures', 'مقياس مكرر');

  const calcs = spec.calcs === undefined ? [] : spec.calcs;
  if (!Array.isArray(calcs) || calcs.length > LIMITS.calcs) fail('invalid_calcs', `حتى ${LIMITS.calcs} نسب محسوبة`);
  const names = new Set(measures);
  const outCalcs = calcs.map((c) => {
    if (!isPlain(c)) fail('invalid_calcs', 'نسبة محسوبة غير صالحة');
    for (const k of Object.keys(c)) if (!['key', 'label', 'expr', 'format'].includes(k)) fail('invalid_calcs', `حقل غير معروف في النسبة: ${String(k).slice(0, 30)}`);
    if (!str(c.key, 32) || !/^[a-z][a-z0-9_]*$/.test(c.key)) fail('invalid_calcs', 'اسم النسبة: أحرف لاتينية صغيرة وأرقام و_');
    if (names.has(c.key) || Object.prototype.hasOwnProperty.call(src.measures, c.key)) fail('invalid_calcs', `الاسم ${c.key} مستخدم`);
    const format = c.format || 'number';
    if (!['number', 'percent', 'money'].includes(format)) fail('invalid_calcs', 'تنسيق النسبة: number أو percent أو money');
    if (c.label !== undefined && !str(c.label, 60)) fail('invalid_calcs', 'عنوان النسبة حتى 60 حرفًا');
    E.parse(c.expr, measures); // reads the selected measures only
    names.add(c.key);
    return { key: c.key, label: c.label || c.key, expr: c.expr, format };
  });

  const dims = spec.dimensions === undefined ? [] : spec.dimensions;
  if (!Array.isArray(dims) || dims.length > LIMITS.dimensions) fail('invalid_dimensions', `حتى ${LIMITS.dimensions} أبعاد`);
  for (const k of dims) {
    if (typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(src.dims, k)) fail('invalid_dimension', `بُعد غير معروف: ${String(k).slice(0, 30)}`);
    requireNeed(acc, src.dims[k].needs, src.dims[k].label_ar);
  }
  if (new Set(dims).size !== dims.length) fail('invalid_dimensions', 'بُعد مكرر');

  const filters = spec.filters === undefined ? [] : spec.filters;
  if (!Array.isArray(filters) || filters.length > LIMITS.filters) fail('invalid_filters', `حتى ${LIMITS.filters} فلاتر`);
  const outFilters = filters.map((f) => {
    if (!isPlain(f)) fail('invalid_filters', 'فلتر غير صالح');
    for (const k of Object.keys(f)) if (!['dim', 'op', 'values'].includes(k)) fail('invalid_filters', `حقل غير معروف في الفلتر: ${String(k).slice(0, 30)}`);
    if (typeof f.dim !== 'string' || !Object.prototype.hasOwnProperty.call(src.dims, f.dim)) fail('invalid_filters', `فلتر على بُعد غير معروف: ${String(f.dim).slice(0, 30)}`);
    const dim = src.dims[f.dim];
    requireNeed(acc, dim.needs, dim.label_ar);
    const op = f.op || 'in';
    if (!['in', 'not_in'].includes(op)) fail('invalid_filters', 'العملية: in أو not_in');
    if (!Array.isArray(f.values) || !f.values.length || f.values.length > LIMITS.values) fail('invalid_filters', `قيم الفلتر من 1 إلى ${LIMITS.values}`);
    const values = f.values.map((v) => {
      if (v === null) return null;
      if (dim.text) { if (!str(v, 100)) fail('invalid_filters', 'قيمة فلتر غير صالحة'); return v; }
      const id = Number(v);
      if (!Number.isInteger(id) || id <= 0) fail('invalid_filters', 'معرّف غير صالح في الفلتر');
      refs().requireOwned(ctx.companyId, dim.kind, id); // a foreign id is refused like a missing one
      return id;
    });
    return { dim: f.dim, op, values };
  });

  const period = resolvePeriod(spec.period, ctx.now);
  const compare = spec.compare === undefined || spec.compare === null ? null : spec.compare;
  if (compare !== null && !['previous_period', 'previous_year'].includes(compare)) fail('invalid_compare', 'المقارنة: previous_period أو previous_year');

  let sort = null;
  if (spec.sort !== undefined && spec.sort !== null) {
    if (!isPlain(spec.sort)) fail('invalid_sort', 'ترتيب غير صالح');
    const by = spec.sort.by;
    if (typeof by !== 'string' || !(names.has(by) || dims.includes(by))) fail('invalid_sort', 'الترتيب يكون على مقياس أو نسبة أو بُعد مختار');
    const dir = spec.sort.dir === 'asc' ? 'asc' : spec.sort.dir === undefined || spec.sort.dir === 'desc' ? 'desc' : fail('invalid_sort', 'اتجاه الترتيب asc أو desc');
    sort = { by, dir };
  }
  const limit = spec.limit === undefined || spec.limit === null ? 1000 : Number(spec.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.rows) fail('invalid_limit', `عدد الصفوف من 1 إلى ${LIMITS.rows}`);
  if (spec.includeClosing !== undefined && typeof spec.includeClosing !== 'boolean') fail('invalid_spec', 'includeClosing: true أو false');
  if (spec.includeClosing && !src.closing) fail('invalid_spec', 'قيود الإقفال تخص مصدر القيود فقط');

  return {
    source: spec.source, measures: [...measures], calcs: outCalcs, dimensions: [...dims], filters: outFilters,
    period: spec.period.preset !== undefined ? { preset: spec.period.preset, ...(spec.period.n !== undefined ? { n: Number(spec.period.n) } : {}) } : { from: period.from, to: period.to },
    resolved: { ...period, compare: comparePeriod(period, compare) },
    compare, sort, limit, includeClosing: !!spec.includeClosing,
    needs: [...specNeeds({ source: spec.source, measures, dimensions: dims, filters: outFilters })].sort(),
  };
}

// ---------------------------------------------------------------------
// Execution (pure; dbh may be read-only)
// ---------------------------------------------------------------------
function whereFor(src, spec, cid, { from, to }) {
  const where = ['company_id = ?'];
  const args = [cid];
  if (src.monthly) { where.push(`${src.date} BETWEEN ? AND ?`); args.push(from.slice(0, 7), to.slice(0, 7)); } else { where.push(`${src.date} BETWEEN ? AND ?`); args.push(from, to); }
  if (src.closing && !spec.includeClosing) where.push('is_closing = 0');
  for (const f of spec.filters) {
    const col = src.dims[f.dim].col;
    const vals = f.values.filter((v) => v !== null);
    const hasNull = vals.length !== f.values.length;
    const list = vals.map(() => '?').join(', ');
    if (f.op === 'in') {
      // in: the listed values, and NULL rows when null is listed.
      const parts = [];
      if (vals.length) { parts.push(`${col} IN (${list})`); args.push(...vals); }
      if (hasNull) parts.push(`${col} IS NULL`);
      where.push(`(${parts.join(' OR ')})`);
    } else if (hasNull) {
      // not_in with null: neither the listed values nor NULL.
      where.push(vals.length ? `(${col} NOT IN (${list}) AND ${col} IS NOT NULL)` : `${col} IS NOT NULL`);
      args.push(...vals);
    } else {
      // not_in without null: SQL's NOT IN drops NULL rows; keep them.
      where.push(`(${col} NOT IN (${list}) OR ${col} IS NULL)`);
      args.push(...vals);
    }
  }
  return { sql: where.join(' AND '), args };
}

function aggregate(dbh, src, spec, cid, period, grouped) {
  const dimCols = grouped ? spec.dimensions.map((k) => src.dims[k].col) : [];
  const sel = [...dimCols.map((c, i) => `${c} AS d${i}`), ...spec.measures.map((m, i) => `${src.measures[m].sql} AS m${i}`)];
  const w = whereFor(src, spec, cid, period);
  const sql = `SELECT ${sel.join(', ')} FROM ${src.table} WHERE ${w.sql}${dimCols.length ? ` GROUP BY ${dimCols.join(', ')}` : ''}`;
  return dbh.prepare(sql).all(...w.args);
}

const round4 = (v) => (v === null ? null : Math.round(v * 10000) / 10000);
function withCalcs(spec, values) {
  const out = { ...values };
  for (const c of spec.calcs) {
    const v = E.evaluate(E.parse(c.expr, spec.measures), values);
    out[c.key] = v === null ? null : c.format === 'money' ? Math.round(v) : round4(v);
  }
  return out;
}
const change = (cur, prev) => (cur === null || prev === null || cur === undefined || prev === undefined ? null : cur - prev);
const changePct = (cur, prev) => (cur === null || prev === null || prev === undefined || prev === 0 ? null : round4(((cur - prev) / Math.abs(prev)) * 100));

function columnsFor(src, spec) {
  const cols = spec.dimensions.map((k) => ({ key: k, role: 'dimension', type: 'text', label_ar: src.dims[k].label_ar, label_en: src.dims[k].label_en }));
  const valueCols = [
    ...spec.measures.map((m) => ({ key: m, role: 'measure', type: src.measures[m].type, label_ar: src.measures[m].label_ar, label_en: src.measures[m].label_en })),
    ...spec.calcs.map((c) => ({ key: c.key, role: 'calc', type: c.format, label_ar: c.label, label_en: c.label })),
  ];
  for (const v of valueCols) {
    cols.push(v);
    if (spec.compare) {
      cols.push({ key: `${v.key}__cmp`, role: 'compare', type: v.type, label_ar: `${v.label_ar} (المقارنة)`, label_en: `${v.label_en} (compare)` });
      cols.push({ key: `${v.key}__chg`, role: 'change', type: v.type === 'percent' ? 'number' : v.type, label_ar: `${v.label_ar} (الفرق)`, label_en: `${v.label_en} (change)` });
      cols.push({ key: `${v.key}__pct`, role: 'change_pct', type: 'percent', label_ar: `${v.label_ar} (التغير %)`, label_en: `${v.label_en} (change %)` });
    }
  }
  return cols;
}

function execute(dbh, cid, spec) {
  const src = CATALOG[spec.source];
  if (!src) fail('invalid_source', 'مصدر البيانات غير معروف');
  const { from, to, compare: cmp } = spec.resolved;
  const keyOf = (r) => JSON.stringify(spec.dimensions.map((_, i) => r[`d${i}`] ?? null));
  const valuesOf = (r) => Object.fromEntries(spec.measures.map((m, i) => [m, r ? r[`m${i}`] : 0]));
  const cur = new Map(aggregate(dbh, src, spec, cid, { from, to }, true).map((r) => [keyOf(r), r]));
  const prev = cmp ? new Map(aggregate(dbh, src, spec, cid, cmp, true).map((r) => [keyOf(r), r])) : new Map();
  const keys = [...new Set([...cur.keys(), ...prev.keys()])];
  const valueKeys = [...spec.measures, ...spec.calcs.map((c) => c.key)];
  const build = (curRow, prevRow) => {
    const now = withCalcs(spec, valuesOf(curRow));
    const out = { ...now };
    if (cmp) {
      const was = withCalcs(spec, valuesOf(prevRow));
      for (const k of valueKeys) { out[`${k}__cmp`] = was[k]; out[`${k}__chg`] = change(now[k], was[k]); out[`${k}__pct`] = changePct(now[k], was[k]); }
    }
    return out;
  };
  let rows = keys.map((k) => {
    const dimVals = JSON.parse(k);
    const row = {};
    spec.dimensions.forEach((dk, i) => {
      const dim = src.dims[dk];
      const v = dimVals[i];
      row[`${dk}__id`] = v;
      row[dk] = dim.text ? (v ?? '—') : label(dbh, dim.labelAs, v);
    });
    Object.assign(row, build(cur.get(k), prev.get(k)));
    const filters = Object.fromEntries(spec.dimensions.map((dk, i) => [src.dims[dk].col, dimVals[i]]));
    row.drill = { kind: 'builder', source: spec.source, filters: { ...filters, from: src.monthly ? from.slice(0, 7) : from, to: src.monthly ? to.slice(0, 7) : to } };
    return row;
  });
  const sortBy = spec.sort?.by || valueKeys[0];
  const dir = spec.sort?.dir === 'asc' ? 1 : -1;
  const isDimSort = spec.dimensions.includes(sortBy);
  rows.sort((a, b) => {
    const x = a[sortBy]; const y = b[sortBy];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (isDimSort ? String(x).localeCompare(String(y), 'ar') : x - y) * dir;
  });
  const total = rows.length;
  const truncated = total > spec.limit;
  rows = rows.slice(0, spec.limit);
  // Totals from an ungrouped query (COUNT DISTINCT is not additive over rows).
  const tCur = aggregate(dbh, src, spec, cid, { from, to }, false)[0];
  const tPrev = cmp ? aggregate(dbh, src, spec, cid, cmp, false)[0] : null;
  const totals = build(tCur, tPrev);
  return {
    source: spec.source, label_ar: src.label_ar, label_en: src.label_en,
    period: { from, to }, compare_period: cmp, columns: columnsFor(src, spec), rows, totals, row_count: total, truncated,
  };
}

// Fact rows behind a builder row (the builder's own drill: cost and
// payroll columns removed for users without those permissions).
function drill(dbh, cid, { source, filters }, permissions) {
  const acc = access(permissions);
  if (!acc.reports) fail('forbidden_reports', 'يحتاج صلاحية عرض التقارير المالية', 403);
  const src = Object.prototype.hasOwnProperty.call(CATALOG, source) ? CATALOG[source] : null;
  if (!src) fail('invalid_source', 'مصدر البيانات غير معروف');
  requireNeed(acc, src.needs, src.label_ar);
  if (!isPlain(filters)) fail('invalid_filters', 'فلاتر غير صالحة');
  const byCol = Object.fromEntries(Object.entries(src.dims).map(([k, x]) => [x.col, { key: k, ...x }]));
  const where = ['company_id = ?'];
  const args = [cid];
  for (const [col, v] of Object.entries(filters)) {
    if (col === 'from' || col === 'to') {
      const ok = src.monthly ? /^\d{4}-\d{2}$/.test(String(v)) : isDate(String(v));
      if (!ok) fail('invalid_filters', 'تاريخ غير صالح');
      where.push(`${src.date} ${col === 'from' ? '>=' : '<='} ?`); args.push(String(v)); continue;
    }
    const dim = byCol[col];
    if (!dim) fail('invalid_filters', `فلتر غير مدعوم: ${String(col).slice(0, 30)}`);
    requireNeed(acc, dim.needs, dim.label_ar);
    if (v === null) { where.push(`${col} IS NULL`); continue; }
    if (dim.text) { if (!str(v, 100)) fail('invalid_filters', 'قيمة غير صالحة'); } else { refs().requireOwned(cid, dim.kind, Number(v)); }
    where.push(`${col} = ?`); args.push(v);
  }
  const cap = 1000;
  const rows = dbh.prepare(`SELECT * FROM ${src.table} WHERE ${where.join(' AND ')} ORDER BY ${src.date}, rowid LIMIT ${cap + 1}`).all(...args).map((r) => {
    const o = { ...r };
    if (!acc.costs) for (const c of COST_COLUMNS[src.table] || []) delete o[c];
    if (!acc.payroll) for (const c of PAYROLL_COLUMNS[src.table] || []) delete o[c];
    return o;
  });
  return { source, rows: rows.slice(0, cap), truncated: rows.length > cap };
}

module.exports = { CATALOG, PAYROLL_PERMS, COSTS_PERM, REPORTS_PERM, access, specNeeds, catalogFor, validate, execute, drill, resolvePeriod, comparePeriod, addMonths };
