import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

// Post-dated cheques received: portfolio -> deposited -> cleared, or bounced
// (which reverses the receipt so the customer owes again).
const STATUSES = ['in_portfolio', 'deposited', 'cleared', 'bounced'];

export default function ChequesPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Prompt 7: bank boxes to clear into (a foreign cheque needs one in its currency).
  const [banks, setBanks] = useState([]);
  const [clearing, setClearing] = useState(null);

  const load = () => api.getCheques(status ? { status } : {}).then(setRows).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => {
    api.getSalesMeta().then(setMeta).catch((err) => setError(ledgerError(err, t)));
    api.trGet('/boxes').then((bs) => setBanks(bs.filter((b) => b.kind === 'bank'))).catch(() => setBanks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  const d = meta?.base_currency.minor_unit_digits ?? 2;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('nav.cheques')}</h1>
          <p className="ledger-subtitle">{t('rec.cheques.subtitle')}</p>
        </div>
        {can('manage_receipts') && <button type="button" className="gold-btn" onClick={() => setForm({ shopId: '', chequeNumber: '', bankName: '', receivedDate: today, dueDate: '', amount: '', currencyCode: meta?.base_currency.code || '' })}>{t('rec.cheques.new')}</button>}
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {form && meta && (
        <div className="card ledger-card">
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('sales.customer')}
              <select value={form.shopId} onChange={(e) => setForm({ ...form, shopId: e.target.value })}>
                <option value="">—</option>
                {meta.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="ledger-field">{t('rec.cheques.number')}<input dir="ltr" value={form.chequeNumber} onChange={(e) => setForm({ ...form, chequeNumber: e.target.value })} /></label>
            <label className="ledger-field">{t('rec.cheques.bank')}<input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} /></label>
            <label className="ledger-field">{t('rec.cheques.received')}<input type="date" value={form.receivedDate} onChange={(e) => setForm({ ...form, receivedDate: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.dueDate')}<input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.total')}<input dir="ltr" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
            {(meta.currencies || []).length > 1 && <label className="ledger-field">{t('tr.currency')}<select value={form.currencyCode} onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}>{meta.currencies.filter((c) => c.is_active !== 0).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></label>}
          </div>
          {form.currencyCode && form.currencyCode !== meta.base_currency.code && <p className="ledger-hint">{t('rec.cheques.fxHint')}</p>}
          <div className="ledger-actions">
            <button type="button" className="ghost-btn" onClick={() => setForm(null)}>{t('ledger.cancel')}</button>
            <button type="button" className="gold-btn" disabled={busy || !form.shopId || !form.chequeNumber || !form.dueDate || !form.amount}
              onClick={() => act(async () => { await api.receiveCheque({ ...form, shopId: Number(form.shopId) }); setForm(null); })}>{t('rec.cheques.receive')}</button>
          </div>
        </div>
      )}
      <div className="ledger-tabs">
        {['', ...STATUSES].map((s) => (
          <button key={s || 'all'} type="button" className={`ledger-tab-btn${status === s ? ' active' : ''}`} onClick={() => setStatus(s)}>{s ? t(`rec.cheque.status.${s}`) : t('ledger.all')}</button>
        ))}
      </div>
      {rows && rows.length === 0 && <div className="ledger-empty">{t('rec.cheques.empty')}</div>}
      {rows && rows.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr><th>{t('rec.cheques.number')}</th><th>{t('sales.customer')}</th><th>{t('rec.cheques.bank')}</th><th>{t('sales.dueDate')}</th><th className="ledger-num">{t('sales.total')}</th><th>{t('ledger.entries.status')}</th><th>{t('rec.receipts.number')}</th>{can('manage_receipts') && <th />}</tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={c.status === 'bounced' ? 'ledger-row-error' : ''}>
                  <td dir="ltr">{c.cheque_number}</td><td>{c.shop_name}</td><td>{c.bank_name || '—'}</td>
                  <td>{c.due_date}{c.status === 'in_portfolio' && c.due_date <= today ? ' ⚑' : ''}</td>
                  <td className="ledger-num">{c.currency_code ? <>{formatMinor(c.amount_original_minor, (meta?.currencies || []).find((x) => x.code === c.currency_code)?.minor_unit_digits ?? 2)} {c.currency_code}<div className="ledger-hint">{formatMinor(c.amount_minor, d)}</div></> : formatMinor(c.amount_minor, d)}</td>
                  <td>{t(`rec.cheque.status.${c.status}`)}</td>
                  <td>{c.receipt_id ? <Link to={`/receivables/receipts?id=${c.receipt_id}`}>{c.receipt_number}</Link> : '—'}</td>
                  {can('manage_receipts') && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {c.status === 'in_portfolio' && <button type="button" className="ghost-btn" disabled={busy} onClick={() => act(() => api.chequeAction(c.id, 'deposit'))}>{t('rec.cheques.deposit')}</button>}{' '}
                      {['in_portfolio', 'deposited'].includes(c.status) && (clearing?.id === c.id
                        ? <span>
                            <select value={clearing.cashBoxId} onChange={(e) => setClearing({ ...clearing, cashBoxId: e.target.value })}>
                              {!c.currency_code && <option value="">{t('rec.cheques.noBox')}</option>}
                              {banks.filter((b) => b.currency_code === (c.currency_code || meta?.base_currency.code)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                            </select>{' '}
                            <button type="button" className="gold-btn" disabled={busy || (c.currency_code && !clearing.cashBoxId)} onClick={() => act(async () => { await api.chequeAction(c.id, 'clear', clearing.cashBoxId ? { cashBoxId: Number(clearing.cashBoxId) } : {}); setClearing(null); })}>{t('rec.cheques.clear')}</button>
                          </span>
                        : <button type="button" className="ghost-btn" disabled={busy} onClick={() => setClearing({ id: c.id, cashBoxId: c.currency_code ? (banks.find((b) => b.currency_code === c.currency_code)?.id || '') : '' })}>{t('rec.cheques.clear')}</button>)}{' '}
                      {['in_portfolio', 'deposited'].includes(c.status) && (
                        <button type="button" className="danger-btn" disabled={busy} onClick={() => {
                          const reason = window.prompt(t('rec.cheques.bounceReason'));
                          if (reason !== null) act(() => api.chequeAction(c.id, 'bounce', { reason }));
                        }}>{t('rec.cheques.bounce')}</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
