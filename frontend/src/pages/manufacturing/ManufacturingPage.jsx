import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

// Manufacturing (Prompt 9): recipes and versions (losses per stage,
// by-products, theoretical cost and margin), effective-dated cost inputs,
// allergens and quality checks, plans (allergen sequencing, MRP, purchase
// request), production orders (release / issue / output / QC / close /
// reject), reports. The workshop tablet screen is /manufacturing/floor.
const TABS = ['orders', 'recipes', 'plans', 'costs', 'quality', 'reports'];
const qtyFmt = (q) => (Math.round((q || 0) * 1000) / 1000).toLocaleString('en-US');
const sel = (value, onChange, rows, label, nameKey = 'name') => (
  <label className="ledger-field">{label}<select value={value} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{rows.map((r) => <option key={r.id} value={r.id}>{r[nameKey]}</option>)}</select></label>
);

export default function ManufacturingPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => { api.mfGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (msg) setNotice(msg);
      return r;
    } catch (err) {
      setError(err?.detail?.warnings ? `${ledgerError(err, t)} — ${err.detail.warnings.map((w) => w.message).join(' | ')}` : ledgerError(err, t));
      return null;
    }
  };
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'orders';
  const m = (minor) => formatMinor(minor || 0, meta.digits);
  const props = { t, can, meta, act, m, sp, setSp };
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.manufacturing')}</h1><p className="ledger-subtitle">{t('mf.subtitle')}</p></div>
        <Link to="/manufacturing/floor" className="gold-btn">{t('mf.floor')}</Link>
      </div>
      {!meta.stock_ledger_active && <div className="ledger-error">{t('mf.needsStock')}</div>}
      <div className="ledger-tabs">{TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`mf.tab.${k}`)}</button>)}</div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {tab === 'orders' && <Orders {...props} />}
      {tab === 'recipes' && <Recipes {...props} />}
      {tab === 'plans' && <Plans {...props} />}
      {tab === 'costs' && <Costs {...props} />}
      {tab === 'quality' && <Quality {...props} />}
      {tab === 'reports' && <Reports {...props} />}
    </div>
  );
}

// ---------------------------------------------------------------- recipes
const emptyComp = { productId: '', kind: 'material', qtyPerBatch: '', losses: '' };
// "sorting:1.5, roasting:2.5" <-> [{ stage, lossPct }]
const parseLosses = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [stage, pct] = x.split(':'); return { stage: stage.trim(), lossPct: Number(pct) }; });
const lossesText = (ls) => ls.map((l) => `${l.stage}:${l.loss_bp / 100}`).join(', ');

function Recipes({ t, can, meta, act, m }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const [cost, setCost] = useState(null);
  const [price, setPrice] = useState('');
  const [form, setForm] = useState({ productId: '', batchOutputQty: '', outputKgPerUnit: '1', labourHoursPerBatch: '', shelfLifeDays: '', components: [{ ...emptyComp }], outputs: [] });
  const load = () => api.mfGet('/recipes').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const openVersion = async (id) => {
    const v = await act(() => api.mfGet(`/versions/${id}`));
    if (!v) return;
    setOpen(v);
    setCost(null);
    setForm({ productId: String(v.product_id), batchOutputQty: v.batch_output_qty, outputKgPerUnit: v.output_kg_per_unit, labourHoursPerBatch: v.labour_hours_per_batch, shelfLifeDays: v.shelf_life_days ?? '', components: v.components.map((c) => ({ productId: String(c.product_id), kind: c.kind, qtyPerBatch: c.qty_per_batch, losses: lossesText(c.losses) })), outputs: v.outputs.map((o) => ({ productId: String(o.product_id), qtyPerBatch: o.qty_per_batch })) });
  };
  const body = () => ({ ...form, productId: Number(form.productId), components: form.components.filter((c) => c.productId).map((c) => ({ productId: Number(c.productId), kind: c.kind, qtyPerBatch: Number(c.qtyPerBatch), losses: parseLosses(c.losses) })), outputs: form.outputs.filter((o) => o.productId).map((o) => ({ productId: Number(o.productId), qtyPerBatch: Number(o.qtyPerBatch) })) });
  const setComp = (i, k, v) => setForm({ ...form, components: form.components.map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
  const manage = can('manage_recipes');
  return (
    <div>
      <table className="ledger-table">
        <thead><tr><th>{t('sales.product')}</th><th>{t('mf.activeVersion')}</th><th>{t('mf.versions')}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.product_name}</td><td>{r.active_version ?? '—'}</td><td>{r.versions.map((v) => <button key={v.id} type="button" className="ledger-link-btn" onClick={() => openVersion(v.id)}>v{v.version_no} {t(`mf.vstatus.${v.status}`)}{v.locked_at ? ' 🔒' : ''}</button>)}</td></tr>)}</tbody>
      </table>
      {manage && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{open ? `${open.product_name} v${open.version_no}${open.locked_at ? ` — ${t('mf.locked')}` : ''}` : t('mf.newRecipe')}</h2>
          <div className="ledger-form-grid">
            {sel(form.productId, (v) => setForm({ ...form, productId: v }), meta.products, t('mf.output'))}
            <label className="ledger-field">{t('mf.batchQty')}<input dir="ltr" value={form.batchOutputQty} onChange={(e) => setForm({ ...form, batchOutputQty: e.target.value })} /></label>
            <label className="ledger-field">{t('mf.kgPerUnit')}<input dir="ltr" value={form.outputKgPerUnit} onChange={(e) => setForm({ ...form, outputKgPerUnit: e.target.value })} /></label>
            <label className="ledger-field">{t('mf.labourHours')}<input dir="ltr" value={form.labourHoursPerBatch} onChange={(e) => setForm({ ...form, labourHoursPerBatch: e.target.value })} /></label>
            <label className="ledger-field">{t('mf.shelfLife')}<input dir="ltr" value={form.shelfLifeDays} onChange={(e) => setForm({ ...form, shelfLifeDays: e.target.value })} /></label>
          </div>
          <h3 className="atlas-section-title">{t('mf.components')}</h3>
          {form.components.map((c, i) => (
            <div key={i} className="ledger-form-grid">
              {sel(c.productId, (v) => setComp(i, 'productId', v), meta.products, t('sales.product'))}
              <label className="ledger-field">{t('mf.kind')}<select value={c.kind} onChange={(e) => setComp(i, 'kind', e.target.value)}>{['material', 'packaging', 'label'].map((k) => <option key={k} value={k}>{t(`mf.ckind.${k}`)}</option>)}</select></label>
              <label className="ledger-field">{t('mf.qtyPerBatch')}<input dir="ltr" value={c.qtyPerBatch} onChange={(e) => setComp(i, 'qtyPerBatch', e.target.value)} /></label>
              <label className="ledger-field">{t('mf.losses')}<input dir="ltr" placeholder="sorting:1.5, roasting:2.5" value={c.losses} onChange={(e) => setComp(i, 'losses', e.target.value)} /></label>
            </div>
          ))}
          <button type="button" className="ledger-link-btn" onClick={() => setForm({ ...form, components: [...form.components, { ...emptyComp }] })}>+ {t('mf.addComponent')}</button>
          <h3 className="atlas-section-title">{t('mf.byproducts')}</h3>
          {form.outputs.map((o, i) => (
            <div key={i} className="ledger-form-grid">
              {sel(o.productId, (v) => setForm({ ...form, outputs: form.outputs.map((x, j) => (j === i ? { ...x, productId: v } : x)) }), meta.products, t('sales.product'))}
              <label className="ledger-field">{t('mf.qtyPerBatch')}<input dir="ltr" value={o.qtyPerBatch} onChange={(e) => setForm({ ...form, outputs: form.outputs.map((x, j) => (j === i ? { ...x, qtyPerBatch: e.target.value } : x)) })} /></label>
            </div>
          ))}
          <button type="button" className="ledger-link-btn" onClick={() => setForm({ ...form, outputs: [...form.outputs, { productId: '', qtyPerBatch: '' }] })}>+ {t('mf.addByproduct')}</button>
          <div className="ledger-actions">
            {(!open || !open.locked_at) && <button type="button" className="gold-btn" onClick={async () => { const r = await act(() => (open ? api.mfPut(`/versions/${open.id}`, body()) : api.mfPost('/versions', body())), t('tr.saved')); if (r) { setOpen(r); load(); } }}>{open ? t('common.save') : t('mf.createVersion')}</button>}
            {open && <button type="button" className="ghost-btn" onClick={async () => { const r = await act(() => api.mfPost(`/versions/${open.id}/copy`), t('mf.copied')); if (r) { load(); openVersion(r.id); } }}>{t('mf.copyVersion')}</button>}
            {open && open.status !== 'active' && <button type="button" className="ghost-btn" onClick={async () => { if (await act(() => api.mfPost(`/versions/${open.id}/activate`), t('tr.saved'))) { load(); openVersion(open.id); } }}>{t('mf.activate')}</button>}
            {open && <button type="button" className="ghost-btn" onClick={() => setOpen(null)}>{t('mf.newRecipe')}</button>}
          </div>
        </section>
      )}
      {open && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('mf.theoreticalCost')}</h2>
          <div className="ledger-toolbar">
            <label className="ledger-field">{t('mf.sellingPrice')}<input dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            {['latest', 'average', 'standard'].map((b) => <button key={b} type="button" className="ghost-btn" onClick={async () => setCost(await act(() => api.mfGet(`/versions/${open.id}/cost`, { basis: b, sellingPrice: price })))}>{t(`mf.basis.${b}`)}</button>)}
          </div>
          {cost && (
            <>
              <table className="ledger-table">
                <thead><tr><th>{t('sales.product')}</th><th className="ledger-num">{t('mf.net')}</th><th className="ledger-num">{t('mf.lossPct')}</th><th className="ledger-num">{t('mf.gross')}</th><th className="ledger-num">{t('st.unitCost')}</th><th className="ledger-num">{t('st.value')}</th></tr></thead>
                <tbody>{cost.lines.map((l) => <tr key={l.product_id}><td>{l.product_name}</td><td className="ledger-num">{qtyFmt(l.net_qty)}</td><td className="ledger-num">{l.loss_pct}%</td><td className="ledger-num">{qtyFmt(l.gross_qty)}</td><td className="ledger-num">{l.unit_minor == null ? '—' : m(Math.round(l.unit_minor))}</td><td className="ledger-num">{l.amount_minor == null ? '—' : m(l.amount_minor)}</td></tr>)}</tbody>
              </table>
              <div className="ledger-meta-grid">
                <div><span className="ledger-hint">{t('mf.materials')}</span><strong>{m(cost.materials_minor)}</strong></div>
                <div><span className="ledger-hint">{t('mf.packaging')}</span><strong>{m(cost.packaging_minor)}</strong></div>
                <div><span className="ledger-hint">{t('mf.labour')}</span><strong>{m(cost.labour.amount_minor)}</strong></div>
                <div><span className="ledger-hint">{t('mf.energy')}</span><strong>{m(cost.energy.amount_minor)}</strong></div>
                <div><span className="ledger-hint">{t('mf.overhead')}</span><strong>{m(cost.overhead.amount_minor)}</strong></div>
                <div><span className="ledger-hint">{t('mf.byproductCredit')}</span><strong>-{m(cost.byproduct_credit_minor)}</strong></div>
                <div><span className="ledger-hint">{t('mf.total')}</span><strong>{m(cost.total_minor)}</strong></div>
                <div><span className="ledger-hint">{t('mf.perKg')}</span><strong>{m(cost.cost_per_kg_minor)}</strong></div>
                {cost.margin_minor != null && <div><span className="ledger-hint">{t('mf.margin')}</span><strong>{m(cost.margin_minor)} ({cost.margin_pct}%)</strong></div>}
              </div>
              {cost.missing_prices.length > 0 && <p className="ledger-error">{t('mf.missingPrices')}: {cost.missing_prices.join('، ')}</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- orders
function Orders({ t, can, meta, act, m, sp, setSp }) {
  const [rows, setRows] = useState([]);
  const [o, setO] = useState(null);
  const [form, setForm] = useState({ productId: '', batches: '1', warehouseId: '' });
  const [rec, setRec] = useState({ kind: 'output', qty: '', stage: '', productId: '', labourHours: '' });
  const load = () => api.mfGet('/orders').then(setRows).catch(() => setRows([]));
  const openOrder = (id) => api.mfGet(`/orders/${id}`).then(setO).catch(() => null);
  useEffect(() => { load(); if (sp.get('order')) openOrder(sp.get('order')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn, msg) => { const r = await act(fn, msg); if (r) { setO(r); load(); } return r; };
  return (
    <div>
      {can('manage_production_orders') && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('mf.newOrder')}</h2>
          <div className="ledger-form-grid">
            {sel(form.productId, (v) => setForm({ ...form, productId: v }), meta.products, t('mf.output'))}
            <label className="ledger-field">{t('mf.batches')}<input dir="ltr" value={form.batches} onChange={(e) => setForm({ ...form, batches: e.target.value })} /></label>
            {sel(form.warehouseId, (v) => setForm({ ...form, warehouseId: v }), meta.warehouses, t('st.holder'))}
          </div>
          <button type="button" className="gold-btn" onClick={() => run(() => api.mfPost('/orders', { productId: Number(form.productId), batches: Number(form.batches), warehouseId: form.warehouseId ? Number(form.warehouseId) : null }), t('tr.saved'))}>{t('mf.createOrder')}</button>
        </section>
      )}
      <table className="ledger-table">
        <thead><tr><th>{t('st.number')}</th><th>{t('sales.product')}</th><th className="ledger-num">{t('mf.batches')}</th><th className="ledger-num">{t('mf.planned')}</th><th>{t('st.status')}</th><th>{t('mf.qc')}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><button type="button" className="ledger-link-btn" onClick={() => { setSp({ tab: 'orders', order: r.id }); openOrder(r.id); }}>{r.order_number}</button></td><td>{r.product_name}</td><td className="ledger-num">{r.batches}</td><td className="ledger-num">{qtyFmt(r.planned_qty)}</td><td>{t(`mf.ostatus.${r.status}`)}</td><td>{t(`mf.qcstatus.${r.qc_status}`)}</td></tr>)}</tbody>
      </table>
      {o && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{o.order_number} — {o.product_name} (v{o.version_no}) · {t(`mf.ostatus.${o.status}`)}</h2>
          <div className="ledger-actions">
            {o.status === 'draft' && can('manage_production_orders') && <button type="button" className="gold-btn" onClick={() => run(() => api.mfPost(`/orders/${o.id}/release`), t('tr.saved'))}>{t('mf.release')}</button>}
            {['released', 'in_progress'].includes(o.status) && can('record_production') && <button type="button" className="gold-btn" onClick={() => run(() => api.mfPost(`/orders/${o.id}/issue`, {}), t('tr.saved'))}>{t('mf.issueAll')}</button>}
            {o.status === 'in_progress' && can('manage_production_orders') && <button type="button" className="gold-btn" onClick={() => run(() => api.mfPost(`/orders/${o.id}/close`, {}), t('mf.closed'))}>{t('mf.close')}</button>}
            {o.status === 'in_progress' && o.qc_status === 'failed' && can('manage_production_orders') && <button type="button" className="ghost-btn" onClick={() => run(() => api.mfPost(`/orders/${o.id}/close`, { quarantine: true }), t('mf.closed'))}>{t('mf.closeQuarantine')}</button>}
            {o.status === 'in_progress' && can('manage_production_orders') && <button type="button" className="ghost-btn" onClick={() => { const reason = window.prompt(t('mf.rejectReason')); if (reason) run(() => api.mfPost(`/orders/${o.id}/reject`, { reason }), t('tr.saved')); }}>{t('mf.reject')}</button>}
            {['draft', 'released'].includes(o.status) && can('manage_production_orders') && <button type="button" className="ghost-btn" onClick={() => { const reason = window.prompt(t('st.reason')); if (reason) run(() => api.mfPost(`/orders/${o.id}/cancel`, { reason }), t('tr.saved')); }}>{t('mf.cancel')}</button>}
            {o.status === 'closed' && <a className="ghost-btn" href={`/api/manufacturing/orders/${o.id}/coa`} target="_blank" rel="noreferrer">{t('mf.coa')}</a>}
          </div>
          <table className="ledger-table">
            <thead><tr><th>{t('mf.component')}</th><th className="ledger-num">{t('mf.required')}</th><th className="ledger-num">{t('mf.issued')}</th><th className="ledger-num">{t('mf.returned')}</th><th className="ledger-num">{t('st.value')}</th></tr></thead>
            <tbody>{o.materials.map((x) => <tr key={x.id}><td>{x.product_name}</td><td className="ledger-num">{qtyFmt(x.required_qty)}</td><td className="ledger-num">{qtyFmt(x.issued_qty)}</td><td className="ledger-num">{qtyFmt(x.returned_qty)}</td><td className="ledger-num">{m(x.issued_value_minor - x.returned_value_minor)}</td></tr>)}</tbody>
          </table>
          <div className="ledger-meta-grid">
            <div><span className="ledger-hint">{t('mf.planned')}</span><strong>{qtyFmt(o.planned_qty)}</strong></div>
            <div><span className="ledger-hint">{t('mf.outputQty')}</span><strong>{qtyFmt(o.output_qty)}</strong></div>
            <div><span className="ledger-hint">{t('mf.wastage')}</span><strong>{qtyFmt(o.wastage_qty)}</strong></div>
            <div><span className="ledger-hint">{t('mf.rework')}</span><strong>{qtyFmt(o.rework_qty)}</strong></div>
            <div><span className="ledger-hint">{t('mf.labourHours')}</span><strong>{o.labour_hours ?? '—'}</strong></div>
            {o.output_lot && <div><span className="ledger-hint">{t('st.lot')}</span><strong>{o.output_lot.lot_code} · {o.output_lot.expiry_date || '—'}</strong></div>}
          </div>
          {['released', 'in_progress'].includes(o.status) && can('record_production') && (
            <div className="ledger-form-grid">
              <label className="ledger-field">{t('mf.kind')}<select value={rec.kind} onChange={(e) => setRec({ ...rec, kind: e.target.value })}>{['output', 'wastage', 'byproduct', 'rework'].map((k) => <option key={k} value={k}>{t(`mf.ekind.${k}`)}</option>)}</select></label>
              <label className="ledger-field">{t('sales.qty')}<input dir="ltr" value={rec.qty} onChange={(e) => setRec({ ...rec, qty: e.target.value })} /></label>
              {rec.kind === 'wastage' && <label className="ledger-field">{t('mf.stage')}<select value={rec.stage} onChange={(e) => setRec({ ...rec, stage: e.target.value })}><option value="">—</option>{meta.stages.map((s) => <option key={s} value={s}>{t(`mf.stage.${s}`)}</option>)}</select></label>}
              {rec.kind === 'byproduct' && sel(rec.productId, (v) => setRec({ ...rec, productId: v }), meta.products, t('sales.product'))}
              <label className="ledger-field">{t('mf.labourHours')}<input dir="ltr" value={rec.labourHours} onChange={(e) => setRec({ ...rec, labourHours: e.target.value })} /></label>
              <button type="button" className="ghost-btn" onClick={() => run(() => api.mfPost(`/orders/${o.id}/events`, { kind: rec.kind, qty: Number(rec.qty), stage: rec.stage || undefined, productId: rec.productId ? Number(rec.productId) : undefined, labourHours: rec.labourHours === '' ? undefined : Number(rec.labourHours) }), t('tr.saved'))}>{t('mf.record')}</button>
            </div>
          )}
          {o.qc_checks.length > 0 && (
            <>
              <h3 className="atlas-section-title">{t('mf.qc')} · {t(`mf.qcstatus.${o.qc_status}`)}</h3>
              <table className="ledger-table"><tbody>{o.qc_checks.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.kind === 'range' ? `${c.min_value ?? '—'}–${c.max_value ?? '—'} ${c.unit || ''}` : t('mf.passFail')}</td><td>{c.kind === 'range' ? (c.value_num ?? '—') : c.passed === 1 ? '✓' : c.passed === 0 ? '✗' : '—'}</td>
                <td>{can('approve_production_qc') && ['released', 'in_progress'].includes(o.status) && (c.kind === 'range'
                  ? <button type="button" className="ledger-link-btn" onClick={() => { const v = window.prompt(c.name); if (v !== null && v !== '') run(() => api.mfPost(`/orders/${o.id}/qc`, { results: [{ checkId: c.id, value: Number(v) }] }), t('tr.saved')); }}>{t('mf.enterResult')}</button>
                  : <><button type="button" className="ledger-link-btn" onClick={() => run(() => api.mfPost(`/orders/${o.id}/qc`, { results: [{ checkId: c.id, passed: true }] }), t('tr.saved'))}>✓</button><button type="button" className="ledger-link-btn" onClick={() => run(() => api.mfPost(`/orders/${o.id}/qc`, { results: [{ checkId: c.id, passed: false }] }), t('tr.saved'))}>✗</button></>)}</td></tr>)}</tbody></table>
            </>
          )}
          {o.cost && o.status === 'closed' && (
            <div className="ledger-meta-grid">
              <div><span className="ledger-hint">{t('mf.materials')}</span><strong>{m(o.cost.materials_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.labour')}</span><strong>{m(o.cost.labour.amount_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.energy')}</span><strong>{m(o.cost.energy.amount_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.overhead')}</span><strong>{m(o.cost.overhead.amount_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.byproductCredit')}</span><strong>-{m(o.cost.byproduct_credit_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.abnormalLoss')}</span><strong>{m(o.cost.abnormal_loss_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.fgValue')}</span><strong>{m(o.cost.fg_value_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.perKg')}</span><strong>{m(o.cost.cost_per_kg_minor)}</strong></div>
              <div><span className="ledger-hint">{t('mf.yield')}</span><strong>{o.cost.yield_pct}%</strong></div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- plans
function Plans({ t, can, meta, act }) {
  const [rows, setRows] = useState([]);
  const [plan, setPlan] = useState(null);
  const [mrp, setMrp] = useState(null);
  const [lines, setLines] = useState([{ kind: 'production', productId: '', qty: '' }]);
  const load = () => api.mfGet('/plans').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const open = async (id) => { setPlan(await act(() => api.mfGet(`/plans/${id}`))); setMrp(null); };
  return (
    <div>
      {can('plan_production') && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('mf.newPlan')}</h2>
          {lines.map((l, i) => (
            <div key={i} className="ledger-form-grid">
              <label className="ledger-field">{t('mf.kind')}<select value={l.kind} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}><option value="production">{t('mf.production')}</option><option value="sanitation">{t('mf.sanitation')}</option></select></label>
              {l.kind === 'production' && sel(l.productId, (v) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: v } : x))), meta.products, t('sales.product'))}
              {l.kind === 'production' && <label className="ledger-field">{t('sales.qty')}<input dir="ltr" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></label>}
            </div>
          ))}
          <button type="button" className="ledger-link-btn" onClick={() => setLines([...lines, { kind: 'production', productId: '', qty: '' }])}>+ {t('st.addLine')}</button>
          <button type="button" className="gold-btn" onClick={async () => { const r = await act(() => api.mfPost('/plans', { lines: lines.map((l) => (l.kind === 'sanitation' ? { kind: 'sanitation' } : { productId: Number(l.productId), qty: Number(l.qty) })) }), t('tr.saved')); if (r) { setPlan(r); load(); } }}>{t('mf.savePlan')}</button>
        </section>
      )}
      <table className="ledger-table">
        <thead><tr><th>{t('st.number')}</th><th>{t('fr.date')}</th><th>{t('st.status')}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><button type="button" className="ledger-link-btn" onClick={() => open(r.id)}>{r.plan_number}</button></td><td>{r.plan_date}</td><td>{t(`mf.pstatus.${r.status}`)}</td></tr>)}</tbody>
      </table>
      {plan && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{plan.plan_number}</h2>
          <ol>{plan.lines.map((l) => <li key={l.id}>{l.kind === 'sanitation' ? `🧼 ${t('mf.sanitation')}` : `${l.product_name} — ${qtyFmt(l.qty)}`}</li>)}</ol>
          {plan.sequence.ok ? <div className="ledger-notice">{t('mf.sequenceOk')}</div> : (
            <div className="ledger-error">{t('mf.sequenceWarn')}: {plan.sequence.warnings.map((w) => w.message).join(' | ')}<div>{t('mf.suggestedOrder')}: {plan.sequence.suggested_order.join(' ← ')}</div></div>
          )}
          <div className="ledger-actions">
            <button type="button" className="ghost-btn" onClick={async () => setMrp(await act(() => api.mfGet(`/plans/${plan.id}/mrp`)))}>{t('mf.mrp')}</button>
            {mrp && can('plan_production') && <label className="ledger-field"><span><input type="checkbox" checked={mrp.settings.include_sales_reservations} onChange={async (e) => { if (await act(() => api.mfPut('/settings', { includeSalesReservations: e.target.checked }))) setMrp(await act(() => api.mfGet(`/plans/${plan.id}/mrp`))); }} /> {t('mf.includeSales')}</span></label>}
            {plan.status === 'draft' && can('plan_production') && <button type="button" className="gold-btn" onClick={async () => { const reason = plan.sequence.ok ? undefined : window.prompt(t('mf.overrideReason')); const r = await act(() => api.mfPost(`/plans/${plan.id}/confirm`, { overrideReason: reason }), t('tr.saved')); if (r) { setPlan(r); load(); } }}>{t('mf.confirmPlan')}</button>}
          </div>
          {mrp && (
            <>
              <table className="ledger-table">
                <thead><tr><th>{t('sales.product')}</th><th className="ledger-num">{t('mf.level')}</th><th className="ledger-num">{t('mf.required')}</th><th className="ledger-num">{t('st.col.on_hand')}</th><th className="ledger-num">{t('st.col.reserved')}</th><th className="ledger-num">{t('mf.salesReserved')}</th><th className="ledger-num">{t('mf.onOrderDue')}</th><th className="ledger-num">{t('mf.onOrderLate')}</th><th className="ledger-num">{t('mf.shortfall')}</th><th>{t('mf.source')}</th><th className="ledger-num">{t('mf.requested')}</th><th className="ledger-num">{t('mf.toRequest')}</th></tr></thead>
                <tbody>{mrp.rows.map((r) => <tr key={r.product_id} className={r.shortfall > 0 ? 'ledger-neg' : ''}><td>{r.product_name}</td><td className="ledger-num">{r.level}</td><td className="ledger-num">{qtyFmt(r.required)}</td><td className="ledger-num">{qtyFmt(r.on_hand)}</td><td className="ledger-num">{qtyFmt(r.reserved)}</td><td className="ledger-num">{qtyFmt(r.sales_reserved)}</td><td className="ledger-num">{qtyFmt(r.on_order_due)}</td><td className="ledger-num">{qtyFmt(r.on_order_late)}</td><td className="ledger-num">{qtyFmt(r.shortfall)}</td><td>{r.source ? t(`mf.src.${r.source}`) : '—'}</td><td className="ledger-num">{qtyFmt(r.requested)}</td><td className="ledger-num">{qtyFmt(r.to_request)}</td></tr>)}</tbody>
              </table>
              {mrp.purchase_lines.length > 0 && can('plan_production') && <button type="button" className="gold-btn" onClick={() => act(() => api.mfPost(`/plans/${plan.id}/purchase-request`), t('mf.prCreated'))}>{t('mf.createPr')}</button>}
            </>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- costs
function Costs({ t, can, meta, act, m }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ kind: 'labour', basis: 'hour', productId: '', rate: '', effectiveFrom: new Date().toISOString().slice(0, 10) });
  const load = () => api.mfGet('/cost-rates').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const bases = { material: ['unit'], byproduct: ['unit'], labour: ['hour'], energy: ['kg', 'hour', 'batch'], overhead: ['kg', 'hour', 'batch'] };
  return (
    <div>
      {can('manage_production_costs') && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('mf.addRate')}</h2>
          <p className="ledger-hint">{t('mf.ratesHint')}</p>
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('mf.kind')}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, basis: bases[e.target.value][0] })}>{Object.keys(bases).map((k) => <option key={k} value={k}>{t(`mf.rkind.${k}`)}</option>)}</select></label>
            <label className="ledger-field">{t('mf.basisLabel')}<select value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })}>{bases[f.kind].map((b) => <option key={b} value={b}>{t(`mf.rbasis.${b}`)}</option>)}</select></label>
            {['material', 'byproduct'].includes(f.kind) && sel(f.productId, (v) => setF({ ...f, productId: v }), meta.products, t('sales.product'))}
            <label className="ledger-field">{t('mf.rate')}<input dir="ltr" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></label>
            <label className="ledger-field">{t('mf.effectiveFrom')}<input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></label>
          </div>
          <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.mfPost('/cost-rates', { ...f, productId: f.productId ? Number(f.productId) : null }), t('tr.saved'))) load(); }}>{t('common.save')}</button>
        </section>
      )}
      <table className="ledger-table">
        <thead><tr><th>{t('mf.kind')}</th><th>{t('sales.product')}</th><th>{t('mf.basisLabel')}</th><th className="ledger-num">{t('mf.rate')}</th><th>{t('mf.effectiveFrom')}</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{t(`mf.rkind.${r.kind}`)}</td><td>{r.product_name || '—'}</td><td>{t(`mf.rbasis.${r.basis}`)}</td><td className="ledger-num">{m(r.rate_minor)}</td><td>{r.effective_from}</td><td>{can('manage_production_costs') && <button type="button" className="ledger-link-btn" onClick={async () => { if (await act(() => api.mfDel(`/cost-rates/${r.id}`), t('tr.saved'))) load(); }}>✕</button>}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- quality and allergens
function Quality({ t, can, meta, act }) {
  const [checks, setChecks] = useState([]);
  const [productId, setProductId] = useState('');
  const [allergens, setAllergens] = useState(null);
  const [label, setLabel] = useState(null);
  const [f, setF] = useState({ name: '', kind: 'range', minValue: '', maxValue: '', unit: '' });
  const load = () => api.mfGet('/qc-checks', productId ? { productId } : {}).then(setChecks).catch(() => setChecks([]));
  useEffect(() => {
    load();
    if (productId) {
      api.mfGet(`/products/${productId}/allergens`).then(setAllergens).catch(() => setAllergens(null));
      api.mfGet(`/products/${productId}/label`).then(setLabel).catch(() => setLabel(null));
    }
  }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (a, level) => {
    const own = allergens.own;
    const contains = new Set(own.contains);
    const may = new Set(own.may_contain);
    const target = level === 'contains' ? contains : may;
    const other = level === 'contains' ? may : contains;
    if (target.has(a)) target.delete(a); else { target.add(a); other.delete(a); }
    if (await act(() => api.mfPut(`/products/${productId}/allergens`, { contains: [...contains], mayContain: [...may] }), t('tr.saved'))) {
      setAllergens(await api.mfGet(`/products/${productId}/allergens`));
      setLabel(await api.mfGet(`/products/${productId}/label`));
    }
  };
  return (
    <div>
      <div className="ledger-toolbar">{sel(productId, setProductId, meta.products, t('sales.product'))}</div>
      {productId && allergens && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('mf.allergens')}</h2>
          <table className="ledger-table"><thead><tr><th /><th>{t('mf.contains')}</th><th>{t('mf.mayContain')}</th></tr></thead>
            <tbody>{meta.allergens.map((a) => <tr key={a}><td>{t(`mf.allergen.${a}`)}</td>
              <td><input type="checkbox" disabled={!can('manage_recipes')} checked={allergens.own.contains.includes(a)} onChange={() => toggle(a, 'contains')} /></td>
              <td><input type="checkbox" disabled={!can('manage_recipes')} checked={allergens.own.may_contain.includes(a)} onChange={() => toggle(a, 'may_contain')} /></td></tr>)}</tbody></table>
          {label && <p className="ledger-hint">{t('mf.labelDeclaration')}: <strong>{label.declaration_ar}</strong> — {label.declaration_en}</p>}
        </section>
      )}
      {productId && can('manage_recipes') && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('mf.addCheck')}</h2>
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('mf.checkName')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="ledger-field">{t('mf.kind')}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="range">{t('mf.range')}</option><option value="pass_fail">{t('mf.passFail')}</option></select></label>
            {f.kind === 'range' && <><label className="ledger-field">{t('mf.min')}<input dir="ltr" value={f.minValue} onChange={(e) => setF({ ...f, minValue: e.target.value })} /></label><label className="ledger-field">{t('mf.max')}<input dir="ltr" value={f.maxValue} onChange={(e) => setF({ ...f, maxValue: e.target.value })} /></label><label className="ledger-field">{t('mf.unit')}<input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></label></>}
          </div>
          <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.mfPost('/qc-checks', { ...f, productId: Number(productId) }), t('tr.saved'))) load(); }}>{t('common.save')}</button>
        </section>
      )}
      <table className="ledger-table"><thead><tr><th>{t('sales.product')}</th><th>{t('mf.checkName')}</th><th>{t('mf.spec')}</th></tr></thead>
        <tbody>{checks.map((c) => <tr key={c.id}><td>{c.product_name}</td><td>{c.name}</td><td>{c.kind === 'range' ? `${c.min_value ?? '—'}–${c.max_value ?? '—'} ${c.unit || ''}` : t('mf.passFail')}</td></tr>)}</tbody></table>
    </div>
  );
}

// ---------------------------------------------------------------- reports
const REPORTS = ['batch-cost', 'yield', 'variances', 'wastage', 'consumption', 'profitability'];
function Reports({ t, meta }) {
  const [name, setName] = useState('batch-cost');
  const [data, setData] = useState(null);
  useEffect(() => { setData(null); api.mfGet(`/reports/${name}`).then(setData).catch(() => setData([])); }, [name]);
  const tables = name === 'profitability' && data ? [['mf.byProduct', data.by_product], ['mf.byCustomer', data.by_customer]] : [[null, Array.isArray(data) ? data : []]];
  const fmt = (k, v) => (/_minor$/.test(k) && typeof v === 'number' ? (v / 10 ** meta.digits).toLocaleString('en-US', { minimumFractionDigits: meta.digits, maximumFractionDigits: meta.digits }) : typeof v === 'number' ? (Math.round(v * 1000) / 1000).toLocaleString('en-US') : typeof v === 'boolean' ? (v ? '✓' : '') : v ?? '—');
  return (
    <div>
      <div className="ledger-tabs">{REPORTS.map((r) => <button key={r} type="button" className={`ledger-tab-btn ${name === r ? 'active' : ''}`} onClick={() => setName(r)}>{t(`mf.report.${r}`)}</button>)}</div>
      {!data ? <div className="ledger-loading">{t('ledger.loading')}</div> : tables.map(([title, rows]) => {
        const cols = rows.length ? Object.keys(rows[0]).filter((k) => !/(^|_)id$/.test(k) && typeof rows[0][k] !== 'object') : [];
        return (
          <div key={title || 'x'} className="ledger-table-wrap">
            {title && <h3 className="atlas-section-title">{t(title)}</h3>}
            <table className="ledger-table"><thead><tr>{cols.map((c) => <th key={c}>{t(`mf.col.${c}`) === `mf.col.${c}` ? c : t(`mf.col.${c}`)}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'ledger-num' : ''}>{fmt(c, r[c])}</td>)}</tr>)}</tbody></table>
            {!rows.length && <p className="ledger-hint">{t('st.noRows')}</p>}
          </div>
        );
      })}
    </div>
  );
}
