import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import '../../styles/admin-users.css';

export default function AdminUsersPanel() {
  const { user: currentUser, can } = useAuth();
  const { t } = useLanguage();
  const STATUS_LABEL = { pending: t('permissions.statusPending'), approved: t('permissions.statusApproved'), rejected: t('permissions.statusRejected') };
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  function load() {
    setLoading(true);
    return api
      .adminListUsers()
      .then(setUsers)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleApprove(id) {
    setBusyId(id);
    setError(null);
    try {
      await api.adminApproveUser(id);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id) {
    setBusyId(id);
    setError(null);
    try {
      await api.adminRejectUser(id);
      await load();
    } catch (err) {
      setError(
        err.detail?.error === 'cannot_remove_last_permission_manager'
          ? t('adminUsers.errorCannotRejectLastMeta')
          : t('adminUsers.errorGeneric')
      );
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="admin-users-page loading">{t('adminUsers.loading')}</div>;

  const pending = users.filter((u) => u.status === 'pending');
  const active = users.filter((u) => u.status !== 'pending');

  return (
    <div className="admin-users-page">
      {error && <p className="admin-users-error">{error}</p>}

      {pending.length > 0 && (
        <section className="admin-users-section">
          <h2 className="admin-users-section-title">⏳ {t('adminUsers.pendingApproval')} ({pending.length})</h2>
          <div className="admin-users-list">
            {pending.map((u) => (
              <div key={u.id} className="admin-user-row card">
                <div className="admin-user-info">
                  <strong>{u.name}</strong>
                  <span dir="ltr">{u.contact}</span>
                  <span className="admin-user-date">{u.created_at}</span>
                </div>
                <div className="admin-user-actions">
                  <button className="ghost-btn" disabled={busyId === u.id} onClick={() => handleReject(u.id)}>
                    {t('adminUsers.reject')}
                  </button>
                  <button className="gold-btn" disabled={busyId === u.id} onClick={() => handleApprove(u.id)}>
                    {t('adminUsers.approve')}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {can('manage_permissions') && (
            <p className="settings-hint">
              {t('adminUsers.afterApprovalPrefix')}{' '}
              <Link to="/settings?tab=permissions">{t('adminUsers.managePermissionsLink')}</Link> — {t('adminUsers.afterApprovalSuffix')}
            </p>
          )}
        </section>
      )}

      <section className="admin-users-section">
        <h2 className="admin-users-section-title">{t('adminUsers.allAccounts')}</h2>
        <div className="admin-users-list">
          {active.map((u) => (
            <div key={u.id} className="admin-user-row card">
              <div className="admin-user-info">
                <strong>{u.name}</strong>
                <span dir="ltr">{u.contact}</span>
                <span className={'admin-user-status ' + u.status}>{STATUS_LABEL[u.status]}</span>
                <span className="admin-user-perm-count">{u.permissions?.length || 0} {t('adminUsers.permissionCount')}</span>
              </div>
              <div className="admin-user-actions">
                {can('manage_permissions') && (
                  <Link className="ghost-btn" to={`/settings?tab=permissions&user=${u.id}`}>
                    {t('adminUsers.permissionsLink')}
                  </Link>
                )}
                {u.status === 'approved' && u.id !== currentUser.id && (
                  <button className="ghost-btn" disabled={busyId === u.id} onClick={() => handleReject(u.id)}>
                    {t('adminUsers.revokeAccess')}
                  </button>
                )}
                {u.status === 'rejected' && (
                  <button className="gold-btn" disabled={busyId === u.id} onClick={() => handleApprove(u.id)}>
                    {t('adminUsers.reapprove')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
