import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { withBreakGlass } from '../ledger/ledgerShared.js';

// Prompt 8b tabs of the stock page: lots (status, trace, recall), counts
// (draft -> approve with separation of duties), wastage / repack, reports.
const qtyFmt = (q) => (Math.round((q || 0) * 1000) / 1000).toLocaleString('en-US');
const sel = (value, onChange, rows, label, nameKey = 'name') => (
  <label className="ledger-field">{label}<select value={value} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{rows.map((r) => <option key={r.id} value={r.id}>{r[nameKey]}</option>)}</select></label>
);

export function Lots({ t, meta, can, act, sp }) {
  const [rows, setRows] = useState([]);
  const [productId, setProductId] = useState('');
  const [recall, setRecall] = useState(null);
  const load = () => api.stGet('/lots', productId ? { productId } : {}).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (sp.get('lot')) api.stGet(`/lots/${sp.get('lot')}/recall`).then(setRecall).catch(() => null); }, [sp]);
  if (!meta.active) return <p className="ledger-hint">{t('st.activateFirst')}</p>;
  const setStatus = async (l, status) => {
    const reason = status === 'available' ? '' : window.prompt(t('st.reason'));
    if (status !== 'available' && !reason) return;
    await act(() => api.stPut(`/lots/${l.id}/status`, { status, reason }), t('st.done'));
    load();
  };
  return (
    <div>
      <div className="ledger-toolbar">{sel(productId, setProductId, meta.products, t('sales.product'))}</div>
      <table className="ledger-table">
        <thead><tr><th>{t('st.lot')}</th><th>{t('sales.product')}</th><th>{t('st.expiry')}</th><th>{t('st.supplierLot')}</th><th>{t('st.status')}</th><th className="ledger-num">{t('sales.qty')}</th><th /></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={l.id}>
            <td>{l.lot_code}</td><td>{l.product_name}</td>
            <td className={l.days_to_expiry !== null && l.days_to_expiry <= 30 ? 'ledger-neg' : ''}>{l.expiry_date || '—'}{l.days_to_expiry !== null ? <div className="ledger-hint">{l.days_to_expiry} {t('st.days')}</div> : null}</td>
            <td>{l.supplier_lot || '—'}</td><td>{t(`st.lotStatus.${l.status}`)}</td><td className="ledger-num">{qtyFmt(l.qty)}</td>
            <td>
              <button type="button" className="ledger-link-btn" onClick={() => api.stGet(`/lots/${l.id}/recall`).then(setRecall)}>{t('st.recall')}</button>
              {can('manage_lots') && l.status === 'available' && <button type="button" className="ledger-link-btn" onClick={() => setStatus(l, 'quarantine')}>{t('st.quarantine')}</button>}
              {can('manage_lots') && l.status === 'quarantine' && <button type="button" className="ledger-link-btn" onClick={() => setStatus(l, 'available')}>{t('st.release')}</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      {recall && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('st.recallFor')} {recall.lot.lot_code} — {recall.lot.product_name}</h2>
          <p className="ledger-hint">{t('st.supplier')}: {recall.supplier.name || '—'} ({recall.supplier.supplier_lot || '—'}) · {t('st.received')}: {qtyFmt(recall.received_qty)} · {t('st.sold')}: {qtyFmt(recall.sold_qty)} · {t('st.inStock')}: {qtyFmt(recall.in_stock_qty)}</p>
          <table className="ledger-table">
            <thead><tr><th>{t('sales.customer')}</th><th>{t('st.phone')}</th><th className="ledger-num">{t('sales.qty')}</th><th>{t('st.documents')}</th></tr></thead>
            <tbody>{recall.customers.map((c) => <tr key={c.shop_id}><td>{c.shop_name}</td><td dir="ltr">{c.phone || '—'}</td><td className="ledger-num">{qtyFmt(c.qty)}</td><td>{c.documents.map((d) => d.document).join('، ')}</td></tr>)}</tbody>
          </table>
          {recall.in_stock.length > 0 && <p className="ledger-hint">{t('st.pullFrom')}: {recall.in_stock.map((b) => `${b.holder_name} (${qtyFmt(b.qty)})`).join('، ')}</p>}
        </section>
      )}
    </div>
  );
}

export function Counts({ t, meta, can, act }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [form, setForm] = useState({ holderId: '', lines: [{ productId: '', lotId: '', countedQty: '', reasonCode: '' }] });
  const load = () => api.stGet('/counts').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); api.stGet('/reason-codes').then(setReasons).catch(() => null); }, []);
  if (!meta.active) return <p className="ledger-hint">{t('st.activateFirst')}</p>;
  const setLine = (i, k, v) => setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const create = async () => {
    const r = await act(() => api.stPost('/counts', { holderId: Number(form.holderId), lines: form.lines.filter((l) => l.productId).map((l) => ({ productId: Number(l.productId), lotId: l.lotId ? Number(l.lotId) : null, countedQty: Number(l.countedQty), reasonCode: l.reasonCode || null })) }), t('st.done'));
    if (r) { setOpen(r); load(); }
  };
  const approve = async (c) => {
    const r = await act(() => withBreakGlass(t, (extra) => api.stPost(`/counts/${c.id}/approve`, extra)), t('st.done'));
    if (r) { setOpen(r); load(); }
  };
  const reject = async (c) => {
    const reason = window.prompt(t('st.reason'));
    if (!reason) return;
    const r = await act(() => api.stPost(`/counts/${c.id}/reject`, { reason }), t('st.done'));
    if (r) { setOpen(r); load(); }
  };
  return (
    <div>
      {can('manage_stock_counts') && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('st.newCount')}</h2>
          <div className="ledger-form-grid">{sel(form.holderId, (v) => setForm({ ...form, holderId: v }), meta.holders, t('st.holder'))}</div>
          {form.lines.map((l, i) => (
            <div key={i} className="ledger-form-grid">
              {sel(l.productId, (v) => setLine(i, 'productId', v), meta.products, t('sales.product'))}
              <label className="ledger-field">{t('st.lotId')}<input dir="ltr" value={l.lotId} onChange={(e) => setLine(i, 'lotId', e.target.value)} /></label>
              <label className="ledger-field">{t('st.counted')}<input dir="ltr" value={l.countedQty} onChange={(e) => setLine(i, 'countedQty', e.target.value)} /></label>
              <label className="ledger-field">{t('st.reason')}<select value={l.reasonCode} onChange={(e) => setLine(i, 'reasonCode', e.target.value)}><option value="">—</option>{reasons.map((r) => <option key={r} value={r}>{t(`st.reasonCode.${r}`)}</option>)}</select></label>
            </div>
          ))}
          <button type="button" className="ledger-link-btn" onClick={() => setForm({ ...form, lines: [...form.lines, { productId: '', lotId: '', countedQty: '', reasonCode: '' }] })}>+ {t('st.addLine')}</button>
          <button type="button" className="gold-btn" onClick={create}>{t('st.saveDraft')}</button>
        </section>
      )}
      <table className="ledger-table">
        <thead><tr><th>{t('st.number')}</th><th>{t('fr.date')}</th><th>{t('st.holder')}</th><th>{t('st.status')}</th><th /></tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.id}>
            <td><button type="button" className="ledger-link-btn" onClick={() => api.stGet(`/counts/${c.id}`).then(setOpen)}>{c.count_number}</button></td>
            <td>{c.count_date}</td><td>{c.holder_name}</td><td>{t(`st.countStatus.${c.status}`)}</td>
            <td>{c.status === 'draft' && can('approve_stock_counts') && <><button type="button" className="ledger-link-btn" onClick={() => approve(c)}>{t('st.approve')}</button><button type="button" className="ledger-link-btn" onClick={() => reject(c)}>{t('st.reject')}</button></>}</td>
          </tr>
        ))}</tbody>
      </table>
      {open && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{open.count_number} — {open.holder_name}</h2>
          <table className="ledger-table">
            <thead><tr><th>{t('sales.product')}</th><th>{t('st.lot')}</th><th className="ledger-num">{t('st.expected')}</th><th className="ledger-num">{t('st.counted')}</th><th className="ledger-num">{t('st.variance')}</th><th>{t('st.reason')}</th></tr></thead>
            <tbody>{open.lines.map((l) => <tr key={l.id}><td>{l.product_name}</td><td>{l.lot_code || '—'}</td><td className="ledger-num">{qtyFmt(l.expected_qty)}</td><td className="ledger-num">{qtyFmt(l.counted_qty)}</td><td className={`ledger-num ${l.variance < 0 ? 'ledger-neg' : ''}`}>{qtyFmt(l.variance)}</td><td>{l.reason_code ? t(`st.reasonCode.${l.reason_code}`) : '—'}</td></tr>)}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export function Wastage({ t, meta, can, act, m }) {
  const [docs, setDocs] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [w, setW] = useState({ holderId: '', reasonCode: 'damage', productId: '', lotId: '', qty: '' });
  const [rp, setRp] = useState({ holderId: '', fromId: '', fromQty: '', toId: '', toQty: '' });
  const load = () => api.stGet('/documents').then(setDocs).catch(() => setDocs([]));
  useEffect(() => { load(); api.stGet('/reason-codes').then(setReasons).catch(() => null); }, []);
  if (!meta.active) return <p className="ledger-hint">{t('st.activateFirst')}</p>;
  return (
    <div>
      {can('post_stock_wastage') && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('st.wastage')}</h2>
          <div className="ledger-form-grid">
            {sel(w.holderId, (v) => setW({ ...w, holderId: v }), meta.holders, t('st.holder'))}
            {sel(w.productId, (v) => setW({ ...w, productId: v }), meta.products, t('sales.product'))}
            <label className="ledger-field">{t('st.lotId')}<input dir="ltr" value={w.lotId} onChange={(e) => setW({ ...w, lotId: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.qty')}<input dir="ltr" value={w.qty} onChange={(e) => setW({ ...w, qty: e.target.value })} /></label>
            <label className="ledger-field">{t('st.reason')}<select value={w.reasonCode} onChange={(e) => setW({ ...w, reasonCode: e.target.value })}>{reasons.map((r) => <option key={r} value={r}>{t(`st.reasonCode.${r}`)}</option>)}</select></label>
          </div>
          <button type="button" className="gold-btn" onClick={async () => { await act(() => api.stPost('/wastage', { holderId: Number(w.holderId), reasonCode: w.reasonCode, lines: [{ productId: Number(w.productId), lotId: w.lotId ? Number(w.lotId) : null, qty: Number(w.qty) }] }), t('st.done')); load(); }}>{t('ledger.form.post')}</button>
        </section>
      )}
      {can('manage_stock_ledger') && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('st.repack')}</h2>
          <div className="ledger-form-grid">
            {sel(rp.holderId, (v) => setRp({ ...rp, holderId: v }), meta.holders, t('st.holder'))}
            {sel(rp.fromId, (v) => setRp({ ...rp, fromId: v }), meta.products, t('st.from'))}
            <label className="ledger-field">{t('sales.qty')}<input dir="ltr" value={rp.fromQty} onChange={(e) => setRp({ ...rp, fromQty: e.target.value })} /></label>
            {sel(rp.toId, (v) => setRp({ ...rp, toId: v }), meta.products, t('st.to'))}
            <label className="ledger-field">{t('sales.qty')}<input dir="ltr" value={rp.toQty} onChange={(e) => setRp({ ...rp, toQty: e.target.value })} /></label>
          </div>
          <button type="button" className="gold-btn" onClick={async () => { await act(() => api.stPost('/repack', { holderId: Number(rp.holderId), from: { productId: Number(rp.fromId), qty: Number(rp.fromQty) }, to: { productId: Number(rp.toId), qty: Number(rp.toQty) } }), t('st.done')); load(); }}>{t('ledger.form.post')}</button>
        </section>
      )}
      <table className="ledger-table">
        <thead><tr><th>{t('st.number')}</th><th>{t('fr.date')}</th><th>{t('st.kind')}</th><th>{t('st.holder')}</th><th>{t('st.reason')}</th><th className="ledger-num">{t('st.value')}</th></tr></thead>
        <tbody>{docs.map((d) => <tr key={d.id}><td>{d.doc_number}</td><td>{d.doc_date}</td><td>{t(`st.docKind.${d.kind}`)}</td><td>{d.holder_name}</td><td>{d.reason_code ? t(`st.reasonCode.${d.reason_code}`) : '—'}</td><td className="ledger-num">{m(d.value_minor)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

const REPORTS = ['item-balance', 'reorder', 'near-expiry', 'ageing', 'slow-moving', 'count-variances', 'turnover', 'profitability', 'wastage'];
const MONEY_COLS = /_minor$/;
export function Reports({ t, meta }) {
  const [name, setName] = useState('item-balance');
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
    (name === 'reorder' ? api.stGet('/reorder') : api.stGet(`/reports/${name}`)).then(setData).catch(() => setData([]));
  }, [name]);
  if (!meta.active) return <p className="ledger-hint">{t('st.activateFirst')}</p>;
  const rows = Array.isArray(data) ? data : data?.rows || [];
  const cols = rows.length ? Object.keys(rows[0]).filter((k) => !/_id$|^id$|json|documents/.test(k) && typeof rows[0][k] !== 'object') : [];
  const fmt = (k, v) => (MONEY_COLS.test(k) && typeof v === 'number' ? (v / 10 ** meta.digits).toLocaleString('en-US', { minimumFractionDigits: meta.digits, maximumFractionDigits: meta.digits }) : typeof v === 'number' ? qtyFmt(v) : typeof v === 'boolean' ? (v ? '✓' : '') : v ?? '—');
  return (
    <div>
      <div className="ledger-tabs">{REPORTS.map((r) => <button key={r} type="button" className={`ledger-tab-btn ${name === r ? 'active' : ''}`} onClick={() => setName(r)}>{t(`st.report.${r}`)}</button>)}</div>
      {!data ? <div className="ledger-loading">{t('ledger.loading')}</div> : (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr>{cols.map((c) => <th key={c}>{t(`st.col.${c}`) === `st.col.${c}` ? c : t(`st.col.${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'ledger-num' : ''}>{c === 'product_name' && r.product_id ? <Link to={`/stock/items/${r.product_id}`}>{r[c]}</Link> : fmt(c, r[c])}</td>)}</tr>)}</tbody>
          </table>
          {!rows.length && <p className="ledger-hint">{t('st.noRows')}</p>}
        </div>
      )}
    </div>
  );
}
