import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { CHIME_PRESET_OPTIONS, previewChime } from '../../lib/celebration.js';
import { UNITS } from '../../lib/units.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import TargetsSection from './TargetsSection.jsx';
import '../../styles/settings.css';

const WA_STATUS_LABEL = {
  disconnected: 'settings.waDisconnected',
  initializing: 'settings.waInitializing',
  qr_pending: 'settings.waQrPending',
  connected: 'settings.waConnected',
  auth_failed: 'settings.waAuthFailed',
};

const SECTIONS = [
  { key: 'general', labelKey: 'settings.general' },
  { key: 'products', labelKey: 'settings.products' },
  { key: 'classification', labelKey: 'settings.classification' },
  { key: 'alerts', labelKey: 'settings.alerts' },
  { key: 'targets', labelKey: 'settings.targets' },
  { key: 'whatsapp', labelKey: 'settings.whatsapp' },
  { key: 'map', labelKey: 'settings.map' },
  { key: 'sound', labelKey: 'settings.sound' },
  { key: 'inventory', labelKey: 'settings.inventory' },
];

export default function GeneralSettingsPanel() {
  const { t, lang } = useLanguage();
  const [activeSection, setActiveSection] = useState('general');
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  const [products, setProducts] = useState([]);
  const [newProductName, setNewProductName] = useState('');
  const [newProductUnit, setNewProductUnit] = useState('كغم');

  const [recomputing, setRecomputing] = useState(false);
  const [recomputeResult, setRecomputeResult] = useState(null);

  const [waStatus, setWaStatus] = useState(null);
  const waPollRef = useRef(null);

  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getProducts(true).then(setProducts);
    refreshWaStatus();
    return () => clearInterval(waPollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refreshWaStatus() {
    api.getWhatsAppStatus().then((s) => {
      setWaStatus(s);
      const shouldPoll = s.status === 'initializing' || s.status === 'qr_pending';
      clearInterval(waPollRef.current);
      if (shouldPoll) {
        waPollRef.current = setInterval(refreshWaStatus, 3000);
      }
    });
  }

  async function connectWhatsApp() {
    await api.connectWhatsApp();
    refreshWaStatus();
  }

  async function disconnectWhatsApp() {
    await api.disconnectWhatsApp();
    refreshWaStatus();
  }

  async function recomputeClassifications() {
    setRecomputing(true);
    setRecomputeResult(null);
    try {
      const result = await api.recomputeClassifications();
      setRecomputeResult(result);
    } finally {
      setRecomputing(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const updated = await api.updateSettings(settings);
      setSettings(updated);
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function addProduct() {
    if (!newProductName.trim()) return;
    const p = await api.createProduct({ name: newProductName.trim(), unit: newProductUnit.trim() || null });
    setProducts((prev) => [...prev, p]);
    setNewProductName('');
  }

  async function toggleProduct(product) {
    const updated = await api.updateProduct(product.id, { active: !product.active });
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  async function removeProduct(product) {
    await api.deleteProduct(product.id);
    setProducts((prev) => prev.filter((p) => p.id !== product.id));
  }

  async function uploadLogo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoUploading(true);
    setLogoError(null);
    try {
      const { company_logo_url } = await api.uploadLogo(file);
      setSettings((s) => ({ ...s, company_logo_url }));
    } catch (err) {
      setLogoError(err.detail?.error || t('settings.logoUploadFailed'));
    } finally {
      setLogoUploading(false);
      e.target.value = '';
    }
  }

  if (!settings) return <div className="settings-page loading">{t('settings.loading')}</div>;

  // Every section's save button hits the same full-object PUT — matches the
  // pre-reorg layout, where every card independently triggered saveSettings().
  function renderSaveBar() {
    return (
      <div className="qof-actions">
        <button type="button" className="gold-btn" onClick={saveSettings} disabled={saving}>
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
        {savedNote && <span className="settings-saved-note">{t('settings.saved')}</span>}
      </div>
    );
  }

  return (
    <div className="settings-page settings-page-wide">
      <div className="settings-subnav-layout">
        <aside className="card settings-subnav">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={'settings-subnav-item' + (activeSection === s.key ? ' active' : '')}
              onClick={() => setActiveSection(s.key)}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </aside>

        <div className="settings-subnav-content">
          {activeSection === 'general' && (
            <section className="card settings-section">
              <h2>{t('settings.general')}</h2>
              <div className="settings-grid">
                <label>
                  {t('settings.companyName')}
                  <input
                    type="text"
                    value={settings.company_name}
                    onChange={(e) => setSettings({ ...settings, company_name: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.defaultLanguage')}
                  <select
                    value={settings.default_language}
                    onChange={(e) => setSettings({ ...settings, default_language: e.target.value })}
                  >
                    <option value="ar">{t('settings.arabic')}</option>
                    <option value="en">{t('settings.english')}</option>
                  </select>
                </label>
                <label>
                  {t('settings.exchangeRate')}
                  <input
                    type="number"
                    step="0.01"
                    placeholder={t('settings.exchangePlaceholder')}
                    value={settings.usd_exchange_rate}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        usd_exchange_rate: e.target.value,
                        usd_exchange_rate_source: 'manual',
                        usd_exchange_rate_updated_at: new Date().toISOString(),
                      })
                    }
                  />
                </label>
              </div>
              <p className="settings-hint">
                {settings.usd_exchange_rate
                  ? `${t('settings.rateUpdated')}: ${new Date(settings.usd_exchange_rate_updated_at).toLocaleString(lang === 'ar' ? 'ar-SY' : 'en-US')} — ${
                      settings.usd_exchange_rate_source === 'manual' ? t('settings.manualUpdate') : t('settings.dailyUpdate')
                    }`
                  : t('settings.rateMissing')}
              </p>

              <div className="settings-logo-row">
                <div className="settings-logo-preview">
                  {settings.company_logo_url ? <img src={settings.company_logo_url} alt={t('settings.logoAlt')} /> : <img className="atlas-settings-wordmark" src="/atlas-icon-mark.png" alt="Atlas" />}
                </div>
                <div className="settings-logo-controls">
                  <label className="ghost-btn settings-logo-upload-btn">
                    {logoUploading ? t('settings.logoUploading') : t('settings.logoUpload')}
                    <input
                      type="file"
                      accept=".png,.jpg,.jpeg,.webp,.svg"
                      hidden
                      onChange={uploadLogo}
                      disabled={logoUploading}
                    />
                  </label>
                  <p className="settings-hint">{t('settings.logoHint')}</p>
                  {logoError && <p className="settings-error">{logoError}</p>}
                </div>
              </div>

              {renderSaveBar()}
            </section>
          )}

          {activeSection === 'products' && (
            <section className="card settings-section">
              <h2>{t('settings.productList')}</h2>
              <div className="settings-product-add">
                <input
                  placeholder={t('settings.productName')}
                  value={newProductName}
                  onChange={(e) => setNewProductName(e.target.value)}
                />
                <input
                  placeholder={t('settings.unit')}
                  value={newProductUnit}
                  onChange={(e) => setNewProductUnit(e.target.value)}
                  className="settings-unit-input"
                />
                <button type="button" className="gold-btn" onClick={addProduct}>
                  {t('settings.add')}
                </button>
              </div>
              <div className="settings-product-list">
                {products.map((p) => (
                  <div key={p.id} className={'settings-product-row' + (p.active ? '' : ' inactive')}>
                    <span>
                      {p.name} {p.unit && <em>/ {p.unit}</em>}
                    </span>
                    <div className="settings-product-actions">
                      <button type="button" className="ghost-btn" onClick={() => toggleProduct(p)}>
                        {p.active ? t('settings.hide') : t('settings.show')}
                      </button>
                      <button type="button" className="ghost-btn danger" onClick={() => removeProduct(p)}>
                        {t('settings.remove')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {activeSection === 'classification' && (
            <section className="card settings-section">
              <h2>{t('settings.classificationTitle')}</h2>
              <p className="settings-hint">{t('settings.classificationHint')}</p>
              <div className="settings-grid">
                <label>
                  {t('settings.classificationWindowDays')}
                  <input
                    type="number"
                    value={settings.classification_window_days}
                    onChange={(e) => setSettings({ ...settings, classification_window_days: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.classificationSalesAMin')}
                  <input
                    type="number"
                    placeholder={t('settings.notSet')}
                    value={settings.classification_sales_a_min}
                    onChange={(e) => setSettings({ ...settings, classification_sales_a_min: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.classificationSalesBMin')}
                  <input
                    type="number"
                    placeholder={t('settings.notSet')}
                    value={settings.classification_sales_b_min}
                    onChange={(e) => setSettings({ ...settings, classification_sales_b_min: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.classificationRegularityAMax')}
                  <input
                    type="number"
                    step="0.05"
                    placeholder={t('settings.notSet')}
                    value={settings.classification_regularity_cv_a_max}
                    onChange={(e) => setSettings({ ...settings, classification_regularity_cv_a_max: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.classificationRegularityBMax')}
                  <input
                    type="number"
                    step="0.05"
                    placeholder={t('settings.notSet')}
                    value={settings.classification_regularity_cv_b_max}
                    onChange={(e) => setSettings({ ...settings, classification_regularity_cv_b_max: e.target.value })}
                  />
                </label>
              </div>
              <p className="settings-hint">
                {t('settings.baseLocationLabel')}:{' '}
                {settings.base_lat && settings.base_lng
                  ? `${settings.base_lat}, ${settings.base_lng}`
                  : t('settings.baseLocationMissing')}
              </p>
              {renderSaveBar()}
              <div className="qof-actions">
                <button type="button" className="ghost-btn" onClick={recomputeClassifications} disabled={recomputing}>
                  {recomputing ? t('settings.recomputing') : t('settings.recomputeClassifications')}
                </button>
                {recomputeResult && (
                  <span className="settings-saved-note">
                    {t('settings.recomputeDone')}: A={recomputeResult.counts.A} · B={recomputeResult.counts.B} · C={recomputeResult.counts.C} ·
                    {t('settings.unclassified')}={recomputeResult.counts.unclassified}
                  </span>
                )}
              </div>
            </section>
          )}

          {activeSection === 'alerts' && (
            <section className="card settings-section">
              <h2>{t('settings.alertsTitle')}</h2>
              <div className="settings-grid">
                <label>
                  {t('settings.debtThreshold')}
                  <input
                    type="number"
                    value={settings.debt_threshold}
                    onChange={(e) => setSettings({ ...settings, debt_threshold: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.orderOverdueDays')}
                  <input
                    type="number"
                    value={settings.order_overdue_days}
                    onChange={(e) => setSettings({ ...settings, order_overdue_days: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.attentionMultiplier')}
                  <input
                    type="number"
                    step="0.1"
                    value={settings.attention_overdue_multiplier}
                    onChange={(e) => setSettings({ ...settings, attention_overdue_multiplier: e.target.value })}
                  />
                </label>
              </div>
              {renderSaveBar()}
            </section>
          )}

          {activeSection === 'targets' && <TargetsSection />}

          {activeSection === 'whatsapp' && (
            <section className="card settings-section">
              <h2>{t('settings.whatsappTitle')}</h2>
              <p className="settings-hint">{t('settings.whatsappHint')}</p>
              <div className="settings-grid">
                <label>
                  {t('settings.whatsappNumberLabel')}
                  <input
                    type="text"
                    dir="ltr"
                    placeholder="963xxxxxxxxx"
                    value={settings.manager_whatsapp_number}
                    onChange={(e) => setSettings({ ...settings, manager_whatsapp_number: e.target.value })}
                  />
                </label>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.whatsapp_customer_notify_enabled === '1'}
                    onChange={(e) =>
                      setSettings({ ...settings, whatsapp_customer_notify_enabled: e.target.checked ? '1' : '0' })
                    }
                  />
                  {t('settings.whatsappCustomerNotifyLabel')}
                </label>
                <p className="settings-hint">{t('settings.whatsappCustomerNotifyHint')}</p>
              </div>
              {renderSaveBar()}

              {waStatus && (
                <div className="wa-status-box">
                  <div className="wa-status-row">
                    <span>{t('settings.connectionStatus')}:</span>
                    <span className={'wa-status-pill wa-' + waStatus.status}>
                      {WA_STATUS_LABEL[waStatus.status] ? t(WA_STATUS_LABEL[waStatus.status]) : waStatus.status}
                    </span>
                    {waStatus.connectedNumber && <span dir="ltr">({waStatus.connectedNumber})</span>}
                  </div>

                  {waStatus.status === 'qr_pending' && waStatus.qr && (
                    <div className="wa-qr-box">
                      <img src={waStatus.qr} alt="WhatsApp QR" />
                      <p className="settings-hint">{t('settings.scanQrHint')}</p>
                    </div>
                  )}

                  <div className="qof-actions">
                    {waStatus.status === 'connected' ? (
                      <button type="button" className="ghost-btn danger" onClick={disconnectWhatsApp}>
                        {t('settings.disconnect')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={waStatus.status === 'initializing'}
                        onClick={connectWhatsApp}
                      >
                        {waStatus.status === 'initializing' ? t('settings.waInitializing') : t('settings.connectWhatsapp')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {activeSection === 'map' && (
            <section className="card settings-section">
              <h2>{t('settings.map')}</h2>
              <div className="settings-grid">
                <label>
                  {t('settings.mapDefaultLayerLabel')}
                  <select
                    value={settings.map_default_layer}
                    onChange={(e) => setSettings({ ...settings, map_default_layer: e.target.value })}
                  >
                    <option value="flat">{t('settings.mapLayerFlat')}</option>
                    <option value="satellite">{t('settings.mapLayerSatellite')}</option>
                  </select>
                </label>
                <label>
                  {t('settings.mapDefaultZoomLabel')}
                  <input
                    type="number"
                    min="1"
                    max="18"
                    value={settings.map_default_zoom}
                    onChange={(e) => setSettings({ ...settings, map_default_zoom: e.target.value })}
                  />
                </label>
              </div>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.map_clustering_enabled === '1'}
                  onChange={(e) => setSettings({ ...settings, map_clustering_enabled: e.target.checked ? '1' : '0' })}
                />
                {t('settings.mapClusteringLabel')}
              </label>
              {renderSaveBar()}
            </section>
          )}

          {activeSection === 'sound' && (
            <section className="card settings-section">
              <h2>{t('settings.sound')}</h2>
              <div className="settings-grid">
                <label>
                  {t('settings.soundVolumeLabel')}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={settings.sound_volume}
                    onChange={(e) => setSettings({ ...settings, sound_volume: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.soundChimeLabel')}
                  <select
                    value={settings.sound_chime_preset}
                    onChange={(e) => setSettings({ ...settings, sound_chime_preset: e.target.value })}
                  >
                    {CHIME_PRESET_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {t(opt.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="qof-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => previewChime(settings.sound_chime_preset)}
                >
                  {t('settings.soundPreview')}
                </button>
              </div>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.sound_default_muted !== '1'}
                  onChange={(e) => setSettings({ ...settings, sound_default_muted: e.target.checked ? '0' : '1' })}
                />
                {t('settings.soundDefaultOnLabel')}
              </label>
              {renderSaveBar()}
            </section>
          )}

          {activeSection === 'inventory' && (
            <section className="card settings-section">
              <h2>{t('settings.inventory')}</h2>
              <div className="settings-grid">
                <label>
                  {t('settings.inventoryMinQtyLabel')}
                  <input
                    type="number"
                    step="0.01"
                    value={settings.inventory_default_min_quantity}
                    onChange={(e) => setSettings({ ...settings, inventory_default_min_quantity: e.target.value })}
                  />
                </label>
                <label>
                  {t('settings.inventoryDefaultUnitLabel')}
                  <select
                    value={settings.inventory_default_unit}
                    onChange={(e) => setSettings({ ...settings, inventory_default_unit: e.target.value })}
                  >
                    {UNITS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="settings-hint">{t('settings.inventoryHint')}</p>
              {renderSaveBar()}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
