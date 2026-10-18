import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError, accountLabel } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

// Prompt 10: fixed assets (categories, register, depreciation run,
// disposal, schedule), tax codes (effective-dated rates, tax report) and
// recurring templates (recurring / accrual / prepayment). /api/accounting.
const TABS = ['assets', 'depreciation', 'tax', 'recurring'];
const D = () => new Date().toISOString().slice(0, 10);
const thisYear = () => `${D().slice(0, 4)}-01-01`;
const prevMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

function AccountSelect({ value, onChange, accounts, label, filter }) {
  const rows = filter ? accounts.filter(filter) : accounts;
  return (
    <label className="ledger-field">{label}
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {rows.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
      </select>
    </label>
  );
}

export default function AdjustmentsPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => { api.acGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (msg) setNotice(msg);
      return r;
    } catch (err) {
      setError(ledgerError(err, t));
      return null;
    }
  };
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const allowed = TABS.filter((k) => (k === 'tax' ? can('manage_tax_codes') : k === 'recurring' ? can('manage_recurring_entries') : can('manage_fixed_assets')));
  const tab = allowed.includes(sp.get('tab')) ? sp.get('tab') : allowed[0];
  const m = (minor) => formatMinor(minor || 0, meta.digits);
  const props = { t, meta, act, m };
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.adjustments')}</h1><p className="ledger-subtitle">{t('ax.subtitle')}</p></div>
      </div>
      <div className="ledger-tabs">{allowed.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`ax.tab.${k}`)}</button>)}</div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {tab === 'assets' && <Assets {...props} />}
      {tab === 'depreciation' && <Depreciation {...props} />}
      {tab === 'tax' && <Tax {...props} />}
      {tab === 'recurring' && <Recurring {...props} />}
    </div>
  );
}

function Assets({ t, meta, act, m }) {
  const [cats, setCats] = useState([]);
  const [assets, setAssets] = useState([]);
  const [cat, setCat] = useState({ name: '', assetAccountId: '', accumulatedAccountId: '', expenseAccountId: '', disposalAccountId: '', defaultLifeMonths: '', defaultMethod: 'straight_line' });
  const [f, setF] = useState({ categoryId: '', name: '', cost: '', salvage: '', purchaseDate: D(), usefulLifeMonths: '', method: '', fundingAccountId: '' });
  const [disp, setDisp] = useState(null);
  const [sched, setSched] = useState(null);
  const load = () => Promise.all([api.acGet('/asset-categories').then(setCats), api.acGet('/assets').then(setAssets)]).catch(() => {});
  useEffect(() => { load(); }, []);
  const A = meta.accounts;
  return (
    <>
      <section className="ledger-card">
        <h2>{t('ax.categories')}</h2>
        <table className="ledger-table"><thead><tr><th>{t('ax.name')}</th><th>{t('ax.assetAccount')}</th><th>{t('ax.accumulatedAccount')}</th><th>{t('ax.expenseAccount')}</th><th>{t('ax.disposalAccount')}</th><th>{t('ax.life')}</th></tr></thead>
          <tbody>{cats.map((c) => { const a = (id) => accountLabel(A.find((x) => x.id === id)); return <tr key={c.id}><td>{c.name}</td><td>{a(c.asset_account_id)}</td><td>{a(c.accumulated_account_id)}</td><td>{a(c.expense_account_id)}</td><td>{a(c.disposal_account_id)}</td><td>{c.default_life_months || '—'}</td></tr>; })}</tbody></table>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ax.name')}<input value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} /></label>
          <AccountSelect label={t('ax.assetAccount')} accounts={A} filter={(a) => a.type === 'asset'} value={cat.assetAccountId} onChange={(v) => setCat({ ...cat, assetAccountId: v })} />
          <AccountSelect label={t('ax.accumulatedAccount')} accounts={A} filter={(a) => a.type === 'asset'} value={cat.accumulatedAccountId} onChange={(v) => setCat({ ...cat, accumulatedAccountId: v })} />
          <AccountSelect label={t('ax.expenseAccount')} accounts={A} filter={(a) => a.type === 'expense'} value={cat.expenseAccountId} onChange={(v) => setCat({ ...cat, expenseAccountId: v })} />
          <AccountSelect label={t('ax.disposalAccount')} accounts={A} filter={(a) => ['revenue', 'expense'].includes(a.type)} value={cat.disposalAccountId} onChange={(v) => setCat({ ...cat, disposalAccountId: v })} />
          <label className="ledger-field">{t('ax.life')}<input type="number" value={cat.defaultLifeMonths} onChange={(e) => setCat({ ...cat, defaultLifeMonths: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.method')}<select value={cat.defaultMethod} onChange={(e) => setCat({ ...cat, defaultMethod: e.target.value })}><option value="straight_line">{t('ax.method.straight_line')}</option><option value="declining_balance">{t('ax.method.declining_balance')}</option></select></label>
        </div>
        <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.acPost('/asset-categories', { ...cat, defaultLifeMonths: cat.defaultLifeMonths || null }), t('ax.saved'))) load(); }}>{t('ax.addCategory')}</button>
      </section>
      <section className="ledger-card">
        <h2>{t('ax.register')}</h2>
        <table className="ledger-table"><thead><tr><th>#</th><th>{t('ax.name')}</th><th>{t('ax.category')}</th><th>{t('ax.cost')}</th><th>{t('ax.accumulated')}</th><th>{t('ax.nbv')}</th><th>{t('ax.status')}</th><th /></tr></thead>
          <tbody>{assets.map((a) => (
            <tr key={a.id}><td>{a.asset_number}</td><td>{a.name}</td><td>{a.category_name}</td><td className="num">{m(a.cost_minor)}</td><td className="num">{m(a.accumulated_minor)}</td><td className="num">{m(a.nbv_minor)}</td><td>{t(`ax.status.${a.status}`)}</td>
              <td><button type="button" className="ledger-link-btn" onClick={() => api.acGet(`/assets/${a.id}/schedule`).then(setSched)}>{t('ax.schedule')}</button>{a.status !== 'disposed' && <button type="button" className="ledger-link-btn" onClick={() => setDisp({ id: a.id, date: D(), proceeds: '', proceedsAccountId: '', reason: '' })}>{t('ax.dispose')}</button>}</td></tr>
          ))}</tbody></table>
        {disp && (
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('ax.date')}<input type="date" value={disp.date} onChange={(e) => setDisp({ ...disp, date: e.target.value })} /></label>
            <label className="ledger-field">{t('ax.proceeds')}<input value={disp.proceeds} onChange={(e) => setDisp({ ...disp, proceeds: e.target.value })} /></label>
            <AccountSelect label={t('ax.proceedsAccount')} accounts={A} filter={(a) => a.type === 'asset'} value={disp.proceedsAccountId} onChange={(v) => setDisp({ ...disp, proceedsAccountId: v })} />
            <label className="ledger-field">{t('ax.reason')}<input value={disp.reason} onChange={(e) => setDisp({ ...disp, reason: e.target.value })} /></label>
            <button type="button" className="gold-btn" onClick={async () => { const r = await act(() => api.acPost(`/assets/${disp.id}/dispose`, disp)); if (r) { setDisp(null); load(); act(async () => null, `${t('ax.disposed')}: ${r.gain_loss_minor >= 0 ? t('ax.gain') : t('ax.loss')} ${m(Math.abs(r.gain_loss_minor))}`); } }}>{t('ax.confirmDispose')}</button>
          </div>
        )}
        {sched && (
          <table className="ledger-table"><thead><tr><th>{t('ax.period')}</th><th>{t('ax.amount')}</th><th>{t('ax.accumulated')}</th><th>{t('ax.nbv')}</th><th>{t('ax.posted')}</th></tr></thead>
            <tbody>{sched.rows.map((r) => <tr key={r.period}><td>{r.period}</td><td className="num">{m(r.amount_minor)}</td><td className="num">{m(r.accumulated_minor)}</td><td className="num">{m(r.nbv_minor)}</td><td>{r.posted ? '✓' : ''}</td></tr>)}</tbody></table>
        )}
        <h3>{t('ax.newAsset')}</h3>
        <p className="ledger-subtitle">{t('ax.fromInvoiceHint')}</p>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ax.category')}<select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="ledger-field">{t('ax.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.cost')}<input value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.salvage')}<input value={f.salvage} onChange={(e) => setF({ ...f, salvage: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.purchaseDate')}<input type="date" value={f.purchaseDate} onChange={(e) => setF({ ...f, purchaseDate: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.life')}<input type="number" value={f.usefulLifeMonths} onChange={(e) => setF({ ...f, usefulLifeMonths: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.method')}<select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="">{t('ax.categoryDefault')}</option><option value="straight_line">{t('ax.method.straight_line')}</option><option value="declining_balance">{t('ax.method.declining_balance')}</option></select></label>
          <AccountSelect label={t('ax.fundingAccount')} accounts={A} value={f.fundingAccountId} onChange={(v) => setF({ ...f, fundingAccountId: v })} />
        </div>
        <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.acPost('/assets', { ...f, usefulLifeMonths: f.usefulLifeMonths || undefined, method: f.method || undefined, fundingAccountId: f.fundingAccountId || undefined }), t('ax.saved'))) load(); }}>{t('ax.register.add')}</button>
      </section>
    </>
  );
}

function Depreciation({ t, act, m }) {
  const [period, setPeriod] = useState(prevMonth());
  const [run, setRun] = useState(null);
  const [rep, setRep] = useState(null);
  const [range, setRange] = useState({ from: thisYear(), to: D() });
  const loadRep = () => api.acGet(`/asset-schedule?from=${range.from}&to=${range.to}`).then(setRep).catch(() => {});
  useEffect(() => { loadRep(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <section className="ledger-card">
        <h2>{t('ax.runDepreciation')}</h2>
        <p className="ledger-subtitle">{t('ax.runHint')}</p>
        <div className="ledger-form-grid"><label className="ledger-field">{t('ax.period')}<input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label></div>
        <button type="button" className="gold-btn" onClick={async () => { const r = await act(() => api.acPost('/depreciation/run', { period })); if (r) { setRun(r); loadRep(); } }}>{t('ax.run')}</button>
        {run && <div className="ledger-notice">{t('ax.runResult').replace('{n}', run.entries).replace('{total}', m(run.total_minor))}</div>}
      </section>
      <section className="ledger-card">
        <h2>{t('ax.scheduleReport')}</h2>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ax.from')}<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.to')}<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button type="button" className="gold-btn" onClick={loadRep}>{t('ax.show')}</button>
        </div>
        {rep && (
          <table className="ledger-table"><thead><tr><th>#</th><th>{t('ax.name')}</th><th>{t('ax.category')}</th><th>{t('ax.cost')}</th><th>{t('ax.periodDep')}</th><th>{t('ax.accumulated')}</th><th>{t('ax.nbv')}</th><th>{t('ax.status')}</th></tr></thead>
            <tbody>{rep.rows.map((r) => <tr key={r.id}><td>{r.asset_number}</td><td>{r.name}</td><td>{r.category}</td><td className="num">{m(r.cost_minor)}</td><td className="num">{m(r.depreciation_in_period_minor)}</td><td className="num">{m(r.accumulated_minor)}</td><td className="num">{m(r.nbv_minor)}</td><td>{t(`ax.status.${r.status}`)}</td></tr>)}</tbody>
            <tfoot><tr><td colSpan={3}>{t('ax.total')}</td><td className="num">{m(rep.totals.cost_minor)}</td><td className="num">{m(rep.totals.depreciation_in_period_minor)}</td><td className="num">{m(rep.totals.accumulated_minor)}</td><td className="num">{m(rep.totals.nbv_minor)}</td><td /></tr></tfoot></table>
        )}
      </section>
    </>
  );
}

function Tax({ t, meta, act, m }) {
  const [codes, setCodes] = useState([]);
  const [f, setF] = useState({ code: '', name: '', type: 'sales', accountId: '', rate: '', effectiveFrom: D(), priceMode: '' });
  const [pm, setPm] = useState(null);
  const [newMode, setNewMode] = useState('');
  const loadPm = () => api.acGet('/price-mode').then(setPm).catch(() => {});
  useEffect(() => { loadPm(); }, []);
  const [rate, setRate] = useState({});
  const [range, setRange] = useState({ from: `${D().slice(0, 7)}-01`, to: D() });
  const [rep, setRep] = useState(null);
  const load = () => api.acGet('/tax-codes').then(setCodes).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <>
      <section className="ledger-card">
        <h2>{t('ax.taxCodes')}</h2>
        <p className="ledger-subtitle">{t('ax.taxHint2')}</p>
        {pm && (
          <div className="ledger-form-grid" data-testid="price-mode-setting">
            <span className={pm.mode ? 'ledger-badge' : 'ledger-error'}>{t('ax.priceModeLabel')}: {pm.mode ? t(`ax.mode.${pm.mode}`) : t('ax.notChosen')}</span>
            {pm.has_tax_codes && (
              <>
                <select value={newMode} onChange={(e) => setNewMode(e.target.value)}><option value="">—</option><option value="inclusive">{t('ax.mode.inclusive')}</option><option value="exclusive">{t('ax.mode.exclusive')}</option></select>
                <button type="button" className="ghost-btn" disabled={!newMode} onClick={async () => { if (await act(() => api.acPut('/price-mode', { mode: newMode }), t('ax.saved'))) loadPm(); }}>{pm.mode ? t('ax.changeMode') : t('ax.choose')}</button>
              </>
            )}
          </div>
        )}
        <table className="ledger-table"><thead><tr><th>{t('ax.code')}</th><th>{t('ax.name')}</th><th>{t('ax.type')}</th><th>{t('ax.taxAccount')}</th><th>{t('ax.rates')}</th><th /></tr></thead>
          <tbody>{codes.map((c) => (
            <tr key={c.id}><td>{c.code}</td><td>{c.name}</td><td>{t(`ax.taxType.${c.type}`)}</td><td>{accountLabel(meta.accounts.find((a) => a.id === c.account_id))}</td>
              <td>{(c.rates || []).map((r) => `${r.rate_bp / 100}% ${t('ax.fromDate')} ${r.effective_from}`).join(' · ')}</td>
              <td><input placeholder="%" size={4} value={rate[c.id]?.rate || ''} onChange={(e) => setRate({ ...rate, [c.id]: { ...rate[c.id], rate: e.target.value } })} /><input type="date" value={rate[c.id]?.effectiveFrom || ''} onChange={(e) => setRate({ ...rate, [c.id]: { ...rate[c.id], effectiveFrom: e.target.value } })} />
                <button type="button" className="ledger-link-btn" onClick={async () => { if (await act(() => api.acPost(`/tax-codes/${c.id}/rates`, rate[c.id] || {}), t('ax.saved'))) load(); }}>{t('ax.addRate')}</button></td></tr>
          ))}</tbody></table>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ax.code')}<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.type')}<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="sales">{t('ax.taxType.sales')}</option><option value="purchase">{t('ax.taxType.purchase')}</option></select></label>
          <AccountSelect label={t('ax.taxAccount')} accounts={meta.accounts} filter={(a) => ['liability', 'asset'].includes(a.type)} value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} />
          <label className="ledger-field">{t('ax.rate')}<input value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.effectiveFrom')}<input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></label>
          {pm && !pm.mode && (
            <label className="ledger-field">{t('ax.firstCodeMode')}<select value={f.priceMode} onChange={(e) => setF({ ...f, priceMode: e.target.value })}><option value="">—</option><option value="inclusive">{t('ax.mode.inclusive')}</option><option value="exclusive">{t('ax.mode.exclusive')}</option></select></label>
          )}
        </div>
        <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.acPost('/tax-codes', { ...f, priceMode: f.priceMode || undefined }), t('ax.saved'))) { load(); loadPm(); } }}>{t('ax.addCode')}</button>
      </section>
      <section className="ledger-card">
        <h2>{t('ax.taxReport')}</h2>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ax.from')}<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.to')}<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button type="button" className="gold-btn" onClick={() => act(() => api.acGet(`/tax-report?from=${range.from}&to=${range.to}`).then(setRep))}>{t('ax.show')}</button>
        </div>
        {rep && (
          <>
            <div className={rep.reconciled ? 'ledger-notice' : 'ledger-error'}>{rep.reconciled ? t('ax.reconciled') : t('ax.notReconciled')}</div>
            <table className="ledger-table" data-testid="tax-rows"><thead><tr><th>{t('ax.section')}</th><th>{t('ax.codeOrKind')}</th><th>{t('ax.rate')}</th><th>{t('ax.currency')}</th><th>{t('ax.taxDocCurrency')}</th><th>{t('ax.taxBase')}</th><th>{t('ax.base')}</th><th>{t('ax.docs')}</th></tr></thead>
              <tbody>{rep.rows.map((r, k) => <tr key={k}><td>{t(`ax.section.${r.section}`)}</td><td>{r.section === 'coded' ? r.code : r.section === 'free_rate' ? t(`ax.kindDoc.${r.kind}`) : r.source_type}</td><td>{r.rate !== undefined ? `${r.rate}%` : '—'}</td><td>{r.currency || '—'}</td><td className="num">{r.currency && r.currency !== rep.base_currency ? r.tax_original_minor : '—'}</td><td className="num">{m(r.tax_base_minor)}</td><td className="num">{m(r.taxable_base_minor)}</td><td>{r.documents}</td></tr>)}</tbody>
              <tfoot>
                <tr><td colSpan={5}>{t('ax.totalRows')}</td><td className="num">{m(rep.totals.coded_minor + rep.totals.free_rate_minor + rep.totals.other_minor)}</td><td colSpan={2} /></tr>
                <tr><td colSpan={5}>{t('ax.totalLedger')}</td><td className="num">{m(rep.totals.ledger_net_credit_minor)}</td><td colSpan={2} /></tr>
              </tfoot></table>
            <table className="ledger-table"><thead><tr><th>{t('ax.taxAccount')}</th><th>{t('ax.debit')}</th><th>{t('ax.credit')}</th><th>{t('ax.netCredit')}</th></tr></thead>
              <tbody>{rep.accounts.map((a) => <tr key={a.account_id}><td>{a.code} — {a.name}</td><td className="num">{m(a.debit_minor)}</td><td className="num">{m(a.credit_minor)}</td><td className="num">{m(a.net_credit_minor)}</td></tr>)}</tbody>
              <tfoot>
                <tr><td colSpan={3}>{t('ax.outputTax')}</td><td className="num">{m(rep.output_tax_minor)}</td></tr>
                <tr><td colSpan={3}>{t('ax.inputTax')}</td><td className="num">{m(rep.input_tax_minor)}</td></tr>
                <tr><td colSpan={3}>{t('ax.netPayable')}</td><td className="num">{m(rep.net_payable_minor)}</td></tr>
              </tfoot></table>
            {rep.reconciliation.some((r) => r.difference_minor) && (
              <table className="ledger-table"><thead><tr><th>{t('ax.taxAccount')}</th><th>{t('ax.ledger')}</th><th>{t('ax.documents')}</th><th>{t('ax.otherPostings')}</th><th>{t('ax.difference')}</th></tr></thead>
                <tbody>{rep.reconciliation.map((r) => <tr key={r.account_id}><td>{r.code}</td><td className="num">{m(r.ledger_net_credit_minor)}</td><td className="num">{m(r.documents_net_credit_minor)}</td><td className="num">{m(r.other_net_credit_minor)}</td><td className="num">{m(r.unexplained_minor)}</td></tr>)}</tbody></table>
            )}
          </>
        )}
      </section>
    </>
  );
}

function Recurring({ t, meta, act, m }) {
  const [rows, setRows] = useState([]);
  const blank = { name: '', kind: 'recurring', frequency: 'monthly', startDate: D(), dayOfMonth: '', occurrences: '', endDate: '', total: '', debitAccountId: '', creditAccountId: '', amount: '' };
  const [f, setF] = useState(blank);
  const [asOf, setAsOf] = useState(D());
  const load = () => api.acGet('/recurring').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);
  const toMinor = (v) => Math.round(Number(v || 0) * 10 ** meta.digits);
  const save = () => {
    const body = { name: f.name, kind: f.kind, frequency: f.frequency, startDate: f.startDate, dayOfMonth: f.dayOfMonth || null, occurrences: f.occurrences || null, endDate: f.endDate || null };
    if (f.kind === 'prepayment') Object.assign(body, { total: f.total, debitAccountId: f.debitAccountId, creditAccountId: f.creditAccountId });
    else body.lines = [{ accountId: f.debitAccountId, debitMinor: toMinor(f.amount) }, { accountId: f.creditAccountId, creditMinor: toMinor(f.amount) }];
    return api.acPost('/recurring', body);
  };
  return (
    <>
      <section className="ledger-card">
        <h2>{t('ax.templates')}</h2>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ax.asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          <button type="button" className="gold-btn" onClick={async () => { const r = await act(() => api.acPost('/recurring/run', { asOf })); if (r) { act(async () => null, t('ax.recurringResult').replace('{p}', r.posted.length).replace('{r}', r.reversed.length)); load(); } }}>{t('ax.runDue')}</button>
        </div>
        <table className="ledger-table"><thead><tr><th>{t('ax.name')}</th><th>{t('ax.kind')}</th><th>{t('ax.frequency')}</th><th>{t('ax.amount')}</th><th>{t('ax.runs')}</th><th>{t('ax.nextDate')}</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.name}</td><td>{t(`ax.kind.${r.kind}`)}</td><td>{t(`ax.freq.${r.frequency}`)}</td><td className="num">{m(r.total_minor)}</td><td>{r.runs_count}{r.occurrences ? ` / ${r.occurrences}` : ''}</td><td>{r.next_date || '—'}</td></tr>)}</tbody></table>
      </section>
      <section className="ledger-card">
        <h2>{t('ax.newTemplate')}</h2>
        <p className="ledger-subtitle">{t(`ax.kindHint.${f.kind}`)}</p>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ax.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.kind')}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['recurring', 'accrual', 'prepayment'].map((k) => <option key={k} value={k}>{t(`ax.kind.${k}`)}</option>)}</select></label>
          <label className="ledger-field">{t('ax.frequency')}<select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>{['monthly', 'quarterly', 'yearly'].map((k) => <option key={k} value={k}>{t(`ax.freq.${k}`)}</option>)}</select></label>
          <label className="ledger-field">{t('ax.startDate')}<input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.dayOfMonth')}<input type="number" min={1} max={31} value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.occurrences')}<input type="number" value={f.occurrences} onChange={(e) => setF({ ...f, occurrences: e.target.value })} /></label>
          <label className="ledger-field">{t('ax.endDate')}<input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
          <AccountSelect label={t('ax.debitAccount')} accounts={meta.accounts} value={f.debitAccountId} onChange={(v) => setF({ ...f, debitAccountId: v })} />
          <AccountSelect label={t('ax.creditAccount')} accounts={meta.accounts} value={f.creditAccountId} onChange={(v) => setF({ ...f, creditAccountId: v })} />
          {f.kind === 'prepayment'
            ? <label className="ledger-field">{t('ax.prepaidTotal')}<input value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} /></label>
            : <label className="ledger-field">{t('ax.amount')}<input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>}
        </div>
        <button type="button" className="gold-btn" onClick={async () => { if (await act(save, t('ax.saved'))) { setF(blank); load(); } }}>{t('ax.addTemplate')}</button>
      </section>
    </>
  );
}
