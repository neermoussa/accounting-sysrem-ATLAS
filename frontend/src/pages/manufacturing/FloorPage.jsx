import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import '../../styles/ledger.css';

// Workshop tablet (Prompt 9): large touch targets to record material issue,
// output and wastage on an open production order. Every record goes through
// the offline sync endpoint (/api/sync/batch, entity types production_issue
// / production_output / production_wastage) with an idempotency key; when
// the device is offline it waits in a local queue and is sent when the
// connection comes back — a replay never records twice.
const QUEUE_KEY = 'atlas_mfg_floor_queue';
const readQueue = () => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
};
const writeQueue = (q) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    // storage unavailable: the queue lives in memory for this session
  }
};
const big = { fontSize: '1.25rem', padding: '18px 22px', minHeight: 64, minWidth: 140 };
const newKey = () => `floor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export default function FloorPage() {
  const { t } = useLanguage();
  const [orders, setOrders] = useState([]);
  const [order, setOrder] = useState(null);
  const [meta, setMeta] = useState(null);
  const [mode, setMode] = useState('output');
  const [qty, setQty] = useState('');
  const [productId, setProductId] = useState('');
  const [stage, setStage] = useState('sorting');
  const [queue, setQueue] = useState(readQueue);
  const [msg, setMsg] = useState(null);
  const loadOrders = () => api.mfGet('/orders').then((rows) => setOrders(rows.filter((o) => ['released', 'in_progress'].includes(o.status)))).catch(() => null);
  const openOrder = (id) => api.mfGet(`/orders/${id}`).then(setOrder).catch(() => null);
  useEffect(() => {
    loadOrders();
    api.mfGet('/meta').then(setMeta).catch(() => null);
  }, []);
  const flush = async (q = readQueue()) => {
    if (!q.length || !navigator.onLine) return;
    try {
      const res = await api.submitSyncBatch(q);
      const done = new Set((res.results || []).filter((r) => r.status === 'applied').map((r) => r.idempotencyKey ?? r.idempotency_key));
      const errors = (res.results || []).filter((r) => r.status === 'error');
      const left = q.filter((op) => !done.has(op.idempotencyKey) && !errors.some((e) => (e.idempotencyKey ?? e.idempotency_key) === op.idempotencyKey));
      writeQueue(left);
      setQueue(left);
      setMsg(errors.length ? `${t('mf.floorErrors')}: ${errors.map((e) => e.error_message).join(' | ')}` : t('mf.floorSynced'));
      if (order) openOrder(order.id);
    } catch {
      setMsg(t('mf.floorQueued'));
    }
  };
  useEffect(() => {
    const on = () => flush();
    window.addEventListener('online', on);
    flush();
    return () => window.removeEventListener('online', on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => {
    if (!order || !(Number(qty) > 0)) return;
    const key = newKey();
    const payload = { orderId: order.id, qty: Number(qty), clientKey: key };
    let entityType = 'production_output';
    if (mode === 'issue') { entityType = 'production_issue'; payload.productId = Number(productId); }
    if (mode === 'wastage') { entityType = 'production_wastage'; payload.stage = stage; }
    const op = { clientId: 'floor', idempotencyKey: key, entityType, operation: 'create', payload };
    const q = [...readQueue(), op];
    writeQueue(q);
    setQueue(q);
    setQty('');
    setMsg(navigator.onLine ? null : t('mf.floorQueued'));
    flush(q);
  };
  const pad = (d) => setQty((v) => (d === 'C' ? '' : d === '⌫' ? v.slice(0, -1) : `${v}${d}`));
  return (
    <div className="ledger-page" style={{ maxWidth: 900 }}>
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('mf.floor')}</h1><p className="ledger-subtitle">{navigator.onLine ? t('mf.online') : t('mf.offline')} · {t('mf.pending')}: {queue.length}</p></div>
        <Link to="/manufacturing">{t('nav.manufacturing')}</Link>
      </div>
      {msg && <div className="ledger-notice">{msg}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {orders.map((o) => <button key={o.id} type="button" style={big} className={order?.id === o.id ? 'gold-btn' : 'ghost-btn'} onClick={() => openOrder(o.id)}>{o.order_number}<br />{o.product_name}</button>)}
        {!orders.length && <p className="ledger-hint">{t('mf.noOpenOrders')}</p>}
      </div>
      {order && (
        <section className="card ledger-card" style={{ marginTop: 16 }}>
          <h2 className="atlas-section-title">{order.order_number} — {order.product_name}: {order.output_qty} / {order.planned_qty}</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {['issue', 'output', 'wastage'].map((k) => <button key={k} type="button" style={big} className={mode === k ? 'gold-btn' : 'ghost-btn'} onClick={() => setMode(k)}>{t(`mf.floor.${k}`)}</button>)}
          </div>
          {mode === 'issue' && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
              {order.materials.map((m) => <button key={m.product_id} type="button" style={big} className={String(productId) === String(m.product_id) ? 'gold-btn' : 'ghost-btn'} onClick={() => { setProductId(m.product_id); setQty(String(m.open_qty || '')); }}>{m.product_name}<br />{m.issued_qty}/{m.required_qty}</button>)}
            </div>
          )}
          {mode === 'wastage' && meta && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
              {meta.stages.map((s) => <button key={s} type="button" style={big} className={stage === s ? 'gold-btn' : 'ghost-btn'} onClick={() => setStage(s)}>{t(`mf.stage.${s}`)}</button>)}
            </div>
          )}
          <div style={{ fontSize: '2.5rem', textAlign: 'center', margin: '16px 0', direction: 'ltr' }}>{qty || '0'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, direction: 'ltr' }}>
            {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'].map((d) => <button key={d} type="button" style={big} className="ghost-btn" onClick={() => pad(d)}>{d}</button>)}
          </div>
          <button type="button" style={{ ...big, width: '100%', marginTop: 14 }} className="gold-btn" disabled={!(Number(qty) > 0) || (mode === 'issue' && !productId)} onClick={submit}>{t('mf.record')}</button>
          {queue.length > 0 && <button type="button" style={{ ...big, width: '100%', marginTop: 10 }} className="ghost-btn" onClick={() => flush()}>{t('mf.syncNow')} ({queue.length})</button>}
        </section>
      )}
    </div>
  );
}
