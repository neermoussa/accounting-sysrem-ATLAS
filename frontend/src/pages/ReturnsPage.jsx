import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/returns.css';

const RETURN_STATUSES = ['pending_review', 'approved', 'rejected'];
const INSPECTION_STATUSES = ['valid', 'needs_further_inspection', 'damaged'];

function StatusBadge({ status, t }) {
  return <span className={`returns-badge returns-badge-${status}`}>{t(`returns.status.${status}`)}</span>;
}

function InspectionBadge({ status, t }) {
  return <span className={`returns-inspection-badge returns-inspection-badge-${status}`}>{t(`returns.inspection.${status}`)}</span>;
}

function errorMessage(err, t) {
  if (!err) return null;
  const code = err?.detail?.error;
  if (code && t(`returns.error.${code}`) !== `returns.error.${code}`) return t(`returns.error.${code}`);
  if (code) return code;
  return t('returns.error.generic');
}

export default function ReturnsPage() {
  const { can, canAny } = useAuth();
  const { t } = useLanguage();
  const [shops, setShops] = useState([]);
  const [returns, setReturns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const canView = canAny('view_app', 'request_returns', 'approve_returns');
  const canRequest = can('request_returns');
  const canApprove = can('approve_returns');

  function load(silent) {
    if (!silent) setLoading(true);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    if (shopFilter) params.shopId = shopFilter;
    return api
      .getReturnRequests(params)
      .then(setReturns)
      .catch((err) => setError(errorMessage(err, t)))
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, shopFilter]);

  useEffect(() => {
    api.getShops().then(setShops).catch(() => {});
  }, []);

  const shopsById = Object.fromEntries(shops.map((s) => [String(s.id), s]));

  if (!canView) return <div className="no-access"><p>{t('requirePermission.noAccess')}</p></div>;

  if (selectedId) {
    return (
      <ReturnDetail
        id={selectedId}
        shopsById={shopsById}
        canApprove={canApprove}
        onBack={() => {
          setSelectedId(null);
          load(true);
        }}
        t={t}
      />
    );
  }

  return (
    <div className="returns-page">
      <div className="returns-header">
        <div>
          <h1 className="atlas-page-title">{t('returns.title')}</h1>
          <p className="returns-subtitle">{t('returns.subtitle')}</p>
        </div>
        {canRequest && (
          <button type="button" className="gold-btn" onClick={() => setShowCreate(true)}>{t('returns.newRequest')}</button>
        )}
      </div>

      <div className="returns-filters">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{t('returns.filter.allStatuses')}</option>
          {RETURN_STATUSES.map((s) => (
            <option key={s} value={s}>{t(`returns.status.${s}`)}</option>
          ))}
        </select>
        <select value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
          <option value="">{t('returns.filter.allShops')}</option>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {error && <p className="returns-error">{error}</p>}
      {notice && <p className="returns-notice">{notice}</p>}

      {loading ? (
        <p className="returns-loading">{t('common.loading')}</p>
      ) : returns.length === 0 ? (
        <div className="returns-empty"><p className="returns-empty-title">{t('returns.empty')}</p></div>
      ) : (
        <div className="returns-table-wrap">
          <table className="returns-table">
            <thead>
              <tr>
                <th>{t('returns.column.id')}</th>
                <th>{t('returns.column.shop')}</th>
                <th>{t('returns.column.reason')}</th>
                <th>{t('returns.column.status')}</th>
                <th>{t('returns.column.itemsCount')}</th>
                <th>{t('returns.column.createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.id} className="returns-row" onClick={() => setSelectedId(r.id)}>
                  <td>#{r.id}</td>
                  <td>{shopsById[String(r.shop_id)]?.name || t('orders.unknownShop')}</td>
                  <td className="returns-cell-muted">{r.reason || '—'}</td>
                  <td><StatusBadge status={r.status} t={t} /></td>
                  <td>{r.items?.length ?? 0}</td>
                  <td className="returns-cell-muted">{r.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateReturnModal
          shops={shops}
          t={t}
          onClose={() => setShowCreate(false)}
          onCreated={(request) => {
            setShowCreate(false);
            setNotice(t('returns.notice.created'));
            load(true);
            setSelectedId(request.id);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Create return request
// ---------------------------------------------------------------------

function CreateReturnModal({ shops, t, onClose, onCreated }) {
  const [shopId, setShopId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [reason, setReason] = useState('');
  const [items, setItems] = useState([{ productName: '', qty: '', unitKey: '' }]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function updateItem(idx, field, value) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  }
  function addItem() {
    setItems((prev) => [...prev, { productName: '', qty: '', unitKey: '' }]);
  }
  function removeItem(idx) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        shopId: Number(shopId),
        orderId: orderId ? Number(orderId) : undefined,
        reason: reason.trim() || undefined,
        items: items
          .filter((it) => it.productName.trim() && Number(it.qty) > 0)
          .map((it) => ({ productName: it.productName.trim(), qty: Number(it.qty), unitKey: it.unitKey.trim() || undefined })),
      };
      const request = await api.fileReturnRequest(payload);
      onCreated(request);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="returns-modal-backdrop" onClick={onClose}>
      <div className="returns-modal returns-modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('returns.form.title')}</h2>
        {error && <p className="returns-error">{error}</p>}
        <form className="returns-form" onSubmit={submit}>
          <label>
            {t('returns.column.shop')}
            <select value={shopId} onChange={(e) => setShopId(e.target.value)} required>
              <option value="">{t('orders.form.selectShop')}</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label>
            {t('returns.form.orderId')}
            <input type="number" value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder={t('returns.form.orderIdPlaceholder')} />
          </label>
          <label>
            {t('returns.column.reason')}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </label>

          <div className="returns-items-editor">
            <span className="returns-form-subtitle">{t('returns.items.title')}</span>
            {items.map((it, i) => (
              <div key={i} className="returns-item-row">
                <input type="text" placeholder={t('returns.items.product')} value={it.productName} onChange={(e) => updateItem(i, 'productName', e.target.value)} />
                <input type="number" step="any" min="0" placeholder={t('returns.items.qty')} value={it.qty} onChange={(e) => updateItem(i, 'qty', e.target.value)} />
                <input type="text" placeholder={t('custody.items.unit')} value={it.unitKey} onChange={(e) => updateItem(i, 'unitKey', e.target.value)} className="returns-unit-input" />
                {items.length > 1 && (
                  <button type="button" className="returns-link-btn danger" onClick={() => removeItem(i)}>{t('custody.items.remove')}</button>
                )}
              </div>
            ))}
            <button type="button" className="returns-link-btn" onClick={addItem}>{t('returns.items.addItem')}</button>
          </div>

          <div className="returns-modal-actions">
            <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
            <button type="submit" className="gold-btn" disabled={busy}>{busy ? t('orders.form.submitting') : t('returns.form.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Detail: items, inspection, approve/reject
// ---------------------------------------------------------------------

function ReturnDetail({ id, shopsById, canApprove, onBack, t }) {
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showReject, setShowReject] = useState(false);

  function load(silent) {
    if (!silent) setLoading(true);
    return api.getReturnRequest(id).then(setRequest).catch((err) => setError(errorMessage(err, t))).finally(() => {
      if (!silent) setLoading(false);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading || !request) return <p className="returns-loading">{t('common.loading')}</p>;

  const shop = shopsById[String(request.shop_id)];
  const allInspected = request.items.every((it) => it.inspection_status !== 'pending_inspection');

  async function approve() {
    if (!window.confirm(t('returns.confirm.approve'))) return;
    try {
      const result = await api.approveReturnRequest(request.id, undefined);
      setNotice(result.creditApplied ? t('returns.notice.approvedWithCredit') : t('returns.notice.approved'));
      load(true);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  return (
    <div>
      <div className="returns-detail-header">
        <button type="button" className="ghost-btn" onClick={onBack}>{t('orders.back')}</button>
        <h1 className="atlas-section-title">#{request.id}</h1>
        <StatusBadge status={request.status} t={t} />
      </div>

      {error && <p className="returns-error">{error}</p>}
      {notice && <p className="returns-notice">{notice}</p>}

      <div className="card returns-meta-grid">
        <div><span className="returns-meta-label">{t('returns.column.shop')}</span><span>{shop?.name || t('orders.unknownShop')}</span></div>
        <div><span className="returns-meta-label">{t('returns.column.reason')}</span><span>{request.reason || '—'}</span></div>
        <div><span className="returns-meta-label">{t('returns.detail.requestedBy')}</span><span>{request.requested_by_name || '—'}</span></div>
        <div><span className="returns-meta-label">{t('returns.column.createdAt')}</span><span>{request.created_at}</span></div>
        {request.order_id && (
          <div><span className="returns-meta-label">{t('returns.form.orderId')}</span><span>#{request.order_id}</span></div>
        )}
        {request.review_notes && (
          <div><span className="returns-meta-label">{t('returns.detail.reviewNotes')}</span><span>{request.review_notes}</span></div>
        )}
        {request.financial_adjustment_applied ? (
          <div><span className="returns-meta-label">{t('returns.detail.financialAdjustment')}</span><span>{t('returns.detail.applied')}</span></div>
        ) : null}
      </div>

      <section className="returns-section">
        <h2 className="atlas-section-title">{t('returns.items.title')}</h2>
        <div className="returns-table-wrap">
          <table className="returns-items-table">
            <thead>
              <tr>
                <th>{t('returns.items.product')}</th>
                <th>{t('returns.items.requestedQty')}</th>
                <th>{t('returns.items.inspectedQty')}</th>
                <th>{t('returns.inspection.title')}</th>
                {canApprove && request.status === 'pending_review' && <th></th>}
              </tr>
            </thead>
            <tbody>
              {request.items.map((item) => (
                <ReturnItemRow key={item.id} item={item} returnId={request.id} canApprove={canApprove} requestStatus={request.status} t={t} onReload={() => load(true)} onError={(err) => setError(errorMessage(err, t))} />
              ))}
            </tbody>
          </table>
        </div>

        {request.media?.length > 0 && (
          <div className="returns-media-grid">
            {request.media.map((m) => (
              <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="returns-media-thumb">
                <img src={m.url} alt="" />
              </a>
            ))}
          </div>
        )}
      </section>

      {canApprove && request.status === 'pending_review' && (
        <section className="returns-section returns-actions-row">
          <button type="button" className="gold-btn" disabled={!allInspected} onClick={approve}>{t('returns.actions.approve')}</button>
          <button type="button" className="danger-btn" onClick={() => setShowReject(true)}>{t('returns.actions.reject')}</button>
          {!allInspected && <p className="returns-hint">{t('returns.hint.inspectAllFirst')}</p>}
        </section>
      )}

      <HistorySection returnId={request.id} t={t} />

      {showReject && (
        <RejectModal
          t={t}
          onClose={() => setShowReject(false)}
          onSubmit={async (notes) => {
            await api.rejectReturnRequest(request.id, notes);
            setShowReject(false);
            setNotice(t('returns.notice.rejected'));
            load(true);
          }}
          onError={(err) => setError(errorMessage(err, t))}
        />
      )}
    </div>
  );
}

function ReturnItemRow({ item, returnId, canApprove, requestStatus, t, onReload, onError }) {
  const [inspecting, setInspecting] = useState(false);

  const canInspect = canApprove && requestStatus === 'pending_review' && item.inspection_status === 'pending_inspection';

  return (
    <>
      <tr>
        <td>{item.product_name}</td>
        <td>{item.requested_qty}</td>
        <td>{item.inspected_qty ?? '—'}</td>
        <td><InspectionBadge status={item.inspection_status} t={t} /></td>
        {canApprove && requestStatus === 'pending_review' && (
          <td>
            {canInspect && (
              <button type="button" className="returns-link-btn" onClick={() => setInspecting((v) => !v)}>{t('returns.inspection.inspect')}</button>
            )}
          </td>
        )}
      </tr>
      {inspecting && (
        <tr>
          <td colSpan={5}>
            <InspectForm item={item} returnId={returnId} t={t} onDone={() => { setInspecting(false); onReload(); }} onError={onError} />
          </td>
        </tr>
      )}
    </>
  );
}

function InspectForm({ item, returnId, t, onDone, onError }) {
  const [inspectedQty, setInspectedQty] = useState(item.requested_qty);
  const [inspectionStatus, setInspectionStatus] = useState('valid');
  const [discrepancyReason, setDiscrepancyReason] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!window.confirm(t('returns.confirm.inspect'))) return;
    setBusy(true);
    onError(null);
    try {
      if (file) {
        await api.uploadReturnMedia(returnId, file, item.id);
      }
      await api.inspectReturnItem(returnId, item.id, {
        inspectedQty: Number(inspectedQty),
        inspectionStatus,
        discrepancyReason: Number(inspectedQty) !== item.requested_qty ? discrepancyReason.trim() : undefined,
        notes: notes.trim() || undefined,
      });
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="returns-inspect-form" onSubmit={submit}>
      <label>
        {t('returns.inspection.inspectedQty')}
        <input type="number" step="any" min="0" value={inspectedQty} onChange={(e) => setInspectedQty(e.target.value)} required />
      </label>
      <label>
        {t('returns.inspection.status')}
        <select value={inspectionStatus} onChange={(e) => setInspectionStatus(e.target.value)}>
          {INSPECTION_STATUSES.map((s) => (
            <option key={s} value={s}>{t(`returns.inspection.${s}`)}</option>
          ))}
        </select>
      </label>
      {Number(inspectedQty) !== item.requested_qty && (
        <label>
          {t('returns.inspection.discrepancyReason')}
          <input type="text" value={discrepancyReason} onChange={(e) => setDiscrepancyReason(e.target.value)} required />
        </label>
      )}
      <label>
        {t('returns.inspection.notes')}
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </label>
      <label>
        {t('returns.inspection.media')}
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </label>
      <button type="submit" className="gold-btn" disabled={busy}>{busy ? t('orders.form.submitting') : t('returns.inspection.save')}</button>
    </form>
  );
}

function RejectModal({ t, onClose, onSubmit, onError }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!window.confirm(t('orders.confirm.generic'))) return;
    setBusy(true);
    try {
      await onSubmit(notes.trim() || undefined);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="returns-modal-backdrop" onClick={onClose}>
      <div className="returns-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('returns.actions.reject')}</h2>
        <label className="returns-form-label">
          {t('returns.detail.reviewNotes')}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </label>
        <div className="returns-modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
          <button type="button" className="danger-btn" disabled={busy} onClick={confirm}>{busy ? t('orders.form.submitting') : t('returns.actions.reject')}</button>
        </div>
      </div>
    </div>
  );
}

function HistorySection({ returnId, t }) {
  const [changes, setChanges] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) api.getReturnChanges(returnId).then(setChanges).catch(() => {});
  }, [open, returnId]);

  return (
    <section className="returns-section">
      <button type="button" className="returns-link-btn" onClick={() => setOpen((o) => !o)}>{t('orders.history.title')}</button>
      {open && (
        <ul className="returns-history-list">
          {changes.length === 0 && <li className="returns-hint">{t('orders.history.empty')}</li>}
          {changes.map((c) => (
            <li key={c.id}><span className="returns-cell-muted">{c.changed_at}</span> — {c.action}{c.changed_by_name ? ` — ${c.changed_by_name}` : ''}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
