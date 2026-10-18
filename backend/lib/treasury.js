// backend/lib/treasury.js
//
// Treasury (Prompt 7):
//  - cash boxes and bank accounts, each on its own ledger account with its
//    own currency, and per-user access (cash_box_users);
//  - vouchers: RV receipt, PV payment, EV expense, TR transfer (cross-
//    currency on the Prompt 5 rates, difference -> fx_realized), BF bank
//    fee (the bank fees log). Draft -> approved (posts) -> reversed, with
//    the purchasing separation-of-duties setting (creator cannot approve);
//  - cheques issued (issued -> in_transit -> cleared | bounced, or
//    cancelled) — to a supplier they ARE a supplier payment credited to
//    cheques_payable; clearing moves cheques_payable to the bank box;
//  - received cheques (lib/receivables.js) clear into a chosen bank box;
//  - rep cash handover per currency (rep_cash_custody -> cash box, over /
//    short -> cash_over_short, rate difference -> fx_realized);
//  - daily cash report per box, due-cheques alert sweep;
//  - bank statements, auto-match with confidence, manual review,
//    reconciliation report.
// Every client id goes through lib/tenantRefs.js (P.owned). Ledger rows are
// written only through lib/ledger.js.

const db = require('../db/init');
const ledger = require('./ledger');
const P = require('./purchasing');
const pay = require('./payables');
const { logAudit } = require('./auditLog');
const { toMinor, fromMinor } = require('./ledgerCurrencies');
const { checkpoint } = require('./faultInjection');
const { createNotification, hasUnreadNotification } = require('./notify');

const { fail, owned, optionalOwned } = P;
const today = () => new Date().toISOString().slice(0, 10);
const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const sysAcc = (companyId, key) => P.systemAccount(companyId, key);

const VOUCHER_PREFIX = { receipt: ['RV', 'RV-'], payment: ['PV', 'PV-'], expense: ['EV', 'EV-'], transfer: ['TR', 'TR-'], bank_fee: ['BF', 'BF-'] };
// Accounts a voucher may not hit directly: their sub-ledgers need their own
// documents (customer receipt, supplier payment, cheque, handover ...).
const VOUCHER_BLOCKED_KEYS = {
  ar_control: 'استخدم سند قبض الزبائن من شاشة الذمم المدينة',
  ap_control: 'استخدم دفعة المورد من شاشة المشتريات',
  grni: 'يتحرك مع استلام البضاعة وفواتير الموردين فقط',
  inventory: 'يتحرك مع المخزون والمشتريات فقط',
  cheques_in_portfolio: 'استخدم شاشة الشيكات الواردة',
  cheques_payable: 'استخدم شاشة الشيكات الصادرة',
  rep_cash_custody: 'استخدم تسليم نقدية المندوب',
  input_tax: 'أدخل الضريبة في حقل الضريبة بسند المصاريف',
  output_tax: 'تتحرك مع فواتير المبيعات فقط',
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function fxl(companyId, code, original, rate) {
  if (code === P.base(companyId).code) return {};
  return { currencyCode: code, amountOriginalMinor: original, rateE8: rate.rateE8, rateQuote: rate.quote };
}
function rateFor(companyId, code, date, override, actor) {
  return P.docRate(companyId, code, date, override || {}, actor);
}
function digitsOf(companyId, code) {
  return P.currencyOf(companyId, code).minor_unit_digits;
}
function money(companyId, code, minor) {
  return `${fromMinor(minor, digitsOf(companyId, code))} ${code}`;
}
const hasPerm = (actor, perm) => Array.isArray(actor?.permissions) && actor.permissions.includes(perm);

// ---------------------------------------------------------------------
// Cash boxes
// ---------------------------------------------------------------------

// The main cash box sits on the existing cash_default account (base
// currency), created on first use so existing postings show in it.
function ensureMainBox(companyId) {
  if (db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND is_main = 1').get(companyId)) return;
  const acc = ledger.getAccountBySystemKey(companyId, 'cash_default');
  if (!acc) return;
  if (db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND account_id = ?').get(companyId, acc.id)) return;
  let name = 'الصندوق الرئيسي';
  if (db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND name = ?').get(companyId, name)) name = `${name} (${acc.code})`;
  db.prepare("INSERT INTO cash_boxes (company_id, name, kind, currency_code, account_id, is_main) VALUES (?, ?, 'cash', ?, ?, 1)").run(companyId, name, P.base(companyId).code, acc.id);
}

function boxBalance(companyId, box, asOf) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) base,
              COALESCE(SUM(CASE WHEN l.currency_code = ? THEN (CASE WHEN l.debit_minor > 0 THEN l.amount_original_minor ELSE -l.amount_original_minor END) ELSE 0 END), 0) orig
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? ${asOf ? 'AND e.entry_date <= ?' : ''}`
    )
    .get(...[box.currency_code, companyId, box.account_id, ...(asOf ? [asOf] : [])]);
  const isBase = box.currency_code === P.base(companyId).code;
  return { base_minor: r.base, balance_minor: isBase ? r.base : r.orig };
}

function decorateBox(companyId, box) {
  const acc = ledger.getAccount(companyId, box.account_id);
  const users = db.prepare('SELECT u.id, u.name FROM cash_box_users cu JOIN users u ON u.id = cu.user_id WHERE cu.cash_box_id = ? ORDER BY u.name').all(box.id);
  return { ...box, account_code: acc?.code, account_name: acc?.name_ar, digits: digitsOf(companyId, box.currency_code), users, ...boxBalance(companyId, box) };
}

function canUseBox(companyId, box, actor) {
  if (!actor) return true; // internal / system calls
  if (hasPerm(actor, 'manage_cash_boxes')) return true;
  return Boolean(db.prepare('SELECT 1 FROM cash_box_users WHERE cash_box_id = ? AND user_id = ?').get(box.id, actor.id));
}
function usableBox(companyId, id, actor, { kind } = {}) {
  const box = owned(companyId, 'cash_box', id, { active: true });
  if (!canUseBox(companyId, box, actor)) fail('cash_box_access_denied', `ليست لديك صلاحية على ${box.name}`, 403);
  if (kind && box.kind !== kind) fail('wrong_box_kind', kind === 'bank' ? `${box.name} ليس حسابًا بنكيًا` : `${box.name} ليس صندوقًا نقديًا`);
  return box;
}

function listBoxes(companyId, actor, { includeInactive } = {}) {
  ensureMainBox(companyId);
  const rows = db.prepare(`SELECT * FROM cash_boxes WHERE company_id = ? ${includeInactive ? '' : 'AND is_active = 1'} ORDER BY is_main DESC, kind, name`).all(companyId);
  return rows.filter((b) => canUseBox(companyId, b, actor)).map((b) => decorateBox(companyId, b));
}
function getBox(companyId, id, actor) {
  ensureMainBox(companyId);
  const box = owned(companyId, 'cash_box', id);
  if (!canUseBox(companyId, box, actor)) fail('cash_box_access_denied', `ليست لديك صلاحية على ${box.name}`, 403);
  return decorateBox(companyId, box);
}

function nextCode(companyId, start) {
  let n = Number(start);
  while (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?').get(companyId, String(n))) n += 1;
  return String(n);
}

// input: { name, kind, currencyCode, accountId? (existing asset account),
//          bankName?, accountNumber?, iban?, notes?, userIds? }
function createBox(companyId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    ensureMainBox(companyId);
    const name = String(input.name || '').trim();
    if (!name) fail('name_required', 'اسم الصندوق مطلوب');
    if (db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND name = ?').get(companyId, name)) fail('duplicate_name', 'يوجد صندوق بهذا الاسم', 409);
    const kind = input.kind === 'bank' ? 'bank' : input.kind === 'cash' || !input.kind ? 'cash' : fail('invalid_kind', 'النوع غير صالح');
    const cur = P.currencyOf(companyId, input.currencyCode);
    const isBase = cur.code === P.base(companyId).code;
    let account;
    if (input.accountId) {
      account = owned(companyId, 'account', input.accountId, { active: true });
      if (account.type !== 'asset' || !account.is_postable) fail('invalid_box_account', 'حساب الصندوق يجب أن يكون حساب أصول فرعيًا يقبل الترحيل');
      if (account.system_key && account.system_key !== 'cash_default' && account.system_key !== 'bank_in_transit') fail('invalid_box_account', `الحساب ${account.code} حساب نظامي لا يُستخدم صندوقًا`);
      if (db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND account_id = ?').get(companyId, account.id)) fail('account_in_use', 'هذا الحساب مرتبط بصندوق آخر', 409);
      if (account.currency_code && account.currency_code !== cur.code) fail('currency_mismatch', `الحساب ${account.code} بعملة ${account.currency_code}`);
      if (!isBase && !account.currency_code) {
        const other = db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? AND currency_code <> ? LIMIT 1').get(account.id, cur.code);
        if (other) fail('currency_mismatch', `على الحساب ${account.code} قيود بعملة أخرى — اختر حسابًا جديدًا`);
        ledger.updateAccount(companyId, account.id, { currencyCode: cur.code }, actor);
      }
    } else {
      // New ledger account: banks under 1120 when it is a header (or empty),
      // cash boxes (and banks otherwise) under 11.
      const parent11 = db.prepare("SELECT * FROM accounts WHERE company_id = ? AND code = '11' AND type = 'asset'").get(companyId);
      const banks = db.prepare("SELECT * FROM accounts WHERE company_id = ? AND code = '1120' AND type = 'asset'").get(companyId);
      const banksUsable = banks && banks.is_active && !(banks.is_postable && db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(banks.id));
      const parent = kind === 'bank' && banksUsable ? banks : parent11;
      account = ledger.createAccount(companyId, {
        code: nextCode(companyId, parent?.code === '1120' ? 1121 : kind === 'bank' ? 1121 : 1111),
        nameAr: name, nameEn: input.nameEn || null, parentId: parent?.id, type: 'asset', currencyCode: isBase ? null : cur.code, reportClass: 'cash',
      }, actor);
    }
    const id = Number(
      db.prepare('INSERT INTO cash_boxes (company_id, name, kind, currency_code, account_id, bank_name, account_number, iban, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, name, kind, cur.code, account.id, input.bankName || null, input.accountNumber || null, input.iban || null, input.notes || null, actor?.id ?? null).lastInsertRowid
    );
    if (Array.isArray(input.userIds)) setBoxUsersTx(companyId, id, input.userIds);
    const box = decorateBox(companyId, db.prepare('SELECT * FROM cash_boxes WHERE id = ?').get(id));
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.box.create', entityType: 'cash_box', entityId: id, before: null, after: box });
    return box;
  });
}

function setBoxUsersTx(companyId, boxId, userIds) {
  db.prepare('DELETE FROM cash_box_users WHERE cash_box_id = ?').run(boxId);
  const ins = db.prepare('INSERT OR IGNORE INTO cash_box_users (cash_box_id, user_id, company_id) VALUES (?, ?, ?)');
  for (const u of userIds) ins.run(boxId, owned(companyId, 'user', u).id, companyId);
}

function updateBox(companyId, id, input, actor) {
  return ledger.transaction(() => {
    const box = owned(companyId, 'cash_box', id);
    const before = decorateBox(companyId, box);
    const name = input.name !== undefined ? String(input.name || '').trim() : box.name;
    if (!name) fail('name_required', 'اسم الصندوق مطلوب');
    if (name !== box.name && db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND name = ? AND id <> ?').get(companyId, name, box.id)) fail('duplicate_name', 'يوجد صندوق بهذا الاسم', 409);
    const active = input.isActive !== undefined ? (input.isActive ? 1 : 0) : box.is_active;
    if (!active && box.is_main) fail('main_box_required', 'لا يمكن إيقاف الصندوق الرئيسي', 409);
    if (!active && boxBalance(companyId, box).base_minor !== 0) fail('box_not_empty', 'رصيد الصندوق ليس صفرًا — حوّل رصيده أولًا', 409);
    db.prepare("UPDATE cash_boxes SET name = ?, bank_name = ?, account_number = ?, iban = ?, notes = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, input.bankName !== undefined ? input.bankName || null : box.bank_name, input.accountNumber !== undefined ? input.accountNumber || null : box.account_number, input.iban !== undefined ? input.iban || null : box.iban, input.notes !== undefined ? input.notes || null : box.notes, active, box.id);
    if (Array.isArray(input.userIds)) setBoxUsersTx(companyId, box.id, input.userIds);
    const after = decorateBox(companyId, db.prepare('SELECT * FROM cash_boxes WHERE id = ?').get(box.id));
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.box.update', entityType: 'cash_box', entityId: box.id, before, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------

function decorateVoucher(companyId, v) {
  const box = db.prepare('SELECT name, currency_code FROM cash_boxes WHERE id = ?').get(v.cash_box_id);
  const to = v.to_cash_box_id ? db.prepare('SELECT name, currency_code FROM cash_boxes WHERE id = ?').get(v.to_cash_box_id) : null;
  const acc = v.counter_account_id ? ledger.getAccount(companyId, v.counter_account_id) : null;
  const users = db.prepare('SELECT id, name FROM users WHERE id IN (?, ?)').all(v.created_by ?? 0, v.approved_by ?? 0);
  const nameOf = (uid) => users.find((u) => u.id === uid)?.name || null;
  return {
    ...v, cash_box_name: box?.name, to_cash_box_name: to?.name, counter_account_code: acc?.code, counter_account_name: acc?.name_ar,
    digits: digitsOf(companyId, v.currency_code), to_digits: v.to_currency_code ? digitsOf(companyId, v.to_currency_code) : null,
    created_by_name: nameOf(v.created_by), approved_by_name: nameOf(v.approved_by),
  };
}
function getVoucher(companyId, id) {
  return decorateVoucher(companyId, owned(companyId, 'treasury_voucher', id));
}
function listVouchers(companyId, actor, { status, type, cashBoxId, from, to } = {}) {
  const where = ['v.company_id = ?'];
  const p = [companyId];
  if (status) { where.push('v.status = ?'); p.push(String(status)); }
  if (type) { where.push('v.type = ?'); p.push(String(type)); }
  if (cashBoxId) { where.push('(v.cash_box_id = ? OR v.to_cash_box_id = ?)'); p.push(Number(cashBoxId), Number(cashBoxId)); }
  if (from) { where.push('v.voucher_date >= ?'); p.push(from); }
  if (to) { where.push('v.voucher_date <= ?'); p.push(to); }
  return db.prepare(`SELECT v.* FROM treasury_vouchers v WHERE ${where.join(' AND ')} ORDER BY v.voucher_date DESC, v.id DESC LIMIT 500`).all(...p)
    .filter((v) => canUseBox(companyId, { id: v.cash_box_id }, actor) || (v.to_cash_box_id && canUseBox(companyId, { id: v.to_cash_box_id }, actor)))
    .map((v) => decorateVoucher(companyId, v));
}

function voucherFields(companyId, input, actor, existing) {
  const type = existing?.type || input.type;
  if (!VOUCHER_PREFIX[type]) fail('invalid_type', 'نوع السند غير صالح');
  const date = input.date || input.voucherDate || existing?.voucher_date || today();
  if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
  const box = usableBox(companyId, input.cashBoxId ?? existing?.cash_box_id, actor, { kind: type === 'bank_fee' ? 'bank' : undefined });
  const d = digitsOf(companyId, box.currency_code);
  const amount = input.amountMinor !== undefined ? Number(input.amountMinor) : input.amount !== undefined ? toMinor(input.amount, d) : existing?.amount_original_minor;
  if (!Number.isSafeInteger(amount) || amount <= 0) fail('invalid_amount', 'المبلغ يجب أن يكون أكبر من صفر');
  const tax = type === 'expense' ? (input.taxMinor !== undefined ? Number(input.taxMinor) : input.tax !== undefined && input.tax !== '' ? toMinor(input.tax, d) : existing?.tax_original_minor || 0) : 0;
  if (!Number.isSafeInteger(tax) || tax < 0 || tax >= amount) fail('invalid_tax', 'مبلغ الضريبة غير صالح (يجب أن يكون أقل من المبلغ الإجمالي)');
  let counter = null;
  let to = null;
  let toAmount = null;
  let partyType = null;
  let partyId = null;
  if (type === 'transfer') {
    to = usableBox(companyId, input.toCashBoxId ?? existing?.to_cash_box_id, actor);
    if (to.id === box.id) fail('same_box', 'لا يمكن التحويل إلى الصندوق نفسه');
    if (to.currency_code === box.currency_code) toAmount = amount;
    else {
      const td = digitsOf(companyId, to.currency_code);
      toAmount = input.toAmountMinor !== undefined ? Number(input.toAmountMinor) : input.toAmount !== undefined && input.toAmount !== '' ? toMinor(input.toAmount, td) : null;
      if (toAmount !== null && (!Number.isSafeInteger(toAmount) || toAmount <= 0)) fail('invalid_to_amount', 'المبلغ المستلم غير صالح');
    }
  } else if (type === 'bank_fee') {
    counter = ledger.getAccount(companyId, sysAcc(companyId, 'bank_charges'));
  } else {
    counter = owned(companyId, 'account', input.counterAccountId ?? existing?.counter_account_id, { active: true });
    if (!counter.is_postable) fail('non_postable_account', `الحساب ${counter.code} حساب رئيسي لا يقبل الترحيل`);
    if (counter.system_key && VOUCHER_BLOCKED_KEYS[counter.system_key]) fail('control_account', `لا يمكن استخدام الحساب ${counter.code} في سند خزينة: ${VOUCHER_BLOCKED_KEYS[counter.system_key]}`);
    if (db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND account_id = ?').get(companyId, counter.id)) fail('use_transfer', 'الحساب المقابل صندوق أو بنك — استخدم سند تحويل');
    if (type === 'expense' && counter.type !== 'expense') fail('expense_account_required', 'سند المصاريف يتطلب حساب مصروف');
    if (counter.currency_code && counter.currency_code !== box.currency_code) fail('currency_mismatch', `الحساب ${counter.code} لا يقبل إلا ${counter.currency_code}`);
    const pt = input.partyType !== undefined ? input.partyType : existing?.party_type;
    if (pt) {
      if (pt !== 'employee') fail('invalid_party', 'الطرف غير صالح');
      partyType = 'employee';
      partyId = owned(companyId, 'user', input.partyId !== undefined ? input.partyId : existing?.party_id).id;
    }
  }
  return {
    type, date, box, amount, tax, counter, to, toAmount, partyType, partyId,
    payee: input.payee !== undefined ? input.payee || null : existing?.payee ?? null,
    reference: input.reference !== undefined ? input.reference || null : existing?.reference ?? null,
    description: input.description !== undefined ? input.description || null : existing?.description ?? null,
  };
}

function createVoucher(companyId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    ensureMainBox(companyId);
    const f = voucherFields(companyId, input || {}, actor, null);
    const id = Number(
      db.prepare(`INSERT INTO treasury_vouchers (company_id, type, voucher_date, cash_box_id, to_cash_box_id, counter_account_id, party_type, party_id, currency_code, amount_original_minor, tax_original_minor, to_currency_code, to_amount_original_minor, payee, reference, description, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, f.type, f.date, f.box.id, f.to?.id ?? null, f.counter?.id ?? null, f.partyType, f.partyId, f.box.currency_code, f.amount, f.tax, f.to?.currency_code ?? null, f.toAmount, f.payee, f.reference, f.description, actor?.id ?? null).lastInsertRowid
    );
    const v = getVoucher(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.voucher.create', entityType: 'treasury_voucher', entityId: id, before: null, after: v });
    return v;
  });
}

function updateVoucher(companyId, id, input, actor) {
  return ledger.transaction(() => {
    const v = owned(companyId, 'treasury_voucher', id);
    if (v.status !== 'draft') fail('voucher_not_draft', 'السند ليس مسودة', 409);
    // Prompt 11-lite: payroll payments / advances are edited from payroll.
    if (db.prepare('SELECT 1 FROM payroll_payments WHERE voucher_id = ? UNION ALL SELECT 1 FROM employee_advances WHERE voucher_id = ? UNION ALL SELECT 1 FROM payroll_deduction_payments WHERE voucher_id = ?').get(v.id, v.id, v.id)) fail('payroll_linked_voucher', 'هذا السند مرتبط بالرواتب أو بسلفة موظف — ارفضه وأنشئ دفعة جديدة من شاشة الرواتب', 409);
    const f = voucherFields(companyId, input || {}, actor, v);
    db.prepare(`UPDATE treasury_vouchers SET voucher_date = ?, cash_box_id = ?, to_cash_box_id = ?, counter_account_id = ?, party_type = ?, party_id = ?, currency_code = ?, amount_original_minor = ?, tax_original_minor = ?, to_currency_code = ?, to_amount_original_minor = ?, payee = ?, reference = ?, description = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(f.date, f.box.id, f.to?.id ?? null, f.counter?.id ?? null, f.partyType, f.partyId, f.box.currency_code, f.amount, f.tax, f.to?.currency_code ?? null, f.toAmount, f.payee, f.reference, f.description, v.id);
    const after = getVoucher(companyId, v.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.voucher.update', entityType: 'treasury_voucher', entityId: v.id, before: v, after });
    return after;
  });
}

function deleteVoucher(companyId, id, actor) {
  return ledger.transaction(() => {
    const v = owned(companyId, 'treasury_voucher', id);
    if (v.status !== 'draft') fail('voucher_not_draft', 'لا يُحذف إلا سند مسودة', 409);
    db.prepare('DELETE FROM treasury_vouchers WHERE id = ?').run(v.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.voucher.delete', entityType: 'treasury_voucher', entityId: v.id, before: v, after: null });
    return { deleted: true };
  });
}

function rejectVoucher(companyId, id, { reason } = {}, actor) {
  return ledger.transaction(() => {
    const v = owned(companyId, 'treasury_voucher', id);
    if (v.status !== 'draft') fail('voucher_not_draft', 'السند ليس مسودة', 409);
    if (!String(reason || '').trim()) fail('reason_required', 'سبب الرفض مطلوب');
    db.prepare("UPDATE treasury_vouchers SET status = 'rejected', reject_reason = ?, updated_at = datetime('now') WHERE id = ?").run(String(reason).trim(), v.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.voucher.reject', entityType: 'treasury_voucher', entityId: v.id, before: { status: 'draft' }, after: { status: 'rejected', reason } });
    return getVoucher(companyId, v.id);
  });
}

// Approve = post. The rate is the posting-date rate of each box currency
// (override with override_exchange_rate).
function approveVoucher(companyId, id, { exchangeRate, rateQuote, toExchangeRate, toRateQuote, toAmount, breakGlassReason } = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const v = owned(companyId, 'treasury_voucher', id);
    if (v.status !== 'draft') fail('voucher_not_draft', 'السند ليس مسودة', 409);
    if (actor?.id && v.created_by === actor.id) {
      P.sodGuard(companyId, 'voucher', actor, breakGlassReason, { code: 'sod_voucher_creator', message: 'فصل المهام: لا يمكنك اعتماد سند أنشأته بنفسك. يجب أن يعتمده مستخدم آخر.', entityType: 'treasury_voucher', entityId: v.id });
    }
    const box = usableBox(companyId, v.cash_box_id, actor);
    const baseCode = P.base(companyId).code;
    const rate = rateFor(companyId, v.currency_code, v.voucher_date, { exchangeRate, rateQuote }, actor);
    const amountBase = P.toBase(companyId, v.currency_code, v.amount_original_minor, rate);
    if (amountBase <= 0) fail('invalid_amount', 'المبلغ بعد التحويل يساوي صفرًا');
    const boxFx = fxl(companyId, v.currency_code, v.amount_original_minor, rate);
    const memo = v.description || v.payee || null;
    let lines;
    let toBase = null;
    let toRate = null;
    let toOriginal = v.to_amount_original_minor;
    let fxMinor = 0;
    if (v.type === 'transfer') {
      const to = usableBox(companyId, v.to_cash_box_id, actor);
      toRate = rateFor(companyId, to.currency_code, v.voucher_date, { exchangeRate: toExchangeRate, rateQuote: toRateQuote }, actor);
      if (toAmount !== undefined && toAmount !== '' && to.currency_code !== v.currency_code) toOriginal = toMinor(toAmount, digitsOf(companyId, to.currency_code));
      // No received amount typed: convert through base at the day's rates.
      if (!toOriginal) toOriginal = P.fromBase(companyId, to.currency_code, amountBase, toRate);
      if (!Number.isSafeInteger(toOriginal) || toOriginal <= 0) fail('invalid_to_amount', 'المبلغ المستلم غير صالح');
      toBase = to.currency_code === v.currency_code ? amountBase : P.toBase(companyId, to.currency_code, toOriginal, toRate);
      fxMinor = amountBase - toBase; // > 0: received less than sent (loss)
      lines = [
        { accountId: to.account_id, debitMinor: toBase, ...(to.currency_code === v.currency_code ? boxFx : fxl(companyId, to.currency_code, toOriginal, toRate)), memo: `تحويل من ${box.name}` },
        { accountId: box.account_id, creditMinor: amountBase, ...boxFx, memo: `تحويل إلى ${to.name}` },
      ];
      if (fxMinor) lines.push({ accountId: sysAcc(companyId, 'fx_realized'), debitMinor: fxMinor > 0 ? fxMinor : 0, creditMinor: fxMinor < 0 ? -fxMinor : 0, memo: 'فرق صرف تحويل بين صندوقين' });
    } else {
      const party = v.party_type ? { partyType: v.party_type, partyId: v.party_id } : {};
      const counterFx = v.currency_code !== baseCode ? fxl(companyId, v.currency_code, v.amount_original_minor - v.tax_original_minor, rate) : {};
      if (v.type === 'receipt') {
        lines = [
          { accountId: box.account_id, debitMinor: amountBase, ...boxFx, memo },
          { accountId: v.counter_account_id, creditMinor: amountBase, ...counterFx, ...party, memo },
        ];
      } else {
        const taxBase = v.tax_original_minor ? P.toBase(companyId, v.currency_code, v.tax_original_minor, rate) : 0;
        const netBase = amountBase - taxBase;
        // Prompt 11-lite: a payroll payment in a foreign currency relieves the
        // salaries payable at its accrual value; the rate difference is
        // realized FX (null for every other voucher: unchanged).
        const payroll = v.type === 'payment' ? require('./payroll').voucherCounter(companyId, v) : null;
        if (payroll) {
          const fxDiff = netBase - payroll.counterBase;
          lines = [
            { accountId: v.counter_account_id, debitMinor: payroll.counterBase, ...counterFx, ...party, memo },
            ...(fxDiff ? [{ accountId: sysAcc(companyId, 'fx_realized'), debitMinor: fxDiff > 0 ? fxDiff : 0, creditMinor: fxDiff < 0 ? -fxDiff : 0, memo: 'فرق صرف دفع الرواتب' }] : []),
            { accountId: box.account_id, creditMinor: amountBase, ...boxFx, memo },
          ];
        } else lines = [
          { accountId: v.counter_account_id, debitMinor: netBase, ...counterFx, ...party, memo },
          ...(taxBase ? [{ accountId: sysAcc(companyId, 'input_tax'), debitMinor: taxBase, ...(v.currency_code !== baseCode ? fxl(companyId, v.currency_code, v.tax_original_minor, rate) : {}), memo: 'ضريبة مدخلات' }] : []),
          { accountId: box.account_id, creditMinor: amountBase, ...boxFx, memo },
        ];
      }
    }
    const [docType, prefix] = VOUCHER_PREFIX[v.type];
    const number = P.issueNumber(companyId, docType, prefix);
    const label = { receipt: 'سند قبض', payment: 'سند صرف', expense: 'سند مصاريف', transfer: 'تحويل', bank_fee: 'عمولة بنكية' }[v.type];
    const entry = ledger.postEntry(companyId, { date: v.voucher_date, description: `${label} ${number}${v.payee ? ` — ${v.payee}` : ''}${v.reference ? ` (${v.reference})` : ''}`, sourceType: 'treasury_voucher', sourceId: v.id, lines }, actor);
    checkpoint('treasury.voucher.after_entry');
    db.prepare(`UPDATE treasury_vouchers SET status = 'posted', voucher_number = ?, rate_e8 = ?, rate_quote = ?, amount_base_minor = ?, to_rate_e8 = ?, to_rate_quote = ?, to_amount_original_minor = ?, to_amount_base_minor = ?, fx_minor = ?,
                journal_entry_id = ?, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(number, rate.rateE8, rate.quote, amountBase, toRate?.rateE8 ?? null, toRate?.quote ?? null, v.type === 'transfer' ? toOriginal : null, toBase, fxMinor, entry.id, actor?.id ?? null, v.id);
    const after = getVoucher(companyId, v.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.voucher.approve', entityType: 'treasury_voucher', entityId: v.id, before: { status: 'draft' }, after });
    return after;
  });
}

function reverseVoucher(companyId, id, { reason, date } = {}, actor) {
  return ledger.transaction(() => {
    const v = owned(companyId, 'treasury_voucher', id);
    if (v.status !== 'posted') fail('voucher_not_posted', 'السند غير مرحّل', 409);
    if (!String(reason || '').trim()) fail('reason_required', 'سبب العكس مطلوب');
    usableBox(companyId, v.cash_box_id, actor);
    if (v.journal_entry_id && db.prepare('SELECT 1 FROM bank_statement_lines WHERE journal_line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?) AND status = ?').get(v.journal_entry_id, 'matched')) {
      fail('voucher_reconciled', 'السند مطابق مع كشف البنك — ألغِ المطابقة أولًا', 409);
    }
    ledger.reverseEntry(companyId, v.journal_entry_id, { reason: `عكس السند ${v.voucher_number} — ${reason}`, date, fromSource: true }, actor);
    checkpoint('treasury.voucher.after_reverse');
    db.prepare("UPDATE treasury_vouchers SET status = 'reversed', reversed_by = ?, reversed_at = datetime('now'), reverse_reason = ?, updated_at = datetime('now') WHERE id = ?").run(actor?.id ?? null, String(reason).trim(), v.id);
    const after = getVoucher(companyId, v.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.voucher.reverse', entityType: 'treasury_voucher', entityId: v.id, before: { status: 'posted' }, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Cheques issued
// ---------------------------------------------------------------------

function decorateIssued(companyId, c) {
  const box = db.prepare('SELECT name FROM cash_boxes WHERE id = ?').get(c.cash_box_id);
  const sup = c.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(c.supplier_id) : null;
  return { ...c, cash_box_name: box?.name, supplier_name: sup?.name || null, digits: digitsOf(companyId, c.currency_code) };
}
function getIssuedCheque(companyId, id) {
  return decorateIssued(companyId, owned(companyId, 'cheque_issued', id));
}
function listIssuedCheques(companyId, actor, { status } = {}) {
  return db.prepare(`SELECT * FROM cheques_issued WHERE company_id = ? ${status ? 'AND status = ?' : ''} ORDER BY due_date, id`).all(...[companyId, ...(status ? [String(status)] : [])])
    .filter((c) => canUseBox(companyId, { id: c.cash_box_id }, actor))
    .map((c) => decorateIssued(companyId, c));
}

// input: { cashBoxId (bank), chequeNumber, issueDate, dueDate, amount,
//   supplierId | counterAccountId, payee?, notes?, allocations?, exchangeRate? }
function issueCheque(companyId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const box = usableBox(companyId, input.cashBoxId, actor, { kind: 'bank' });
    const number = String(input.chequeNumber || '').trim();
    if (!number) fail('cheque_number_required', 'رقم الشيك مطلوب');
    const issueDate = input.issueDate || today();
    const due = input.dueDate || issueDate;
    if (!isValidDate(issueDate) || !isValidDate(due) || due < issueDate) fail('invalid_date', 'تاريخ الإصدار أو الاستحقاق غير صالح');
    if (db.prepare('SELECT 1 FROM cheques_issued WHERE company_id = ? AND cash_box_id = ? AND cheque_number = ?').get(companyId, box.id, number)) fail('duplicate_cheque', 'رقم الشيك مستخدم لهذا الحساب البنكي', 409);
    const amount = input.amountMinor !== undefined ? Number(input.amountMinor) : toMinor(input.amount, digitsOf(companyId, box.currency_code));
    if (!Number.isSafeInteger(amount) || amount <= 0) fail('invalid_amount', 'مبلغ الشيك يجب أن يكون أكبر من صفر');
    const supplier = optionalOwned(companyId, 'supplier', input.supplierId);
    const counter = supplier ? null : owned(companyId, 'account', input.counterAccountId, { active: true });
    if (counter) {
      if (!counter.is_postable) fail('non_postable_account', `الحساب ${counter.code} حساب رئيسي لا يقبل الترحيل`);
      if (counter.system_key && VOUCHER_BLOCKED_KEYS[counter.system_key]) fail('control_account', `لا يمكن استخدام الحساب ${counter.code}: ${VOUCHER_BLOCKED_KEYS[counter.system_key]}`);
    }
    const payable = sysAcc(companyId, 'cheques_payable');
    const cid = Number(
      db.prepare('INSERT INTO cheques_issued (company_id, cheque_number, cash_box_id, supplier_id, counter_account_id, payee, issue_date, due_date, currency_code, amount_original_minor, amount_base_minor, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .run(companyId, number, box.id, supplier?.id ?? null, counter?.id ?? null, input.payee || supplier?.name || null, issueDate, due, box.currency_code, amount, input.notes || null, actor?.id ?? null).lastInsertRowid
    );
    let rate;
    let baseMinor;
    let entryId;
    let paymentId = null;
    if (supplier) {
      // The cheque IS the supplier payment (AP sub-ledger, allocations,
      // realized FX, separation of duties) — credited to cheques_payable.
      const p = pay.createPayment(companyId, {
        supplierId: supplier.id, paymentDate: issueDate, method: 'cheque', currencyCode: box.currency_code, amountMinor: amount,
        exchangeRate: input.exchangeRate, rateQuote: input.rateQuote, reference: `شيك ${number}`, notes: input.notes, allocations: input.allocations, autoAllocate: input.autoAllocate, breakGlassReason: input.breakGlassReason,
      }, actor, { creditAccountId: payable });
      rate = P.rateOf(p);
      baseMinor = p.amount_minor;
      entryId = p.journal_entry_id;
      paymentId = p.id;
    } else {
      rate = rateFor(companyId, box.currency_code, issueDate, { exchangeRate: input.exchangeRate, rateQuote: input.rateQuote }, actor);
      baseMinor = P.toBase(companyId, box.currency_code, amount, rate);
      const f = fxl(companyId, box.currency_code, amount, rate);
      const entry = ledger.postEntry(companyId, {
        date: issueDate, description: `شيك صادر ${number}${input.payee ? ` — ${input.payee}` : ''}`, sourceType: 'cheque_issued', sourceId: cid,
        lines: [
          { accountId: counter.id, debitMinor: baseMinor, ...f, memo: input.payee || null },
          { accountId: payable, creditMinor: baseMinor, ...f, memo: `شيك ${number} يستحق ${due}` },
        ],
      }, actor);
      entryId = entry.id;
    }
    checkpoint('treasury.cheque_issue.after_entry');
    db.prepare('UPDATE cheques_issued SET rate_e8 = ?, rate_quote = ?, amount_base_minor = ?, issue_entry_id = ?, supplier_payment_id = ? WHERE id = ?').run(rate.rateE8, rate.quote, baseMinor, entryId, paymentId, cid);
    const after = getIssuedCheque(companyId, cid);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.cheque_issued.issue', entityType: 'cheque_issued', entityId: cid, before: null, after });
    return after;
  });
}

function handOverCheque(companyId, id, actor) {
  return ledger.transaction(() => {
    const c = owned(companyId, 'cheque_issued', id);
    usableBox(companyId, c.cash_box_id, actor);
    if (c.status !== 'issued') fail('invalid_transition', 'الشيك ليس بحالة "صادر"', 409);
    db.prepare("UPDATE cheques_issued SET status = 'in_transit', handed_at = datetime('now') WHERE id = ?").run(c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.cheque_issued.in_transit', entityType: 'cheque_issued', entityId: c.id, before: { status: c.status }, after: { status: 'in_transit' } });
    return getIssuedCheque(companyId, c.id);
  });
}

// Cleared by the bank: Dr cheques_payable (carried base) / Cr bank box at
// the clearing-date rate; any difference -> fx_realized.
function clearIssuedCheque(companyId, id, { date, exchangeRate, rateQuote } = {}, actor) {
  return ledger.transaction(() => {
    const c = owned(companyId, 'cheque_issued', id);
    const box = usableBox(companyId, c.cash_box_id, actor);
    if (!['issued', 'in_transit'].includes(c.status)) fail('invalid_transition', 'لا يمكن صرف هذا الشيك', 409);
    const d = date || today();
    if (!isValidDate(d) || d < c.issue_date) fail('invalid_date', 'تاريخ الصرف غير صالح');
    const rate = rateFor(companyId, c.currency_code, d, { exchangeRate, rateQuote }, actor);
    const bankBase = P.toBase(companyId, c.currency_code, c.amount_original_minor, rate);
    const fxMinor = bankBase - c.amount_base_minor; // > 0: paid more base than carried (loss)
    const lines = [
      { accountId: sysAcc(companyId, 'cheques_payable'), debitMinor: c.amount_base_minor, ...fxl(companyId, c.currency_code, c.amount_original_minor, P.rateOf(c)), memo: `شيك ${c.cheque_number}` },
      { accountId: box.account_id, creditMinor: bankBase, ...fxl(companyId, c.currency_code, c.amount_original_minor, rate), memo: `صرف الشيك ${c.cheque_number}` },
    ];
    if (fxMinor) lines.push({ accountId: sysAcc(companyId, 'fx_realized'), debitMinor: fxMinor > 0 ? fxMinor : 0, creditMinor: fxMinor < 0 ? -fxMinor : 0, memo: 'فرق صرف بين إصدار الشيك وصرفه' });
    const entry = ledger.postEntry(companyId, { date: d, description: `صرف الشيك الصادر ${c.cheque_number}`, sourceType: 'cheque_issued_clear', sourceId: c.id, lines }, actor);
    checkpoint('treasury.cheque_clear.after_entry');
    db.prepare("UPDATE cheques_issued SET status = 'cleared', cleared_at = datetime('now'), clear_entry_id = ?, clear_fx_minor = ? WHERE id = ?").run(entry.id, fxMinor, c.id);
    const after = getIssuedCheque(companyId, c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.cheque_issued.clear', entityType: 'cheque_issued', entityId: c.id, before: { status: c.status }, after });
    return after;
  });
}

// Bounced (refused by the bank) or cancelled before clearing: the issue is
// undone — supplier cheques reverse their supplier payment (AP owed again,
// allocations freed), other cheques reverse their entry.
function undoIssuedCheque(companyId, id, status, { reason, date } = {}, actor) {
  return ledger.transaction(() => {
    const c = owned(companyId, 'cheque_issued', id);
    usableBox(companyId, c.cash_box_id, actor);
    if (c.status === 'cleared') fail('cheque_already_cleared', 'الشيك مصروف — لا يمكن إلغاؤه أو تسجيل ارتداده', 409);
    if (!['issued', 'in_transit'].includes(c.status)) fail('invalid_transition', 'الشيك منتهٍ مسبقًا', 409);
    if (!String(reason || '').trim()) fail('reason_required', status === 'bounced' ? 'سبب الارتداد مطلوب' : 'سبب الإلغاء مطلوب');
    const label = status === 'bounced' ? 'ارتداد' : 'إلغاء';
    if (c.supplier_payment_id) pay.reversePayment(companyId, c.supplier_payment_id, { reason: `${label} الشيك ${c.cheque_number} — ${reason}`, date }, actor);
    else ledger.reverseEntry(companyId, c.issue_entry_id, { reason: `${label} الشيك ${c.cheque_number} — ${reason}`, date, fromSource: true }, actor);
    checkpoint('treasury.cheque_undo.after_reverse');
    db.prepare(`UPDATE cheques_issued SET status = ?, status_reason = ?, ${status === 'bounced' ? 'bounced_at' : 'cancelled_at'} = datetime('now') WHERE id = ?`).run(status, String(reason).trim(), c.id);
    const after = getIssuedCheque(companyId, c.id);
    logAudit({ companyId, actor: actorOf(actor), action: `treasury.cheque_issued.${status === 'bounced' ? 'bounce' : 'cancel'}`, entityType: 'cheque_issued', entityId: c.id, before: { status: c.status }, after });
    if (status === 'bounced') {
      createNotification({
        companyId, type: 'cheque_issued_bounced',
        message_ar: `ارتد الشيك الصادر رقم ${c.cheque_number} (${money(companyId, c.currency_code, c.amount_original_minor)})${after.supplier_name ? ` للمورد ${after.supplier_name} — أُعيد المبلغ إلى ذمته` : ''}.`,
        message_en: `Issued cheque ${c.cheque_number} bounced.`,
        link_path: '/treasury?tab=cheques', entity_type: 'cheque_issued', entity_id: c.id,
      });
    }
    return after;
  });
}
const bounceIssuedCheque = (companyId, id, opts, actor) => undoIssuedCheque(companyId, id, 'bounced', opts, actor);
const cancelIssuedCheque = (companyId, id, opts, actor) => undoIssuedCheque(companyId, id, 'cancelled', opts, actor);

// ---------------------------------------------------------------------
// Rep cash handover (per currency)
// ---------------------------------------------------------------------

function repCashEnabled(companyId) {
  return P.getSetting(companyId, 'rep_cash_handover', '0') === '1';
}

// Confirmed cash collections of a rep that sit on rep_cash_custody and are
// not in a posted handover, in one currency.
function repCashItems(companyId, repId, currencyCode) {
  const custody = ledger.getAccountBySystemKey(companyId, 'rep_cash_custody');
  if (!custody) return [];
  const baseCode = P.base(companyId).code;
  const d = P.base(companyId).minor_unit_digits;
  return db
    .prepare(
      `SELECT c.id, c.shop_id, c.amount, c.confirmed_at, s.name AS shop_name, fx.currency_code AS fx_code, fx.amount_original_minor AS fx_original, l.debit_minor AS custody_base, l.amount_original_minor AS line_original, l.currency_code AS line_code
       FROM collections c
       JOIN journal_entries e ON e.company_id = c.company_id AND e.source_type = 'collection' AND e.source_id = c.id AND e.status = 'posted'
       JOIN journal_lines l ON l.entry_id = e.id AND l.account_id = ? AND l.debit_minor > 0
       LEFT JOIN collection_fx fx ON fx.collection_id = c.id
       LEFT JOIN shops s ON s.id = c.shop_id
       WHERE c.company_id = ? AND c.rep_id = ? AND c.status = 'confirmed' AND c.method = 'cash'
         AND NOT EXISTS (SELECT 1 FROM rep_cash_handover_items hi JOIN rep_cash_handovers h ON h.id = hi.handover_id WHERE hi.collection_id = c.id AND h.status = 'posted')
       ORDER BY c.confirmed_at, c.id`
    )
    .all(custody.id, companyId, Number(repId))
    .map((r) => ({ ...r, currency_code: r.fx_code || baseCode, amount_original_minor: r.fx_code ? r.fx_original : r.line_code === baseCode ? r.custody_base : Math.round(r.amount * 10 ** d), base_minor: r.custody_base }))
    .filter((r) => !currencyCode || r.currency_code === currencyCode);
}

// What each rep holds, per currency.
function repCashSummary(companyId) {
  const reps = db.prepare("SELECT DISTINCT c.rep_id, u.name FROM collections c JOIN users u ON u.id = c.rep_id WHERE c.company_id = ? AND c.status = 'confirmed' AND c.method = 'cash'").all(companyId);
  const out = [];
  for (const r of reps) {
    const by = new Map();
    for (const it of repCashItems(companyId, r.rep_id)) {
      const g = by.get(it.currency_code) || { rep_id: r.rep_id, rep_name: r.name, currency_code: it.currency_code, digits: digitsOf(companyId, it.currency_code), count: 0, expected_original_minor: 0, carried_base_minor: 0 };
      g.count += 1;
      g.expected_original_minor += it.amount_original_minor;
      g.carried_base_minor += it.base_minor;
      by.set(it.currency_code, g);
    }
    out.push(...by.values());
  }
  return out;
}

// input: { repId, currencyCode, cashBoxId, counted, date?, notes?, exchangeRate? }
function createHandover(companyId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    if (!require('./customerLedger').isLedgerLive(companyId)) fail('not_ledger_live', 'تسليم نقدية المندوبين يتطلب تفعيل دفتر الأستاذ', 409);
    const rep = owned(companyId, 'user', input.repId);
    const cur = P.currencyOf(companyId, input.currencyCode);
    const box = usableBox(companyId, input.cashBoxId, actor, { kind: 'cash' });
    if (box.currency_code !== cur.code) fail('currency_mismatch', `${box.name} بعملة ${box.currency_code} — اختر صندوقًا بعملة ${cur.code}`);
    const date = input.date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const items = repCashItems(companyId, rep.id, cur.code);
    if (!items.length) fail('nothing_to_hand_over', `لا توجد نقدية مؤكدة بعملة ${cur.code} لدى ${rep.name}`, 409);
    const counted = input.countedMinor !== undefined ? Number(input.countedMinor) : toMinor(input.counted, cur.minor_unit_digits);
    if (!Number.isSafeInteger(counted) || counted < 0) fail('invalid_amount', 'المبلغ المعدود غير صالح');
    const expected = items.reduce((s, i) => s + i.amount_original_minor, 0);
    const carried = items.reduce((s, i) => s + i.base_minor, 0);
    const rate = rateFor(companyId, cur.code, date, { exchangeRate: input.exchangeRate, rateQuote: input.rateQuote }, actor);
    const overShort = counted - expected; // < 0 short, > 0 over (in the currency)
    const countedBase = P.toBase(companyId, cur.code, counted, rate);
    const osBase = overShort === 0 ? 0 : Math.sign(overShort) * P.toBase(companyId, cur.code, Math.abs(overShort), rate);
    // The expected cash at today's rate vs what it was carried at.
    const fxMinor = countedBase - osBase - carried; // > 0 gain
    const number = P.issueNumber(companyId, 'CH', 'CH-');
    const hid = Number(
      db.prepare(`INSERT INTO rep_cash_handovers (company_id, handover_number, rep_id, cash_box_id, currency_code, handover_date, expected_original_minor, counted_original_minor, over_short_original_minor, carried_base_minor, rate_e8, rate_quote, counted_base_minor, over_short_base_minor, fx_minor, notes, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, number, rep.id, box.id, cur.code, date, expected, counted, overShort, carried, rate.rateE8, rate.quote, countedBase, osBase, fxMinor, input.notes || null, actor?.id ?? null).lastInsertRowid
    );
    const ins = db.prepare('INSERT INTO rep_cash_handover_items (handover_id, collection_id, company_id, amount_original_minor, base_minor) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) ins.run(hid, it.id, companyId, it.amount_original_minor, it.base_minor);
    const lines = [
      ...(countedBase ? [{ accountId: box.account_id, debitMinor: countedBase, ...fxl(companyId, cur.code, counted, rate), memo: `تسليم نقدية ${rep.name}` }] : []),
      { accountId: sysAcc(companyId, 'rep_cash_custody'), creditMinor: carried, ...fxl(companyId, cur.code, expected, rate), partyType: 'employee', partyId: rep.id, memo: `${items.length} تحصيل نقدي` },
    ];
    if (osBase) lines.push({ accountId: sysAcc(companyId, 'cash_over_short'), debitMinor: osBase < 0 ? -osBase : 0, creditMinor: osBase > 0 ? osBase : 0, memo: osBase < 0 ? `عجز ${money(companyId, cur.code, -overShort)}` : `زيادة ${money(companyId, cur.code, overShort)}` });
    if (fxMinor) lines.push({ accountId: sysAcc(companyId, 'fx_realized'), debitMinor: fxMinor < 0 ? -fxMinor : 0, creditMinor: fxMinor > 0 ? fxMinor : 0, memo: 'فرق صرف بين تأكيد التحصيل والتسليم' });
    const entry = ledger.postEntry(companyId, { date, description: `تسليم نقدية المندوب ${rep.name} ${number} (${cur.code})`, sourceType: 'rep_cash_handover', sourceId: hid, lines }, actor);
    checkpoint('treasury.handover.after_entry');
    db.prepare('UPDATE rep_cash_handovers SET journal_entry_id = ? WHERE id = ?').run(entry.id, hid);
    const after = getHandover(companyId, hid);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.handover.create', entityType: 'rep_cash_handover', entityId: hid, before: null, after });
    return after;
  });
}

function getHandover(companyId, id) {
  const h = owned(companyId, 'rep_cash_handover', id);
  const rep = db.prepare('SELECT name FROM users WHERE id = ?').get(h.rep_id);
  const box = db.prepare('SELECT name FROM cash_boxes WHERE id = ?').get(h.cash_box_id);
  const items = db.prepare('SELECT hi.*, c.shop_id, s.name AS shop_name FROM rep_cash_handover_items hi JOIN collections c ON c.id = hi.collection_id LEFT JOIN shops s ON s.id = c.shop_id WHERE hi.handover_id = ? ORDER BY hi.collection_id').all(h.id);
  return { ...h, rep_name: rep?.name, cash_box_name: box?.name, digits: digitsOf(companyId, h.currency_code), items };
}
function listHandovers(companyId) {
  return db.prepare('SELECT id FROM rep_cash_handovers WHERE company_id = ? ORDER BY handover_date DESC, id DESC LIMIT 300').all(companyId).map((r) => getHandover(companyId, r.id));
}
function reverseHandover(companyId, id, { reason, date } = {}, actor) {
  return ledger.transaction(() => {
    const h = owned(companyId, 'rep_cash_handover', id);
    if (h.status !== 'posted') fail('already_reversed', 'السند معكوس مسبقًا', 409);
    if (!String(reason || '').trim()) fail('reason_required', 'سبب العكس مطلوب');
    usableBox(companyId, h.cash_box_id, actor);
    ledger.reverseEntry(companyId, h.journal_entry_id, { reason: `عكس تسليم النقدية ${h.handover_number} — ${reason}`, date, fromSource: true }, actor);
    checkpoint('treasury.handover.after_reverse');
    db.prepare("UPDATE rep_cash_handovers SET status = 'reversed' WHERE id = ?").run(h.id);
    const after = getHandover(companyId, h.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.handover.reverse', entityType: 'rep_cash_handover', entityId: h.id, before: { status: 'posted' }, after: { status: 'reversed', reason } });
    return after;
  });
}

// ---------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------

// Daily cash report per box: opening, in, out, closing per day, in the box
// currency (base too), with the movements.
function dailyCashReport(companyId, boxId, { from, to } = {}, actor) {
  const box = owned(companyId, 'cash_box', boxId);
  if (!canUseBox(companyId, box, actor)) fail('cash_box_access_denied', `ليست لديك صلاحية على ${box.name}`, 403);
  const t = to || today();
  const f = from || t;
  if (!isValidDate(f) || !isValidDate(t) || f > t) fail('invalid_dates', 'الفترة غير صالحة');
  const isBase = box.currency_code === P.base(companyId).code;
  const opening = boxBalance(companyId, box, addDays(f, -1));
  const lines = db
    .prepare(
      `SELECT l.id, e.id AS entry_id, e.entry_number, e.entry_date, e.description, e.source_type, e.source_id, l.memo, l.debit_minor, l.credit_minor, l.currency_code, l.amount_original_minor
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND e.entry_date BETWEEN ? AND ?
       ORDER BY e.entry_date, e.id, l.line_no`
    )
    .all(companyId, box.account_id, f, t)
    .map((l) => {
      const orig = isBase ? l.debit_minor || l.credit_minor : l.currency_code === box.currency_code ? l.amount_original_minor : 0;
      return { ...l, in_minor: l.debit_minor ? orig : 0, out_minor: l.credit_minor ? orig : 0, in_base_minor: l.debit_minor, out_base_minor: l.credit_minor };
    });
  const days = [];
  let bal = opening.balance_minor;
  let balBase = opening.base_minor;
  for (let d = f; d <= t; d = addDays(d, 1)) {
    const dl = lines.filter((l) => l.entry_date === d);
    const inM = dl.reduce((s, l) => s + l.in_minor, 0);
    const outM = dl.reduce((s, l) => s + l.out_minor, 0);
    const inB = dl.reduce((s, l) => s + l.in_base_minor, 0);
    const outB = dl.reduce((s, l) => s + l.out_base_minor, 0);
    const day = { date: d, opening_minor: bal, in_minor: inM, out_minor: outM, closing_minor: bal + inM - outM, opening_base_minor: balBase, closing_base_minor: balBase + inB - outB, lines: dl };
    bal = day.closing_minor;
    balBase = day.closing_base_minor;
    if (dl.length || f === t || d === f || d === t) days.push(day);
  }
  return { box: decorateBox(companyId, box), from: f, to: t, opening_minor: opening.balance_minor, closing_minor: bal, opening_base_minor: opening.base_minor, closing_base_minor: balBase, days, ledger_closing_minor: boxBalance(companyId, box, t).balance_minor };
}

// Due-cheques alert (notifications table + the alert-sweep pattern): one
// unread notification per cheque, re-raised after it is read while due.
function sweepDueCheques({ now } = {}) {
  const day = (now || new Date()).toISOString().slice(0, 10);
  const companies = db.prepare('SELECT DISTINCT company_id FROM cash_boxes UNION SELECT DISTINCT company_id FROM cheques_received').all().map((r) => r.company_id);
  let created = 0;
  for (const cid of companies) {
    const days = Number(P.getSetting(cid, 'cheque_due_alert_days', '3')) || 0;
    const limit = addDays(day, days);
    const rec = db.prepare("SELECT c.*, s.name AS shop_name FROM cheques_received c LEFT JOIN shops s ON s.id = c.shop_id WHERE c.company_id = ? AND c.status IN ('in_portfolio', 'deposited') AND c.due_date <= ?").all(cid, limit);
    for (const c of rec) {
      if (hasUnreadNotification(cid, 'cheque_due', c.id, 'cheque_received')) continue;
      const code = c.currency_code || P.base(cid).code;
      createNotification({
        companyId: cid, type: 'cheque_due',
        message_ar: `شيك وارد رقم ${c.cheque_number} من ${c.shop_name || ''} ${c.due_date < day ? 'متأخر منذ' : 'يستحق في'} ${c.due_date} (${money(cid, code, c.amount_original_minor || c.amount_minor)}) — أودعه أو حصّله.`,
        message_en: `Received cheque ${c.cheque_number} is due ${c.due_date}.`,
        link_path: '/receivables/cheques', entity_type: 'cheque_received', entity_id: c.id,
      });
      created += 1;
    }
    const iss = db.prepare("SELECT * FROM cheques_issued WHERE company_id = ? AND status IN ('issued', 'in_transit') AND due_date <= ?").all(cid, limit);
    for (const c of iss) {
      if (hasUnreadNotification(cid, 'cheque_due', c.id, 'cheque_issued')) continue;
      createNotification({
        companyId: cid, type: 'cheque_due',
        message_ar: `شيك صادر رقم ${c.cheque_number}${c.payee ? ` لـ ${c.payee}` : ''} ${c.due_date < day ? 'مستحق منذ' : 'يستحق في'} ${c.due_date} (${money(cid, c.currency_code, c.amount_original_minor)}) — تأكد من رصيد البنك.`,
        message_en: `Issued cheque ${c.cheque_number} is due ${c.due_date}.`,
        link_path: '/treasury?tab=cheques', entity_type: 'cheque_issued', entity_id: c.id,
      });
      created += 1;
    }
  }
  return created;
}

// ---------------------------------------------------------------------
// Bank statements + reconciliation
// ---------------------------------------------------------------------

const MAP_GUESS = {
  date: /^(date|value date|transaction date|التاريخ|تاريخ)/i,
  description: /^(description|details|narrative|البيان|الوصف|التفاصيل)/i,
  reference: /^(reference|ref|cheque|check|المرجع|مرجع|رقم)/i,
  amount: /^(amount|المبلغ)$/i,
  debit: /^(debit|withdrawal|out|مدين|سحب|صادر)/i,
  credit: /^(credit|deposit|in|دائن|إيداع|ايداع|وارد)/i,
  balance: /^(balance|الرصيد|رصيد)/i,
};
function guessMapping(header) {
  const m = {};
  header.forEach((h, i) => {
    for (const [k, re] of Object.entries(MAP_GUESS)) if (m[k] === undefined && re.test(String(h || '').trim())) m[k] = i;
  });
  return m;
}

function parseCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = (lines[0] || '').includes('\t') ? '\t' : (lines[0] || '').split(';').length > (lines[0] || '').split(',').length ? ';' : ',';
  const split = (l) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const rows = lines.map(split);
  return { header: rows[0] || [], dataRows: rows.slice(1) };
}

function parseDateCell(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000).toISOString().slice(0, 10); // Excel serial
  return null;
}
function parseAmountCell(v, digits) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 10 ** digits);
  let s = String(v).trim().replace(/[\s ]/g, '').replace(/[^\d.,\-()]/g, '');
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()\-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const minor = toMinor(s || '0', digits);
  return neg ? -minor : minor;
}

// rows: raw arrays (from the preview); mapping: { date, description,
// reference, amount | debit + credit, balance } -> column index.
function importStatement(companyId, input, actor) {
  return ledger.transaction(() => {
    const box = usableBox(companyId, input.cashBoxId, actor, { kind: 'bank' });
    const m = input.mapping || {};
    if (m.date === undefined || (m.amount === undefined && m.debit === undefined && m.credit === undefined)) fail('mapping_required', 'حدّد عمود التاريخ وعمود المبلغ (أو المدين والدائن)');
    const d = digitsOf(companyId, box.currency_code);
    const rows = (input.rows || []).map((r, i) => {
      const cell = (k) => (m[k] === undefined || m[k] === null || m[k] === '' ? null : r[Number(m[k])]);
      const date = parseDateCell(cell('date'));
      if (!date) fail('invalid_row_date', `السطر ${i + 1}: تاريخ غير مفهوم (${cell('date') ?? ''})`);
      const amount = m.amount !== undefined && m.amount !== null && m.amount !== '' ? parseAmountCell(cell('amount'), d) : parseAmountCell(cell('credit'), d) - Math.abs(parseAmountCell(cell('debit'), d));
      const balance = m.balance !== undefined && m.balance !== null && m.balance !== '' && cell('balance') !== null && cell('balance') !== '' ? parseAmountCell(cell('balance'), d) : null;
      return { date, description: cell('description') ? String(cell('description')).slice(0, 500) : null, reference: cell('reference') ? String(cell('reference')).slice(0, 120) : null, amount, balance };
    }).filter((r) => r.amount !== 0);
    if (!rows.length) fail('no_rows', 'لا توجد أسطر بمبالغ في الكشف');
    // Re-importing (the same file, or an overlapping export) adds no line
    // twice: a line identical to one already imported for this account
    // (date, amount, reference, description, balance) is skipped — counting
    // occurrences, so two genuine identical lines still both import once.
    const keyOf = (r) => JSON.stringify([r.date, r.amount, r.reference || null, r.description || null, r.balance ?? null]);
    const seen = new Map();
    for (const l of db.prepare('SELECT line_date, amount_minor, reference, description, balance_minor FROM bank_statement_lines WHERE cash_box_id = ?').all(box.id)) {
      const k = keyOf({ date: l.line_date, amount: l.amount_minor, reference: l.reference, description: l.description, balance: l.balance_minor });
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const fresh = [];
    let skipped = 0;
    for (const r of rows) {
      const k = keyOf(r);
      if (seen.get(k)) {
        seen.set(k, seen.get(k) - 1);
        skipped += 1;
      } else fresh.push(r);
    }
    if (!fresh.length) fail('statement_already_imported', `كل أسطر الكشف (${rows.length}) مستوردة مسبقًا لهذا الحساب`, 409, { skipped });
    rows.length = 0;
    rows.push(...fresh);
    const dates = rows.map((r) => r.date).sort();
    const last = [...rows].reverse().find((r) => r.balance !== null);
    const first = rows.find((r) => r.balance !== null);
    const opening = input.openingBalance !== undefined && input.openingBalance !== '' ? toMinor(input.openingBalance, d) : first ? first.balance - first.amount : null;
    const sid = Number(
      db.prepare('INSERT INTO bank_statements (company_id, cash_box_id, file_name, date_from, date_to, opening_balance_minor, closing_balance_minor, line_count, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, box.id, input.fileName || null, dates[0], dates[dates.length - 1], opening, last ? last.balance : opening !== null ? opening + rows.reduce((s, r) => s + r.amount, 0) : null, rows.length, actor?.id ?? null).lastInsertRowid
    );
    const ins = db.prepare('INSERT INTO bank_statement_lines (company_id, statement_id, cash_box_id, line_no, line_date, description, reference, amount_minor, balance_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    rows.forEach((r, i) => ins.run(companyId, sid, box.id, i + 1, r.date, r.description, r.reference, r.amount, r.balance));
    const matched = autoMatch(companyId, sid);
    logAudit({ companyId, actor: actorOf(actor), action: 'treasury.bank.import', entityType: 'bank_statement', entityId: sid, before: null, after: { cash_box_id: box.id, lines: rows.length, skipped_duplicates: skipped, auto_matched: matched.matched, suggested: matched.suggested } });
    return { ...getStatement(companyId, sid, actor), skipped_duplicates: skipped };
  });
}

// Book lines on the bank account that can still be matched: posted, not a
// reversed pair (an entry that was reversed and its reversal net out), not
// matched yet. Amount signed in the box currency (+ in, - out).
function openBookLines(companyId, box, { upTo } = {}) {
  const isBase = box.currency_code === P.base(companyId).code;
  return db
    .prepare(
      `SELECT l.id, l.debit_minor, l.credit_minor, l.currency_code, l.amount_original_minor, l.memo, e.entry_number, e.entry_date, e.description, e.source_type, e.source_id
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND l.account_id = ? AND e.status = 'posted' AND e.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.journal_line_id = l.id AND b.status = 'matched') ${upTo ? 'AND e.entry_date <= ?' : ''}
       ORDER BY e.entry_date, l.id`
    )
    .all(...[companyId, box.account_id, ...(upTo ? [upTo] : [])])
    .map((l) => {
      const orig = isBase ? l.debit_minor || l.credit_minor : l.amount_original_minor;
      return { ...l, amount_minor: l.debit_minor ? orig : -orig };
    });
}

function referenceHit(sl, bl) {
  const hay = `${bl.entry_number || ''} ${bl.description || ''} ${bl.memo || ''}`.toLowerCase();
  const tokens = `${sl.reference || ''} ${sl.description || ''}`.toLowerCase().split(/[\s,;:/#()\-]+/).filter((t) => t.length >= 3 && /\d/.test(t));
  return tokens.some((t) => hay.includes(t));
}
function score(sl, bl) {
  if (sl.amount_minor !== bl.amount_minor) return 0;
  const days = Math.abs(daysBetween(sl.line_date, bl.entry_date));
  if (days > 10) return 0;
  let s = 50 + (days === 0 ? 30 : days <= 3 ? 20 : days <= 7 ? 10 : 0);
  if (referenceHit(sl, bl)) s += 20;
  return Math.min(100, s);
}

// Greedy by confidence: >= 80 -> matched (reconciled), 50-79 -> suggested
// (needs a click), else exceptions for manual review.
function autoMatch(companyId, statementId) {
  const st = owned(companyId, 'bank_statement', statementId);
  const box = db.prepare('SELECT * FROM cash_boxes WHERE id = ?').get(st.cash_box_id);
  const sls = db.prepare("SELECT * FROM bank_statement_lines WHERE statement_id = ? AND status IN ('unmatched', 'suggested')").all(st.id);
  db.prepare("UPDATE bank_statement_lines SET status = 'unmatched', journal_line_id = NULL, confidence = NULL, match_method = NULL WHERE statement_id = ? AND status = 'suggested'").run(st.id);
  const taken = new Set(db.prepare("SELECT journal_line_id FROM bank_statement_lines WHERE company_id = ? AND journal_line_id IS NOT NULL").all(companyId).map((r) => r.journal_line_id));
  const book = openBookLines(companyId, box).filter((b) => !taken.has(b.id));
  const pairs = [];
  for (const sl of sls) for (const bl of book) {
    const sc = score(sl, bl);
    if (sc >= 50) pairs.push({ sl, bl, sc });
  }
  pairs.sort((a, b) => b.sc - a.sc || Math.abs(daysBetween(a.sl.line_date, a.bl.entry_date)) - Math.abs(daysBetween(b.sl.line_date, b.bl.entry_date)) || a.bl.id - b.bl.id);
  const usedS = new Set();
  const usedB = new Set();
  let matched = 0;
  let suggested = 0;
  // Ambiguity is judged on the full candidate set BEFORE greedy picking:
  // a pair is ambiguous when its statement line has another candidate with
  // the same score, or its ledger line is wanted by another statement line
  // with the same score (e.g. three identical -9.00 lines on one day). An
  // ambiguous pair is only suggested, never auto-matched — otherwise the
  // last of the identical lines would be "matched" just because the others
  // were taken first.
  const tie = (a, b) => a.sc === b.sc && a !== b;
  const ambiguous = (p) => pairs.some((q) => tie(p, q) && (q.sl.id === p.sl.id || q.bl.id === p.bl.id));
  for (const p of pairs) {
    if (usedS.has(p.sl.id) || usedB.has(p.bl.id)) continue;
    const status = p.sc >= 80 && !ambiguous(p) ? 'matched' : 'suggested';
    usedS.add(p.sl.id);
    usedB.add(p.bl.id);
    db.prepare("UPDATE bank_statement_lines SET status = ?, journal_line_id = ?, confidence = ?, match_method = 'auto', matched_at = CASE WHEN ? = 'matched' THEN datetime('now') ELSE NULL END WHERE id = ?").run(status, p.bl.id, p.sc, status, p.sl.id);
    if (status === 'matched') matched += 1;
    else suggested += 1;
  }
  return { matched, suggested };
}

function statementLineView(companyId, l) {
  const jl = l.journal_line_id ? db.prepare('SELECT l.id, l.debit_minor, l.credit_minor, e.entry_number, e.entry_date, e.description, e.id AS entry_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.id = ?').get(l.journal_line_id) : null;
  return { ...l, journal_line: jl };
}
function getStatement(companyId, id, actor) {
  const st = owned(companyId, 'bank_statement', id);
  const box = owned(companyId, 'cash_box', st.cash_box_id);
  if (!canUseBox(companyId, box, actor)) fail('cash_box_access_denied', `ليست لديك صلاحية على ${box.name}`, 403);
  const lines = db.prepare('SELECT * FROM bank_statement_lines WHERE statement_id = ? ORDER BY line_no').all(st.id).map((l) => statementLineView(companyId, l));
  const counts = { matched: 0, suggested: 0, unmatched: 0, ignored: 0 };
  for (const l of lines) counts[l.status] += 1;
  return { ...st, cash_box_name: box.name, currency_code: box.currency_code, digits: digitsOf(companyId, box.currency_code), counts, lines, exceptions: lines.filter((l) => l.status === 'unmatched' || l.status === 'suggested') };
}
function listStatements(companyId, actor, { cashBoxId } = {}) {
  return db.prepare(`SELECT s.*, b.name AS cash_box_name, b.currency_code FROM bank_statements s JOIN cash_boxes b ON b.id = s.cash_box_id WHERE s.company_id = ? ${cashBoxId ? 'AND s.cash_box_id = ?' : ''} ORDER BY s.date_to DESC, s.id DESC`).all(...[companyId, ...(cashBoxId ? [Number(cashBoxId)] : [])])
    .filter((s) => canUseBox(companyId, { id: s.cash_box_id }, actor));
}

// Candidates for manual review of one statement line.
function matchCandidates(companyId, lineId, actor) {
  const sl = owned(companyId, 'bank_statement_line', lineId);
  const box = usableBox(companyId, sl.cash_box_id, actor);
  const taken = new Set(db.prepare('SELECT journal_line_id FROM bank_statement_lines WHERE company_id = ? AND journal_line_id IS NOT NULL AND id <> ?').all(companyId, sl.id).map((r) => r.journal_line_id));
  return openBookLines(companyId, box).filter((b) => !taken.has(b.id)).map((b) => ({ ...b, confidence: score(sl, b) }))
    .sort((a, b) => b.confidence - a.confidence || Math.abs(a.amount_minor - sl.amount_minor) - Math.abs(b.amount_minor - sl.amount_minor)).slice(0, 30);
}

// action: 'match' (journalLineId; amounts must be equal) | 'confirm'
// (accept the suggestion) | 'unmatch' | 'ignore' | 'unignore'
function reviewLine(companyId, lineId, { action, journalLineId } = {}, actor) {
  return ledger.transaction(() => {
    const sl = owned(companyId, 'bank_statement_line', lineId);
    const box = usableBox(companyId, sl.cash_box_id, actor);
    const before = { ...sl };
    if (action === 'match') {
      const jl = owned(companyId, 'journal_line', journalLineId);
      const bl = openBookLines(companyId, box).find((b) => b.id === jl.id);
      if (!bl) fail('line_not_available', 'سطر القيد ليس على هذا الحساب البنكي أو مطابق مسبقًا', 409);
      if (db.prepare('SELECT 1 FROM bank_statement_lines WHERE journal_line_id = ? AND id <> ?').get(jl.id, sl.id)) fail('line_not_available', 'سطر القيد مقترح أو مطابق مع سطر كشف آخر', 409);
      if (bl.amount_minor !== sl.amount_minor) fail('amount_mismatch', `المبلغان غير متساويين (${fromMinor(sl.amount_minor, digitsOf(companyId, box.currency_code))} / ${fromMinor(bl.amount_minor, digitsOf(companyId, box.currency_code))}) — سجّل الفرق بسند (مثل عمولة بنكية) ثم طابق`, 409);
      db.prepare("UPDATE bank_statement_lines SET status = 'matched', journal_line_id = ?, confidence = ?, match_method = 'manual', matched_by = ?, matched_at = datetime('now') WHERE id = ?").run(jl.id, score(sl, bl), actor?.id ?? null, sl.id);
    } else if (action === 'confirm') {
      if (sl.status !== 'suggested') fail('not_suggested', 'لا يوجد اقتراح لهذا السطر', 409);
      db.prepare("UPDATE bank_statement_lines SET status = 'matched', match_method = 'confirmed', matched_by = ?, matched_at = datetime('now') WHERE id = ?").run(actor?.id ?? null, sl.id);
    } else if (action === 'unmatch') {
      db.prepare("UPDATE bank_statement_lines SET status = 'unmatched', journal_line_id = NULL, confidence = NULL, match_method = NULL, matched_by = NULL, matched_at = NULL WHERE id = ?").run(sl.id);
    } else if (action === 'ignore') {
      db.prepare("UPDATE bank_statement_lines SET status = 'ignored', journal_line_id = NULL, confidence = NULL, matched_by = ?, matched_at = datetime('now') WHERE id = ?").run(actor?.id ?? null, sl.id);
    } else if (action === 'unignore') {
      if (sl.status !== 'ignored') fail('not_ignored', 'السطر غير متجاهل', 409);
      db.prepare("UPDATE bank_statement_lines SET status = 'unmatched', matched_by = NULL, matched_at = NULL WHERE id = ?").run(sl.id);
    } else fail('invalid_action', 'إجراء غير صالح');
    const after = statementLineView(companyId, db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(sl.id));
    logAudit({ companyId, actor: actorOf(actor), action: `treasury.bank.${action}`, entityType: 'bank_statement_line', entityId: sl.id, before, after });
    return after;
  });
}

// Book balance vs bank balance with the reconciling items, as of a date.
// Reconciliation starts at the first imported statement: book lines before
// it are covered by that statement's opening balance.
function reconciliationReport(companyId, boxId, { asOf } = {}, actor) {
  const box = usableBox(companyId, boxId, actor, { kind: 'bank' });
  const date = asOf || today();
  if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
  const firstSt = db.prepare('SELECT * FROM bank_statements WHERE cash_box_id = ? AND date_from <= ? ORDER BY date_from, id LIMIT 1').get(box.id, date);
  const book = boxBalance(companyId, box, date);
  const start = firstSt?.date_from || null;
  const outstanding = start ? openBookLines(companyId, box, { upTo: date }).filter((l) => l.entry_date >= start) : [];
  const bankOnly = db.prepare("SELECT * FROM bank_statement_lines WHERE cash_box_id = ? AND line_date <= ? AND status IN ('unmatched', 'suggested') ORDER BY line_date, id").all(box.id, date);
  const ignored = db.prepare("SELECT * FROM bank_statement_lines WHERE cash_box_id = ? AND line_date <= ? AND status = 'ignored' ORDER BY line_date, id").all(box.id, date);
  const lastLine = db.prepare('SELECT balance_minor FROM bank_statement_lines WHERE cash_box_id = ? AND line_date <= ? AND balance_minor IS NOT NULL ORDER BY line_date DESC, statement_id DESC, line_no DESC LIMIT 1').get(box.id, date);
  const bankMovements = db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s FROM bank_statement_lines WHERE cash_box_id = ? AND line_date <= ? AND status <> 'ignored'").get(box.id, date).s;
  const bankBalance = lastLine ? lastLine.balance_minor : firstSt && firstSt.opening_balance_minor !== null ? firstSt.opening_balance_minor + bankMovements : null;
  const bookAtStart = start ? boxBalance(companyId, box, addDays(start, -1)).balance_minor : 0;
  const openingDiff = firstSt && firstSt.opening_balance_minor !== null ? firstSt.opening_balance_minor - bookAtStart : 0;
  const deposits = outstanding.filter((l) => l.amount_minor > 0).reduce((s, l) => s + l.amount_minor, 0);
  const payments = outstanding.filter((l) => l.amount_minor < 0).reduce((s, l) => s - l.amount_minor, 0);
  const bankIn = bankOnly.filter((l) => l.amount_minor > 0).reduce((s, l) => s + l.amount_minor, 0);
  const bankOut = bankOnly.filter((l) => l.amount_minor < 0).reduce((s, l) => s - l.amount_minor, 0);
  // bank = book - deposits in transit + unpresented payments + bank-only in - bank-only out + opening difference
  const expectedBank = book.balance_minor - deposits + payments + bankIn - bankOut + openingDiff;
  return {
    box: decorateBox(companyId, box), as_of: date, started_at: start,
    book_balance_minor: book.balance_minor,
    deposits_in_transit_minor: deposits, unpresented_payments_minor: payments,
    bank_only_in_minor: bankIn, bank_only_out_minor: bankOut, opening_difference_minor: openingDiff,
    expected_bank_balance_minor: expectedBank, bank_balance_minor: bankBalance,
    difference_minor: bankBalance === null ? null : bankBalance - expectedBank,
    outstanding_book_lines: outstanding, unmatched_bank_lines: bankOnly, ignored_bank_lines: ignored,
  };
}

module.exports = {
  ensureMainBox,
  listBoxes,
  getBox,
  createBox,
  updateBox,
  canUseBox,
  boxBalance,
  listVouchers,
  getVoucher,
  createVoucher,
  updateVoucher,
  deleteVoucher,
  rejectVoucher,
  approveVoucher,
  reverseVoucher,
  listIssuedCheques,
  getIssuedCheque,
  issueCheque,
  handOverCheque,
  clearIssuedCheque,
  bounceIssuedCheque,
  cancelIssuedCheque,
  repCashEnabled,
  repCashItems,
  repCashSummary,
  createHandover,
  getHandover,
  listHandovers,
  reverseHandover,
  dailyCashReport,
  sweepDueCheques,
  guessMapping,
  parseCsv,
  parseAmountCell,
  parseDateCell,
  importStatement,
  autoMatch,
  getStatement,
  listStatements,
  matchCandidates,
  reviewLine,
  reconciliationReport,
  usableBox,
};
