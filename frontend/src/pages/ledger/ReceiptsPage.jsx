import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

// Receipts and their allocation to invoices (Prompt 3). Confirmed
// collections and cheques create receipts automatically; manual receipts
// are created here. Allocation: oldest-first by default, editable.
export default function ReceiptsPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getSalesMeta().then(setMeta).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const id = params.get('id');
  return (
    <div className="ledger-page">
      {error && <div className="ledger-error">{error}</div>}
      {meta && params.get('new') === '1' && <NewReceipt t={t} meta={meta} go={setParams} />}
      {meta && id && <ReceiptDetail key={id} t={t} meta={meta} id={id} can={can} go={setParams} />}
      {meta && !id && params.get('new') !== '1' && <ReceiptList t={t} meta={meta} can={can} go={setParams} />}
    </div>
  );
}

function ReceiptList({ t, meta, can, go }) {
  const [rows, setRows] = useState(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [error, setError] = useState(null);
  const d = meta.base_currency.minor_unit_digits;
  useEffect(() => {
    api.getReceipts(onlyOpen ? { unallocated: '1' } : {}).then(setRows).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyOpen]);
  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('rec.receipts.title')}</h1>
          <p className="ledger-subtitle">{t('rec.receipts.subtitle')}</p>
        </div>
        {can('manage_receipts') && <button type="button" className="gold-btn" onClick={() => go({ new: '1' })}>{t('rec.receipts.new')}</button>}
      </div>
      {error && <div className="ledger-error">{error}</div>}
      <label className="ledger-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> {t('rec.receipts.onlyUnallocated')}
      </label>
      {rows && rows.length === 0 && <div className="ledger-empty">{t('rec.receipts.empty')}</div>}
      {rows && rows.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr><th>{t('rec.receipts.number')}</th><th>{t('ledger.entries.date')}</th><th>{t('sales.customer')}</th><th>{t('rec.method')}</th><th className="ledger-num">{t('sales.total')}</th><th className="ledger-num">{t('rec.unallocated')}</th><th>{t('ledger.entries.status')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="ledger-row-click" onClick={() => go({ id: String(r.id) })}>
                  <td>{r.receipt_number}</td><td>{r.receipt_date}</td><td>{r.shop_name}</td><td>{t(`rec.method.${r.method}`)}</td>
                  <td className="ledger-num">{formatMinor(r.amount_minor, d)}</td><td className="ledger-num">{r.unallocated_minor ? formatMinor(r.unallocated_minor, d) : ''}</td>
                  <td><span className={`ledger-badge ledger-badge-${r.status === 'posted' ? 'posted' : 'reversed'}`}>{t(`rec.status.${r.status}`)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewReceipt({ t, meta, go }) {
  const [form, setForm] = useState({ shopId: '', date: new Date().toISOString().slice(0, 10), method: 'cash', amount: '', notes: '', autoAllocate: true, currencyCode: meta.base_currency.code });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rateInfo, setRateInfo] = useState(null);
  const foreign = form.currencyCode !== meta.base_currency.code;
  useEffect(() => {
    if (!foreign) { setRateInfo(null); return; }
    api.getCurrentRate(form.currencyCode, form.date).then(setRateInfo).catch(() => setRateInfo(null));
  }, [foreign, form.currencyCode, form.date]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createReceipt({ ...form, shopId: Number(form.shopId) });
      go({ id: String(r.id) });
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="ledger-header">
        <h1 className="atlas-page-title">{t('rec.receipts.new')}</h1>
        <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="card ledger-card">
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('sales.customer')}
            <select value={form.shopId} onChange={(e) => setForm({ ...form, shopId: e.target.value })}>
              <option value="">—</option>
              {meta.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="ledger-field">{t('ledger.entries.date')}<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
          <label className="ledger-field">{t('rec.method')}
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {['cash', 'transfer', 'other'].map((m) => <option key={m} value={m}>{t(`rec.method.${m}`)}</option>)}
            </select>
          </label>
          <label className="ledger-field">{t('ledger.form.currency')}
            <select value={form.currencyCode} onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}>
              {(meta.currencies || [meta.base_currency]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </label>
          <label className="ledger-field">{t('sales.total')} ({form.currencyCode})<input dir="ltr" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
          {foreign && (
            <p className={rateInfo ? 'ledger-hint' : 'ledger-error'} style={{ gridColumn: '1 / -1' }}>
              {rateInfo ? `${t('fx.rateUsed')}: ${rateInfo.rate} (${rateInfo.rate_quote === 'foreign_per_base' ? `${form.currencyCode}/${meta.base_currency.code}` : `${meta.base_currency.code}/${form.currencyCode}`})` : t('fx.noRate')}
              {' '}<Link to="/ledger/exchange-rates">{t('nav.exchangeRates')}</Link>
            </p>
          )}
          <label className="ledger-field">{t('sales.notes')}<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        </div>
        <label className="ledger-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input type="checkbox" checked={form.autoAllocate} onChange={(e) => setForm({ ...form, autoAllocate: e.target.checked })} /> {t('rec.autoAllocate')}
        </label>
        <p className="ledger-hint">{t('rec.receipts.chequeHint')} <Link to="/receivables/cheques">{t('nav.cheques')}</Link></p>
        <button type="button" className="gold-btn" disabled={busy || !form.shopId || !form.amount} onClick={save}>{t('rec.receipts.save')}</button>
      </div>
    </>
  );
}

function ReceiptDetail({ t, meta, id, can, go }) {
  const [r, setR] = useState(null);
  const [open, setOpen] = useState([]);
  const [alloc, setAlloc] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = meta.base_currency.minor_unit_digits;

  async function load() {
    try {
      const rec = await api.getReceipt(id);
      setR(rec);
      const inv = rec.status === 'posted' ? await api.getOpenInvoices(rec.shop_id) : [];
      // Invoices already allocated from this receipt are editable too.
      const merged = [...rec.allocations.map((a) => ({ id: a.invoice_id, invoice_number: a.invoice_number, open_minor: 0 }))];
      for (const i of inv) {
        const m = merged.find((x) => x.id === i.id);
        if (m) Object.assign(m, i);
        else merged.push(i);
      }
      setOpen(merged);
      setAlloc(Object.fromEntries(rec.allocations.map((a) => [a.invoice_id, a.receipt_amount])));
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);

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

  if (!r) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  const digitsOf = (code) => ((meta.currencies || []).find((c) => c.code === code) || meta.base_currency).minor_unit_digits;
  const rd = digitsOf(r.currency_code);
  const editable = r.status === 'posted' && can('manage_receipts');
  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{r.receipt_number} <span className={`ledger-badge ledger-badge-${r.status === 'posted' ? 'posted' : 'reversed'}`}>{t(`rec.status.${r.status}`)}</span></h1>
          <p className="ledger-subtitle">{r.shop?.name} · {r.receipt_date} · {t(`rec.method.${r.method}`)} · {r.currency_code !== meta.base_currency.code ? `${r.amount_original} ${r.currency_code} @ ${r.exchange_rate} = ` : ''}{formatMinor(r.amount_minor, d)} {meta.base_currency.code}</p>
          {r.fx_settlements?.length > 0 && <p className="ledger-hint">{t('fx.realizedOnReceipt')}: {r.fx_settlements.map((x) => `${x.entry_number} (${formatMinor(x.fx_minor, d)})`).join('، ')}</p>}
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          {editable && !r.cheque_id && (
            <button type="button" className="danger-btn" disabled={busy} onClick={() => {
              const reason = window.prompt(t('rec.reversePrompt'));
              if (reason) act(() => api.reverseReceipt(r.id, reason));
            }}>{t('ledger.detail.reverse')}</button>
          )}
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="card ledger-card">
        <div className="ledger-meta-grid">
          <div><div className="ledger-meta-label">{t('sales.journalEntry')}</div>{r.journal_entry ? <Link to={`/ledger/entries?id=${r.journal_entry.id}`}>{r.journal_entry.entry_number}</Link> : '—'}</div>
          <div><div className="ledger-meta-label">{t('rec.allocated')}</div>{formatMinor(r.allocated_minor, rd)} {r.currency_code}</div>
          <div><div className="ledger-meta-label">{t('rec.unallocated')}</div>{formatMinor(r.unallocated_minor, rd)} {r.currency_code}</div>
          {r.collection_id && <div><div className="ledger-meta-label">{t('rec.fromCollection')}</div>#{r.collection_id}</div>}
          {r.cheque && <div><div className="ledger-meta-label">{t('rec.cheque')}</div>{r.cheque.cheque_number} · {t(`rec.cheque.status.${r.cheque.status}`)}</div>}
        </div>
      </div>
      <div className="card ledger-card">
        <div className="ledger-toolbar">
          <h2 className="atlas-section-title">{t('rec.allocations')}</h2>
          {editable && <button type="button" className="ghost-btn" disabled={busy} onClick={() => act(() => api.autoAllocateReceipt(r.id))}>{t('rec.autoAllocateNow')}</button>}
        </div>
        {open.length === 0 && <p className="ledger-hint">{t('rec.noOpenInvoices')}</p>}
        {open.length > 0 && (
          <div className="ledger-table-wrap">
            <table className="ledger-table ledger-lines-table">
              <thead><tr><th>{t('sales.invoices.number')}</th><th>{t('sales.dueDate')}</th><th className="ledger-num">{t('sales.open')}</th><th>{t('rec.allocate')} ({r.currency_code})</th></tr></thead>
              <tbody>
                {open.map((i) => (
                  <tr key={i.id}>
                    <td><Link to={`/sales/invoices?id=${i.id}`}>{i.invoice_number}</Link></td>
                    <td>{i.due_date || i.invoice_date || ''}</td>
                    <td className="ledger-num">{formatMinor(i.open_minor, digitsOf(i.currency_code))} {i.currency_code}</td>
                    <td><input dir="ltr" disabled={!editable} value={alloc[i.id] || ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && open.length > 0 && (
          <div className="ledger-actions" style={{ marginTop: 12 }}>
            <button type="button" className="gold-btn" disabled={busy} onClick={() => act(() => api.setReceiptAllocations(r.id, Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([invoiceId, amount]) => ({ invoiceId: Number(invoiceId), amount }))))}>{t('rec.saveAllocations')}</button>
          </div>
        )}
      </div>
    </>
  );
}
