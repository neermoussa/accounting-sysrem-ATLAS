import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { MANAGE_PERMISSIONS_LABEL } from '../../auth/permissions.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import '../../styles/permissions.css';

export default function PermissionsPanel() {
  const { user: currentUser, refresh } = useAuth();
  const { t } = useLanguage();
  const STATUS_LABEL = { pending: t('permissions.statusPending'), approved: t('permissions.statusApproved'), rejected: t('permissions.statusRejected') };
  const [searchParams, setSearchParams] = useSearchParams();
  const [catalog, setCatalog] = useState(null);
  const [users, setUsers] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [draft, setDraft] = useState([]); // permission keys currently checked for the selected user
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [newTemplateName, setNewTemplateName] = useState('');

  function loadAll() {
    setLoading(true);
    return Promise.all([api.getPermissionsCatalog(), api.getPermissionsUsers(), api.getPermissionTemplates()])
      .then(([catalogData, usersData, templatesData]) => {
        setCatalog(catalogData);
        setUsers(usersData);
        setTemplates(templatesData);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const fromQuery = searchParams.get('user');
    if (fromQuery) setSelectedUserId(Number(fromQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) || null, [users, selectedUserId]);

  useEffect(() => {
    if (selectedUser) setDraft(selectedUser.permissions.filter((p) => p !== 'manage_permissions'));
  }, [selectedUser]);

  // Merges into the existing query string (which also carries ?tab=) rather
  // than replacing it outright — this panel only ever renders while
  // tab=permissions anyway, so re-asserting that here keeps the URL correct
  // without needing the parent tab container involved in user selection.
  function selectUser(id) {
    setSelectedUserId(id);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', 'permissions');
        next.set('user', String(id));
        return next;
      },
      { replace: true }
    );
    setError(null);
  }

  function toggleDraft(key) {
    setDraft((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));
  }

  async function handleSave() {
    if (!selectedUser) return;
    setSaving(true);
    setError(null);
    try {
      await api.setUserPermissions(selectedUser.id, draft);
      await loadAll();
      if (selectedUser.id === currentUser.id) await refresh();
    } catch (err) {
      setError(t('permissions.errorSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleApplyTemplate(templateId) {
    if (!selectedUser || !templateId) return;
    setSaving(true);
    setError(null);
    try {
      await api.applyPermissionTemplate(selectedUser.id, templateId);
      await loadAll();
      if (selectedUser.id === currentUser.id) await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleManagePermissions(grant) {
    if (!selectedUser) return;
    if (
      grant &&
      !window.confirm(
        `${t('permissions.confirmGrantMeta')} "${selectedUser.name}" ${t('permissions.confirmGrantMetaSuffix')}`
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.setManagePermissions(selectedUser.id, grant);
      await loadAll();
      if (selectedUser.id === currentUser.id) await refresh();
    } catch (err) {
      setError(
        err.detail?.error === 'cannot_remove_last_permission_manager'
          ? t('permissions.errorCannotRemoveLast')
          : t('permissions.errorGeneric')
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAsTemplate() {
    const name = newTemplateName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      await api.createPermissionTemplate({ name, permissions: draft });
      setNewTemplateName('');
      await loadAll();
    } catch (err) {
      setError(err.detail?.error === 'template_name_exists' ? t('permissions.errorTemplateExists') : t('permissions.errorGeneric'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTemplate(id) {
    if (!window.confirm(t('permissions.confirmDeleteTemplate'))) return;
    await api.deletePermissionTemplate(id);
    await loadAll();
  }

  if (loading) return <div className="permissions-page loading">{t('permissions.loading')}</div>;

  const hasMetaPermission = selectedUser?.permissions.includes('manage_permissions');
  const isLastMetaHolder =
    hasMetaPermission && users.filter((u) => u.permissions.includes('manage_permissions')).length <= 1;

  return (
    <div className="permissions-page">
      <p className="settings-hint">{t('permissions.pageHint')}</p>

      {error && <p className="admin-users-error">{error}</p>}

      <div className="permissions-layout">
        <aside className="card permissions-user-list">
          <h2>{t('permissions.users')}</h2>
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              className={'permissions-user-row' + (u.id === selectedUserId ? ' active' : '')}
              onClick={() => selectUser(u.id)}
            >
              <span className="permissions-user-name">
                {u.name}
                {u.permissions.includes('manage_permissions') && <span className="shield-badge">🛡</span>}
              </span>
              <span dir="ltr" className="permissions-user-contact">{u.contact}</span>
              <span className={'admin-user-status ' + u.status}>{STATUS_LABEL[u.status]}</span>
            </button>
          ))}
        </aside>

        <section className="permissions-detail">
          {!selectedUser && <div className="card permissions-empty">{t('permissions.selectUserHint')}</div>}

          {selectedUser && (
            <>
              <div className="card permissions-detail-header">
                <div>
                  <h2>{selectedUser.name}</h2>
                  <span dir="ltr" className="permissions-user-contact">{selectedUser.contact}</span>
                </div>
                <div className="permissions-template-apply">
                  <select
                    defaultValue=""
                    disabled={saving}
                    onChange={(e) => {
                      if (e.target.value) handleApplyTemplate(Number(e.target.value));
                      e.target.value = '';
                    }}
                  >
                    <option value="" disabled>
                      {t('permissions.applyTemplatePlaceholder')}
                    </option>
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="card permissions-grid-card">
                <h3>{t('permissions.permissionsTitle')}</h3>
                <div className="permissions-grid">
                  {catalog.permissions.map((p) => (
                    <label key={p.key} className="permissions-checkbox">
                      <input type="checkbox" checked={draft.includes(p.key)} onChange={() => toggleDraft(p.key)} />
                      {p.label}
                    </label>
                  ))}
                </div>
                <div className="permissions-save-row">
                  <button type="button" className="gold-btn" disabled={saving} onClick={handleSave}>
                    {saving ? t('permissions.saving') : t('permissions.savePermissions')}
                  </button>
                </div>
              </div>

              <div className="card permissions-meta-card">
                <h3>{t('permissions.metaTitle')}</h3>
                <p className="settings-hint">{MANAGE_PERMISSIONS_LABEL}</p>
                <label className="permissions-checkbox meta">
                  <input
                    type="checkbox"
                    checked={!!hasMetaPermission}
                    disabled={saving || (hasMetaPermission && isLastMetaHolder)}
                    onChange={(e) => handleToggleManagePermissions(e.target.checked)}
                  />
                  {t('permissions.hasMetaPermission')}
                </label>
                {hasMetaPermission && isLastMetaHolder && (
                  <p className="settings-hint">{t('permissions.lastMetaHolderNote')}</p>
                )}
              </div>

              <div className="card permissions-save-template-card">
                <h3>{t('permissions.saveAsTemplateTitle')}</h3>
                <div className="permissions-save-template-row">
                  <input
                    placeholder={t('permissions.templateNamePlaceholder')}
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                  />
                  <button type="button" className="ghost-btn" disabled={saving || !newTemplateName.trim()} onClick={handleSaveAsTemplate}>
                    {t('permissions.saveAsTemplate')}
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="card permissions-templates-card">
            <h3>{t('permissions.readyTemplates')}</h3>
            <div className="permissions-templates-list">
              {templates.map((tpl) => (
                <div key={tpl.id} className="permissions-template-row">
                  <div>
                    <strong>{tpl.name}</strong>
                    <span className="settings-hint"> — {tpl.permissions.length} {t('permissions.permissionCount')}</span>
                  </div>
                  <button type="button" className="ghost-btn danger" onClick={() => handleDeleteTemplate(tpl.id)}>
                    {t('permissions.delete')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
