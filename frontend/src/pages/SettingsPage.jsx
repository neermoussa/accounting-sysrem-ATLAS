import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import GeneralSettingsPanel from './settings/GeneralSettingsPanel.jsx';
import AdminUsersPanel from './settings/AdminUsersPanel.jsx';
import PermissionsPanel from './settings/PermissionsPanel.jsx';
import AuditLogPanel from './settings/AuditLogPanel.jsx';
import '../styles/import.css';
import '../styles/uploads.css';

// Users/Permissions/Audit-log used to be separate sidebar pages — folded in
// here as tabs since they're all "administer the account/system" concerns.
// Each tab still checks its own permission independently (not just
// manage_settings for the page as a whole): in this app's actual data only
// the admin template grants all four together, so in practice this reads
// as "admin only" without hard-coding that assumption into the UI.
const TABS = [
  { key: 'general', labelKey: 'settings.tabGeneral', permission: null },
  { key: 'users', labelKey: 'settings.tabUsers', permission: 'manage_users' },
  { key: 'permissions', labelKey: 'settings.tabPermissions', permission: 'manage_permissions' },
  { key: 'audit', labelKey: 'settings.tabAudit', permission: 'view_audit_log' },
];

export default function SettingsPage() {
  const { can } = useAuth();
  const { t, lang } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const availableTabs = TABS.filter((t) => !t.permission || can(t.permission));
  const requestedTab = searchParams.get('tab');
  const activeTab = availableTabs.find((t) => t.key === requestedTab)?.key || availableTabs[0]?.key;

  function switchTab(key) {
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div className="settings-page settings-workspace" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <header className="settings-workspace-header">
        <div>
          <span className="settings-workspace-kicker">{t('settings.workspaceKicker')}</span>
          <h1>{t('settings.pageTitle')}</h1>
          <p>{t('settings.workspaceSubtitle')}</p>
        </div>
        <div className="settings-header-status"><span className="settings-status-dot" />{t('settings.managerAccess')}</div>
      </header>

      {availableTabs.length > 1 ? (
        <div className="settings-subnav-layout">
          <aside className="card settings-subnav">
            {availableTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={'settings-subnav-item' + (activeTab === tab.key ? ' active' : '')}
                onClick={() => switchTab(tab.key)}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </aside>
          <div className="settings-subnav-content">
            {activeTab === 'general' && <GeneralSettingsPanel />}
            {activeTab === 'users' && <AdminUsersPanel />}
            {activeTab === 'permissions' && <PermissionsPanel />}
            {activeTab === 'audit' && <AuditLogPanel />}
          </div>
        </div>
      ) : (
        <>
          {activeTab === 'general' && <GeneralSettingsPanel />}
          {activeTab === 'users' && <AdminUsersPanel />}
          {activeTab === 'permissions' && <PermissionsPanel />}
          {activeTab === 'audit' && <AuditLogPanel />}
        </>
      )}
    </div>
  );
}
