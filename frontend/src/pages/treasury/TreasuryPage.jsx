import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError, withBreakGlass } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

const TABS = ['boxes', 'vouchers', 'cheques', 'rep-cash', 'daily'];
const VTYPES = ['receipt', 'payment', 'expense', 'transfer', 'bank_fee'];
const today = () => new Date().toISOString().slice(0, 10);
const boxMoney = (minor, box) => `${formatMinor(minor || 0, box?.digits ?? 2)} ${box?.currency_code || ''}`;
const docMoney = (minor, digits, code) => `${formatMinor(minor || 0, digits ?? 2)} ${code || ''}`;

function Badge({ t, status }) {
  const cls = ['posted', 'cleared', 'matched'].includes(status) ? 'posted' : ['reversed', 'rejected', 'bounced', 'cancelled'].includes(status) ? 'reversed' : 'draft';
  return <span className={`ledger-badge ledger-badge-${cls}`}>{t(`tr.status.${status}`)}</span>;
}

// Treasury workspace (Prompt 7): cash boxes and bank accounts, vouchers
// (receipt / payment / expense / transfer / bank fee), cheques issued, rep
// cash handover per currency, daily cash report. Bank reconciliation has
// its own screen (/treasury/bank).
export default function TreasuryPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'boxes';
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const loadMeta = () => api.trGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => {
    loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (fn, okMsg) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (okMsg) setNotice(okMsg);
      loadMeta();
      return r;
    } catch (err) {
      setError(ledgerError(err, t));
      return null;
    }
  };
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const props = { t, can, meta, act, setError };
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.treasury')}</h1><p className="ledger-subtitle">{t('tr.subtitle')}</p></div>
        <Link className="ghost-btn" to="/treasury/bank">{t('nav.bankReconciliation')}</Link>
      </div>
      <div className="ledger-tabs">{TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`tr.tab.${k}`)}</button>)}</div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {tab === 'boxes' && <Boxes {...props} />}
      {tab === 'vouchers' && <Vouchers {...props} />}
      {tab === 'cheques' && <Cheques {...props} />}
      {tab === 'rep-cash' && <RepCash {...props} />}
      {tab === 'daily' && <Daily {...props} />}
    </div>
  );
}

function Boxes({ t, can, meta, act }) {
  const [form, setForm] = useState(null);
  const blank = { name: '', kind: 'cash', currencyCode: meta.base_currency.code, bankName: '', accountNumber: '', iban: '', userIds: [] };
  const save = async () => {
    const body = { ...form, userIds: form.userIds.map(Number) };
    const r = await act(() => (form.id ? api.trPut(`/boxes/${form.id}`, body) : api.trPost('/boxes', body)), t('tr.saved'));
    if (r) setForm(null);
  };
  return (
    <>
      {can('manage_cash_boxes') && !form && <div className="ledger-toolbar"><span /><button type="button" className="gold-btn" onClick={() => setForm(blank)}>{t('tr.box.new')}</button></div>}
      {form && (
        <div className="card ledger-card">
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('tr.box.name')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            {!form.id && <label className="ledger-field">{t('tr.box.kind')}<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="cash">{t('tr.kind.cash')}</option><option value="bank">{t('tr.kind.bank')}</option></select></label>}
            {!form.id && <label className="ledger-field">{t('tr.currency')}<select value={form.currencyCode} onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}>{meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></label>}
            {form.kind === 'bank' && <label className="ledger-field">{t('tr.box.bankName')}<input value={form.bankName || ''} onChange={(e) => setForm({ ...form, bankName: e.target.value })} /></label>}
            {form.kind === 'bank' && <label className="ledger-field">{t('tr.box.accountNumber')}<input dir="ltr" value={form.accountNumber || ''} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} /></label>}
            {form.kind === 'bank' && <label className="ledger-field">IBAN<input dir="ltr" value={form.iban || ''} onChange={(e) => setForm({ ...form, iban: e.target.value })} /></label>}
            <label className="ledger-field">{t('tr.box.users')}<select multiple value={form.userIds.map(String)} onChange={(e) => setForm({ ...form, userIds: [...e.target.selectedOptions].map((o) => o.value) })} style={{ minHeight: 90 }}>{meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          </div>
          <p className="ledger-hint">{t('tr.box.usersHint')}</p>
          <div className="ledger-actions"><button type="button" className="ghost-btn" onClick={() => setForm(null)}>{t('common.cancel')}</button><button type="button" className="gold-btn" onClick={save}>{t('common.save')}</button></div>
        </div>
      )}
      <div className="card ledger-card">
        <table className="ledger-table">
          <thead><tr><th>{t('tr.box.name')}</th><th>{t('tr.box.kind')}</th><th>{t('tr.currency')}</th><th>{t('tr.box.account')}</th><th className="ledger-num">{t('tr.balance')}</th><th className="ledger-num">{t('tr.balanceBase')}</th><th>{t('tr.box.users')}</th><th /></tr></thead>
          <tbody>{meta.boxes.map((b) => (
            <tr key={b.id}>
              <td>{b.name}{b.is_main && !b.name.includes(t('tr.box.main')) ? ` (${t('tr.box.main')})` : ''}{b.bank_name ? <div className="ledger-hint">{b.bank_name} {b.iban || b.account_number || ''}</div> : null}</td>
              <td>{t(`tr.kind.${b.kind}`)}</td><td>{b.currency_code}</td><td dir="ltr">{b.account_code}</td>
              <td className="ledger-num">{boxMoney(b.balance_minor, b)}</td><td className="ledger-num">{formatMinor(b.base_minor, meta.base_currency.minor_unit_digits)}</td>
              <td>{b.users.map((u) => u.name).join('، ') || '—'}</td>
              <td>
                <Link className="ghost-btn" to={`/treasury?tab=daily&box=${b.id}`}>{t('tr.tab.daily')}</Link>
                {can('manage_cash_boxes') && <button type="button" className="ghost-btn" onClick={() => setForm({ ...blank, ...b, bankName: b.bank_name, accountNumber: b.account_number, userIds: b.users.map((u) => u.id) })}>{t('tr.edit')}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

function Vouchers({ t, can, meta, act }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState({ status: '', type: '' });
  const [form, setForm] = useState(null);
  const load = () => api.trGet('/vouchers', filter).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);
  const box = (id) => meta.boxes.find((b) => String(b.id) === String(id));
  const blank = { type: 'payment', cashBoxId: meta.boxes[0]?.id || '', toCashBoxId: '', counterAccountId: '', amount: '', tax: '', toAmount: '', payee: '', reference: '', description: '', date: today() };
  const accounts = form?.type === 'expense' ? meta.accounts.filter((a) => a.type === 'expense') : meta.accounts;
  const run = async (fn, msg) => {
    const r = await act(fn, msg);
    load();
    return r;
  };
  const create = async () => {
    const r = await run(() => api.trPost('/vouchers', { ...form, cashBoxId: Number(form.cashBoxId), toCashBoxId: form.toCashBoxId ? Number(form.toCashBoxId) : undefined, counterAccountId: form.counterAccountId ? Number(form.counterAccountId) : undefined }), t('tr.v.created'));
    if (r) setForm(null);
  };
  const from = form ? box(form.cashBoxId) : null;
  const to = form ? box(form.toCashBoxId) : null;
  return (
    <>
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">{t('tr.v.type')}<select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}><option value="">{t('tr.all')}</option>{VTYPES.map((k) => <option key={k} value={k}>{t(`tr.vtype.${k}`)}</option>)}</select></label>
          <label className="ledger-field">{t('tr.statusLabel')}<select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">{t('tr.all')}</option>{['draft', 'posted', 'rejected', 'reversed'].map((k) => <option key={k} value={k}>{t(`tr.status.${k}`)}</option>)}</select></label>
        </div>
        {can('create_vouchers') && !form && <button type="button" className="gold-btn" onClick={() => setForm(blank)}>{t('tr.v.new')}</button>}
      </div>
      {form && (
        <div className="card ledger-card">
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('tr.v.type')}<select value={form.type} onChange={(e) => { const type = e.target.value; const keep = type !== 'bank_fee' || box(form.cashBoxId)?.kind === 'bank'; setForm({ ...form, type, counterAccountId: '', cashBoxId: keep ? form.cashBoxId : meta.boxes.find((b) => b.kind === 'bank')?.id || '' }); }}>{VTYPES.map((k) => <option key={k} value={k}>{t(`tr.vtype.${k}`)}</option>)}</select></label>
            <label className="ledger-field">{t('fr.date')}<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <label className="ledger-field">{form.type === 'transfer' ? t('tr.v.fromBox') : t('tr.v.box')}<select value={form.cashBoxId} onChange={(e) => setForm({ ...form, cashBoxId: e.target.value })}>{meta.boxes.filter((b) => form.type !== 'bank_fee' || b.kind === 'bank').map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency_code})</option>)}</select></label>
            {form.type === 'transfer' && <label className="ledger-field">{t('tr.v.toBox')}<select value={form.toCashBoxId} onChange={(e) => setForm({ ...form, toCashBoxId: e.target.value })}><option value="">—</option>{meta.boxes.filter((b) => String(b.id) !== String(form.cashBoxId)).map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency_code})</option>)}</select></label>}
            {['receipt', 'payment', 'expense'].includes(form.type) && <label className="ledger-field">{t('tr.v.counter')}<select value={form.counterAccountId} onChange={(e) => setForm({ ...form, counterAccountId: e.target.value })}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></label>}
            <label className="ledger-field">{t('fr.amount')} {from ? `(${from.currency_code})` : ''}<input dir="ltr" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
            {form.type === 'expense' && <label className="ledger-field">{t('tr.v.tax')}<input dir="ltr" value={form.tax} onChange={(e) => setForm({ ...form, tax: e.target.value })} /></label>}
            {form.type === 'transfer' && to && from && to.currency_code !== from.currency_code && <label className="ledger-field">{t('tr.v.toAmount')} ({to.currency_code})<input dir="ltr" value={form.toAmount} placeholder={t('tr.v.toAmountHint')} onChange={(e) => setForm({ ...form, toAmount: e.target.value })} /></label>}
            <label className="ledger-field">{t('tr.v.payee')}<input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} /></label>
            <label className="ledger-field">{t('pur.reference')}<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.description')}<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          </div>
          <p className="ledger-hint">{t('tr.v.sodHint')}</p>
          <div className="ledger-actions"><button type="button" className="ghost-btn" onClick={() => setForm(null)}>{t('common.cancel')}</button><button type="button" className="gold-btn" onClick={create}>{t('tr.v.saveDraft')}</button></div>
        </div>
      )}
      <div className="card ledger-card">
        {!rows ? <div className="ledger-loading">{t('ledger.loading')}</div> : (
          <table className="ledger-table">
            <thead><tr><th>{t('fr.date')}</th><th>{t('tr.v.number')}</th><th>{t('tr.v.type')}</th><th>{t('tr.v.box')}</th><th>{t('tr.v.counter')}</th><th className="ledger-num">{t('fr.amount')}</th><th>{t('tr.statusLabel')}</th><th>{t('tr.v.by')}</th><th /></tr></thead>
            <tbody>{rows.map((v) => (
              <tr key={v.id}>
                <td>{v.voucher_date}</td><td dir="ltr">{v.voucher_number || '—'}</td><td>{t(`tr.vtype.${v.type}`)}</td>
                <td>{v.cash_box_name}{v.to_cash_box_name ? ` ← ${v.to_cash_box_name}` : ''}</td>
                <td>{v.counter_account_code ? `${v.counter_account_code} ${v.counter_account_name}` : '—'}{v.payee ? <div className="ledger-hint">{v.payee}</div> : null}</td>
                <td className="ledger-num">{docMoney(v.amount_original_minor, v.digits, v.currency_code)}{v.to_amount_original_minor && v.to_currency_code !== v.currency_code ? <div className="ledger-hint">→ {docMoney(v.to_amount_original_minor, v.to_digits, v.to_currency_code)}</div> : null}{v.fx_minor ? <div className="ledger-hint">{t('tr.fx')}: {formatMinor(v.fx_minor, meta.base_currency.minor_unit_digits)}</div> : null}</td>
                <td><Badge t={t} status={v.status} /></td>
                <td>{v.created_by_name}{v.approved_by_name ? ` / ${v.approved_by_name}` : ''}</td>
                <td>
                  {v.journal_entry_id && <Link className="ghost-btn" to={`/ledger/entries/${v.journal_entry_id}`}>{t('tr.entry')}</Link>}
                  {v.status === 'draft' && can('approve_vouchers') && <button type="button" className="gold-btn" onClick={() => run(() => withBreakGlass(t, (bg) => api.trPost(`/vouchers/${v.id}/approve`, bg)), t('tr.v.approved'))}>{t('tr.v.approve')}</button>}
                  {v.status === 'draft' && can('approve_vouchers') && <button type="button" className="ghost-btn" onClick={() => { const reason = window.prompt(t('tr.reasonPrompt')); if (reason) run(() => api.trPost(`/vouchers/${v.id}/reject`, { reason })); }}>{t('tr.v.reject')}</button>}
                  {v.status === 'draft' && can('create_vouchers') && <button type="button" className="ghost-btn" onClick={() => run(() => api.trDel(`/vouchers/${v.id}`))}>{t('tr.delete')}</button>}
                  {v.status === 'posted' && can('approve_vouchers') && <button type="button" className="danger-btn" onClick={() => { const reason = window.prompt(t('tr.reasonPrompt')); if (reason) run(() => api.trPost(`/vouchers/${v.id}/reverse`, { reason }), t('tr.reversed')); }}>{t('ledger.detail.reverse')}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Cheques({ t, can, meta, act }) {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState(null);
  const banks = meta.boxes.filter((b) => b.kind === 'bank');
  const load = () => api.trGet('/cheques', { status }).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const run = async (fn, msg) => {
    const r = await act(fn, msg);
    load();
    return r;
  };
  const blank = { cashBoxId: banks[0]?.id || '', chequeNumber: '', issueDate: today(), dueDate: today(), amount: '', payTo: 'supplier', supplierId: '', counterAccountId: '', payee: '' };
  const issue = async () => {
    const body = { cashBoxId: Number(form.cashBoxId), chequeNumber: form.chequeNumber, issueDate: form.issueDate, dueDate: form.dueDate, amount: form.amount, payee: form.payee || undefined, ...(form.payTo === 'supplier' ? { supplierId: Number(form.supplierId) } : { counterAccountId: Number(form.counterAccountId) }) };
    const r = await run(() => api.trPost('/cheques', body), t('tr.ch.issued'));
    if (r) setForm(null);
  };
  const withReason = (cid, action, msg) => { const reason = window.prompt(t('tr.reasonPrompt')); if (reason) run(() => api.trPost(`/cheques/${cid}/${action}`, { reason }), msg); };
  return (
    <>
      <div className="ledger-toolbar">
        <div className="ledger-filters"><label className="ledger-field">{t('tr.statusLabel')}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('tr.all')}</option>{['issued', 'in_transit', 'cleared', 'bounced', 'cancelled'].map((k) => <option key={k} value={k}>{t(`tr.status.${k}`)}</option>)}</select></label></div>
        <div className="ledger-actions">
          <Link className="ghost-btn" to="/receivables/cheques">{t('tr.ch.received')}</Link>
          {can('manage_cheques') && !form && banks.length > 0 && <button type="button" className="gold-btn" onClick={() => setForm(blank)}>{t('tr.ch.new')}</button>}
        </div>
      </div>
      {form && (
        <div className="card ledger-card">
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('tr.kind.bank')}<select value={form.cashBoxId} onChange={(e) => setForm({ ...form, cashBoxId: e.target.value })}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency_code})</option>)}</select></label>
            <label className="ledger-field">{t('tr.ch.number')}<input dir="ltr" value={form.chequeNumber} onChange={(e) => setForm({ ...form, chequeNumber: e.target.value })} /></label>
            <label className="ledger-field">{t('tr.ch.issueDate')}<input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></label>
            <label className="ledger-field">{t('tr.ch.dueDate')}<input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
            <label className="ledger-field">{t('fr.amount')}<input dir="ltr" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
            <label className="ledger-field">{t('tr.ch.payTo')}<select value={form.payTo} onChange={(e) => setForm({ ...form, payTo: e.target.value })}><option value="supplier">{t('pur.supplier')}</option><option value="account">{t('tr.v.counter')}</option></select></label>
            {form.payTo === 'supplier'
              ? <label className="ledger-field">{t('pur.supplier')}<select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}><option value="">—</option>{meta.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
              : <label className="ledger-field">{t('tr.v.counter')}<select value={form.counterAccountId} onChange={(e) => setForm({ ...form, counterAccountId: e.target.value })}><option value="">—</option>{meta.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></label>}
            <label className="ledger-field">{t('tr.v.payee')}<input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} /></label>
          </div>
          <p className="ledger-hint">{t('tr.ch.hint')}</p>
          <div className="ledger-actions"><button type="button" className="ghost-btn" onClick={() => setForm(null)}>{t('common.cancel')}</button><button type="button" className="gold-btn" onClick={issue}>{t('tr.ch.issue')}</button></div>
        </div>
      )}
      <div className="card ledger-card">
        {!rows ? <div className="ledger-loading">{t('ledger.loading')}</div> : (
          <table className="ledger-table">
            <thead><tr><th>{t('tr.ch.number')}</th><th>{t('tr.kind.bank')}</th><th>{t('tr.v.payee')}</th><th>{t('tr.ch.issueDate')}</th><th>{t('tr.ch.dueDate')}</th><th className="ledger-num">{t('fr.amount')}</th><th>{t('tr.statusLabel')}</th><th /></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className={['issued', 'in_transit'].includes(c.status) && c.due_date <= today() ? 'ledger-row-warn' : ''}>
                <td dir="ltr">{c.cheque_number}</td><td>{c.cash_box_name}</td><td>{c.supplier_name || c.payee || '—'}</td><td>{c.issue_date}</td><td>{c.due_date}</td>
                <td className="ledger-num">{docMoney(c.amount_original_minor, c.digits, c.currency_code)}{c.clear_fx_minor ? <div className="ledger-hint">{t('tr.fx')}: {formatMinor(c.clear_fx_minor, meta.base_currency.minor_unit_digits)}</div> : null}</td>
                <td><Badge t={t} status={c.status} /></td>
                <td>
                  {can('manage_cheques') && c.status === 'issued' && <button type="button" className="ghost-btn" onClick={() => run(() => api.trPost(`/cheques/${c.id}/hand-over`, {}))}>{t('tr.ch.handOver')}</button>}
                  {can('manage_cheques') && ['issued', 'in_transit'].includes(c.status) && <button type="button" className="gold-btn" onClick={() => { const date = window.prompt(t('tr.ch.clearDate'), today()); if (date) run(() => api.trPost(`/cheques/${c.id}/clear`, { date }), t('tr.ch.cleared')); }}>{t('tr.ch.clear')}</button>}
                  {can('manage_cheques') && ['issued', 'in_transit'].includes(c.status) && <button type="button" className="danger-btn" onClick={() => withReason(c.id, 'bounce', t('tr.ch.bounced'))}>{t('tr.ch.bounce')}</button>}
                  {can('manage_cheques') && ['issued', 'in_transit'].includes(c.status) && <button type="button" className="ghost-btn" onClick={() => withReason(c.id, 'cancel')}>{t('tr.ch.cancel')}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function RepCash({ t, can, meta, act }) {
  const [data, setData] = useState(null);
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const load = () => {
    api.trGet('/rep-cash').then(setData).catch(() => setData({ enabled: false, summary: [] }));
    api.trGet('/handovers').then(setList).catch(() => setList([]));
  };
  useEffect(load, []);
  const run = async (fn, msg) => {
    const r = await act(fn, msg);
    load();
    return r;
  };
  if (!data) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const cashBoxes = (code) => meta.boxes.filter((b) => b.kind === 'cash' && b.currency_code === code);
  return (
    <>
      <div className="card ledger-card">
        <div className={`ledger-balance ${data.enabled ? 'ledger-balance-ok' : ''}`}>{data.enabled ? t('tr.rc.enabled') : t('tr.rc.disabled')}</div>
        {can('manage_cash_boxes') && <button type="button" className="ghost-btn" onClick={() => run(() => api.trPut('/settings', { repCashHandover: !data.enabled }))}>{data.enabled ? t('tr.rc.turnOff') : t('tr.rc.turnOn')}</button>}
        <table className="ledger-table">
          <thead><tr><th>{t('tr.rc.rep')}</th><th>{t('tr.currency')}</th><th className="ledger-num">{t('tr.rc.count')}</th><th className="ledger-num">{t('tr.rc.expected')}</th><th className="ledger-num">{t('tr.rc.carried')}</th><th /></tr></thead>
          <tbody>{data.summary.map((r) => (
            <tr key={`${r.rep_id}-${r.currency_code}`}>
              <td>{r.rep_name}</td><td>{r.currency_code}</td><td className="ledger-num">{r.count}</td>
              <td className="ledger-num">{docMoney(r.expected_original_minor, r.digits, r.currency_code)}</td><td className="ledger-num">{formatMinor(r.carried_base_minor, meta.base_currency.minor_unit_digits)}</td>
              <td>{can('approve_vouchers') && <button type="button" className="gold-btn" onClick={() => setForm({ repId: r.rep_id, repName: r.rep_name, currencyCode: r.currency_code, cashBoxId: cashBoxes(r.currency_code)[0]?.id || '', counted: formatMinor(r.expected_original_minor, r.digits).replace(/,/g, ''), date: today(), expected: r })}>{t('tr.rc.handover')}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
        {!data.summary.length && <p className="ledger-hint">{t('tr.rc.none')}</p>}
      </div>
      {form && (
        <div className="card ledger-card">
          <h2 className="atlas-section-title">{t('tr.rc.handover')} — {form.repName} ({form.currencyCode})</h2>
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('tr.v.box')}<select value={form.cashBoxId} onChange={(e) => setForm({ ...form, cashBoxId: e.target.value })}><option value="">—</option>{cashBoxes(form.currencyCode).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="ledger-field">{t('tr.rc.counted')}<input dir="ltr" value={form.counted} onChange={(e) => setForm({ ...form, counted: e.target.value })} /></label>
            <label className="ledger-field">{t('fr.date')}<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
          </div>
          <p className="ledger-hint">{t('tr.rc.expected')}: {docMoney(form.expected.expected_original_minor, form.expected.digits, form.currencyCode)} — {t('tr.rc.hint')}</p>
          <div className="ledger-actions"><button type="button" className="ghost-btn" onClick={() => setForm(null)}>{t('common.cancel')}</button><button type="button" className="gold-btn" onClick={async () => { const r = await run(() => api.trPost('/handovers', { repId: form.repId, currencyCode: form.currencyCode, cashBoxId: Number(form.cashBoxId), counted: form.counted, date: form.date }), t('tr.rc.done')); if (r) setForm(null); }}>{t('ledger.form.post')}</button></div>
        </div>
      )}
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('tr.rc.history')}</h2>
        <table className="ledger-table">
          <thead><tr><th>{t('fr.date')}</th><th>{t('tr.v.number')}</th><th>{t('tr.rc.rep')}</th><th>{t('tr.v.box')}</th><th className="ledger-num">{t('tr.rc.expected')}</th><th className="ledger-num">{t('tr.rc.counted')}</th><th className="ledger-num">{t('tr.rc.overShort')}</th><th className="ledger-num">{t('tr.fx')}</th><th>{t('tr.statusLabel')}</th><th /></tr></thead>
          <tbody>{list.map((h) => (
            <tr key={h.id}>
              <td>{h.handover_date}</td><td dir="ltr">{h.handover_number}</td><td>{h.rep_name}</td><td>{h.cash_box_name}</td>
              <td className="ledger-num">{docMoney(h.expected_original_minor, h.digits, h.currency_code)}</td><td className="ledger-num">{docMoney(h.counted_original_minor, h.digits, h.currency_code)}</td>
              <td className={`ledger-num ${h.over_short_original_minor < 0 ? 'ledger-neg' : ''}`}>{docMoney(h.over_short_original_minor, h.digits, h.currency_code)}</td>
              <td className="ledger-num">{formatMinor(h.fx_minor, meta.base_currency.minor_unit_digits)}</td>
              <td><Badge t={t} status={h.status} /></td>
              <td>
                {h.journal_entry_id && <Link className="ghost-btn" to={`/ledger/entries/${h.journal_entry_id}`}>{t('tr.entry')}</Link>}
                {h.status === 'posted' && can('approve_vouchers') && <button type="button" className="danger-btn" onClick={() => { const reason = window.prompt(t('tr.reasonPrompt')); if (reason) run(() => api.trPost(`/handovers/${h.id}/reverse`, { reason }), t('tr.reversed')); }}>{t('ledger.detail.reverse')}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

function Daily({ t, meta }) {
  const [sp, setSp] = useSearchParams();
  const boxId = sp.get('box') || meta.boxes[0]?.id;
  const [q, setQ] = useState({ from: today(), to: today() });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!boxId) return;
    setData(null);
    api.trGet('/reports/daily-cash', { cashBoxId: boxId, ...q }).then(setData).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxId, q]);
  return (
    <>
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">{t('tr.v.box')}<select value={boxId || ''} onChange={(e) => setSp({ tab: 'daily', box: e.target.value })}>{meta.boxes.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency_code})</option>)}</select></label>
          <label className="ledger-field">{t('fr.from')}<input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></label>
          <label className="ledger-field">{t('fr.to')}<input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></label>
        </div>
        <button type="button" className="ghost-btn" onClick={() => api.trDownload('/reports/daily-cash', { cashBoxId: boxId, ...q, format: 'xlsx' })}>Excel</button>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {!data ? <div className="ledger-loading">{t('ledger.loading')}</div> : (
        <div className="card ledger-card">
          <div className={`ledger-balance ${data.closing_minor === data.ledger_closing_minor ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{t('tr.d.closingVsLedger')}: {boxMoney(data.closing_minor, data.box)} / {boxMoney(data.ledger_closing_minor, data.box)}</div>
          {data.days.map((d) => (
            <div key={d.date} style={{ marginBottom: 16 }}>
              <h3 className="atlas-section-title">{d.date}</h3>
              <table className="ledger-table">
                <thead><tr><th>{t('tr.entry')}</th><th>{t('sales.description')}</th><th className="ledger-num">{t('tr.d.in')}</th><th className="ledger-num">{t('tr.d.out')}</th></tr></thead>
                <tbody>
                  <tr className="ledger-row-header"><td colSpan={2}>{t('tr.d.opening')}</td><td colSpan={2} className="ledger-num">{boxMoney(d.opening_minor, data.box)}</td></tr>
                  {d.lines.map((l) => <tr key={l.id}><td dir="ltr"><Link to={`/ledger/entries/${l.entry_id}`}>{l.entry_number}</Link></td><td>{l.memo || l.description}</td><td className="ledger-num">{l.in_minor ? boxMoney(l.in_minor, data.box) : ''}</td><td className="ledger-num">{l.out_minor ? boxMoney(l.out_minor, data.box) : ''}</td></tr>)}
                </tbody>
                <tfoot><tr><th colSpan={2}>{t('fr.total')}</th><th className="ledger-num">{boxMoney(d.in_minor, data.box)}</th><th className="ledger-num">{boxMoney(d.out_minor, data.box)}</th></tr><tr><th colSpan={3}>{t('tr.d.closing')}</th><th className="ledger-num">{boxMoney(d.closing_minor, data.box)}</th></tr></tfoot>
              </table>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
