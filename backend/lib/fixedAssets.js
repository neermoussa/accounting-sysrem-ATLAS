// backend/lib/fixedAssets.js
//
// Prompt 10 — fixed assets: categories (accounts), the asset register,
// monthly depreciation, disposal / sale with gain or loss, the asset
// schedule. Assets are also created by posting a supplier expense invoice
// whose line is marked as an asset (lib/payables.js).
//
// Conventions
//  - Full-month convention: depreciation starts in the month of
//    depreciation_start (default: the purchase month) and runs for
//    useful_life_months months. No depreciation in the disposal month.
//  - Straight line, cumulative rounding: after k months the accumulated
//    amount is round(depreciable * k / life); each month posts the
//    difference, so the total is exactly cost - salvage - opening.
//  - Declining balance: NBV * annual rate / 12 (default rate = 2 / life in
//    years, "double declining"), never below salvage; the last month of the
//    life takes NBV down to salvage.
//  - One fa_depreciation row per asset per month (UNIQUE): a period is
//    posted once whatever the number of runs (idempotent); a run catches up
//    every missing month up to the requested one, in order.
//
// Postings (lib/ledger.js):
//   acquisition (manual, with a funding account)  Dr asset / Cr funding
//   acquisition (supplier invoice line)           Dr asset (in the invoice entry)
//   depreciation   Dr category expense / Cr accumulated depreciation
//   disposal       Dr accumulated / Dr proceeds account / Cr asset cost /
//                  Cr (gain) or Dr (loss) the category's disposal account

const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const documentNumbering = require('./documentNumbering');
const { logAudit } = require('./auditLog');
const { checkpoint } = require('./faultInjection');
const { requirePostable } = require('./periodGuard');

class FixedAssetError extends ledger.LedgerError {}
const fail = (code, message, status = 400, extra) => {
  throw new FixedAssetError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const isPeriod = (p) => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
const today = () => new Date().toISOString().slice(0, 10);
const METHODS = ['straight_line', 'declining_balance'];

const monthIndex = (p) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7)) - 1;
const periodOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const lastDay = (p) => {
  const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
};
// round(a * b / c) for non-negative integers, exact.
const mulDivRound = (a, b, c) => Number((BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (BigInt(c) * 2n));

function owned(companyId, kind, id, opts) {
  try {
    return tenantRefs.requireOwned(companyId, kind, id, opts);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message, 400);
    throw err;
  }
}
function ownedRow(companyId, table, id, code, label) {
  const n = Number(id);
  const r = Number.isInteger(n) && n > 0 ? db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(n, companyId) : null;
  if (!r) fail(code, `${label} غير موجود أو لا يتبع لهذه الشركة`, 400);
  return r;
}
const postable = (companyId, id, label, types) => {
  const a = owned(companyId, 'account', id, { active: true });
  if (!a.is_postable) fail('account_not_postable', `${label}: اختر حسابًا فرعيًا`);
  if (types && !types.includes(a.type)) fail('invalid_account_type', `${label}: نوع الحساب غير مناسب`);
  return a;
};
const money = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail('invalid_amount', `${label}: مبلغ غير صالح`);
  return n;
};

// ---------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------

function listCategories(companyId) {
  return db.prepare('SELECT * FROM fa_categories WHERE company_id = ? ORDER BY name').all(companyId);
}

function saveCategory(companyId, id, input = {}, actor) {
  return ledger.transaction(() => {
    const existing = id ? ownedRow(companyId, 'fa_categories', id, 'invalid_category', 'فئة الأصل') : null;
    const name = String(input.name ?? existing?.name ?? '').trim();
    if (!name) fail('name_required', 'اسم الفئة مطلوب');
    const asset = postable(companyId, input.assetAccountId ?? existing?.asset_account_id, 'حساب الأصل', ['asset']).id;
    const acc = postable(companyId, input.accumulatedAccountId ?? existing?.accumulated_account_id, 'حساب مجمع الإهلاك', ['asset']).id;
    const exp = postable(companyId, input.expenseAccountId ?? existing?.expense_account_id, 'حساب مصروف الإهلاك', ['expense']).id;
    const disp = postable(companyId, input.disposalAccountId ?? existing?.disposal_account_id, 'حساب أرباح/خسائر الاستبعاد', ['revenue', 'expense']).id;
    if (asset === acc) fail('same_accounts', 'حساب الأصل ومجمع الإهلاك يجب أن يختلفا');
    const life = input.defaultLifeMonths ?? existing?.default_life_months ?? null;
    if (life !== null && life !== '' && !(Number.isInteger(Number(life)) && Number(life) > 0)) fail('invalid_life', 'العمر الإنتاجي غير صالح');
    const method = input.defaultMethod ?? existing?.default_method ?? 'straight_line';
    if (!METHODS.includes(method)) fail('invalid_method', 'طريقة الإهلاك غير صالحة');
    if (db.prepare('SELECT 1 FROM fa_categories WHERE company_id = ? AND name = ? AND id <> ?').get(companyId, name, existing?.id ?? 0)) fail('duplicate_category', 'اسم الفئة مستخدم', 409);
    const vals = [name, asset, acc, exp, disp, life === '' || life === null ? null : Number(life), method, input.active === undefined ? existing?.active ?? 1 : input.active ? 1 : 0];
    let cid = existing?.id;
    if (existing) db.prepare('UPDATE fa_categories SET name = ?, asset_account_id = ?, accumulated_account_id = ?, expense_account_id = ?, disposal_account_id = ?, default_life_months = ?, default_method = ?, active = ? WHERE id = ?').run(...vals, cid);
    else cid = Number(db.prepare('INSERT INTO fa_categories (company_id, name, asset_account_id, accumulated_account_id, expense_account_id, disposal_account_id, default_life_months, default_method, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(companyId, ...vals).lastInsertRowid);
    const after = db.prepare('SELECT * FROM fa_categories WHERE id = ?').get(cid);
    logAudit({ companyId, actor: actorOf(actor), action: existing ? 'fixed_assets.category.update' : 'fixed_assets.category.create', entityType: 'fa_category', entityId: cid, before: existing, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------

function accumulated(asset) {
  return asset.opening_accumulated_minor + db.prepare('SELECT COALESCE(SUM(amount_minor), 0) s FROM fa_depreciation WHERE asset_id = ?').get(asset.id).s;
}

function getAsset(companyId, id) {
  const a = ownedRow(companyId, 'fixed_assets', id, 'invalid_asset', 'الأصل');
  const acc = accumulated(a);
  return {
    ...a,
    category: db.prepare('SELECT * FROM fa_categories WHERE id = ?').get(a.category_id),
    accumulated_minor: acc,
    nbv_minor: a.status === 'disposed' ? 0 : a.cost_minor - acc,
    depreciation: db.prepare('SELECT d.*, e.entry_number FROM fa_depreciation d LEFT JOIN journal_entries e ON e.id = d.journal_entry_id WHERE d.asset_id = ? ORDER BY d.period').all(a.id),
  };
}

function listAssets(companyId, { status, categoryId } = {}) {
  const w = ['a.company_id = ?'];
  const p = [companyId];
  if (status) { w.push('a.status = ?'); p.push(status); }
  if (categoryId) { w.push('a.category_id = ?'); p.push(Number(categoryId)); }
  return db.prepare(`SELECT a.*, c.name category_name FROM fixed_assets a JOIN fa_categories c ON c.id = a.category_id WHERE ${w.join(' AND ')} ORDER BY a.id`).all(...p)
    .map((a) => { const acc = accumulated(a); return { ...a, accumulated_minor: acc, nbv_minor: a.status === 'disposed' ? 0 : a.cost_minor - acc }; });
}

// Shared by the manual register and supplier-invoice posting. `entryLines`
// false = the acquisition is already in another entry (the invoice).
function insertAsset(companyId, input, actor, { invoiceId = null, invoiceLineId = null } = {}) {
  const cat = ownedRow(companyId, 'fa_categories', input.categoryId, 'invalid_category', 'فئة الأصل');
  if (!cat.active) fail('category_inactive', 'فئة الأصل غير مفعّلة');
  const name = String(input.name || '').trim();
  if (!name) fail('name_required', 'اسم الأصل مطلوب');
  const cost = money(input.costMinor, 'التكلفة');
  if (cost <= 0) fail('invalid_amount', 'التكلفة يجب أن تكون أكبر من صفر');
  const salvage = money(input.salvageMinor ?? 0, 'القيمة التخريدية');
  const opening = money(input.openingAccumulatedMinor ?? 0, 'الإهلاك المتراكم الافتتاحي');
  if (salvage + opening > cost) fail('invalid_salvage', 'القيمة التخريدية + الإهلاك المتراكم أكبر من التكلفة');
  const purchaseDate = input.purchaseDate;
  if (!isValidDate(purchaseDate)) fail('invalid_date', 'تاريخ الشراء غير صالح');
  const start = input.depreciationStart || `${purchaseDate.slice(0, 7)}-01`;
  if (!isValidDate(start)) fail('invalid_date', 'تاريخ بدء الإهلاك غير صالح');
  const life = Number(input.usefulLifeMonths ?? cat.default_life_months);
  if (!Number.isInteger(life) || life <= 0) fail('invalid_life', 'العمر الإنتاجي (بالأشهر) مطلوب');
  const method = input.method || cat.default_method;
  if (!METHODS.includes(method)) fail('invalid_method', 'طريقة الإهلاك غير صالحة');
  let rate = null;
  if (method === 'declining_balance') {
    rate = input.decliningRate !== undefined && input.decliningRate !== null && input.decliningRate !== '' ? Math.round(Number(input.decliningRate) * 100) : Math.min(10000, Math.round(240000 / life));
    if (!Number.isInteger(rate) || rate <= 0 || rate > 10000) fail('invalid_rate', 'نسبة الإهلاك المتناقص غير صالحة');
  }
  const number = documentNumbering.issueNext(companyId, 'fixed_asset');
  const id = Number(db.prepare(`INSERT INTO fixed_assets (company_id, asset_number, name, category_id, cost_minor, salvage_minor, purchase_date, depreciation_start, useful_life_months, method, declining_rate_bp, opening_accumulated_minor, supplier_invoice_id, supplier_invoice_line_id, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, number, name, cat.id, cost, salvage, purchaseDate, start, life, method, rate, opening, invoiceId, invoiceLineId, input.notes || null, actor?.id ?? null).lastInsertRowid);
  return { id, cat, cost, opening, number, purchaseDate };
}

// Manual registration. fundingAccountId -> posts Dr asset / Cr funding (a
// purchase paid outside a supplier invoice); without it the asset is
// registered only (an existing asset already in the opening balances).
function createAsset(companyId, input = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const r = insertAsset(companyId, input, actor);
    if (input.fundingAccountId) {
      const fund = postable(companyId, input.fundingAccountId, 'حساب التمويل');
      const lines = [
        { accountId: r.cat.asset_account_id, debitMinor: r.cost, memo: `${r.number} ${input.name}` },
        { accountId: fund.id, creditMinor: r.cost - r.opening, memo: `شراء أصل ${r.number}` },
      ];
      if (r.opening) lines.push({ accountId: r.cat.accumulated_account_id, creditMinor: r.opening, memo: 'إهلاك متراكم افتتاحي' });
      ledger.postEntry(companyId, { date: r.purchaseDate, description: `اقتناء أصل ثابت ${r.number}`, sourceType: 'fixed_asset', sourceId: r.id, lines }, actor);
      checkpoint('fixed_assets.create.after_entry');
    }
    const after = getAsset(companyId, r.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'fixed_assets.asset.create', entityType: 'fixed_asset', entityId: r.id, after });
    return after;
  });
}

// From lib/payables.js postInvoice, inside its transaction.
function createFromInvoiceLine(companyId, { invoice, line, spec, costBaseMinor }, actor) {
  const r = insertAsset(companyId, {
    categoryId: spec.category_id,
    name: spec.name || line.description,
    costMinor: costBaseMinor,
    salvageMinor: spec.salvage_minor,
    usefulLifeMonths: spec.useful_life_months ?? undefined,
    method: spec.method || undefined,
    purchaseDate: invoice.invoice_date,
  }, actor, { invoiceId: invoice.id, invoiceLineId: line.id });
  logAudit({ companyId, actor: actorOf(actor), action: 'fixed_assets.asset.create_from_invoice', entityType: 'fixed_asset', entityId: r.id, after: { invoice_id: invoice.id, line_id: line.id, cost_minor: costBaseMinor } });
  return r.id;
}

// ---------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------

// The amount for month k (0-based from the start month) given what is
// already posted. 0 once the life is over or NBV reached salvage.
function monthAmount(asset, k, postedSum) {
  const L = asset.useful_life_months;
  if (k < 0 || k >= L) return 0;
  const depreciable = asset.cost_minor - asset.salvage_minor - asset.opening_accumulated_minor;
  if (depreciable <= 0) return 0;
  const room = depreciable - postedSum;
  if (room <= 0) return 0;
  if (asset.method === 'straight_line') return Math.max(0, Math.min(room, mulDivRound(depreciable, k + 1, L) - postedSum));
  if (k === L - 1) return room;
  const nbv = asset.cost_minor - asset.opening_accumulated_minor - postedSum;
  return Math.min(room, mulDivRound(nbv, asset.declining_rate_bp, 120000));
}

// Projected schedule (posted months as posted, the rest computed).
function schedule(companyId, id) {
  const a = ownedRow(companyId, 'fixed_assets', id, 'invalid_asset', 'الأصل');
  const posted = new Map(db.prepare('SELECT period, amount_minor, journal_entry_id FROM fa_depreciation WHERE asset_id = ?').all(a.id).map((r) => [r.period, r]));
  const s0 = monthIndex(a.depreciation_start.slice(0, 7));
  const out = [];
  let sum = 0;
  for (let k = 0; k < a.useful_life_months; k += 1) {
    const p = periodOf(s0 + k);
    const row = posted.get(p);
    const amt = row ? row.amount_minor : a.status === 'disposed' ? 0 : monthAmount(a, k, sum);
    sum += amt;
    out.push({ period: p, amount_minor: amt, accumulated_minor: a.opening_accumulated_minor + sum, nbv_minor: a.cost_minor - a.opening_accumulated_minor - sum, posted: Boolean(row), journal_entry_id: row?.journal_entry_id ?? null });
  }
  return { asset_id: a.id, asset_number: a.asset_number, method: a.method, rows: out };
}

// Post every missing month of every active asset up to `period`
// (inclusive). Re-running posts nothing new.
function runDepreciation(companyId, { period, assetId } = {}, actor) {
  if (!isPeriod(period)) fail('invalid_period', 'الفترة يجب أن تكون بصيغة YYYY-MM');
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const target = monthIndex(period);
    const assets = db.prepare(`SELECT * FROM fixed_assets WHERE company_id = ? AND status = 'active' ${assetId ? 'AND id = ?' : ''} ORDER BY id`).all(...(assetId ? [companyId, Number(assetId)] : [companyId]));
    const posted = [];
    for (const a of assets) {
      const cat = db.prepare('SELECT * FROM fa_categories WHERE id = ?').get(a.category_id);
      const s0 = monthIndex(a.depreciation_start.slice(0, 7));
      const done = new Set(db.prepare('SELECT period FROM fa_depreciation WHERE asset_id = ?').all(a.id).map((r) => r.period));
      let sum = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) s FROM fa_depreciation WHERE asset_id = ?').get(a.id).s;
      const end = Math.min(target, s0 + a.useful_life_months - 1);
      for (let i = s0; i <= end; i += 1) {
        const p = periodOf(i);
        if (done.has(p)) continue;
        const amt = monthAmount(a, i - s0, sum);
        requirePostable(companyId, lastDay(p), `إهلاك ${a.asset_number} عن ${p}`);
        const rowId = Number(db.prepare('INSERT INTO fa_depreciation (company_id, asset_id, period, amount_minor) VALUES (?, ?, ?, ?)').run(companyId, a.id, p, amt).lastInsertRowid);
        if (amt > 0) {
          const e = ledger.postEntry(companyId, {
            date: lastDay(p),
            description: `إهلاك ${a.asset_number} ${a.name} — ${p}`,
            sourceType: 'fa_depreciation',
            sourceId: rowId,
            lines: [
              { accountId: cat.expense_account_id, debitMinor: amt, memo: `إهلاك ${a.asset_number}` },
              { accountId: cat.accumulated_account_id, creditMinor: amt, memo: `مجمع إهلاك ${a.asset_number}` },
            ],
          }, actor);
          checkpoint('fixed_assets.depreciation.after_entry');
          db.prepare('UPDATE fa_depreciation SET journal_entry_id = ? WHERE id = ?').run(e.id, rowId);
          posted.push({ asset_id: a.id, period: p, amount_minor: amt, journal_entry_id: e.id });
        }
        sum += amt;
      }
      if (sum >= a.cost_minor - a.salvage_minor - a.opening_accumulated_minor || end === s0 + a.useful_life_months - 1) {
        db.prepare("UPDATE fixed_assets SET status = 'fully_depreciated' WHERE id = ?").run(a.id);
      }
    }
    const total = posted.reduce((s, x) => s + x.amount_minor, 0);
    if (posted.length) logAudit({ companyId, actor: actorOf(actor), action: 'fixed_assets.depreciation.run', entityType: 'fa_depreciation', entityId: null, after: { period, entries: posted.length, total_minor: total } });
    return { period, entries: posted.length, total_minor: total, posted };
  });
}

// Background: depreciation for every company with active assets up to the
// last complete month. Errors (e.g. a closed period) are logged per company.
function sweep(asOf = today()) {
  const prev = periodOf(monthIndex(asOf.slice(0, 7)) - 1);
  const out = [];
  for (const { company_id: cid } of db.prepare("SELECT DISTINCT company_id FROM fixed_assets WHERE status = 'active'").all()) {
    try {
      out.push({ company_id: cid, ...require('./postingQueue').guard(cid, { kind: 'depreciation.run', sourceId: prev, label: `إهلاك ${prev}` }, () => runDepreciation(cid, { period: prev }, null), null) });
    } catch (err) {
      out.push({ company_id: cid, error: err.code || err.message });
    }
  }
  return out;
}

// Assets whose depreciation for a month (YYYY-MM) is still missing.
function missingDepreciation(companyId, period) {
  const i = monthIndex(period);
  return db.prepare("SELECT * FROM fixed_assets WHERE company_id = ? AND status = 'active'").all(companyId)
    .filter((a) => {
      const s0 = monthIndex(a.depreciation_start.slice(0, 7));
      if (i < s0 || i > s0 + a.useful_life_months - 1) return false;
      return !db.prepare('SELECT 1 FROM fa_depreciation WHERE asset_id = ? AND period = ?').get(a.id, period);
    }).length;
}

// ---------------------------------------------------------------------
// Disposal / sale
// ---------------------------------------------------------------------

// Catches up depreciation to the month before the disposal month, then
// derecognises the asset. proceeds (minor, base) to proceedsAccountId
// (cash / bank / receivable); gain = proceeds - NBV.
function dispose(companyId, id, { date, proceedsMinor = 0, proceedsAccountId, reason } = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const a = ownedRow(companyId, 'fixed_assets', id, 'invalid_asset', 'الأصل');
    if (a.status === 'disposed') fail('already_disposed', 'تم استبعاد الأصل مسبقًا', 409);
    if (!isValidDate(date)) fail('invalid_date', 'تاريخ الاستبعاد غير صالح');
    if (date < a.purchase_date) fail('invalid_date', 'تاريخ الاستبعاد قبل تاريخ الشراء');
    requirePostable(companyId, date, `استبعاد ${a.asset_number}`);
    const proceeds = money(proceedsMinor, 'قيمة البيع');
    const fund = proceeds ? postable(companyId, proceedsAccountId, 'حساب المتحصلات') : null;
    const dm = monthIndex(date.slice(0, 7));
    const later = db.prepare('SELECT period FROM fa_depreciation WHERE asset_id = ? ORDER BY period DESC LIMIT 1').get(a.id);
    if (later && monthIndex(later.period) >= dm) fail('depreciated_after_disposal', `يوجد إهلاك مرحّل عن ${later.period} — تاريخ الاستبعاد يجب أن يكون بعده`, 409);
    if (a.status === 'active' && dm - 1 >= monthIndex(a.depreciation_start.slice(0, 7))) runDepreciation(companyId, { period: periodOf(dm - 1), assetId: a.id }, actor);
    const cat = db.prepare('SELECT * FROM fa_categories WHERE id = ?').get(a.category_id);
    const acc = accumulated(a);
    const nbv = a.cost_minor - acc;
    const gain = proceeds - nbv;
    const lines = [
      ...(acc ? [{ accountId: cat.accumulated_account_id, debitMinor: acc, memo: `مجمع إهلاك ${a.asset_number}` }] : []),
      ...(proceeds ? [{ accountId: fund.id, debitMinor: proceeds, memo: `متحصلات بيع ${a.asset_number}` }] : []),
      { accountId: cat.asset_account_id, creditMinor: a.cost_minor, memo: `استبعاد ${a.asset_number}` },
      ...(gain > 0 ? [{ accountId: cat.disposal_account_id, creditMinor: gain, memo: 'ربح استبعاد أصل' }] : []),
      ...(gain < 0 ? [{ accountId: cat.disposal_account_id, debitMinor: -gain, memo: 'خسارة استبعاد أصل' }] : []),
    ];
    const e = ledger.postEntry(companyId, { date, description: `${proceeds ? 'بيع' : 'استبعاد'} أصل ثابت ${a.asset_number} ${a.name}`, sourceType: 'fa_disposal', sourceId: a.id, lines }, actor);
    checkpoint('fixed_assets.dispose.after_entry');
    db.prepare("UPDATE fixed_assets SET status = 'disposed', disposal_date = ?, disposal_proceeds_minor = ?, disposal_gain_loss_minor = ?, disposal_entry_id = ?, notes = COALESCE(?, notes) WHERE id = ?").run(date, proceeds, gain, e.id, reason || null, a.id);
    const after = getAsset(companyId, a.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'fixed_assets.asset.dispose', entityType: 'fixed_asset', entityId: a.id, before: { status: a.status }, after: { status: 'disposed', proceeds_minor: proceeds, gain_loss_minor: gain, nbv_minor: nbv, journal_entry_id: e.id } });
    return { ...after, gain_loss_minor: gain, nbv_at_disposal_minor: nbv };
  });
}

// ---------------------------------------------------------------------
// Asset schedule report (cost, accumulated, NBV as of a date; the
// period's depreciation; per category totals)
// ---------------------------------------------------------------------

function scheduleReport(companyId, { from, to } = {}) {
  const end = to || today();
  const start = from || `${end.slice(0, 4)}-01-01`;
  if (!isValidDate(start) || !isValidDate(end) || start > end) fail('invalid_period', 'الفترة غير صالحة');
  const pFrom = start.slice(0, 7);
  const pTo = end.slice(0, 7);
  const rows = db.prepare(`SELECT a.*, c.name category_name FROM fixed_assets a JOIN fa_categories c ON c.id = a.category_id
    WHERE a.company_id = ? AND a.purchase_date <= ? AND (a.disposal_date IS NULL OR a.disposal_date >= ?) ORDER BY c.name, a.id`).all(companyId, end, start).map((a) => {
    const sumTo = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) s FROM fa_depreciation WHERE asset_id = ? AND period <= ?').get(a.id, pTo).s;
    const inPeriod = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) s FROM fa_depreciation WHERE asset_id = ? AND period BETWEEN ? AND ?').get(a.id, pFrom, pTo).s;
    const disposed = a.disposal_date && a.disposal_date <= end;
    const acc = a.opening_accumulated_minor + sumTo;
    return {
      id: a.id, asset_number: a.asset_number, name: a.name, category: a.category_name, method: a.method, purchase_date: a.purchase_date,
      cost_minor: disposed ? 0 : a.cost_minor,
      depreciation_in_period_minor: inPeriod,
      accumulated_minor: disposed ? 0 : acc,
      nbv_minor: disposed ? 0 : a.cost_minor - acc,
      status: disposed ? 'disposed' : a.status,
      disposal_date: a.disposal_date, disposal_gain_loss_minor: disposed ? a.disposal_gain_loss_minor : null,
    };
  });
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return { from: start, to: end, rows, totals: { cost_minor: sum('cost_minor'), depreciation_in_period_minor: sum('depreciation_in_period_minor'), accumulated_minor: sum('accumulated_minor'), nbv_minor: sum('nbv_minor') } };
}

const usesFixedAssets = (companyId) => Boolean(db.prepare('SELECT 1 FROM fixed_assets WHERE company_id = ? LIMIT 1').get(companyId));

module.exports = {
  FixedAssetError, METHODS,
  listCategories, saveCategory,
  listAssets, getAsset, createAsset, createFromInvoiceLine,
  monthAmount, schedule, runDepreciation, sweep, missingDepreciation,
  dispose, scheduleReport, usesFixedAssets, lastDay, periodOf, monthIndex,
};
