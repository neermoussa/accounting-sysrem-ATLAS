import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError, toMinorOrNull } from './ledgerShared.js';
import '../../styles/ledger.css';
import PriceModeBadge from '../../components/PriceModeBadge.jsx';

function StatusBadge({ status, t }) {
  const cls = status === 'posted' ? 'posted' : status === 'cancelled' ? 'reversed' : 'draft';
  return <span className={`ledger-badge ledger-badge-${cls}`}>{t(`sales.status.${status}`)}</span>;
}

export default function SalesInvoicesPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getSalesMeta().then(setMeta).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const viewId = params.get('id');
  const editId = params.get('edit');
  const isNew = params.get('new') === '1';
  const fromOrder = params.get('fromOrder') === '1';
  return (
    <div className="ledger-page">
      {error && <div className="ledger-error">{error}</div>}
      {!meta && !error && <div className="ledger-loading">{t('ledger.loading')}</div>}
      {meta && fromOrder && <FromOrderList t={t} meta={meta} go={setParams} />}
      {meta && (isNew || editId) && <InvoiceForm key={editId || 'new'} t={t} meta={meta} editId={editId} go={setParams} />}
      {meta && viewId && !editId && <InvoiceDetail key={viewId} t={t} meta={meta} id={viewId} can={can} go={setParams} />}
      {meta && !viewId && !editId && !isNew && !fromOrder && <InvoiceList t={t} meta={meta} can={can} go={setParams} />}
    </div>
  );
}

function InvoiceList({ t, meta, can, go }) {
  const [filters, setFilters] = useState({ status: '', shopId: '', from: '', to: '' });
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const d = meta.base_currency.minor_unit_digits;

  function load(f = filters) {
    const q = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
    api.getSalesInvoices(q).then(setRows).catch((err) => setError(ledgerError(err, t)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), []);
  const setF = (k) => (e) => {
    const next = { ...filters, [k]: e.target.value };
    setFilters(next);
    load(next);
  };

  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('sales.invoices.title')}</h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{meta.live ? t('sales.live.on') : t('sales.live.off')}</p>
        </div>
        {can('create_sales_invoices') && (
          <div className="ledger-actions">
            <button type="button" className="ghost-btn" onClick={() => go({ fromOrder: '1' })}>{t('sales.fromOrder.button')}</button>
            <button type="button" className="gold-btn" onClick={() => go({ new: '1' })}>{t('sales.invoices.new')}</button>
          </div>
        )}
      </div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">
            {t('ledger.entries.status')}
            <select value={filters.status} onChange={setF('status')}>
              <option value="">{t('ledger.all')}</option>
              {['draft', 'posted', 'cancelled'].map((s) => <option key={s} value={s}>{t(`sales.status.${s}`)}</option>)}
            </select>
          </label>
          <label className="ledger-field">
            {t('sales.customer')}
            <select value={filters.shopId} onChange={setF('shopId')}>
              <option value="">{t('ledger.all')}</option>
              {meta.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="ledger-field">{t('ledger.from')}<input type="date" value={filters.from} onChange={setF('from')} /></label>
          <label className="ledger-field">{t('ledger.to')}<input type="date" value={filters.to} onChange={setF('to')} /></label>
        </div>
      </div>
      {!rows && <div className="ledger-loading">{t('ledger.loading')}</div>}
      {rows && rows.length === 0 && <div className="ledger-empty">{t('sales.invoices.empty')}</div>}
      {rows && rows.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{t('sales.invoices.number')}</th>
                <th>{t('ledger.entries.date')}</th>
                <th>{t('sales.customer')}</th>
                <th className="ledger-num">{t('sales.total')}</th>
                <th className="ledger-num">{t('sales.open')}</th>
                <th>{t('ledger.entries.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="ledger-row-click" onClick={() => go({ id: String(i.id) })}>
                  <td>{i.invoice_number || <span className="ledger-muted">{t('sales.draftNoNumber')}</span>}</td>
                  <td>{i.invoice_date}</td>
                  <td>{i.shop_name}</td>
                  <td className="ledger-num">{i.total} {i.currency_code !== meta.base_currency.code ? i.currency_code : ''}</td>
                  <td className="ledger-num">{i.open}</td>
                  <td><StatusBadge status={i.status} t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const emptyLine = () => ({ productId: '', description: '', qty: '1', unitPrice: '', discount: '', taxRate: '' });

function InvoiceForm({ t, meta, editId, go }) {
  const today = new Date().toISOString().slice(0, 10);
  const [header, setHeader] = useState({ shopId: '', invoiceDate: today, dueDate: '', branchId: '', notes: '', currencyCode: meta.base_currency.code });
  const [rateInfo, setRateInfo] = useState(null);
  const [lines, setLines] = useState([emptyLine()]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!editId);
  const docCur = (meta.currencies || []).find((c) => c.code === header.currencyCode) || meta.base_currency;
  const d = docCur.minor_unit_digits;
  const foreign = docCur.code !== meta.base_currency.code;

  // The rate that will be locked at posting (history rate for the date).
  useEffect(() => {
    if (!foreign) { setRateInfo(null); return; }
    api.getCurrentRate(docCur.code, header.invoiceDate).then(setRateInfo).catch(() => setRateInfo(null));
  }, [foreign, docCur.code, header.invoiceDate]);

  useEffect(() => {
    if (!editId) return;
    api.getSalesInvoice(editId).then((inv) => {
      setHeader({ shopId: String(inv.shop_id), invoiceDate: inv.invoice_date, dueDate: inv.due_date || '', branchId: inv.branch_id || '', notes: inv.notes || '', currencyCode: inv.currency_code });
      setLines(inv.lines.map((l) => ({
        productId: l.product_id ? String(l.product_id) : '', description: l.description, qty: String(l.qty),
        unitPrice: l.unit_price, discount: l.discount_minor ? l.discount : '', taxRate: l.tax_rate_bp ? l.tax_rate : '', taxCodeId: l.tax_code_id ? String(l.tax_code_id) : '',
      })));
      setLoaded(true);
    }).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  // Preview only (the server prices and rounds authoritatively): lines with
  // an empty price are priced by the pricing engine on save.
  const preview = useMemo(() => {
    let exact = 0;
    let rounded = 0;
    let unknown = false;
    for (const l of lines) {
      const price = toMinorOrNull(l.unitPrice, d);
      const qty = Number(l.qty);
      if (l.unitPrice === '' || price === null || !(qty > 0)) {
        if (l.productId || l.description) unknown = true;
        continue;
      }
      const net = price * qty - (toMinorOrNull(l.discount, d) || 0);
      const tax = (net * (toMinorOrNull(l.taxRate, 2) || 0)) / 10000;
      exact += net + tax;
      rounded += Math.round(net) + Math.round(tax);
    }
    const total = Math.round(exact);
    return { total, rounding: total - rounded, unknown };
  }, [lines, d]);

  // Prompt 10: sales tax codes (the column appears only when the company has
  // codes; the preview stays approximate, the server prices authoritatively).
  const [taxCodes, setTaxCodes] = useState([]);
  useEffect(() => { api.acGet('/tax-codes').then((c) => setTaxCodes(c.filter((x) => x.type === 'sales' && x.active))).catch(() => {}); }, []);

  const setLine = (i, k) => (e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));

  async function save(andPost) {
    setSaving(true);
    setError(null);
    const body = {
      shopId: Number(header.shopId),
      invoiceDate: header.invoiceDate,
      dueDate: header.dueDate || null,
      branchId: header.branchId ? Number(header.branchId) : null,
      notes: header.notes,
      currencyCode: header.currencyCode,
      lines: lines.filter((l) => l.productId || l.description).map((l) => ({
        productId: l.productId ? Number(l.productId) : null, description: l.description, qty: l.qty,
        unitPrice: l.unitPrice === '' ? undefined : l.unitPrice, discount: l.discount || undefined, taxRate: l.taxCodeId ? undefined : l.taxRate || undefined, taxCodeId: l.taxCodeId ? Number(l.taxCodeId) : undefined,
      })),
    };
    try {
      let inv = editId ? await api.updateSalesInvoice(editId, body) : await api.createSalesInvoice(body);
      if (andPost) inv = await api.postSalesInvoice(inv.id);
      go({ id: String(inv.id) });
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{editId ? t('sales.invoices.editTitle') : t('sales.invoices.newTitle')}</h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{t('sales.invoices.formHint')}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={() => go(editId ? { id: editId } : {})}>{t('ledger.back')}</button>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="card ledger-card">
        <div className="ledger-form-grid">
          <label className="ledger-field">
            {t('sales.customer')}
            <select value={header.shopId} onChange={(e) => setHeader({ ...header, shopId: e.target.value })}>
              <option value="">—</option>
              {meta.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="ledger-field">{t('ledger.entries.date')}<input type="date" value={header.invoiceDate} onChange={(e) => setHeader({ ...header, invoiceDate: e.target.value })} /></label>
          <label className="ledger-field">{t('sales.dueDate')}<input type="date" value={header.dueDate} onChange={(e) => setHeader({ ...header, dueDate: e.target.value })} /></label>
          <label className="ledger-field">
            {t('ledger.form.branch')}
            <select value={header.branchId} onChange={(e) => setHeader({ ...header, branchId: e.target.value })}>
              <option value="">—</option>
              {meta.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="ledger-field">
            {t('ledger.form.currency')}
            <select value={header.currencyCode} onChange={(e) => setHeader({ ...header, currencyCode: e.target.value })}>
              {(meta.currencies || [meta.base_currency]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </label>
          {foreign && (
            <p className={rateInfo ? 'ledger-hint' : 'ledger-error'} style={{ gridColumn: '1 / -1' }}>
              {rateInfo ? `${t('fx.rateUsed')}: ${rateInfo.rate} (${rateInfo.rate_quote === 'foreign_per_base' ? `${docCur.code}/${meta.base_currency.code}` : `${meta.base_currency.code}/${docCur.code}`}) · ${rateInfo.effective_at}` : t('fx.noRate')}
              {' '}<Link to="/ledger/exchange-rates">{t('nav.exchangeRates')}</Link>
            </p>
          )}
        </div>
        <div className="ledger-table-wrap">
          <table className="ledger-table ledger-lines-table">
            <thead>
              <tr>
                <th>#</th><th>{t('sales.product')}</th><th>{t('sales.description')}</th><th>{t('sales.qty')}</th>
                <th>{t('sales.unitPrice')}</th><th>{t('sales.discount')}</th><th>{t('sales.taxRate')}</th>{taxCodes.length > 0 && <th>{t('ax.code')}</th>}<th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <select value={l.productId} onChange={setLine(i, 'productId')}>
                      <option value="">—</option>
                      {meta.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td><input value={l.description} onChange={setLine(i, 'description')} placeholder={l.productId ? t('sales.fromProduct') : ''} /></td>
                  <td><input dir="ltr" value={l.qty} onChange={setLine(i, 'qty')} /></td>
                  <td><input dir="ltr" value={l.unitPrice} onChange={setLine(i, 'unitPrice')} placeholder={l.productId ? t('sales.autoPrice') : ''} /></td>
                  <td><input dir="ltr" value={l.discount} onChange={setLine(i, 'discount')} /></td>
                  <td><input dir="ltr" value={l.taxRate} disabled={Boolean(l.taxCodeId)} onChange={setLine(i, 'taxRate')} placeholder="%" /></td>
                  {taxCodes.length > 0 && <td><select value={l.taxCodeId || ''} onChange={setLine(i, 'taxCodeId')}><option value="">—</option>{taxCodes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></td>}
                  <td>{lines.length > 1 && <button type="button" className="ghost-btn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="ghost-btn" style={{ marginTop: 10 }} onClick={() => setLines((ls) => [...ls, emptyLine()])}>{t('ledger.form.addLine')}</button>
        <div className="ledger-balance ledger-balance-ok">
          <span>{t('sales.total')}: <strong>{formatMinor(preview.total, d)}</strong> {docCur.code}</span>
          {preview.rounding !== 0 && <span>{t('sales.rounding')}: <strong>{formatMinor(preview.rounding, d)}</strong></span>}
          {preview.unknown && <span>{t('sales.pricedOnSave')}</span>}
        </div>
        <label className="ledger-field" style={{ marginBottom: 12 }}>{t('sales.notes')}<input value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} /></label>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" disabled={saving || !header.shopId} onClick={() => save(false)}>{t('ledger.form.saveDraft')}</button>
          <button type="button" className="gold-btn" disabled={saving || !header.shopId} onClick={() => save(true)}>{t('sales.saveAndPost')}</button>
        </div>
      </div>
    </>
  );
}

function InvoiceDetail({ t, meta, id, can, go }) {
  const [inv, setInv] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = ((meta.currencies || []).find((c) => c.code === inv?.currency_code) || meta.base_currency).minor_unit_digits;
  const load = () => api.getSalesInvoice(id).then(setInv).catch((err) => setError(ledgerError(err, t)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!inv) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{inv.invoice_number || t('sales.draftNoNumber')} <StatusBadge status={inv.status} t={t} /></h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{inv.shop?.name} · {inv.invoice_date} · {inv.currency_code}{inv.exchange_rate && inv.currency_code !== inv.base_currency ? ` · ${t('fx.rateUsed')} ${inv.exchange_rate} · ${t('fx.baseTotal')} ${inv.total_base} ${inv.base_currency}` : ''}</p>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          <a className="ghost-btn" href={`/api/sales/invoices/${inv.id}/print`} target="_blank" rel="noreferrer">{t('sales.print')}</a>
          {inv.status === 'draft' && can('create_sales_invoices') && (
            <>
              <button type="button" className="ghost-btn" onClick={() => go({ edit: String(inv.id) })}>{t('ledger.edit')}</button>
              <button type="button" className="danger-btn" disabled={busy} onClick={() => window.confirm(t('ledger.detail.deleteConfirm')) && act(async () => { await api.deleteSalesInvoice(inv.id); go({}); })}>{t('ledger.delete')}</button>
            </>
          )}
          {inv.status === 'draft' && can('post_sales_invoices') && (
            <button type="button" className="gold-btn" disabled={busy} onClick={() => act(async () => {
              try {
                setInv(await api.postSalesInvoice(inv.id));
              } catch (err) {
                // Credit limit blocked but this user may override with a reason.
                if (err?.detail?.error !== 'credit_override_reason_required') throw err;
                const reason = window.prompt(t('sales.credit.overridePrompt'));
                if (!reason) throw err;
                setInv(await api.postSalesInvoiceWithOverride(inv.id, reason));
              }
            })}>{t('ledger.form.post')}</button>
          )}
          {inv.status === 'posted' && can('create_credit_notes') && (
            <>
              <Link className="ghost-btn" to={`/sales/credit-notes?invoice=${inv.id}`}>{t('sales.creditNote')}</Link>
              <button type="button" className="danger-btn" disabled={busy} onClick={() => {
                const reason = window.prompt(t('sales.cancelReason'));
                if (reason) act(async () => { await api.cancelSalesInvoice(inv.id, { reason, restock: window.confirm(t('sales.restockConfirm')) }); load(); });
              }}>{t('sales.cancelInvoice')}</button>
            </>
          )}
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {inv.credit_check?.exceeded && (
        <div className="ledger-error">
          {inv.credit_check.overridden ? t('sales.credit.overridden') : t('sales.credit.warning')} — {t('sales.credit.limit')}: {inv.credit_check.limit} · {t('sales.credit.projected')}: {Math.round(inv.credit_check.projected_balance * 100) / 100}
        </div>
      )}
      {inv.order_id && <div className="ledger-hint">{t('sales.fromOrder.linked')} #{inv.order_id}</div>}
      <div className="card ledger-card">
        <div className="ledger-meta-grid">
          <div><div className="ledger-meta-label">{t('sales.dueDate')}</div>{inv.due_date || '—'}</div>
          <div><div className="ledger-meta-label">{t('sales.journalEntry')}</div>{inv.journal_entry ? <Link to={`/ledger/entries?id=${inv.journal_entry.id}`}>{inv.journal_entry.entry_number}</Link> : '—'}</div>
          <div><div className="ledger-meta-label">{t('sales.credited')}</div>{formatMinor(inv.credited_minor, d)}</div>
          <div><div className="ledger-meta-label">{t('sales.open')}</div>{formatMinor(inv.total_minor - inv.credited_minor, d)}</div>
          <div><div className="ledger-meta-label">{t('sales.customerLedger')}</div><Link to={`/sales/customers?shop=${inv.shop_id}`}>{inv.shop?.name}</Link></div>
        </div>
      </div>
      <div className="ledger-table-wrap">
        <table className="ledger-table">
          <thead>
            <tr><th>#</th><th>{t('sales.description')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('sales.unitPrice')}</th><th className="ledger-num">{t('sales.discount')}</th><th className="ledger-num">{t('sales.net')}</th><th className="ledger-num">{t('sales.tax')}</th><th className="ledger-num">{t('sales.creditedQty')}</th></tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.line_no}</td><td>{l.description}</td><td className="ledger-num">{l.qty}</td>
                <td className="ledger-num">{formatMinor(l.unit_price_minor, d)}</td><td className="ledger-num">{l.discount_minor ? formatMinor(l.discount_minor, d) : ''}</td>
                <td className="ledger-num">{formatMinor(l.net_minor, d)}</td><td className="ledger-num">{l.tax_minor ? formatMinor(l.tax_minor, d) : ''}</td>
                <td className="ledger-num">{l.credited_qty || ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {inv.tax_minor > 0 && <tr><td colSpan={5}>{t('sales.tax')}</td><td colSpan={3} className="ledger-num">{formatMinor(inv.tax_minor, d)}</td></tr>}
            {inv.rounding_minor !== 0 && <tr><td colSpan={5}>{t('sales.rounding')}</td><td colSpan={3} className="ledger-num">{formatMinor(inv.rounding_minor, d)}</td></tr>}
            <tr><td colSpan={5}>{t('sales.total')}</td><td colSpan={3} className="ledger-num">{formatMinor(inv.total_minor, d)} {inv.currency_code}</td></tr>
          </tfoot>
        </table>
      </div>
      {inv.credit_notes.length > 0 && (
        <div className="card ledger-card" style={{ marginTop: 16 }}>
          <h2 className="atlas-section-title">{t('sales.creditNotes.title')}</h2>
          <ul>{inv.credit_notes.map((c) => <li key={c.id}><Link to={`/sales/credit-notes?id=${c.id}`}>{c.credit_note_number}</Link> · {c.note_date} · {c.total}</li>)}</ul>
        </div>
      )}
    </>
  );
}

// Prompt 3, item 1: delivered orders without an invoice -> prefilled draft.
function FromOrderList({ t, meta, go }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    api.getInvoiceableOrders().then(setRows).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function create(orderId) {
    setBusy(orderId);
    setError(null);
    try {
      const inv = await api.createInvoiceFromOrder(orderId);
      go({ edit: String(inv.id) });
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('sales.fromOrder.title')}</h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{t('sales.fromOrder.hint')}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {rows && rows.length === 0 && <div className="ledger-empty">{t('sales.fromOrder.empty')}</div>}
      {rows && rows.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr><th>#</th><th>{t('sales.customer')}</th><th>{t('ledger.entries.date')}</th><th>{t('sales.fromOrder.deliveredAt')}</th><th className="ledger-num">{t('sales.total')}</th><th /></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td><td>{o.shop_name}</td><td>{o.order_date}</td><td>{o.delivered_at || '—'}</td>
                  <td className="ledger-num">{o.total_value}</td>
                  <td><button type="button" className="gold-btn" disabled={busy === o.id} onClick={() => create(o.id)}>{t('sales.fromOrder.create')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
