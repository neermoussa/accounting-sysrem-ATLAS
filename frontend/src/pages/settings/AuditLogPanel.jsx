import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { PERMISSION_LABELS } from '../../auth/permissions.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import '../../styles/audit-log.css';

const PERMISSIONS_ACTIONS = new Set([
  'permissions_set',
  'permissions_apply_template',
  'manage_permissions_grant',
  'manage_permissions_revoke',
]);

const SHOP_FIELD_KEYS = ['name', 'phone', 'address', 'notes', 'debt_threshold_override', 'order_overdue_days_override'];

function fieldLabel(key, t) {
  const keys = { order_date: 'audit.field.order_date', total_value: 'audit.field.total_value', items: 'audit.field.items' };
  return keys[key] ? t(keys[key]) : key;
}

function formatValue(key, value) {
  if (key === 'items' && Array.isArray(value)) {
    return value.map((it) => `${it.product_name} × ${it.qty}`).join('، ') || '—';
  }
  if (value == null || value === '') return '—';
  return String(value);
}

function ChangedFields({ before, after, t }) {
  if (!before) return null;
  const keys = ['order_date', 'total_value', 'items'];
  const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after?.[k]));
  if (!after) {
    // Delete: show the full snapshot that was removed.
    return (
      <div className="audit-diff">
        {keys.map((k) => (
          <div key={k} className="audit-diff-row">
            <span className="audit-diff-label">{fieldLabel(k, t)}</span>
            <span className="audit-diff-before">{formatValue(k, before[k])}</span>
          </div>
        ))}
      </div>
    );
  }
  if (changed.length === 0) return <p className="audit-diff-empty">{t('audit.noChanges')}</p>;
  return (
    <div className="audit-diff">
      {changed.map((k) => (
        <div key={k} className="audit-diff-row">
          <span className="audit-diff-label">{fieldLabel(k, t)}</span>
          <span className="audit-diff-before">{formatValue(k, before[k])}</span>
          <span className="audit-diff-arrow">←</span>
          <span className="audit-diff-after">{formatValue(k, after[k])}</span>
        </div>
      ))}
    </div>
  );
}

function ShopChangedFields({ action, before, after, t }) {
  const keys = SHOP_FIELD_KEYS;
  if (action === 'shop_delete') {
    return (
      <div className="audit-diff">
        {keys
          .filter((k) => before?.[k] != null && before[k] !== '')
          .map((k) => (
            <div key={k} className="audit-diff-row">
              <span className="audit-diff-label">{t(`audit.field.${k}`)}</span>
              <span className="audit-diff-before">{formatValue(k, before[k])}</span>
            </div>
          ))}
      </div>
    );
  }
  const changed = keys.filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
  if (changed.length === 0) return <p className="audit-diff-empty">{t('audit.noChanges')}</p>;
  return (
    <div className="audit-diff">
      {changed.map((k) => (
        <div key={k} className="audit-diff-row">
          <span className="audit-diff-label">{t(`audit.field.${k}`)}</span>
          <span className="audit-diff-before">{formatValue(k, before[k])}</span>
          <span className="audit-diff-arrow">←</span>
          <span className="audit-diff-after">{formatValue(k, after[k])}</span>
        </div>
      ))}
    </div>
  );
}

function BalanceImportSummary({ after, t }) {
  if (!after) return null;
  return (
    <div className="audit-diff">
      <div className="audit-diff-row">
        <span className="audit-diff-label">{t('audit.file')}</span>
        <span className="audit-diff-after">{after.filename}</span>
      </div>
      <div className="audit-diff-row">
        <span className="audit-diff-label">{t('audit.reportDate')}</span>
        <span className="audit-diff-after">{after.report_date}</span>
      </div>
      <div className="audit-diff-row">
        <span className="audit-diff-label">{t('audit.updatedShopsCount')}</span>
        <span className="audit-diff-after">{after.updatedShops}</span>
      </div>
    </div>
  );
}

function permLabel(key, t) {
  return key === 'manage_permissions' ? t('audit.managePermissions') : PERMISSION_LABELS[key] || key;
}

function PermissionsChangedFields({ action, before, after, t }) {
  if (action === 'manage_permissions_grant' || action === 'manage_permissions_revoke') {
    return <p className="audit-diff-empty">{action === 'manage_permissions_grant' ? t('audit.permissionGranted') : t('audit.permissionRevoked')}</p>;
  }
  const beforeSet = new Set(before?.permissions || []);
  const afterSet = new Set(after?.permissions || []);
  const added = [...afterSet].filter((p) => !beforeSet.has(p));
  const removed = [...beforeSet].filter((p) => !afterSet.has(p));
  return (
    <div className="audit-diff">
      {action === 'permissions_apply_template' && after?.template && (
        <div className="audit-diff-row">
          <span className="audit-diff-label">{t('audit.appliedTemplate')}</span>
          <span className="audit-diff-after">{after.template}</span>
        </div>
      )}
      {added.length > 0 && (
        <div className="audit-diff-row">
          <span className="audit-diff-label">{t('audit.permissionsAdded')}</span>
          <span className="audit-diff-after">{added.map((p) => permLabel(p, t)).join('، ')}</span>
        </div>
      )}
      {removed.length > 0 && (
        <div className="audit-diff-row">
          <span className="audit-diff-label">{t('audit.permissionsRemoved')}</span>
          <span className="audit-diff-before">{removed.map((p) => permLabel(p, t)).join('، ')}</span>
        </div>
      )}
      {added.length === 0 && removed.length === 0 && <p className="audit-diff-empty">{t('audit.noChanges')}</p>}
    </div>
  );
}

function EntryDetail({ entry, t }) {
  if (PERMISSIONS_ACTIONS.has(entry.action)) {
    return <PermissionsChangedFields action={entry.action} before={entry.before} after={entry.after} t={t} />;
  }
  if (entry.action === 'shop_edit' || entry.action === 'shop_delete') {
    return <ShopChangedFields action={entry.action} before={entry.before} after={entry.after} t={t} />;
  }
  if (entry.action === 'balance_import_commit') {
    return <BalanceImportSummary after={entry.after} t={t} />;
  }
  return <ChangedFields before={entry.before} after={entry.after} t={t} />;
}

export default function AuditLogPanel() {
  const { t } = useLanguage();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  function load(filters = {}) {
    setLoading(true);
    api
      .getAuditLog(filters)
      .then(setEntries)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(actionFilter ? { action: actionFilter } : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFilter]);

  return (
    <div className="audit-log-page">
      <div className="audit-log-header">
        <select className="audit-log-filter" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="">{t('audit.allActions')}</option>
          <option value="shop_edit">{t('audit.action.shop_edit')}</option>
          <option value="shop_delete">{t('audit.action.shop_delete')}</option>
          <option value="balance_import_commit">{t('audit.updateBalances')}</option>
          <option value="order_edit">{t('audit.editOrders')}</option>
          <option value="order_delete">{t('audit.deleteOrders')}</option>
          <option value="permissions_set">{t('audit.action.permissions_set')}</option>
          <option value="permissions_apply_template">{t('audit.action.permissions_apply_template')}</option>
          <option value="manage_permissions_grant">{t('audit.grantManagePermissions')}</option>
          <option value="manage_permissions_revoke">{t('audit.revokeManagePermissions')}</option>
        </select>
      </div>

      {loading && <p className="audit-log-loading">{t('audit.loading')}</p>}

      {!loading && entries.length === 0 && <p className="audit-log-empty">{t('audit.empty')}</p>}

      <div className="audit-log-list">
        {entries.map((entry) => {
          const expanded = expandedId === entry.id;
          return (
            <div key={entry.id} className={'audit-log-row card' + (entry.action.includes('delete') ? ' danger' : '')}>
              <button type="button" className="audit-log-row-top" onClick={() => setExpandedId(expanded ? null : entry.id)}>
                <span className="audit-log-action">{t(`audit.action.${entry.action}`)}</span>
                <span className="audit-log-shop">
                  {entry.shop_name ||
                    (entry.action === 'shop_delete' || entry.action === 'shop_edit'
                      ? entry.after?.name || entry.before?.name
                      : null) ||
                    '—'}
                </span>
                <span className="audit-log-actor">{entry.actor_name || t('audit.unknown')}</span>
                <span className="audit-log-date">{entry.created_at}</span>
                <span className="audit-log-toggle">{expanded ? '▲' : '▼'}</span>
              </button>
              {expanded && <EntryDetail entry={entry} t={t} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
