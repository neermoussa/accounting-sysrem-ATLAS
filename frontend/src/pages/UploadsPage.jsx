import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import AminUploadPanel from './AminUploadPanel.jsx';
import ShopImportPanel from './ShopImportPanel.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/import.css';
import '../styles/uploads.css';

export default function UploadsPage() {
  const { can } = useAuth();
  const { t } = useLanguage();
  const TABS = [
    { key: 'amin', label: t('uploadsPage.aminTab'), permission: 'import_amin' },
    { key: 'shops', label: t('uploadsPage.shopsTab'), permission: 'manage_shops' },
  ];
  const availableTabs = TABS.filter((tab) => can(tab.permission));
  const [activeTab, setActiveTab] = useState(availableTabs[0]?.key);

  return (
    <div className="import-page">
      <h1 className="import-title">{t('uploadsPage.title')}</h1>

      {availableTabs.length > 1 && (
        <div className="uploads-tabs">
          {availableTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={'uploads-tab' + (activeTab === tab.key ? ' active' : '')}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {activeTab === 'amin' && <AminUploadPanel />}
      {activeTab === 'shops' && <ShopImportPanel />}
    </div>
  );
}
