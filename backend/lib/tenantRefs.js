// backend/lib/tenantRefs.js
//
// THE one place that checks a client-supplied id belongs to the caller's
// company. Every create/update endpoint resolves foreign keys it receives
// from the request (account, cost center, project, branch, party, shop,
// product, warehouse, vehicle, user ...) through requireOwned() before
// using them. An id from another company is reported exactly like an id
// that does not exist, so the response never confirms that it exists.

const db = require('../db/init');

// kind -> { table, active: SQL predicate for "usable on new records", label }
const REFS = {
  account: { table: 'accounts', active: 'is_active = 1', label: 'الحساب' },
  cost_center: { table: 'cost_centers', active: 'is_active = 1', label: 'مركز الكلفة' },
  project: { table: 'projects', active: 'is_active = 1', label: 'المشروع' },
  branch: { table: 'branches_ref', active: 'is_active = 1', label: 'الفرع' },
  journal_entry: { table: 'journal_entries', active: null, label: 'القيد' },
  journal_attachment: { table: 'journal_attachments', active: null, label: 'المرفق' },
  fiscal_period: { table: 'fiscal_periods', active: null, label: 'الفترة المالية' },
  fiscal_year: { table: 'fiscal_years', active: null, label: 'السنة المالية' },
  shop: { table: 'shops', active: 'active = 1', label: 'الزبون' },
  product: { table: 'products', active: 'active = 1', label: 'المادة' },
  warehouse: { table: 'warehouses', active: null, label: 'المستودع' },
  vehicle: { table: 'vehicles', active: null, label: 'السيارة' },
  user: { table: 'users', active: "status = 'approved'", label: 'المستخدم' },
  order: { table: 'orders', active: 'deleted_at IS NULL', label: 'الطلب' },
  sales_invoice: { table: 'sales_invoices', active: null, label: 'الفاتورة' },
  collection: { table: 'collections', active: null, label: 'القبض' },
  return_request: { table: 'return_requests', active: null, label: 'طلب المرتجع' },
  // Prompt 6: purchasing
  supplier: { table: 'suppliers', active: 'is_active = 1', label: 'المورد' },
  purchase_request: { table: 'purchase_requests', active: null, label: 'طلب الشراء' },
  supplier_quotation: { table: 'supplier_quotations', active: null, label: 'عرض السعر' },
  purchase_order: { table: 'purchase_orders', active: null, label: 'أمر الشراء' },
  goods_receipt: { table: 'goods_receipts', active: null, label: 'سند الاستلام' },
  supplier_invoice: { table: 'supplier_invoices', active: null, label: 'فاتورة المورد' },
  supplier_payment: { table: 'supplier_payments', active: null, label: 'سند الدفع' },
  supplier_debit_note: { table: 'supplier_debit_notes', active: null, label: 'إشعار المدين' },
  // Prompt 7: treasury
  cash_box: { table: 'cash_boxes', active: 'is_active = 1', label: 'الصندوق / الحساب البنكي' },
  treasury_voucher: { table: 'treasury_vouchers', active: null, label: 'السند' },
  cheque_issued: { table: 'cheques_issued', active: null, label: 'الشيك الصادر' },
  cheque_received: { table: 'cheques_received', active: null, label: 'الشيك الوارد' },
  bank_statement: { table: 'bank_statements', active: null, label: 'كشف البنك' },
  bank_statement_line: { table: 'bank_statement_lines', active: null, label: 'سطر كشف البنك' },
  journal_line: { table: 'journal_lines', active: null, label: 'سطر القيد' },
  rep_cash_handover: { table: 'rep_cash_handovers', active: null, label: 'سند تسليم النقدية' },
};

// Ledger party types map onto the tables that hold them.
const PARTY_KINDS = { customer: 'shop', employee: 'user', supplier: 'supplier' };

class ForeignRefError extends Error {
  constructor(kind, label) {
    super(`${label} غير موجود أو لا يتبع لهذه الشركة`);
    this.code = `invalid_${kind}`;
    this.status = 400;
  }
}

function idOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Returns the row (scoped to companyId) or throws ForeignRefError.
// { active: true } additionally requires the row to be usable for new records.
function requireOwned(companyId, kind, id, { active = false } = {}) {
  const ref = REFS[kind];
  if (!ref) throw new Error(`unknown ref kind ${kind}`);
  const n = idOf(id);
  if (!companyId || !n) throw new ForeignRefError(kind, ref.label);
  const row = db.prepare(`SELECT * FROM ${ref.table} WHERE id = ? AND company_id = ?`).get(n, companyId);
  if (!row) throw new ForeignRefError(kind, ref.label);
  if (active && ref.active && !db.prepare(`SELECT 1 FROM ${ref.table} WHERE id = ? AND ${ref.active}`).get(n)) {
    throw new ForeignRefError(kind, ref.label);
  }
  return row;
}

// Null/empty stays null; anything else must be owned.
function optionalOwned(companyId, kind, id, opts) {
  if (id === null || id === undefined || id === '') return null;
  return requireOwned(companyId, kind, id, opts);
}

function requireParty(companyId, partyType, partyId) {
  if (!partyType) return { partyType: null, partyId: null };
  const kind = PARTY_KINDS[partyType];
  if (!kind) {
    const err = new ForeignRefError('party', 'نوع الطرف');
    throw err;
  }
  const row = requireOwned(companyId, kind, partyId);
  return { partyType, partyId: row.id };
}

module.exports = { REFS, PARTY_KINDS, ForeignRefError, requireOwned, optionalOwned, requireParty };
