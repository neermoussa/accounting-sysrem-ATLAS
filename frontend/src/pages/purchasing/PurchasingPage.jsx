import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { ledgerError, withBreakGlass } from '../ledger/ledgerShared.js';
import { Badge, LineEditor, baseMoney, cleanLines, emptyLine, money } from './purchasingShared.jsx';
import '../../styles/ledger.css';
import PriceModeBadge from '../../components/PriceModeBadge.jsx';

const TABS = ['dashboard', 'requests', 'orders', 'receipts', 'invoices', 'payments', 'debit-notes'];
const today = () => new Date().toISOString().slice(0, 10);

// Purchase-to-pay workspace (Prompt 6): request -> approval -> quotations
// -> PO -> approval -> goods receipt -> supplier invoice (three-way match)
// -> payment -> debit note. ?tab=...&id=... opens a document.
export default function PurchasingPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'dashboard';
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    api.purGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = (patch) => setSp(Object.fromEntries(Object.entries({ tab, ...patch }).filter(([, v]) => v)));
  // Runs an action, shows its error/notice in one place.
  const act = async (fn, okMsg) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (okMsg) setNotice(okMsg);
      return r;
    } catch (err) {
      setError(ledgerError(err, t));
      return null;
    }
  };
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const props = { t, meta, can, act, go, id: sp.get('id'), isNew: sp.get('new') === '1', sp };
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('pur.title')}</h1>
          <PriceModeBadge />
          <p className="ledger-subtitle">{t('pur.subtitle')}</p>
        </div>
        <div className="ledger-actions">
          <Link className="ghost-btn" to="/purchasing/suppliers">{t('nav.suppliers')}</Link>
          <Link className="ghost-btn" to="/purchasing/reports">{t('nav.payablesReports')}</Link>
        </div>
      </div>
      <div className="ledger-tabs">
        {TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`pur.tab.${k}`)}</button>)}
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {tab === 'dashboard' && <Dashboard {...props} />}
      {tab === 'requests' && <Requests {...props} />}
      {tab === 'orders' && <Orders {...props} />}
      {tab === 'receipts' && <Receipts {...props} />}
      {tab === 'invoices' && <Invoices {...props} />}
      {tab === 'payments' && <Payments {...props} />}
      {tab === 'debit-notes' && <DebitNotes {...props} />}
    </div>
  );
}

function useList(path, params, deps) {
  const [rows, setRows] = useState(null);
  const reload = () => api.purGet(path, params).then(setRows).catch(() => setRows([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps || []);
  return [rows, reload];
}

function Dashboard({ t, meta }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.purGet('/dashboard').then(setD).catch(() => {}); }, []);
  if (!d) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const tiles = [
    ['payables_minor', 'money'], ['overdue_minor', 'money'], ['due_this_week_minor', 'money'], ['grni_minor', 'money'],
    ['open_pos', 'count'], ['pending_approval', 'count'], ['pending_requests', 'count'], ['mismatched_invoices', 'count'], ['active_suppliers', 'count'],
  ];
  return (
    <>
      <div className="ledger-meta-grid card ledger-card">
        {tiles.map(([k, kind]) => <div key={k}><div className="ledger-meta-label">{t(`pur.dash.${k}`)}</div><strong>{kind === 'money' ? baseMoney(meta, d[k]) : d[k]}</strong></div>)}
      </div>
      <div className={`ledger-balance ${d.reconciliation.difference_minor ? 'ledger-balance-bad' : 'ledger-balance-ok'}`}>{t('pur.dash.recon')}: {baseMoney(meta, d.reconciliation.control_minor)} / {baseMoney(meta, d.reconciliation.subledger_minor)}</div>
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('pur.dash.top')}</h2>
        <table className="ledger-table"><tbody>{d.top_suppliers.map((r) => <tr key={r.key}><td>{r.label}</td><td className="ledger-num">{baseMoney(meta, r.base_minor)}</td></tr>)}</tbody></table>
      </div>
    </>
  );
}

// ---------------- requests (+ quotations, comparison) ----------------

function Requests({ t, meta, can, act, go, id, isNew }) {
  const [rows, reload] = useList('/requests', {}, [id, isNew]);
  if (isNew) return <RequestForm t={t} meta={meta} act={act} go={go} />;
  if (id) return <RequestDetail key={id} t={t} meta={meta} can={can} act={act} go={go} id={id} reload={reload} />;
  return (
    <>
      {can('create_purchase_requests') && <div className="ledger-toolbar"><span /><button type="button" className="gold-btn" onClick={() => go({ new: '1' })}>{t('pur.requests.new')}</button></div>}
      <table className="ledger-table">
        <thead><tr><th>#</th><th>{t('fr.date')}</th><th>{t('pur.neededBy')}</th><th>{t('pur.lines')}</th><th>{t('fr.status')}</th></tr></thead>
        <tbody>{(rows || []).map((r) => <tr key={r.id} className="ledger-row-click" onClick={() => go({ id: String(r.id) })}><td>{r.request_number || t('sales.draftNoNumber')}</td><td>{r.request_date}</td><td>{r.needed_by || ''}</td><td>{r.line_count}</td><td><Badge t={t} status={r.status} /></td></tr>)}</tbody>
      </table>
    </>
  );
}

function RequestForm({ t, meta, act, go }) {
  const [form, setForm] = useState({ neededBy: '', notes: '' });
  const [lines, setLines] = useState([emptyLine()]);
  return (
    <div className="card ledger-card">
      <div className="ledger-form-grid">
        <label className="ledger-field">{t('pur.neededBy')}<input type="date" value={form.neededBy} onChange={(e) => setForm({ ...form, neededBy: e.target.value })} /></label>
        <label className="ledger-field">{t('sales.notes')}<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </div>
      <LineEditor t={t} meta={meta} lines={lines} setLines={setLines} priced={false} />
      <div className="ledger-actions" style={{ marginTop: 12 }}>
        <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
        <button type="button" className="gold-btn" onClick={async () => {
          const r = await act(() => api.purPost('/requests', { ...form, lines: cleanLines(lines).map(({ productId, description, qty }) => ({ productId, description, qty })) }));
          if (r) go({ id: String(r.id) });
        }}>{t('ledger.save')}</button>
      </div>
    </div>
  );
}

function RequestDetail({ t, meta, can, act, go, id }) {
  const [r, setR] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [quote, setQuote] = useState(null);
  const load = () => {
    api.purGet(`/requests/${id}`).then(setR).catch(() => {});
    api.purGet(`/requests/${id}/comparison`).then(setCmp).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id]);
  if (!r) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const action = (a, body = {}) => act(() => api.purPost(`/requests/${id}/${a}`, body)).then(load);
  return (
    <>
      <div className="ledger-toolbar">
        <h2 className="atlas-section-title">{r.request_number || t('sales.draftNoNumber')} <Badge t={t} status={r.status} /></h2>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          {r.status === 'draft' && can('create_purchase_requests') && <button type="button" className="gold-btn" onClick={() => action('submit')}>{t('pur.submit')}</button>}
          {r.status === 'submitted' && can('approve_purchase_orders') && (
            <>
              <button type="button" className="gold-btn" onClick={() => action('approve')}>{t('pur.approve')}</button>
              <button type="button" className="danger-btn" onClick={() => { const reason = window.prompt(t('pur.rejectReason')); if (reason) action('reject', { reason }); }}>{t('pur.reject')}</button>
            </>
          )}
        </div>
      </div>
      <table className="ledger-table"><tbody>{r.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td className="ledger-num">{l.qty}</td></tr>)}</tbody></table>
      {['approved', 'submitted', 'ordered'].includes(r.status) && cmp && (
        <div className="card ledger-card">
          <div className="ledger-toolbar">
            <h2 className="atlas-section-title">{t('pur.comparison')}</h2>
            {can('create_purchase_requests') && r.status !== 'ordered' && <button type="button" className="ghost-btn" onClick={() => setQuote({ supplierId: '', currencyCode: '', prices: {} })}>{t('pur.addQuotation')}</button>}
          </div>
          <table className="ledger-table">
            <thead><tr><th>{t('sales.description')}</th><th>{t('sales.qty')}</th>{cmp.totals.map((q) => <th key={q.quotation_id}>{q.supplier_name}</th>)}</tr></thead>
            <tbody>{cmp.rows.map((row) => (
              <tr key={row.request_line_id}><td>{row.description}</td><td>{row.qty}</td>{cmp.totals.map((q) => {
                const o = row.offers.find((x) => x.quotation_id === q.quotation_id);
                return <td key={q.quotation_id} className="ledger-num" style={o?.best ? { fontWeight: 700, color: 'var(--atlas-success, green)' } : {}}>{o ? `${money(meta, o.unit_price_minor, o.currency_code)}${o.currency_code !== meta.base_currency.code && o.unit_base_minor !== null ? ` ≈ ${baseMoney(meta, o.unit_base_minor)}` : ''}${o.best ? ' ★' : ''}` : '—'}</td>;
              })}</tr>
            ))}</tbody>
            <tfoot><tr><th colSpan={2}>{t('fr.total')} ({meta.base_currency.code})</th>{cmp.totals.map((q) => (
              <th key={q.quotation_id} className="ledger-num">
                {baseMoney(meta, q.base_total_minor)}
                {r.status === 'approved' && can('create_purchase_requests') && <div><button type="button" className="ghost-btn" onClick={async () => {
                  const qt = await api.purGet(`/quotations/${q.quotation_id}`);
                  const po = await act(() => api.purPost('/orders', { supplierId: qt.supplier_id, requestId: r.id, quotationId: qt.id }));
                  if (po) go({ tab: 'orders', id: String(po.id) });
                }}>{t('pur.createPo')}</button></div>}
              </th>
            ))}</tr></tfoot>
          </table>
          {quote && (
            <div className="card ledger-card">
              <div className="ledger-form-grid">
                <label className="ledger-field">{t('pur.supplier')}
                  <select value={quote.supplierId} onChange={(e) => setQuote({ ...quote, supplierId: e.target.value, currencyCode: meta.suppliers.find((s) => s.id === Number(e.target.value))?.currency_code || '' })}>
                    <option value="">—</option>{meta.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="ledger-field">{t('ledger.form.currency')}
                  <select value={quote.currencyCode} onChange={(e) => setQuote({ ...quote, currencyCode: e.target.value })}>
                    <option value="">{meta.base_currency.code}</option>{meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                  </select>
                </label>
              </div>
              <table className="ledger-table"><tbody>{r.lines.map((l) => (
                <tr key={l.id}><td>{l.description}</td><td>{l.qty}</td><td><input dir="ltr" placeholder={t('sales.unitPrice')} value={quote.prices[l.id] || ''} onChange={(e) => setQuote({ ...quote, prices: { ...quote.prices, [l.id]: e.target.value } })} /></td></tr>
              ))}</tbody></table>
              <button type="button" className="gold-btn" onClick={async () => {
                const res = await act(() => api.purPost('/quotations', { requestId: r.id, supplierId: Number(quote.supplierId), currencyCode: quote.currencyCode || undefined, lines: r.lines.filter((l) => quote.prices[l.id]).map((l) => ({ requestLineId: l.id, productId: l.product_id, description: l.description, qty: l.qty, unitPrice: quote.prices[l.id] })) }));
                if (res) { setQuote(null); load(); }
              }}>{t('ledger.save')}</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- purchase orders (+ receive) ----------------

function Orders({ t, meta, can, act, go, id, isNew }) {
  const [rows] = useList('/orders', {}, [id, isNew]);
  if (isNew) return <OrderForm t={t} meta={meta} act={act} go={go} />;
  if (id) return <OrderDetail key={id} t={t} meta={meta} can={can} act={act} go={go} id={id} />;
  return (
    <>
      {can('create_purchase_requests') && <div className="ledger-toolbar"><span /><button type="button" className="gold-btn" onClick={() => go({ new: '1' })}>{t('pur.orders.new')}</button></div>}
      <table className="ledger-table">
        <thead><tr><th>#</th><th>{t('fr.date')}</th><th>{t('pur.supplier')}</th><th className="ledger-num">{t('fr.total')}</th><th>{t('fr.status')}</th></tr></thead>
        <tbody>{(rows || []).map((r) => <tr key={r.id} className="ledger-row-click" onClick={() => go({ id: String(r.id) })}><td>{r.po_number || t('sales.draftNoNumber')}</td><td>{r.order_date}</td><td>{r.supplier_name}</td><td className="ledger-num">{money(meta, r.total_minor, r.currency_code)}</td><td><Badge t={t} status={r.status} /></td></tr>)}</tbody>
      </table>
    </>
  );
}

function OrderForm({ t, meta, act, go }) {
  const [form, setForm] = useState({ supplierId: '', currencyCode: '', orderDate: today(), expectedDate: '', approverUserId: '', warehouseId: '' });
  const [lines, setLines] = useState([emptyLine()]);
  return (
    <div className="card ledger-card">
      <div className="ledger-form-grid">
        <label className="ledger-field">{t('pur.supplier')}
          <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value, currencyCode: meta.suppliers.find((s) => s.id === Number(e.target.value))?.currency_code || '' })}>
            <option value="">—</option>{meta.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="ledger-field">{t('ledger.form.currency')}
          <select value={form.currencyCode} onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}>
            <option value="">{meta.base_currency.code}</option>{meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
        </label>
        <label className="ledger-field">{t('fr.date')}<input type="date" value={form.orderDate} onChange={(e) => setForm({ ...form, orderDate: e.target.value })} /></label>
        <label className="ledger-field">{t('pur.expected')}<input type="date" value={form.expectedDate} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} /></label>
        <label className="ledger-field">{t('pur.approver')}
          <select value={form.approverUserId} onChange={(e) => setForm({ ...form, approverUserId: e.target.value })}>
            <option value="">{t('pur.anyApprover')}</option>{meta.approvers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="ledger-field">{t('pur.warehouse')}
          <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
            <option value="">—</option>{meta.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>
      <LineEditor t={t} meta={meta} lines={lines} setLines={setLines} />
      <div className="ledger-actions" style={{ marginTop: 12 }}>
        <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
        <button type="button" className="gold-btn" onClick={async () => {
          const body = { ...form, supplierId: Number(form.supplierId), currencyCode: form.currencyCode || undefined, approverUserId: form.approverUserId ? Number(form.approverUserId) : null, warehouseId: form.warehouseId ? Number(form.warehouseId) : null, expectedDate: form.expectedDate || null, lines: cleanLines(lines) };
          const r = await act(() => api.purPost('/orders', body));
          if (r) go({ id: String(r.id) });
        }}>{t('ledger.save')}</button>
      </div>
    </div>
  );
}

function OrderDetail({ t, meta, can, act, go, id }) {
  const [po, setPo] = useState(null);
  const [recv, setRecv] = useState(null);
  const load = () => api.purGet(`/orders/${id}`).then(setPo).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);
  if (!po) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const action = (a, body = {}) => act(() => (a === 'approve' ? withBreakGlass(t, (bg) => api.purPost(`/orders/${id}/${a}`, { ...body, ...bg })) : api.purPost(`/orders/${id}/${a}`, body))).then(load);
  return (
    <>
      <div className="ledger-toolbar">
        <h2 className="atlas-section-title">{po.po_number || t('sales.draftNoNumber')} · {po.supplier.name} <Badge t={t} status={po.status} /></h2>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          {po.status === 'draft' && can('create_purchase_requests') && <button type="button" className="gold-btn" onClick={() => action('submit')}>{t('pur.submit')}</button>}
          {po.status === 'pending_approval' && can('approve_purchase_orders') && (
            <>
              <button type="button" className="gold-btn" onClick={() => action('approve')}>{t('pur.approve')}</button>
              <button type="button" className="danger-btn" onClick={() => { const reason = window.prompt(t('pur.rejectReason')); if (reason) action('reject', { reason }); }}>{t('pur.reject')}</button>
            </>
          )}
          {['approved', 'partially_received'].includes(po.status) && can('receive_goods') && <button type="button" className="gold-btn" onClick={() => setRecv({ date: today(), lines: Object.fromEntries(po.lines.map((l) => [l.id, { qty: String(Math.max(0, l.qty - l.received_qty)), rejected: '', weight: '' }])) })}>{t('pur.receive')}</button>}
          {['approved', 'partially_received', 'received'].includes(po.status) && can('post_supplier_invoices') && <button type="button" className="ghost-btn" onClick={() => go({ tab: 'invoices', new: '1', po: String(po.id) })}>{t('pur.invoiceThis')}</button>}
        </div>
      </div>
      <p className="ledger-hint">{po.order_date} · {t('pur.expected')}: {po.expected_date || '—'} · {po.currency_code}{po.estimated_base_minor ? ` · ≈ ${baseMoney(meta, po.estimated_base_minor)} ${meta.base_currency.code}` : ''}</p>
      <table className="ledger-table">
        <thead><tr><th>{t('sales.description')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('sales.unitPrice')}</th><th className="ledger-num">{t('pur.received')}</th><th className="ledger-num">{t('pur.invoiced')}</th>{recv && <><th>{t('pur.receiveQty')}</th><th>{t('pur.rejected')}</th><th>{t('pur.weightKg')}</th></>}</tr></thead>
        <tbody>{po.lines.map((l) => (
          <tr key={l.id}>
            <td>{l.description}</td><td className="ledger-num">{l.qty}</td><td className="ledger-num">{money(meta, l.unit_price_minor, po.currency_code)}</td><td className="ledger-num">{l.received_qty}</td><td className="ledger-num">{l.invoiced_qty}</td>
            {recv && ['qty', 'rejected', 'weight'].map((k) => <td key={k}><input dir="ltr" style={{ width: 70 }} value={recv.lines[l.id][k]} onChange={(e) => setRecv({ ...recv, lines: { ...recv.lines, [l.id]: { ...recv.lines[l.id], [k]: e.target.value } } })} /></td>)}
          </tr>
        ))}</tbody>
        <tfoot><tr><th colSpan={2}>{t('fr.total')}</th><th className="ledger-num">{money(meta, po.total_minor, po.currency_code)}</th><th colSpan={recv ? 5 : 2} /></tr></tfoot>
      </table>
      {recv && (
        <div className="ledger-actions" style={{ marginTop: 12 }}>
          <label className="ledger-field">{t('fr.date')}<input type="date" value={recv.date} onChange={(e) => setRecv({ ...recv, date: e.target.value })} /></label>
          <button type="button" className="gold-btn" onClick={async () => {
            const lines = Object.entries(recv.lines).filter(([, v]) => Number(v.qty) > 0).map(([poLineId, v]) => ({ poLineId: Number(poLineId), qty: v.qty, rejectedQty: v.rejected || 0, weightKg: v.weight || undefined }));
            const r = await act(() => api.purPost(`/orders/${id}/receive`, { receiptDate: recv.date, lines }), t('pur.receivedOk'));
            if (r) { setRecv(null); load(); }
          }}>{t('pur.postReceipt')}</button>
        </div>
      )}
      {po.receipts.length > 0 && <p className="ledger-hint">{t('pur.tab.receipts')}: {po.receipts.map((r) => <Link key={r.id} to={`/purchasing?tab=receipts&id=${r.id}`} style={{ marginInlineEnd: 8 }}>{r.receipt_number}</Link>)}</p>}
      {po.invoices.length > 0 && <p className="ledger-hint">{t('pur.tab.invoices')}: {po.invoices.map((i) => <Link key={i.id} to={`/purchasing?tab=invoices&id=${i.id}`} style={{ marginInlineEnd: 8 }}>{i.invoice_number || i.supplier_invoice_ref || `#${i.id}`}</Link>)}</p>}
    </>
  );
}

// ---------------- receipts ----------------

function Receipts({ t, meta, can, go, id }) {
  const [rows] = useList('/receipts', {}, [id]);
  const [r, setR] = useState(null);
  useEffect(() => { if (id) api.purGet(`/receipts/${id}`).then(setR).catch(() => {}); else setR(null); }, [id]);
  if (id && r) {
    return (
      <>
        <div className="ledger-toolbar">
          <h2 className="atlas-section-title">{r.receipt_number} · {r.supplier.name} · {r.purchase_order.po_number}</h2>
          <div className="ledger-actions">
            <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
            {can('post_supplier_invoices') && <button type="button" className="ghost-btn" onClick={() => go({ tab: 'invoices', new: '1', kind: 'landed_cost', receipt: String(r.id) })}>{t('pur.addLanded')}</button>}
          </div>
        </div>
        <p className="ledger-hint">{r.receipt_date} · {r.currency_code} @ {r.exchange_rate} · {t('pur.value')} {baseMoney(meta, r.total_base_minor)} · {t('pur.landed')} {baseMoney(meta, r.landed_base_minor)} · {r.journal_entry && <Link to={`/ledger/entries?id=${r.journal_entry.id}`}>{r.journal_entry.entry_number}</Link>}</p>
        <table className="ledger-table">
          <thead><tr><th>{t('sales.description')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('pur.rejected')}</th><th className="ledger-num">{t('pur.value')}</th><th className="ledger-num">{t('pur.landed')}</th><th className="ledger-num">{t('pur.invoiced')}</th></tr></thead>
          <tbody>{r.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td className="ledger-num">{l.qty}</td><td className="ledger-num">{l.rejected_qty || ''}</td><td className="ledger-num">{baseMoney(meta, l.value_base_minor)}</td><td className="ledger-num">{baseMoney(meta, l.landed_base_minor)}</td><td className="ledger-num">{l.invoiced_qty}</td></tr>)}</tbody>
        </table>
      </>
    );
  }
  return (
    <table className="ledger-table">
      <thead><tr><th>#</th><th>{t('fr.date')}</th><th>{t('pur.supplier')}</th><th>{t('pur.po')}</th><th className="ledger-num">{t('pur.value')}</th></tr></thead>
      <tbody>{(rows || []).map((x) => <tr key={x.id} className="ledger-row-click" onClick={() => go({ id: String(x.id) })}><td>{x.receipt_number}</td><td>{x.receipt_date}</td><td>{x.supplier_name}</td><td>{x.po_number}</td><td className="ledger-num">{baseMoney(meta, x.total_base_minor)}</td></tr>)}</tbody>
    </table>
  );
}

// ---------------- supplier invoices (+ three-way match review) ----------------

function Invoices({ t, meta, can, act, go, id, isNew, sp }) {
  const [filter, setFilter] = useState('');
  const [rows] = useList('/invoices', { match: filter }, [id, isNew, filter]);
  if (isNew) return <InvoiceForm t={t} meta={meta} act={act} go={go} poId={sp.get('po')} kind={sp.get('kind') || 'goods'} receiptId={sp.get('receipt')} />;
  if (id) return <InvoiceDetail key={id} t={t} meta={meta} can={can} act={act} go={go} id={id} />;
  return (
    <>
      <div className="ledger-toolbar">
        <label className="ledger-field">{t('pur.match')}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">{t('fr.all')}</option>{['mismatch', 'matched', 'approved', 'not_required'].map((k) => <option key={k} value={k}>{t(`pur.status.${k}`)}</option>)}
          </select>
        </label>
        {can('post_supplier_invoices') && <div className="ledger-actions"><button type="button" className="gold-btn" onClick={() => go({ new: '1', kind: 'expense' })}>{t('pur.invoices.newExpense')}</button></div>}
      </div>
      <table className="ledger-table">
        <thead><tr><th>#</th><th>{t('pur.supplierRef')}</th><th>{t('fr.date')}</th><th>{t('pur.supplier')}</th><th>{t('pur.kind')}</th><th className="ledger-num">{t('fr.total')}</th><th className="ledger-num">{t('sales.open')}</th><th>{t('pur.match')}</th><th>{t('fr.status')}</th></tr></thead>
        <tbody>{(rows || []).map((i) => (
          <tr key={i.id} className="ledger-row-click" onClick={() => go({ id: String(i.id) })}>
            <td>{i.invoice_number || t('sales.draftNoNumber')}</td><td>{i.supplier_invoice_ref || ''}</td><td>{i.invoice_date}</td><td>{i.supplier_name}</td><td>{t(`pur.kind.${i.kind}`)}</td>
            <td className="ledger-num">{money(meta, i.total_minor, i.currency_code)}</td><td className="ledger-num">{i.open_minor !== null ? money(meta, i.open_minor, i.currency_code) : ''}</td>
            <td><Badge t={t} status={i.match_status} /></td><td><Badge t={t} status={i.status} /></td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}

function InvoiceForm({ t, meta, act, go, poId, kind, receiptId }) {
  const [po, setPo] = useState(null);
  const [form, setForm] = useState({ supplierId: '', supplierInvoiceRef: '', invoiceDate: today(), currencyCode: '', landedMethod: 'value' });
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (kind === 'goods' && poId) {
      api.purGet(`/orders/${poId}`).then((p) => {
        setPo(p);
        setForm((f) => ({ ...f, supplierId: String(p.supplier_id) }));
        setLines(p.lines.filter((l) => l.received_qty - l.invoiced_qty > 0).map((l) => ({ poLineId: l.id, description: l.description, qty: String(Math.round((l.received_qty - l.invoiced_qty) * 1000) / 1000), unitPrice: (l.unit_price_minor / 10 ** p.digits).toFixed(p.digits), taxRate: String(l.tax_rate_bp / 100) })));
      }).catch(() => {});
    } else setLines([{ description: '', qty: '1', unitPrice: '', taxRate: '', expenseAccountId: '', landedKind: 'shipping' }]);
  }, [kind, poId]);
  const set = (i, k) => (e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));
  // Prompt 10: purchase tax codes and asset categories (expense invoices);
  // the columns appear only when the company has them.
  const [taxCodes, setTaxCodes] = useState([]);
  const [assetCats, setAssetCats] = useState([]);
  useEffect(() => {
    if (kind === 'landed_cost') return;
    api.acGet('/tax-codes').then((c) => setTaxCodes(c.filter((x) => x.type === 'purchase' && x.active))).catch(() => {});
    if (kind === 'expense') api.acGet('/asset-categories').then((c) => setAssetCats(c.filter((x) => x.active))).catch(() => {});
  }, [kind]);
  return (
    <div className="card ledger-card">
      <h2 className="atlas-section-title">{t(`pur.kind.${kind}`)}{po ? ` · ${po.po_number}` : ''}</h2>
      <PriceModeBadge />
      <div className="ledger-form-grid">
        {kind !== 'goods' && (
          <label className="ledger-field">{t('pur.supplier')}
            <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value, currencyCode: meta.suppliers.find((s) => s.id === Number(e.target.value))?.currency_code || '' })}>
              <option value="">—</option>{meta.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="ledger-field">{t('pur.supplierRef')}<input value={form.supplierInvoiceRef} onChange={(e) => setForm({ ...form, supplierInvoiceRef: e.target.value })} /></label>
        <label className="ledger-field">{t('fr.date')}<input type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} /></label>
        {kind !== 'goods' && (
          <label className="ledger-field">{t('ledger.form.currency')}
            <select value={form.currencyCode} onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}>
              <option value="">{meta.base_currency.code}</option>{meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </label>
        )}
        {kind === 'landed_cost' && (
          <label className="ledger-field">{t('pur.landedMethod')}
            <select value={form.landedMethod} onChange={(e) => setForm({ ...form, landedMethod: e.target.value })}>
              {['value', 'weight', 'quantity'].map((k) => <option key={k} value={k}>{t(`pur.method.${k}`)}</option>)}
            </select>
          </label>
        )}
      </div>
      <table className="ledger-table ledger-lines-table">
        <thead><tr><th>{t('sales.description')}</th>{kind === 'expense' && <th>{t('fr.account')}</th>}{kind === 'landed_cost' && <th>{t('pur.landedKind')}</th>}<th>{t('sales.qty')}</th><th>{t('sales.unitPrice')}</th><th>{t('sales.taxRate')}</th>{taxCodes.length > 0 && <th>{t('ax.code')}</th>}{assetCats.length > 0 && <th>{t('pur.assetCategory')}</th>}</tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td>{kind === 'goods' ? l.description : <input value={l.description} onChange={set(i, 'description')} />}</td>
            {kind === 'expense' && <td><select value={l.expenseAccountId} onChange={set(i, 'expenseAccountId')}><option value="">—</option>{meta.expense_accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}</select></td>}
            {kind === 'landed_cost' && <td><select value={l.landedKind} onChange={set(i, 'landedKind')}>{['shipping', 'customs', 'transport', 'insurance', 'other'].map((k) => <option key={k} value={k}>{t(`pur.landedKind.${k}`)}</option>)}</select></td>}
            <td><input dir="ltr" style={{ width: 80 }} value={l.qty} onChange={set(i, 'qty')} /></td>
            <td><input dir="ltr" style={{ width: 100 }} value={l.unitPrice} onChange={set(i, 'unitPrice')} /></td>
            <td><input dir="ltr" style={{ width: 60 }} value={l.taxRate} disabled={Boolean(l.taxCodeId)} onChange={set(i, 'taxRate')} /></td>
            {taxCodes.length > 0 && <td><select value={l.taxCodeId || ''} onChange={set(i, 'taxCodeId')}><option value="">—</option>{taxCodes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></td>}
            {assetCats.length > 0 && <td><select value={l.assetCategoryId || ''} onChange={set(i, 'assetCategoryId')}><option value="">{t('pur.notAsset')}</option>{assetCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>{l.assetCategoryId && <input type="number" placeholder={t('ax.life')} style={{ width: 90 }} value={l.assetLife || ''} onChange={set(i, 'assetLife')} />}</td>}
          </tr>
        ))}</tbody>
      </table>
      {kind !== 'goods' && <button type="button" className="ghost-btn" onClick={() => setLines((ls) => [...ls, { description: '', qty: '1', unitPrice: '', taxRate: '', expenseAccountId: '', landedKind: 'shipping' }])}>{t('ledger.form.addLine')}</button>}
      <div className="ledger-actions" style={{ marginTop: 12 }}>
        <button type="button" className="ghost-btn" onClick={() => go({ new: '', po: '', kind: '', receipt: '' })}>{t('ledger.back')}</button>
        <button type="button" className="gold-btn" onClick={async () => {
          const body = {
            kind, supplierId: Number(form.supplierId), supplierInvoiceRef: form.supplierInvoiceRef || null, invoiceDate: form.invoiceDate,
            currencyCode: kind === 'goods' ? undefined : form.currencyCode || undefined, poId: po?.id, receiptId: receiptId ? Number(receiptId) : undefined, landedMethod: kind === 'landed_cost' ? form.landedMethod : undefined,
            lines: lines.map((l) => ({ poLineId: l.poLineId, description: l.description, qty: l.qty, unitPrice: l.unitPrice, taxRate: l.taxCodeId ? undefined : l.taxRate || undefined, taxCodeId: l.taxCodeId ? Number(l.taxCodeId) : undefined, asset: l.assetCategoryId ? { categoryId: Number(l.assetCategoryId), usefulLifeMonths: l.assetLife ? Number(l.assetLife) : undefined } : undefined, expenseAccountId: l.expenseAccountId ? Number(l.expenseAccountId) : undefined, landedKind: kind === 'landed_cost' ? l.landedKind : undefined })),
          };
          const r = await act(() => api.purPost('/invoices', body));
          if (r) go({ id: String(r.id), new: '', po: '', kind: '', receipt: '' });
        }}>{t('ledger.save')}</button>
      </div>
    </div>
  );
}

function InvoiceDetail({ t, meta, can, act, go, id }) {
  const [inv, setInv] = useState(null);
  const [dn, setDn] = useState(null);
  const load = () => api.purGet(`/invoices/${id}`).then(setInv).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);
  if (!inv) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const cur = inv.currency_code;
  return (
    <>
      <div className="ledger-toolbar">
        <h2 className="atlas-section-title">{inv.invoice_number || t('sales.draftNoNumber')} · {inv.supplier.name} {inv.supplier_invoice_ref ? `(${inv.supplier_invoice_ref})` : ''} <Badge t={t} status={inv.status} /> <Badge t={t} status={inv.match_status} /></h2>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          {inv.status === 'draft' && inv.match_status === 'mismatch' && can('approve_purchase_mismatch') && <button type="button" className="ghost-btn" onClick={() => { const reason = window.prompt(t('pur.mismatchReason')); if (reason) act(() => api.purPost(`/invoices/${id}/approve-mismatch`, { reason })).then(load); }}>{t('pur.approveMismatch')}</button>}
          {inv.status === 'draft' && can('post_supplier_invoices') && (
            <>
              <button type="button" className="danger-btn" onClick={() => window.confirm(t('ledger.detail.deleteConfirm')) && act(() => api.purDel(`/invoices/${id}`)).then((r) => r && go({}))}>{t('ledger.delete')}</button>
              <button type="button" className="gold-btn" onClick={() => act(() => api.purPost(`/invoices/${id}/post`, {}), t('pur.postedOk')).then(load)}>{t('ledger.form.post')}</button>
            </>
          )}
          {inv.status === 'posted' && inv.kind !== 'landed_cost' && inv.open_minor > 0 && can('post_supplier_invoices') && <button type="button" className="ghost-btn" onClick={() => setDn(Object.fromEntries(inv.lines.map((l) => [l.id, ''])))}>{t('pur.debitNote')}</button>}
          {inv.status === 'posted' && inv.open_minor > 0 && can('make_supplier_payments') && <button type="button" className="gold-btn" onClick={() => go({ tab: 'payments', new: '1', supplier: String(inv.supplier_id) })}>{t('pur.pay')}</button>}
        </div>
      </div>
      <p className="ledger-hint">{inv.invoice_date} · {t('sales.dueDate')} {inv.due_date} · {cur}{inv.exchange_rate && cur !== meta.base_currency.code ? ` @ ${inv.exchange_rate}` : ''}{inv.purchase_order ? ` · ${inv.purchase_order.po_number}` : ''}{inv.journal_entry ? ' · ' : ''}{inv.journal_entry && <Link to={`/ledger/entries?id=${inv.journal_entry.id}`}>{inv.journal_entry.entry_number}</Link>}</p>
      {inv.match && inv.kind === 'goods' && (
        <div className={`ledger-balance ${inv.match_status === 'mismatch' ? 'ledger-balance-bad' : 'ledger-balance-ok'}`}>
          <strong>{t('pur.matchReview')}</strong>
          {inv.match.lines.map((l) => (
            <span key={l.line_no}>#{l.line_no} {l.description}: {l.ok ? '✓' : l.issues.map((x) => (x.type === 'qty' ? `${t('pur.issue.qty')} ${x.invoiced} / ${x.received_not_invoiced}` : `${t('pur.issue.price')} ${money(meta, x.invoiced, cur)} / ${money(meta, x.ordered, cur)}`)).join(' · ')}</span>
          ))}
          {inv.mismatch_reason && <span>{t('pur.approvedBecause')}: {inv.mismatch_reason}</span>}
        </div>
      )}
      <table className="ledger-table">
        <thead><tr><th>{t('sales.description')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('sales.unitPrice')}</th><th className="ledger-num">{t('sales.net')}</th><th className="ledger-num">{t('sales.tax')}</th>{inv.status === 'posted' && inv.kind === 'goods' && <th className="ledger-num">{t('pur.ppv')}</th>}{dn && <th>{t('pur.returnQty')}</th>}</tr></thead>
        <tbody>{inv.lines.map((l) => (
          <tr key={l.id}>
            <td>{l.description}</td><td className="ledger-num">{l.qty}</td><td className="ledger-num">{money(meta, l.unit_price_minor, cur)}</td><td className="ledger-num">{money(meta, l.net_minor, cur)}</td><td className="ledger-num">{l.tax_minor ? money(meta, l.tax_minor, cur) : ''}</td>
            {inv.status === 'posted' && inv.kind === 'goods' && <td className="ledger-num">{l.ppv_base_minor ? baseMoney(meta, l.ppv_base_minor) : ''}</td>}
            {dn && <td><input dir="ltr" style={{ width: 70 }} value={dn[l.id]} onChange={(e) => setDn({ ...dn, [l.id]: e.target.value })} /></td>}
          </tr>
        ))}</tbody>
        <tfoot>
          <tr><th colSpan={3}>{t('fr.total')}</th><th colSpan={2} className="ledger-num">{money(meta, inv.total_minor, cur)}{inv.total_base_minor !== null && cur !== meta.base_currency.code ? ` = ${baseMoney(meta, inv.total_base_minor)} ${meta.base_currency.code}` : ''}</th></tr>
          {inv.open_minor !== null && <tr><th colSpan={3}>{t('sales.open')}</th><th colSpan={2} className="ledger-num">{money(meta, inv.open_minor, cur)}</th></tr>}
        </tfoot>
      </table>
      {dn && (
        <div className="ledger-actions" style={{ marginTop: 12 }}>
          <button type="button" className="gold-btn" onClick={async () => {
            const reason = window.prompt(t('pur.debitReason')) || '';
            const r = await act(() => api.purPost('/debit-notes', { invoiceId: inv.id, reason, lines: Object.entries(dn).filter(([, v]) => Number(v) > 0).map(([invoiceLineId, qty]) => ({ invoiceLineId: Number(invoiceLineId), qty })) }), t('pur.debitOk'));
            if (r) { setDn(null); load(); }
          }}>{t('pur.postDebitNote')}</button>
        </div>
      )}
      {inv.landed_allocations.length > 0 && <p className="ledger-hint">{t('pur.landedAlloc')}: {inv.landed_allocations.map((a) => `${a.description} ${baseMoney(meta, a.amount_base_minor)} (${a.product_cost_before ?? '—'} → ${a.product_cost_after ?? '—'})`).join(' · ')}</p>}
      {inv.payments.length > 0 && <p className="ledger-hint">{t('pur.tab.payments')}: {inv.payments.map((p) => <Link key={p.id} to={`/purchasing?tab=payments&id=${p.payment_id}`} style={{ marginInlineEnd: 8 }}>{p.payment_number}</Link>)}</p>}
    </>
  );
}

// ---------------- payments ----------------

function Payments({ t, meta, can, act, go, id, isNew, sp }) {
  const [rows] = useList('/payments', {}, [id, isNew]);
  if (isNew) return <PaymentForm t={t} meta={meta} act={act} go={go} supplierId={sp.get('supplier') || ''} />;
  if (id) return <PaymentDetail key={id} t={t} meta={meta} can={can} act={act} go={go} id={id} />;
  return (
    <>
      {can('make_supplier_payments') && <div className="ledger-toolbar"><span /><button type="button" className="gold-btn" onClick={() => go({ new: '1' })}>{t('pur.payments.new')}</button></div>}
      <table className="ledger-table">
        <thead><tr><th>#</th><th>{t('fr.date')}</th><th>{t('pur.supplier')}</th><th className="ledger-num">{t('fr.amount')}</th><th className="ledger-num">{t('rec.unallocated')}</th><th>{t('fr.status')}</th></tr></thead>
        <tbody>{(rows || []).map((p) => <tr key={p.id} className="ledger-row-click" onClick={() => go({ id: String(p.id) })}><td>{p.payment_number}</td><td>{p.payment_date}</td><td>{p.supplier_name}</td><td className="ledger-num">{money(meta, p.amount_original_minor, p.currency_code)}</td><td className="ledger-num">{p.unallocated_minor ? money(meta, p.unallocated_minor, p.currency_code) : ''}</td><td><Badge t={t} status={p.status} /></td></tr>)}</tbody>
      </table>
    </>
  );
}

function PaymentForm({ t, meta, act, go, supplierId }) {
  const [form, setForm] = useState({ supplierId, paymentDate: today(), method: 'transfer', currencyCode: meta.suppliers.find((s) => s.id === Number(supplierId))?.currency_code || '', amount: '', reference: '' });
  return (
    <div className="card ledger-card">
      <div className="ledger-form-grid">
        <label className="ledger-field">{t('pur.supplier')}
          <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value, currencyCode: meta.suppliers.find((s) => s.id === Number(e.target.value))?.currency_code || '' })}>
            <option value="">—</option>{meta.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="ledger-field">{t('fr.date')}<input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} /></label>
        <label className="ledger-field">{t('rec.method')}<select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{['transfer', 'cash', 'cheque', 'other'].map((m) => <option key={m} value={m}>{t(`rec.method.${m}`)}</option>)}</select></label>
        <label className="ledger-field">{t('ledger.form.currency')}<select value={form.currencyCode} onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}><option value="">{meta.base_currency.code}</option>{meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></label>
        <label className="ledger-field">{t('fr.amount')}<input dir="ltr" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label className="ledger-field">{t('pur.reference')}<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
      </div>
      <p className="ledger-hint">{t('pur.payAutoHint')}</p>
      <button type="button" className="gold-btn" onClick={async () => {
        const r = await act(() => withBreakGlass(t, (bg) => api.purPost('/payments', { ...form, supplierId: Number(form.supplierId), currencyCode: form.currencyCode || undefined, ...bg })));
        if (r) go({ id: String(r.id), new: '', supplier: '' });
      }}>{t('ledger.save')}</button>
    </div>
  );
}

function PaymentDetail({ t, meta, can, act, go, id }) {
  const [p, setP] = useState(null);
  const load = () => api.purGet(`/payments/${id}`).then(setP).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);
  if (!p) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  return (
    <>
      <div className="ledger-toolbar">
        <h2 className="atlas-section-title">{p.payment_number} · {p.supplier.name} <Badge t={t} status={p.status} /></h2>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          {p.status === 'posted' && p.unallocated_minor > 0 && can('make_supplier_payments') && <button type="button" className="ghost-btn" onClick={() => act(() => api.purPost(`/payments/${id}/auto-allocate`, {})).then(load)}>{t('rec.autoAllocateNow')}</button>}
          {p.status === 'posted' && can('make_supplier_payments') && <button type="button" className="danger-btn" onClick={() => { const reason = window.prompt(t('rec.reversePrompt')); if (reason) act(() => api.purPost(`/payments/${id}/reverse`, { reason })).then(load); }}>{t('ledger.detail.reverse')}</button>}
        </div>
      </div>
      <p className="ledger-hint">{p.payment_date} · {t(`rec.method.${p.method}`)} · {money(meta, p.amount_original_minor, p.currency_code)}{p.currency_code !== meta.base_currency.code ? ` @ ${p.exchange_rate} = ${baseMoney(meta, p.amount_minor)} ${meta.base_currency.code}` : ''} · {p.journal_entry && <Link to={`/ledger/entries?id=${p.journal_entry.id}`}>{p.journal_entry.entry_number}</Link>}</p>
      <table className="ledger-table">
        <thead><tr><th>{t('pur.tab.invoices')}</th><th className="ledger-num">{t('pur.settled')}</th><th className="ledger-num">{t('pur.paid')}</th><th className="ledger-num">{t('pur.fx')}</th></tr></thead>
        <tbody>{p.allocations.map((a) => <tr key={a.id}><td><Link to={`/purchasing?tab=invoices&id=${a.invoice_id}`}>{a.invoice_number}</Link></td><td className="ledger-num">{money(meta, a.amount_minor, a.invoice_currency)}</td><td className="ledger-num">{money(meta, a.payment_amount_minor, p.currency_code)}</td><td className="ledger-num">{a.base_relieved_minor !== a.base_paid_minor ? baseMoney(meta, a.base_relieved_minor - a.base_paid_minor) : ''}</td></tr>)}</tbody>
      </table>
      {p.unallocated_minor > 0 && <p className="ledger-hint">{t('rec.unallocated')}: {money(meta, p.unallocated_minor, p.currency_code)}</p>}
    </>
  );
}

function DebitNotes({ t, meta }) {
  const [rows] = useList('/debit-notes', {}, []);
  return (
    <table className="ledger-table">
      <thead><tr><th>#</th><th>{t('fr.date')}</th><th>{t('pur.supplier')}</th><th>{t('pur.tab.invoices')}</th><th className="ledger-num">{t('fr.total')}</th></tr></thead>
      <tbody>{(rows || []).map((d) => <tr key={d.id}><td>{d.debit_note_number}</td><td>{d.note_date}</td><td>{d.supplier_name}</td><td><Link to={`/purchasing?tab=invoices&id=${d.invoice_id}`}>{d.invoice_number}</Link></td><td className="ledger-num">{money(meta, d.total_minor, d.currency_code)}</td></tr>)}</tbody>
    </table>
  );
}
