import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/orders.css';

const ORDER_STATUSES = [
  'pending_approval', 'approved', 'processing', 'out_for_delivery',
  'delivered', 'paid', 'returned', 'cancelled',
];

function StatusBadge({ status, t }) {
  return <span className={`orders-badge orders-badge-${status}`}>{t(`orders.status.${status}`)}</span>;
}

function errorMessage(err, t) {
  if (!err) return null;
  const code = err?.detail?.error;
  if (code && t(`orders.error.${code}`) !== `orders.error.${code}`) return t(`orders.error.${code}`);
  if (code) return code;
  return t('orders.error.generic');
}

export default function OrdersPage() {
  const { can, canAny } = useAuth();
  const { t } = useLanguage();
  const [tab, setTab] = useState('orders');

  const canViewOrders = canAny('view_app', 'approve_orders', 'record_deliveries');
  const canViewInbox = canAny('view_app', 'add_orders');

  return (
    <div className="orders-page">
      <div className="orders-header">
        <div>
          <h1 className="atlas-page-title">{t('orders.title')}</h1>
          <p className="orders-subtitle">{t('orders.subtitle')}</p>
        </div>
        <div className="orders-tabs">
          {canViewOrders && (
            <button type="button" className={`orders-tab-btn${tab === 'orders' ? ' active' : ''}`} onClick={() => setTab('orders')}>
              {t('orders.tab.orders')}
            </button>
          )}
          {canViewInbox && (
            <button type="button" className={`orders-tab-btn${tab === 'inbox' ? ' active' : ''}`} onClick={() => setTab('inbox')}>
              {t('orders.tab.inbox')}
            </button>
          )}
        </div>
      </div>

      {tab === 'orders' && canViewOrders && <OrdersListView t={t} can={can} />}
      {tab === 'inbox' && canViewInbox && <InboxListView t={t} can={can} />}
    </div>
  );
}

// ---------------------------------------------------------------------
// Orders list + detail
// ---------------------------------------------------------------------

function OrdersListView({ t, can }) {
  const [orders, setOrders] = useState([]);
  const [shops, setShops] = useState([]);
  const [reps, setReps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [repFilter, setRepFilter] = useState('');
  const [search, setSearch] = useState('');

  function load(silent) {
    if (!silent) setLoading(true);
    setError(null);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    if (shopFilter) params.shopId = shopFilter;
    if (repFilter) params.repId = repFilter;
    return api
      .getOrders(params)
      .then(setOrders)
      .catch((err) => setError(errorMessage(err, t)))
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, shopFilter, repFilter]);

  useEffect(() => {
    api.getShops().then(setShops).catch(() => {});
    api.getReps().then((r) => setReps(r.reps || [])).catch(() => {});
  }, []);

  const shopsById = Object.fromEntries(shops.map((s) => [String(s.id), s]));
  const repsById = Object.fromEntries(reps.map((r) => [String(r.id), r]));

  const visibleOrders = search.trim()
    ? orders.filter((o) => {
        const shopName = shopsById[String(o.shop_id)]?.name || '';
        const needle = search.trim().toLowerCase();
        return String(o.id).includes(needle) || shopName.toLowerCase().includes(needle);
      })
    : orders;

  if (selectedId) {
    return (
      <OrderDetail
        id={selectedId}
        shopsById={shopsById}
        repsById={repsById}
        onBack={() => {
          setSelectedId(null);
          load(true);
        }}
        t={t}
        can={can}
      />
    );
  }

  return (
    <div>
      <div className="orders-filters">
        <input
          type="text"
          className="orders-search-input"
          placeholder={t('orders.filter.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{t('orders.filter.allStatuses')}</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>{t(`orders.status.${s}`)}</option>
          ))}
        </select>
        <select value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
          <option value="">{t('orders.filter.allShops')}</option>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)}>
          <option value="">{t('orders.filter.allReps')}</option>
          {reps.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </div>

      {error && <p className="orders-error">{error}</p>}

      {loading ? (
        <p className="orders-loading">{t('common.loading')}</p>
      ) : visibleOrders.length === 0 ? (
        <div className="orders-empty">
          <p className="orders-empty-title">{t('orders.empty')}</p>
        </div>
      ) : (
        <div className="orders-table-wrap">
          <table className="orders-table">
            <thead>
              <tr>
                <th>{t('orders.column.id')}</th>
                <th>{t('orders.column.shop')}</th>
                <th>{t('orders.column.rep')}</th>
                <th>{t('orders.column.status')}</th>
                <th>{t('orders.column.total')}</th>
                <th>{t('orders.column.date')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((o) => (
                <tr key={o.id} className="orders-row" onClick={() => setSelectedId(o.id)}>
                  <td>#{o.id}</td>
                  <td>{shopsById[String(o.shop_id)]?.name || t('orders.unknownShop')}</td>
                  <td>{repsById[String(o.rep_id)]?.name || '—'}</td>
                  <td><StatusBadge status={o.status} t={t} /></td>
                  <td>{Number(o.total_value).toLocaleString()}</td>
                  <td className="orders-cell-muted">{o.order_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Order detail
// ---------------------------------------------------------------------

function OrderDetail({ id, shopsById, repsById, onBack, t, can }) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null); // 'deliver' | 'amend' | 'reject' | 'return' | 'cancel'

  function load(silent) {
    if (!silent) setLoading(true);
    return api
      .getOrder(id)
      .then(setOrder)
      .catch((err) => setError(errorMessage(err, t)))
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function showError(err) {
    setError(typeof err === 'string' ? err : errorMessage(err, t));
    setNotice(null);
  }
  function showNotice(msg) {
    setNotice(msg);
    setError(null);
  }

  if (loading || !order) return <div><p className="orders-loading">{t('common.loading')}</p></div>;

  const canApprove = can('approve_orders');
  const canAdd = can('add_orders');
  const canDelete = can('delete_orders');
  const canDeliver = can('record_deliveries');

  const shop = shopsById[String(order.shop_id)];
  const rep = repsById[String(order.rep_id)];
  const locked = ['delivered', 'paid', 'returned', 'cancelled'].includes(order.status);

  async function doApprove() {
    if (!window.confirm(t('orders.confirm.approve'))) return;
    try {
      await api.approveOrderLifecycle(order.id);
      showNotice(t('orders.notice.approved'));
      load(true);
    } catch (err) {
      showError(err);
    }
  }

  async function doMarkPaid() {
    if (!window.confirm(t('orders.confirm.markPaid'))) return;
    try {
      await api.markOrderPaid(order.id);
      showNotice(t('orders.notice.markedPaid'));
      load(true);
    } catch (err) {
      showError(err);
    }
  }

  async function doSetStatus(status) {
    if (!window.confirm(t('orders.confirm.statusChange'))) return;
    try {
      await api.setOrderStatus(order.id, status);
      showNotice(t('orders.notice.statusChanged'));
      load(true);
    } catch (err) {
      showError(err);
    }
  }

  return (
    <div>
      <div className="orders-detail-header">
        <button type="button" className="ghost-btn" onClick={onBack}>
          {t('orders.back')}
        </button>
        <h1 className="atlas-section-title">#{order.id}</h1>
        <StatusBadge status={order.status} t={t} />
      </div>

      {error && <p className="orders-error">{error}</p>}
      {notice && <p className="orders-notice">{notice}</p>}

      <div className="card orders-meta-grid">
        <div>
          <span className="orders-meta-label">{t('orders.column.shop')}</span>
          <span>{shop?.name || t('orders.unknownShop')}</span>
        </div>
        <div>
          <span className="orders-meta-label">{t('orders.column.rep')}</span>
          <span>{rep?.name || '—'}</span>
        </div>
        <div>
          <span className="orders-meta-label">{t('orders.column.date')}</span>
          <span>{order.order_date}</span>
        </div>
        <div>
          <span className="orders-meta-label">{t('orders.column.total')}</span>
          <span>{Number(order.total_value).toLocaleString()}</span>
        </div>
        <div>
          <span className="orders-meta-label">{t('orders.detail.source')}</span>
          <span>{order.source || '—'}</span>
        </div>
        {order.cancel_reason && (
          <div>
            <span className="orders-meta-label">{t('orders.detail.cancelReason')}</span>
            <span>{order.cancel_reason}</span>
          </div>
        )}
        {order.return_reason && (
          <div>
            <span className="orders-meta-label">{t('orders.detail.returnReason')}</span>
            <span>{order.return_reason}</span>
          </div>
        )}
      </div>

      <section className="orders-section">
        <h2 className="atlas-section-title">{t('orders.items.title')}</h2>
        {order.items?.length ? (
          <table className="orders-items-table">
            <thead>
              <tr>
                <th>{t('orders.items.product')}</th>
                <th>{t('orders.items.qty')}</th>
                <th>{t('orders.items.total')}</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it, i) => (
                <tr key={i}>
                  <td>{it.product_name}{it.is_free ? ` (${t('orders.items.free')})` : ''}</td>
                  <td>{it.qty}</td>
                  <td>{it.line_total !== undefined ? Number(it.line_total).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="orders-hint">{t('orders.items.empty')}</p>
        )}
      </section>

      <section className="orders-section orders-actions-section">
        <h2 className="atlas-section-title">{t('orders.actions.title')}</h2>
        <div className="orders-actions-row">
          {canApprove && order.status === 'pending_approval' && (
            <button type="button" className="gold-btn" onClick={doApprove}>{t('orders.actions.approve')}</button>
          )}
          {canApprove && order.status === 'pending_approval' && (
            <button type="button" className="danger-btn" onClick={() => setModal('reject')}>{t('orders.actions.reject')}</button>
          )}
          {canAdd && !locked && (
            <button type="button" className="ghost-btn" onClick={() => setModal('amend')}>{t('orders.actions.amend')}</button>
          )}
          {canAdd && ['approved', 'processing'].includes(order.status) && (
            <button type="button" className="ghost-btn" onClick={() => doSetStatus(order.status === 'approved' ? 'processing' : 'out_for_delivery')}>
              {order.status === 'approved' ? t('orders.actions.markProcessing') : t('orders.actions.markOutForDelivery')}
            </button>
          )}
          {canDeliver && ['approved', 'processing', 'out_for_delivery'].includes(order.status) && (
            <button type="button" className="gold-btn" onClick={() => setModal('deliver')}>{t('orders.actions.deliver')}</button>
          )}
          {canAdd && order.status === 'delivered' && (
            <button type="button" className="gold-btn" onClick={doMarkPaid}>{t('orders.actions.markPaid')}</button>
          )}
          {canDelete && !['returned', 'cancelled'].includes(order.status) && (
            <button type="button" className="danger-btn" onClick={() => setModal('return')}>{t('orders.actions.return')}</button>
          )}
          {canDelete && !['delivered', 'paid'].includes(order.status) && !locked && (
            <button type="button" className="danger-btn" onClick={() => setModal('cancel')}>{t('orders.actions.cancel')}</button>
          )}
        </div>
      </section>

      <HistorySection orderId={order.id} t={t} />

      {modal === 'reject' && (
        <ReasonModal
          title={t('orders.actions.reject')}
          confirmLabel={t('orders.actions.reject')}
          t={t}
          onClose={() => setModal(null)}
          onSubmit={async (reason) => {
            await api.rejectOrderLifecycle(order.id, reason);
            setModal(null);
            showNotice(t('orders.notice.rejected'));
            load(true);
          }}
          onError={showError}
        />
      )}
      {modal === 'return' && (
        <ReasonModal
          title={t('orders.actions.return')}
          confirmLabel={t('orders.actions.return')}
          t={t}
          onClose={() => setModal(null)}
          onSubmit={async (reason) => {
            await api.returnOrder(order.id, reason);
            setModal(null);
            showNotice(t('orders.notice.returned'));
            load(true);
          }}
          onError={showError}
        />
      )}
      {modal === 'cancel' && (
        <ReasonModal
          title={t('orders.actions.cancel')}
          confirmLabel={t('orders.actions.cancel')}
          t={t}
          onClose={() => setModal(null)}
          onSubmit={async (reason) => {
            await api.cancelOrderLifecycle(order.id, reason);
            setModal(null);
            showNotice(t('orders.notice.cancelled'));
            load(true);
          }}
          onError={showError}
        />
      )}
      {modal === 'amend' && (
        <AmendModal order={order} t={t} onClose={() => setModal(null)} onError={showError} onDone={() => {
          setModal(null);
          showNotice(t('orders.notice.amended'));
          load(true);
        }} />
      )}
      {modal === 'deliver' && (
        <DeliverModal order={order} t={t} onClose={() => setModal(null)} onError={showError} onDone={(result) => {
          setModal(null);
          showNotice(
            result.shortfall?.length
              ? t('orders.notice.deliveredWithShortfall')
              : t('orders.notice.delivered')
          );
          load(true);
        }} />
      )}
    </div>
  );
}

function HistorySection({ orderId, t }) {
  const [changes, setChanges] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) api.getOrderHistory(orderId).then(setChanges).catch(() => {});
  }, [open, orderId]);

  return (
    <section className="orders-section">
      <button type="button" className="orders-link-btn" onClick={() => setOpen((o) => !o)}>
        {t('orders.history.title')}
      </button>
      {open && (
        <ul className="orders-history-list">
          {changes.length === 0 && <li className="orders-hint">{t('orders.history.empty')}</li>}
          {changes.map((c) => (
            <li key={c.id}>
              <span className="orders-cell-muted">{c.changed_at}</span> — {c.action}
              {c.changed_by_name ? ` — ${c.changed_by_name}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Reason modal (reject / return / cancel)
// ---------------------------------------------------------------------

function ReasonModal({ title, confirmLabel, t, onClose, onSubmit, onError }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (!window.confirm(t('orders.confirm.generic'))) return;
    setBusy(true);
    onError(null);
    try {
      await onSubmit(reason.trim() || undefined);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="orders-modal-backdrop" onClick={onClose}>
      <div className="orders-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <label>
          {t('orders.form.reason')}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </label>
        <div className="orders-modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
          <button type="button" className="danger-btn" disabled={busy} onClick={handleConfirm}>
            {busy ? t('orders.form.submitting') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Amend modal
// ---------------------------------------------------------------------

function AmendModal({ order, t, onClose, onError, onDone }) {
  const [orderDate, setOrderDate] = useState(order.order_date);
  const [items, setItems] = useState(order.items.map((it) => ({ ...it })));
  const [totalValue, setTotalValue] = useState(order.total_value);
  const [busy, setBusy] = useState(false);

  function updateQty(idx, qty) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, qty: Number(qty) } : it)));
  }

  async function submit(e) {
    e.preventDefault();
    if (!window.confirm(t('orders.confirm.amend'))) return;
    setBusy(true);
    onError(null);
    try {
      await api.amendOrder(order.id, { order_date: orderDate, items, total_value: Number(totalValue) });
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="orders-modal-backdrop" onClick={onClose}>
      <div className="orders-modal orders-modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('orders.actions.amend')}</h2>
        <form className="orders-form" onSubmit={submit}>
          <label>
            {t('orders.column.date')}
            <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} required />
          </label>
          <table className="orders-items-table">
            <thead>
              <tr>
                <th>{t('orders.items.product')}</th>
                <th>{t('orders.items.qty')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td>{it.product_name}</td>
                  <td>
                    <input type="number" step="any" min="0" value={it.qty} onChange={(e) => updateQty(i, e.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label>
            {t('orders.form.newTotal')}
            <input type="number" step="any" min="0" value={totalValue} onChange={(e) => setTotalValue(e.target.value)} required />
          </label>
          <div className="orders-modal-actions">
            <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
            <button type="submit" className="gold-btn" disabled={busy}>{busy ? t('orders.form.submitting') : t('orders.form.save')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Deliver modal — per-line delivered quantities + notes + signature
// ---------------------------------------------------------------------

function SignaturePad({ onChange, t }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  function pos(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  }

  function start(e) {
    drawingRef.current = true;
    draw(e);
  }
  function end() {
    drawingRef.current = false;
    onChange(canvasRef.current.toDataURL('image/png'));
  }
  function draw(e) {
    if (!drawingRef.current && e.type !== 'mousedown' && e.type !== 'touchstart') return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const { x, y } = pos(e, canvas);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#f3f5f7';
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function clear() {
    const canvas = canvasRef.current;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    onChange(null);
  }

  return (
    <div className="orders-signature-pad">
      <canvas
        ref={canvasRef}
        width={320}
        height={120}
        onMouseDown={start}
        onMouseMove={draw}
        onMouseUp={end}
        onMouseLeave={() => drawingRef.current && end()}
        onTouchStart={start}
        onTouchMove={draw}
        onTouchEnd={end}
      />
      <button type="button" className="orders-link-btn" onClick={clear}>{t('orders.deliver.clearSignature')}</button>
    </div>
  );
}

function DeliverModal({ order, t, onClose, onError, onDone }) {
  const [deliveredQty, setDeliveredQty] = useState(() =>
    Object.fromEntries(order.items.map((it, i) => [i, it.is_free ? it.qty : it.qty]))
  );
  const [notes, setNotes] = useState('');
  const [signature, setSignature] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!window.confirm(t('orders.confirm.deliver'))) return;
    setBusy(true);
    onError(null);
    try {
      const deliveredItems = order.items.map((it, i) => ({
        product_id: it.product_id,
        product_name: it.product_name,
        qty: Number(deliveredQty[i]) || 0,
      }));
      const result = await api.deliverOrder(order.id, {
        deliveredItems,
        notes: notes.trim() || undefined,
        signatureDataUrl: signature || undefined,
      });
      onDone(result);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="orders-modal-backdrop" onClick={onClose}>
      <div className="orders-modal orders-modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('orders.actions.deliver')}</h2>
        <form className="orders-form" onSubmit={submit}>
          <table className="orders-items-table">
            <thead>
              <tr>
                <th>{t('orders.items.product')}</th>
                <th>{t('orders.deliver.ordered')}</th>
                <th>{t('orders.deliver.delivered')}</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it, i) => (
                <tr key={i}>
                  <td>{it.product_name}</td>
                  <td>{it.qty}</td>
                  <td>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={deliveredQty[i]}
                      onChange={(e) => setDeliveredQty((prev) => ({ ...prev, [i]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label>
            {t('orders.deliver.notes')}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </label>
          <label>
            {t('orders.deliver.signature')}
            <SignaturePad onChange={setSignature} t={t} />
          </label>
          <div className="orders-modal-actions">
            <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
            <button type="submit" className="gold-btn" disabled={busy}>{busy ? t('orders.form.submitting') : t('orders.actions.deliver')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// WhatsApp order inbox
// ---------------------------------------------------------------------

function InboxListView({ t, can }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [approving, setApproving] = useState(null);

  function load(silent) {
    if (!silent) setLoading(true);
    return api
      .getWhatsappOrderInbox('pending_review')
      .then(setRows)
      .catch((err) => setError(errorMessage(err, t)))
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reject(id) {
    if (!window.confirm(t('orders.confirm.generic'))) return;
    try {
      await api.rejectWhatsappOrder(id);
      setNotice(t('orders.notice.rejected'));
      load(true);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  const canApprove = can('add_orders');

  return (
    <div>
      {error && <p className="orders-error">{error}</p>}
      {notice && <p className="orders-notice">{notice}</p>}
      {loading ? (
        <p className="orders-loading">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <div className="orders-empty"><p className="orders-empty-title">{t('orders.inbox.empty')}</p></div>
      ) : (
        <div className="orders-inbox-list">
          {rows.map((r) => (
            <div key={r.id} className="card orders-inbox-card">
              <div className="orders-inbox-card-head">
                <strong>{r.from_phone}</strong>
                <span className="orders-cell-muted">{r.received_at}</span>
              </div>
              <p className="orders-inbox-raw">{r.raw_text}</p>
              {r.items?.length > 0 && (
                <ul className="orders-inbox-items">
                  {r.items.map((it, i) => (
                    <li key={i}>{it.product_name} × {it.qty}</li>
                  ))}
                </ul>
              )}
              {canApprove && (
                <div className="orders-inbox-actions">
                  <button type="button" className="gold-btn" onClick={() => setApproving(r)}>{t('orders.inbox.approve')}</button>
                  <button type="button" className="danger-btn" onClick={() => reject(r.id)}>{t('orders.inbox.reject')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {approving && (
        <InboxApproveModal
          whatsappOrder={approving}
          t={t}
          onClose={() => setApproving(null)}
          onDone={() => {
            setApproving(null);
            setNotice(t('orders.notice.approved'));
            load(true);
          }}
        />
      )}
    </div>
  );
}

function InboxApproveModal({ whatsappOrder, t, onClose, onDone }) {
  const [shops, setShops] = useState([]);
  const [shopId, setShopId] = useState(whatsappOrder.shop_id || '');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState(whatsappOrder.items?.length ? whatsappOrder.items : []);
  const [totalValue, setTotalValue] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getShops().then(setShops).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!window.confirm(t('orders.confirm.generic'))) return;
    setBusy(true);
    setError(null);
    try {
      await api.approveWhatsappOrder(whatsappOrder.id, {
        shopId: shopId || undefined,
        order_date: orderDate,
        items,
        total_value: Number(totalValue),
        credit_override_reason: creditReason.trim() || undefined,
      });
      onDone();
    } catch (err) {
      const code = err?.detail?.error;
      if (code === 'credit_override_reason_required') {
        setError(t('orders.error.credit_override_reason_required'));
      } else {
        setError(errorMessage(err, t));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="orders-modal-backdrop" onClick={onClose}>
      <div className="orders-modal orders-modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('orders.inbox.approve')}</h2>
        {error && <p className="orders-error">{error}</p>}
        <form className="orders-form" onSubmit={submit}>
          <label>
            {t('orders.column.shop')}
            <select value={shopId} onChange={(e) => setShopId(e.target.value)} required>
              <option value="">{t('orders.form.selectShop')}</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label>
            {t('orders.column.date')}
            <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} required />
          </label>
          {items.length > 0 && (
            <table className="orders-items-table">
              <thead><tr><th>{t('orders.items.product')}</th><th>{t('orders.items.qty')}</th></tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.product_name}</td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={it.qty}
                        onChange={(e) => setItems((prev) => prev.map((p, idx) => (idx === i ? { ...p, qty: Number(e.target.value) } : p)))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <label>
            {t('orders.form.newTotal')}
            <input type="number" step="any" min="0" value={totalValue} onChange={(e) => setTotalValue(e.target.value)} required />
          </label>
          <label>
            {t('orders.form.creditOverrideReason')}
            <input type="text" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} />
          </label>
          <div className="orders-modal-actions">
            <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
            <button type="submit" className="gold-btn" disabled={busy}>{busy ? t('orders.form.submitting') : t('orders.inbox.approve')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
