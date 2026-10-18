import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';
import PriceModeBadge from '../../components/PriceModeBadge.jsx';

// Credit notes: list, detail, and creation — either against a posted
// invoice (?invoice=<id>, quantities per invoice line) or free-standing.
// Return-linked credit notes are created only by the returns approval flow.
export default function CreditNotesPage() {
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
  const invoiceId = params.get('invoice');
  const isNew = params.get('new') === '1';
  return (
    <div className="ledger-page">
      {error && <div className="ledger-error">{error}</div>}
      {meta && (invoiceId || isNew) && <CreditNoteForm key={invoiceId || 'free'} t={t} meta={meta} invoiceId={invoiceId} go={setParams} />}
      {meta && id && <CreditNoteDetail key={id} t={t} meta={meta} id={id} go={setParams} />}
      {meta && !id && !invoiceId && !isNew && <CreditNoteList t={t} meta={meta} can={can} go={setParams} />}
    </div>
  );
}

function CreditNoteList({ t, meta, can, go }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getCreditNotes().then(setRows).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dOf = (code) => ((meta.currencies || []).find((c) => c.code === code) || meta.base_currency).minor_unit_digits;
  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('sales.creditNotes.title')}</h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{t('sales.creditNotes.subtitle')}</p>
        </div>
        {can('create_credit_notes') && <button type="button" className="gold-btn" onClick={() => go({ new: '1' })}>{t('sales.creditNotes.new')}</button>}
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {rows && rows.length === 0 && <div className="ledger-empty">{t('sales.creditNotes.empty')}</div>}
      {rows && rows.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr><th>{t('sales.creditNotes.number')}</th><th>{t('ledger.entries.date')}</th><th>{t('sales.customer')}</th><th>{t('sales.invoices.number')}</th><th>{t('sales.creditNotes.source')}</th><th className="ledger-num">{t('sales.total')}</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="ledger-row-click" onClick={() => go({ id: String(c.id) })}>
                  <td>{c.credit_note_number}</td><td>{c.note_date}</td><td>{c.shop_name}</td><td>{c.invoice_number || '—'}</td>
                  <td>{c.return_request_id ? `${t('sales.creditNotes.fromReturn')} #${c.return_request_id}` : t('sales.creditNotes.manual')}</td>
                  <td className="ledger-num">{formatMinor(c.total_minor, dOf(c.currency_code))} {c.currency_code !== meta.base_currency.code ? c.currency_code : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CreditNoteForm({ t, meta, invoiceId, go }) {
  const [invoice, setInvoice] = useState(null);
  const [qty, setQty] = useState({});
  const [free, setFree] = useState({ shopId: '', description: '', qty: '1', unitPrice: '', taxRate: '' });
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = ((meta.currencies || []).find((c) => c.code === invoice?.currency_code) || meta.base_currency).minor_unit_digits;

  useEffect(() => {
    if (invoiceId) api.getSalesInvoice(invoiceId).then(setInvoice).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = invoice
        ? { invoiceId: invoice.id, reason, restock, lines: invoice.lines.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ invoiceLineId: l.id, qty: Number(qty[l.id]) })) }
        : { shopId: Number(free.shopId), reason, lines: [{ description: free.description, qty: free.qty, unitPrice: free.unitPrice, taxRate: free.taxRate || undefined }] };
      const cn = await api.createCreditNote(body);
      go({ id: String(cn.id) });
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('sales.creditNotes.new')}{invoice ? ` — ${invoice.invoice_number}` : ''}</h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{t('sales.creditNotes.formHint')}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={() => go(invoice ? {} : {})}>{t('ledger.back')}</button>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="card ledger-card">
        {invoice ? (
          <div className="ledger-table-wrap">
            <table className="ledger-table ledger-lines-table">
              <thead><tr><th>{t('sales.description')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('sales.creditedQty')}</th><th className="ledger-num">{t('sales.unitPrice')}</th><th>{t('sales.creditQty')}</th></tr></thead>
              <tbody>
                {invoice.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.description}</td><td className="ledger-num">{l.qty}</td><td className="ledger-num">{l.credited_qty}</td>
                    <td className="ledger-num">{formatMinor(l.unit_price_minor, d)}</td>
                    <td><input dir="ltr" value={qty[l.id] || ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} placeholder={`≤ ${l.qty - l.credited_qty}`} disabled={l.qty - l.credited_qty <= 0} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('sales.customer')}
              <select value={free.shopId} onChange={(e) => setFree({ ...free, shopId: e.target.value })}>
                <option value="">—</option>
                {meta.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="ledger-field">{t('sales.description')}<input value={free.description} onChange={(e) => setFree({ ...free, description: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.qty')}<input dir="ltr" value={free.qty} onChange={(e) => setFree({ ...free, qty: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.unitPrice')}<input dir="ltr" value={free.unitPrice} onChange={(e) => setFree({ ...free, unitPrice: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.taxRate')}<input dir="ltr" value={free.taxRate} onChange={(e) => setFree({ ...free, taxRate: e.target.value })} placeholder="%" /></label>
          </div>
        )}
        <label className="ledger-field" style={{ margin: '12px 0' }}>{t('ledger.detail.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {invoice && (
          <label className="ledger-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> {t('sales.restock')}
          </label>
        )}
        <div className="ledger-actions">
          <button type="button" className="gold-btn" disabled={busy} onClick={submit}>{t('sales.creditNotes.issue')}</button>
        </div>
      </div>
    </>
  );
}

function CreditNoteDetail({ t, meta, id, go }) {
  const [cn, setCn] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getCreditNote(id).then(setCn).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const d = ((meta.currencies || []).find((c) => c.code === cn?.currency_code) || meta.base_currency).minor_unit_digits;
  if (!cn) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{cn.credit_note_number}</h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{cn.shop?.name} · {cn.note_date} · {cn.reason || ''}</p>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          <a className="ghost-btn" href={`/api/sales/credit-notes/${cn.id}/print`} target="_blank" rel="noreferrer">{t('sales.print')}</a>
        </div>
      </div>
      <div className="card ledger-card">
        <div className="ledger-meta-grid">
          <div><div className="ledger-meta-label">{t('sales.invoices.number')}</div>{cn.invoice ? <Link to={`/sales/invoices?id=${cn.invoice.id}`}>{cn.invoice.invoice_number}</Link> : '—'}</div>
          <div><div className="ledger-meta-label">{t('sales.journalEntry')}</div>{cn.journal_entry ? <Link to={`/ledger/entries?id=${cn.journal_entry.id}`}>{cn.journal_entry.entry_number}</Link> : '—'}</div>
          <div><div className="ledger-meta-label">{t('sales.creditNotes.source')}</div>{cn.return_request_id ? `${t('sales.creditNotes.fromReturn')} #${cn.return_request_id}` : t('sales.creditNotes.manual')}</div>
          <div><div className="ledger-meta-label">{t('sales.restock')}</div>{cn.restock ? '✓' : '—'}</div>
        </div>
      </div>
      <div className="ledger-table-wrap">
        <table className="ledger-table">
          <thead><tr><th>{t('sales.description')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('sales.unitPrice')}</th><th className="ledger-num">{t('sales.net')}</th><th className="ledger-num">{t('sales.tax')}</th></tr></thead>
          <tbody>
            {cn.lines.map((l) => (
              <tr key={l.id}><td>{l.description}</td><td className="ledger-num">{l.qty}</td><td className="ledger-num">{formatMinor(l.unit_price_minor, d)}</td><td className="ledger-num">{formatMinor(l.net_minor, d)}</td><td className="ledger-num">{l.tax_minor ? formatMinor(l.tax_minor, d) : ''}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={3}>{t('sales.total')}</td><td colSpan={2} className="ledger-num">{formatMinor(cn.total_minor, d)} {cn.currency_code}</td></tr></tfoot>
        </table>
      </div>
    </>
  );
}
