// backend/test/fixtures/taxScenario.js
//
// Golden scenario of the EXISTING tax and month-end behaviour, recorded
// BEFORE Prompt 10 (tax codes, fixed assets, accruals) touched any code:
// sales invoices with a free per-line tax rate (tax added on top of the
// price), a zero-rate line, a discount, a credit note, a supplier expense
// invoice with input tax, their entries (output / input tax accounts),
// the trial balance and the month-end checklist. A company with no tax
// codes must keep behaving exactly like this.

const { openLiveDb } = require('../liveDb');
const { normalize: baseNormalize } = require('./legacyScenario');

// Date-derived values are normalized so the golden does not depend on the
// clock: ISO dates inside strings (checklist links) and the month-end
// period's id / number (which month of the year the run happens in).
const normalize = (v) => {
  const out = JSON.parse(JSON.stringify(baseNormalize(v)), (k, x) => (k === 'public_token' ? '<TOKEN>' : k === 'backup_path' ? '<BACKUP_PATH>' : typeof x === 'string' ? x.replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>') : x));
  const p = out.steps?.month_end_checklist?.body?.period;
  if (p) Object.assign(p, { id: '<PERIOD_ID>', number: '<PERIOD_NO>' });
  return out;
};

async function runTaxScenario({ manager, dbPath, companyId, h }) {
  const steps = {};
  const s = (name, r) => { if (process.env.TAX_DEBUG) console.error('step', name, r.status, r.status >= 400 ? JSON.stringify(r.body) : ''); steps[name] = { status: r.status, body: r.body }; return r.body; };
  const { accounts } = await h.setupLedger(manager);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  s('go_live', (await h.goLive(manager, h.TODAY)).res);
  const shop = await h.mkShop(manager, 'زبون الضريبة');
  const inv = s('invoice_create', await manager.post('/api/sales/invoices', { shopId: shop, invoiceDate: h.TODAY, lines: [
    { description: 'خدمة خاضعة', qty: 3, unitPrice: '10.00', taxRate: '15' },
    { description: 'مادة معفاة', qty: 1, unitPrice: '7.33', taxRate: '0' },
    { description: 'خدمة بنسبة كسرية', qty: 7, unitPrice: '1.11', taxRate: '7.5', discount: '0.50' },
  ] }));
  const posted = s('invoice_post', await manager.post(`/api/sales/invoices/${inv.id}/post`, {}));
  s('invoice_bad_rate', await manager.post('/api/sales/invoices', { shopId: shop, invoiceDate: h.TODAY, lines: [{ description: 'x', qty: 1, unitPrice: '1', taxRate: '150' }] }));
  s('credit_note', await manager.post('/api/sales/credit-notes', { invoiceId: inv.id, lines: [{ invoiceLineId: posted.lines[0].id, qty: 1 }] }));
  const supplier = s('supplier', await manager.post('/api/purchasing/suppliers', { name: 'مورد الضريبة', currencyCode: 'USD' }));
  const rent = accounts.find((a) => a.type === 'expense' && a.is_postable && !a.system_key).id;
  const exp = s('expense_invoice', await manager.post('/api/purchasing/invoices', { kind: 'expense', supplierId: supplier.id, invoiceDate: h.TODAY, lines: [{ description: 'إيجار', qty: 1, unitPrice: '300', taxRate: '5', expenseAccountId: rent }, { description: 'كهرباء', qty: 2, unitPrice: '12.35', taxRate: '0', expenseAccountId: rent }] }));
  s('expense_post', await manager.post(`/api/purchasing/invoices/${exp.id}/post`, {}));
  s('trial_balance', await manager.get(`/api/financial-reports/trial-balance?asOf=${h.TODAY}`));
  const db = openLiveDb(dbPath);
  const period = db.prepare('SELECT id FROM fiscal_periods WHERE company_id = ? AND start_date <= ? AND end_date >= ?').get(companyId, h.TODAY, h.TODAY);
  s('month_end_checklist', await manager.get(`/api/financial-reports/month-end/${period.id}`));
  const q = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
  const tables = {
    sales_invoices: q('SELECT invoice_number, status, subtotal_minor, discount_minor, tax_minor, rounding_minor, total_minor FROM sales_invoices WHERE company_id = ? ORDER BY id', companyId),
    sales_invoice_lines: q('SELECT l.line_no, l.qty, l.unit_price_minor, l.discount_minor, l.tax_rate_bp, l.net_minor, l.tax_minor FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id WHERE i.company_id = ? ORDER BY l.id', companyId),
    credit_notes: q('SELECT subtotal_minor, tax_minor, rounding_minor, total_minor FROM sales_credit_notes WHERE company_id = ? ORDER BY id', companyId),
    supplier_invoices: q('SELECT kind, status, subtotal_minor, tax_minor, total_minor FROM supplier_invoices WHERE company_id = ? ORDER BY id', companyId),
    supplier_invoice_lines: q('SELECT l.line_no, l.qty, l.unit_price_minor, l.tax_rate_bp FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id WHERE i.company_id = ? ORDER BY l.id', companyId),
    journal_lines: q(`SELECT e.source_type, a.code, a.system_key, l.debit_minor, l.credit_minor FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = ? AND e.source_type IN ('sales_invoice', 'sales_credit_note', 'supplier_invoice') ORDER BY e.id, l.line_no`, companyId),
    tax_accounts: q("SELECT a.system_key, COALESCE(SUM(l.debit_minor - l.credit_minor), 0) balance FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id WHERE a.company_id = ? AND a.system_key IN ('output_tax', 'input_tax') GROUP BY a.id ORDER BY a.system_key", companyId),
  };
  db.close();
  void acc;
  return normalize({ steps, tables });
}

module.exports = { runTaxScenario };
