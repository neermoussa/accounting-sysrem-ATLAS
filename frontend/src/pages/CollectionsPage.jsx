import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { ChartBars } from '../components/charts/ChartPrimitives.jsx';
import '../styles/collections.css';

const COLLECTION_STATUSES = ['pending_accountant_confirmation', 'pending_verification', 'confirmed', 'rejected'];

function StatusBadge({ status, t }) {
  return <span className={`collections-badge collections-badge-${status}`}>{t(`collections.status.${status}`)}</span>;
}

function errorMessage(err, t) {
  if (!err) return null;
  const code = err?.detail?.error;
  if (code && t(`collections.error.${code}`) !== `collections.error.${code}`) return t(`collections.error.${code}`);
  if (code) return code;
  return t('collections.error.generic');
}

export default function CollectionsPage() {
  const { can, canAny } = useAuth();
  const { t } = useLanguage();
  const [tab, setTab] = useState('list');

  const canViewList = canAny('view_app', 'record_collections', 'confirm_collections', 'view_statistics');
  const canViewReport = canAny('view_statistics', 'confirm_collections');
  const canViewReminders = canAny('send_payment_reminders', 'view_app');

  return (
    <div className="collections-page">
      <div className="collections-header">
        <div>
          <h1 className="atlas-page-title">{t('collections.title')}</h1>
          <p className="collections-subtitle">{t('collections.subtitle')}</p>
        </div>
        <div className="collections-tabs">
          {canViewReport && (
            <button type="button" className={`collections-tab-btn${tab === 'report' ? ' active' : ''}`} onClick={() => setTab('report')}>
              {t('collections.tab.report')}
            </button>
          )}
          {canViewList && (
            <button type="button" className={`collections-tab-btn${tab === 'list' ? ' active' : ''}`} onClick={() => setTab('list')}>
              {t('collections.tab.list')}
            </button>
          )}
          {canViewReminders && (
            <button type="button" className={`collections-tab-btn${tab === 'reminders' ? ' active' : ''}`} onClick={() => setTab('reminders')}>
              {t('collections.tab.reminders')}
            </button>
          )}
        </div>
      </div>

      {tab === 'report' && canViewReport && <ReportView t={t} />}
      {tab === 'list' && canViewList && <CollectionsListView t={t} can={can} />}
      {tab === 'reminders' && canViewReminders && <RemindersView t={t} can={can} />}
    </div>
  );
}

// ---------------------------------------------------------------------
// Report / receivables view
// ---------------------------------------------------------------------

function ReportView({ t }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getCollectionsReport()
      .then(setReport)
      .catch((err) => setError(errorMessage(err, t)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="collections-loading">{t('common.loading')}</p>;
  if (error) return <p className="collections-error">{error}</p>;
  if (!report) return null;

  const byMethodData = [
    { x: t('collections.method.cash'), y: report.byMethod.cash },
    { x: t('collections.method.transfer'), y: report.byMethod.transfer },
  ];

  return (
    <div>
      <div className="collections-kpi-grid">
        <div className="card collections-kpi-card">
          <span className="collections-kpi-label">{t('collections.report.expected')}</span>
          <span className="atlas-kpi">{Math.round(report.expectedTotal).toLocaleString()}</span>
        </div>
        <div className="card collections-kpi-card">
          <span className="collections-kpi-label">{t('collections.report.collected')}</span>
          <span className="atlas-kpi">{Math.round(report.collectedTotal).toLocaleString()}</span>
        </div>
        <div className="card collections-kpi-card">
          <span className="collections-kpi-label">{t('collections.report.remaining')}</span>
          <span className="atlas-kpi">{Math.round(report.remainingTotal).toLocaleString()}</span>
        </div>
        <div className="card collections-kpi-card">
          <span className="collections-kpi-label">{t('collections.report.pending')}</span>
          <span className="atlas-kpi">{report.pendingCount}</span>
        </div>
        <div className="card collections-kpi-card">
          <span className="collections-kpi-label">{t('collections.report.discrepancies')}</span>
          <span className="atlas-kpi">{report.discrepancyCount}</span>
        </div>
      </div>

      <div className="card collections-chart-card">
        <h2 className="atlas-section-title">{t('collections.report.byMethod')}</h2>
        <ChartBars data={byMethodData} tone="blue" formatValue={(v) => Math.round(v).toLocaleString()} />
      </div>

      <section className="collections-section">
        <h2 className="atlas-section-title">{t('collections.report.outstandingBalances')}</h2>
        {report.outstandingBalances.length === 0 ? (
          <p className="collections-hint">{t('collections.report.noOutstanding')}</p>
        ) : (
          <div className="collections-table-wrap">
            <table className="collections-table">
              <thead>
                <tr>
                  <th>{t('collections.column.shop')}</th>
                  <th>{t('collections.column.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {report.outstandingBalances.map((r) => (
                  <tr key={r.shop_id}>
                    <td>{r.name}</td>
                    <td>{Math.round(r.balance).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------
// List + detail
// ---------------------------------------------------------------------

function CollectionsListView({ t, can }) {
  const [collections, setCollections] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [showRecord, setShowRecord] = useState(false);

  function load(silent) {
    if (!silent) setLoading(true);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    if (shopFilter) params.shopId = shopFilter;
    if (methodFilter) params.method = methodFilter;
    return api
      .getCollections(params)
      .then(setCollections)
      .catch((err) => setError(errorMessage(err, t)))
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, shopFilter, methodFilter]);

  useEffect(() => {
    api.getShops().then(setShops).catch(() => {});
  }, []);

  const shopsById = Object.fromEntries(shops.map((s) => [String(s.id), s]));
  const canRecord = can('record_collections');
  const canConfirm = can('confirm_collections');

  if (selectedId) {
    return (
      <CollectionDetail
        id={selectedId}
        shopsById={shopsById}
        canConfirm={canConfirm}
        canReverse={canConfirm && can('reverse_journal_entries')}
        onBack={() => {
          setSelectedId(null);
          load(true);
        }}
        t={t}
      />
    );
  }

  return (
    <div>
      <div className="collections-toolbar">
        <div className="collections-filters">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t('collections.filter.allStatuses')}</option>
            {COLLECTION_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`collections.status.${s}`)}</option>
            ))}
          </select>
          <select value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
            <option value="">{t('collections.filter.allShops')}</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
            <option value="">{t('collections.filter.allMethods')}</option>
            <option value="cash">{t('collections.method.cash')}</option>
            <option value="transfer">{t('collections.method.transfer')}</option>
          </select>
        </div>
        {canRecord && (
          <button type="button" className="gold-btn" onClick={() => setShowRecord(true)}>{t('collections.record.button')}</button>
        )}
      </div>

      {error && <p className="collections-error">{error}</p>}
      {notice && <p className="collections-notice">{notice}</p>}

      {loading ? (
        <p className="collections-loading">{t('common.loading')}</p>
      ) : collections.length === 0 ? (
        <div className="collections-empty"><p className="collections-empty-title">{t('collections.empty')}</p></div>
      ) : (
        <div className="collections-table-wrap">
          <table className="collections-table">
            <thead>
              <tr>
                <th>{t('collections.column.id')}</th>
                <th>{t('collections.column.shop')}</th>
                <th>{t('collections.column.method')}</th>
                <th>{t('collections.column.amount')}</th>
                <th>{t('collections.column.status')}</th>
                <th>{t('collections.column.date')}</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr key={c.id} className="collections-row" onClick={() => setSelectedId(c.id)}>
                  <td>#{c.id}</td>
                  <td>{shopsById[String(c.shop_id)]?.name || t('orders.unknownShop')}</td>
                  <td>{t(`collections.method.${c.method}`)}</td>
                  <td>{Number(c.amount).toLocaleString()}</td>
                  <td><StatusBadge status={c.status} t={t} /></td>
                  <td className="collections-cell-muted">{c.collected_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRecord && (
        <RecordCollectionModal
          shops={shops}
          t={t}
          onClose={() => setShowRecord(false)}
          onDone={(c) => {
            setShowRecord(false);
            setNotice(t('collections.notice.recorded'));
            load(true);
            setSelectedId(c.id);
          }}
        />
      )}
    </div>
  );
}

function RecordCollectionModal({ shops, t, onClose, onDone }) {
  const [shopId, setShopId] = useState('');
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [transferReference, setTransferReference] = useState('');
  const [notes, setNotes] = useState('');
  // Prompt 7: optional foreign currency (empty = base). Rate locked when the
  // accountant confirms.
  const [currencyCode, setCurrencyCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api.recordCollection({
        shopId: Number(shopId),
        method,
        amount: Number(amount),
        transferReference: method === 'transfer' ? transferReference.trim() || undefined : undefined,
        notes: notes.trim() || undefined,
        ...(currencyCode.trim() ? { currencyCode: currencyCode.trim().toUpperCase() } : {}),
      });
      onDone(c);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="collections-modal-backdrop" onClick={onClose}>
      <div className="collections-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('collections.record.title')}</h2>
        {error && <p className="collections-error">{error}</p>}
        <form className="collections-form" onSubmit={submit}>
          <label>
            {t('collections.column.shop')}
            <select value={shopId} onChange={(e) => setShopId(e.target.value)} required>
              <option value="">{t('orders.form.selectShop')}</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label>
            {t('collections.column.method')}
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">{t('collections.method.cash')}</option>
              <option value="transfer">{t('collections.method.transfer')}</option>
            </select>
          </label>
          <label>
            {t('collections.column.amount')}
            <input type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          <label>
            {t('collections.record.currency')}
            <input type="text" dir="ltr" maxLength={3} placeholder={t('collections.record.currencyHint')} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} />
          </label>
          {method === 'transfer' && (
            <label>
              {t('collections.record.transferReference')}
              <input type="text" value={transferReference} onChange={(e) => setTransferReference(e.target.value)} />
            </label>
          )}
          <label>
            {t('collections.record.notes')}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </label>
          <div className="collections-modal-actions">
            <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
            <button type="submit" className="gold-btn" disabled={busy}>{busy ? t('orders.form.submitting') : t('collections.record.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CollectionDetail({ id, shopsById, canConfirm, canReverse, onBack, t }) {
  const [collection, setCollection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showReject, setShowReject] = useState(false);

  function load(silent) {
    if (!silent) setLoading(true);
    return api.getCollection(id).then(setCollection).catch((err) => setError(errorMessage(err, t))).finally(() => {
      if (!silent) setLoading(false);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading || !collection) return <p className="collections-loading">{t('common.loading')}</p>;

  const shop = shopsById[String(collection.shop_id)];
  const pending = ['pending_accountant_confirmation', 'pending_verification'].includes(collection.status);

  async function confirm() {
    if (!window.confirm(t('collections.confirm.confirm'))) return;
    try {
      await api.confirmCollection(collection.id);
      setNotice(t('collections.notice.confirmed'));
      load(true);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  return (
    <div>
      <div className="collections-detail-header">
        <button type="button" className="ghost-btn" onClick={onBack}>{t('orders.back')}</button>
        <h1 className="atlas-section-title">#{collection.id}</h1>
        <StatusBadge status={collection.status} t={t} />
      </div>

      {error && <p className="collections-error">{error}</p>}
      {notice && <p className="collections-notice">{notice}</p>}

      <div className="card collections-meta-grid">
        <div><span className="collections-meta-label">{t('collections.column.shop')}</span><span>{shop?.name || t('orders.unknownShop')}</span></div>
        <div><span className="collections-meta-label">{t('collections.column.method')}</span><span>{t(`collections.method.${collection.method}`)}</span></div>
        <div><span className="collections-meta-label">{t('collections.column.amount')}</span><span>{Number(collection.amount).toLocaleString()}</span></div>
        <div><span className="collections-meta-label">{t('collections.column.date')}</span><span>{collection.collected_at}</span></div>
        {collection.transfer_reference && (
          <div><span className="collections-meta-label">{t('collections.record.transferReference')}</span><span>{collection.transfer_reference}</span></div>
        )}
        {collection.notes && (
          <div><span className="collections-meta-label">{t('collections.record.notes')}</span><span>{collection.notes}</span></div>
        )}
        {collection.rejected_reason && (
          <div><span className="collections-meta-label">{t('collections.detail.rejectedReason')}</span><span>{collection.rejected_reason}</span></div>
        )}
        {collection.confirmed_by_name && (
          <div><span className="collections-meta-label">{t('collections.detail.confirmedBy')}</span><span>{collection.confirmed_by_name} · {collection.confirmed_at}</span></div>
        )}
      </div>

      {canConfirm && pending && (
        <section className="collections-section collections-actions-row">
          <button type="button" className="gold-btn" onClick={confirm}>{t('collections.actions.confirm')}</button>
          <button type="button" className="danger-btn" onClick={() => setShowReject(true)}>{t('collections.actions.reject')}</button>
        </section>
      )}

      {/* Ledger-live companies: a confirmed collection is reversed here (its
          journal entry can't be reversed from the journal screen). */}
      {canReverse && collection.status === 'confirmed' && (
        <section className="collections-section collections-actions-row">
          <button type="button" className="danger-btn" onClick={async () => {
            const reason = window.prompt(t('collections.reverse.prompt'));
            if (!reason?.trim()) return;
            try {
              await api.reverseCollection(collection.id, reason.trim());
              setNotice(t('collections.notice.reversed'));
              load(true);
            } catch (err) {
              setError(err?.detail?.message || errorMessage(err, t));
            }
          }}>{t('collections.actions.reverse')}</button>
        </section>
      )}

      <HistorySection collectionId={collection.id} t={t} />

      {showReject && (
        <RejectModal
          t={t}
          onClose={() => setShowReject(false)}
          onSubmit={async (reason) => {
            await api.rejectCollection(collection.id, reason);
            setShowReject(false);
            setNotice(t('collections.notice.rejected'));
            load(true);
          }}
          onError={(err) => setError(errorMessage(err, t))}
        />
      )}
    </div>
  );
}

function RejectModal({ t, onClose, onSubmit, onError }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!window.confirm(t('orders.confirm.generic'))) return;
    setBusy(true);
    try {
      await onSubmit(reason.trim() || undefined);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="collections-modal-backdrop" onClick={onClose}>
      <div className="collections-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('collections.actions.reject')}</h2>
        <label className="collections-form-label">
          {t('orders.form.reason')}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </label>
        <div className="collections-modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>{t('orders.back')}</button>
          <button type="button" className="danger-btn" disabled={busy} onClick={confirm}>{busy ? t('orders.form.submitting') : t('collections.actions.reject')}</button>
        </div>
      </div>
    </div>
  );
}

function HistorySection({ collectionId, t }) {
  const [changes, setChanges] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) api.getCollectionChanges(collectionId).then(setChanges).catch(() => {});
  }, [open, collectionId]);

  return (
    <section className="collections-section">
      <button type="button" className="collections-link-btn" onClick={() => setOpen((o) => !o)}>{t('orders.history.title')}</button>
      {open && (
        <ul className="collections-history-list">
          {changes.length === 0 && <li className="collections-hint">{t('orders.history.empty')}</li>}
          {changes.map((c) => (
            <li key={c.id}><span className="collections-cell-muted">{c.changed_at}</span> — {c.action}{c.changed_by_name ? ` — ${c.changed_by_name}` : ''}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------

function RemindersView({ t, can }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const canSend = can('send_payment_reminders');

  function load(silent) {
    if (!silent) setLoading(true);
    return api.getPaymentReminders('pending_review').then(setRows).catch((err) => setError(errorMessage(err, t))).finally(() => {
      if (!silent) setLoading(false);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(id) {
    if (!window.confirm(t('collections.reminders.confirmSend'))) return;
    try {
      await api.sendPaymentReminder(id);
      setNotice(t('collections.reminders.sent'));
      load(true);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  async function dismiss(id) {
    if (!window.confirm(t('collections.reminders.confirmDismiss'))) return;
    try {
      await api.dismissPaymentReminder(id);
      setNotice(t('collections.reminders.dismissed'));
      load(true);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  return (
    <div>
      {error && <p className="collections-error">{error}</p>}
      {notice && <p className="collections-notice">{notice}</p>}
      {loading ? (
        <p className="collections-loading">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <div className="collections-empty"><p className="collections-empty-title">{t('collections.reminders.empty')}</p></div>
      ) : (
        <div className="collections-inbox-list">
          {rows.map((r) => (
            <div key={r.id} className="card collections-inbox-card">
              <div className="collections-inbox-card-head">
                <strong>{t(`collections.reminders.reason.${r.triggered_reason}`)}</strong>
                <span className="collections-cell-muted">{r.created_at}</span>
              </div>
              <p className="collections-inbox-raw">{r.suggested_message}</p>
              {canSend && (
                <div className="collections-inbox-actions">
                  <button type="button" className="gold-btn" onClick={() => send(r.id)}>{t('collections.reminders.send')}</button>
                  <button type="button" className="danger-btn" onClick={() => dismiss(r.id)}>{t('collections.reminders.dismiss')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
