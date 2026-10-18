import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/settings.css';
import '../styles/wizard.css';

const STEPS = [
  'profile', 'identity', 'modules', 'users', 'warehouses', 'vehicles', 'reps', 'custody', 'whatsapp',
];

const MODULE_LABELS = {
  reps: 'wizard.module.reps',
  customers: 'wizard.module.customers',
  warehouses: 'wizard.module.warehouses',
  delivery: 'wizard.module.delivery',
  collections: 'wizard.module.collections',
  whatsapp: 'wizard.module.whatsapp',
  production: 'wizard.module.production',
  reports: 'wizard.module.reports',
  ai: 'wizard.module.ai',
};

// The wizard a new company's manager walks through right after creating
// their account (see CreateCompanyPage.jsx / App.jsx routing: any company
// with setup_completed === 0 is routed here). Every step's data is saved as
// a draft the moment the manager moves on — closing the tab mid-way and
// coming back later resumes exactly where they left off (see
// company_setup_state on the backend).
export default function StartupSetupWizard() {
  const { t } = useLanguage();
  const { refreshCompany } = useAuth();
  const [company, setCompany] = useState(null);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSetup().then(({ company, setup }) => {
      setCompany(company);
      setCompletedSteps(setup.completed_steps || []);
      const idx = STEPS.indexOf(setup.current_step);
      setStepIndex(idx === -1 ? 0 : idx);
      setLoading(false);
    });
  }, []);

  function markStepDone(step) {
    setCompletedSteps((prev) => (prev.includes(step) ? prev : [...prev, step]));
  }

  async function saveStep(stepData, { andComplete = false } = {}) {
    setSaving(true);
    const step = STEPS[stepIndex];
    const nextCompleted = completedSteps.includes(step) ? completedSteps : [...completedSteps, step];
    const nextStepIndex = Math.min(stepIndex + 1, STEPS.length - 1);
    try {
      const res = await api.saveSetup({
        currentStep: andComplete ? step : STEPS[nextStepIndex],
        completedSteps: nextCompleted,
        stepData,
      });
      setCompany(res.company);
      setCompletedSteps(res.setup.completed_steps);
      if (!andComplete) setStepIndex(nextStepIndex);
    } finally {
      setSaving(false);
    }
  }

  async function handleFinish() {
    setSaving(true);
    try {
      await api.completeSetup();
      await refreshCompany();
    } finally {
      setSaving(false);
    }
  }

  function skipStep() {
    markStepDone(STEPS[stepIndex]);
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  if (loading || !company) return <div className="finance-loading">{t('common.loading')}</div>;

  const step = STEPS[stepIndex];

  return (
    <div className="wizard-shell">
      <header className="wizard-header">
        <h1>{t('wizard.title')}</h1>
        <p>{t('wizard.subtitle')}</p>
      </header>

      <nav className="wizard-steps">
        {STEPS.map((s, i) => (
          <button
            type="button"
            key={s}
            className={
              'wizard-step-btn' +
              (i === stepIndex ? ' active' : '') +
              (completedSteps.includes(s) ? ' done' : '')
            }
            onClick={() => setStepIndex(i)}
          >
            <span className="wizard-step-num">{completedSteps.includes(s) ? '✓' : i + 1}</span>
            {t(`wizard.step.${s}`)}
          </button>
        ))}
      </nav>

      <div className="card wizard-body">
        {step === 'profile' && <ProfileStep company={company} onSave={saveStep} saving={saving} t={t} />}
        {step === 'identity' && <IdentityStep company={company} onSave={saveStep} onSkip={skipStep} saving={saving} t={t} />}
        {step === 'modules' && <ModulesStep company={company} onSave={saveStep} onSkip={skipStep} saving={saving} t={t} />}
        {step === 'users' && <UsersStep onSave={saveStep} onSkip={skipStep} saving={saving} t={t} />}
        {step === 'warehouses' && <WarehousesStep onSave={saveStep} onSkip={skipStep} saving={saving} t={t} />}
        {step === 'vehicles' && <VehiclesStep onSave={saveStep} onSkip={skipStep} saving={saving} t={t} />}
        {step === 'reps' && <RepsStep onSave={saveStep} onSkip={skipStep} saving={saving} t={t} />}
        {step === 'custody' && <CustodyStep company={company} onSave={saveStep} onSkip={skipStep} saving={saving} t={t} />}
        {step === 'whatsapp' && <WhatsappStep onFinish={handleFinish} onSkip={handleFinish} saving={saving} t={t} />}
      </div>
    </div>
  );
}

function StepActions({ onSkip, saveLabel, t, disabled }) {
  return (
    <div className="wizard-actions">
      {onSkip && (
        <button type="button" className="ghost-btn" onClick={onSkip}>
          {t('wizard.skipForNow')}
        </button>
      )}
      <button type="submit" className="gold-btn" disabled={disabled}>
        {saveLabel || t('wizard.saveAndNext')}
      </button>
    </div>
  );
}

// ---- Step 1: company profile (required) ----
function ProfileStep({ company, onSave, saving, t }) {
  const [name, setName] = useState(company.name || '');
  const [contactPhone, setContactPhone] = useState(company.contact_phone || '');
  const [contactEmail, setContactEmail] = useState(company.contact_email || '');
  const [address, setAddress] = useState(company.address || '');
  const [currency, setCurrency] = useState(company.currency || 'USD');
  const [priceDisplayMode, setPriceDisplayMode] = useState(company.price_display_mode || 'with_tax');
  const [branches, setBranches] = useState(company.branches?.length ? company.branches : ['']);

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      contact_phone: contactPhone,
      contact_email: contactEmail,
      address,
      currency,
      price_display_mode: priceDisplayMode,
      branches: branches.map((b) => b.trim()).filter(Boolean),
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>{t('wizard.step.profile')}</h2>
      <div className="settings-grid">
        <label>
          {t('wizard.profile.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          {t('wizard.profile.phone')}
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} dir="ltr" />
        </label>
        <label>
          {t('wizard.profile.email')}
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} dir="ltr" />
        </label>
        <label>
          {t('wizard.profile.address')}
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          {t('wizard.profile.currency')}
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD</option>
            <option value="SYP">SYP</option>
            <option value="EUR">EUR</option>
          </select>
        </label>
        <label>
          {t('wizard.profile.priceDisplay')}
          <select value={priceDisplayMode} onChange={(e) => setPriceDisplayMode(e.target.value)}>
            <option value="with_tax">{t('wizard.profile.withTax')}</option>
            <option value="without_tax">{t('wizard.profile.withoutTax')}</option>
          </select>
        </label>
      </div>
      <h3 className="wizard-subheading">{t('wizard.profile.branches')}</h3>
      {branches.map((b, i) => (
        <div className="wizard-inline-row" key={i}>
          <input
            value={b}
            placeholder={t('wizard.profile.branchPlaceholder')}
            onChange={(e) => setBranches((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))}
          />
          <button type="button" className="ghost-btn" onClick={() => setBranches((prev) => prev.filter((_, idx) => idx !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="ghost-btn" onClick={() => setBranches((prev) => [...prev, ''])}>
        + {t('wizard.profile.addBranch')}
      </button>
      <StepActions t={t} disabled={saving} />
    </form>
  );
}

// ---- Step 2: brand identity ----
function IdentityStep({ company, onSave, onSkip, saving, t }) {
  const [brandColor, setBrandColor] = useState(company.brand_color || '#0b0f14');
  const [docsInfo, setDocsInfo] = useState(company.documents_info?.footer_note || '');
  const [waInfo, setWaInfo] = useState(company.whatsapp_messages_info?.signature || '');
  const ALLOWED_COLORS = ['#1857c9', '#123f8e', '#2e6fe0', '#0b0f14', '#4d8cf0', '#0b3d91'];

  function handleSubmit(e) {
    e.preventDefault();
    onSave({
      brand_color: brandColor,
      documents_info: { footer_note: docsInfo },
      whatsapp_messages_info: { signature: waInfo },
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>{t('wizard.step.identity')}</h2>
      <p className="settings-hint">{t('wizard.identity.hint')}</p>
      <h3 className="wizard-subheading">{t('wizard.identity.color')}</h3>
      <div className="wizard-color-row">
        {ALLOWED_COLORS.map((c) => (
          <button
            type="button"
            key={c}
            className={'wizard-color-swatch' + (brandColor === c ? ' active' : '')}
            style={{ background: c }}
            onClick={() => setBrandColor(c)}
            aria-label={c}
          />
        ))}
      </div>
      <div className="settings-grid">
        <label>
          {t('wizard.identity.documentsFooter')}
          <input value={docsInfo} onChange={(e) => setDocsInfo(e.target.value)} />
        </label>
        <label>
          {t('wizard.identity.whatsappSignature')}
          <input value={waInfo} onChange={(e) => setWaInfo(e.target.value)} />
        </label>
      </div>
      <StepActions onSkip={onSkip} t={t} disabled={saving} />
    </form>
  );
}

// ---- Step 3: modules ----
function ModulesStep({ company, onSave, onSkip, saving, t }) {
  const [modules, setModules] = useState(company.modules || {});

  function toggle(key) {
    setModules((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    await api.updateModules(modules);
    onSave({});
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>{t('wizard.step.modules')}</h2>
      <p className="settings-hint">{t('wizard.modules.hint')}</p>
      <div className="wizard-modules-grid">
        {Object.entries(MODULE_LABELS).map(([key, labelKey]) => (
          <label className="settings-checkbox-row wizard-module-row" key={key}>
            <input type="checkbox" checked={modules[key] !== false} onChange={() => toggle(key)} />
            {t(labelKey)}
          </label>
        ))}
      </div>
      <StepActions onSkip={onSkip} t={t} disabled={saving} />
    </form>
  );
}

// ---- Step 4: users & roles ----
function UsersStep({ onSave, onSkip, saving, t }) {
  const [templates, setTemplates] = useState([]);
  const [users, setUsers] = useState([]);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getPermissionTemplates().then(setTemplates).catch(() => {});
    api.adminListUsers().then(setUsers).catch(() => {});
  }, []);

  async function addUser(e) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !contact.trim() || !password) return;
    try {
      const created = await api.createStaffUser({ name: name.trim(), contact: contact.trim(), password });
      if (templateId) await api.applyPermissionTemplate(created.id, templateId);
      setUsers((prev) => [...prev, created]);
      setName('');
      setContact('');
      setPassword('');
    } catch (err) {
      setError(err.detail?.error || 'error');
    }
  }

  return (
    <div>
      <h2>{t('wizard.step.users')}</h2>
      <p className="settings-hint">{t('wizard.users.hint')}</p>
      <ul className="wizard-simple-list">
        {users.map((u) => (
          <li key={u.id}>{u.name} — <span dir="ltr">{u.contact}</span></li>
        ))}
      </ul>
      <form onSubmit={addUser} className="wizard-inline-form">
        <input placeholder={t('wizard.users.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder={t('wizard.users.contact')} value={contact} onChange={(e) => setContact(e.target.value)} dir="ltr" />
        <input
          placeholder={t('wizard.users.password')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">{t('wizard.users.chooseRole')}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>
        <button type="submit" className="gold-btn">
          + {t('wizard.users.add')}
        </button>
      </form>
      {error && <p className="auth-error">{error}</p>}
      <StepActions onSkip={onSkip} t={t} disabled={saving} saveLabel={t('wizard.saveAndNext')} />
      <button type="button" className="gold-btn wizard-standalone-next" onClick={() => onSave({})}>
        {t('wizard.next')}
      </button>
    </div>
  );
}

// ---- Step 5: warehouses ----
function WarehousesStep({ onSave, onSkip, saving, t }) {
  const [list, setList] = useState([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('factory');

  useEffect(() => {
    api.getWarehouses().then(setList);
  }, []);

  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const created = await api.addWarehouse({ name: name.trim(), kind });
    setList((prev) => [...prev, created]);
    setName('');
  }
  async function remove(id) {
    await api.deleteWarehouse(id);
    setList((prev) => prev.filter((w) => w.id !== id));
  }

  return (
    <div>
      <h2>{t('wizard.step.warehouses')}</h2>
      <ul className="wizard-simple-list">
        {list.map((w) => (
          <li key={w.id}>
            {w.name} <span className="wizard-tag">{t(`wizard.warehouseKind.${w.kind}`)}</span>
            <button type="button" className="ghost-btn" onClick={() => remove(w.id)}>×</button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="wizard-inline-form">
        <input placeholder={t('wizard.warehouses.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="factory">{t('wizard.warehouseKind.factory')}</option>
          <option value="car">{t('wizard.warehouseKind.car')}</option>
          <option value="other">{t('wizard.warehouseKind.other')}</option>
        </select>
        <button type="submit" className="gold-btn">+ {t('wizard.warehouses.add')}</button>
      </form>
      <StepActions onSkip={onSkip} t={t} disabled={saving} />
      <button type="button" className="gold-btn wizard-standalone-next" onClick={() => onSave({})}>
        {t('wizard.next')}
      </button>
    </div>
  );
}

// ---- Step 6: vehicles ----
function VehiclesStep({ onSave, onSkip, saving, t }) {
  const [list, setList] = useState([]);
  const [label, setLabel] = useState('');

  useEffect(() => {
    api.getVehicles().then(setList);
  }, []);

  async function add(e) {
    e.preventDefault();
    if (!label.trim()) return;
    const created = await api.addVehicle({ label: label.trim() });
    setList((prev) => [...prev, { ...created, reps: [] }]);
    setLabel('');
  }
  async function remove(id) {
    await api.deleteVehicle(id);
    setList((prev) => prev.filter((v) => v.id !== id));
  }

  return (
    <div>
      <h2>{t('wizard.step.vehicles')}</h2>
      <ul className="wizard-simple-list">
        {list.map((v) => (
          <li key={v.id}>
            {v.label}
            <button type="button" className="ghost-btn" onClick={() => remove(v.id)}>×</button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="wizard-inline-form">
        <input placeholder={t('wizard.vehicles.label')} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="gold-btn">+ {t('wizard.vehicles.add')}</button>
      </form>
      <p className="settings-hint">{t('wizard.vehicles.linkRepsHint')}</p>
      <StepActions onSkip={onSkip} t={t} disabled={saving} />
      <button type="button" className="gold-btn wizard-standalone-next" onClick={() => onSave({})}>
        {t('wizard.next')}
      </button>
    </div>
  );
}

// ---- Step 7: reps (link to vehicles) ----
function RepsStep({ onSave, onSkip, saving, t }) {
  const [users, setUsers] = useState([]);
  const [vehicles, setVehicles] = useState([]);

  useEffect(() => {
    api.adminListUsers().then(setUsers);
    api.getVehicles().then(setVehicles);
  }, []);

  async function toggleRepOnVehicle(vehicle, userId) {
    const current = vehicle.reps.map((r) => r.id);
    const next = current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId];
    await api.setVehicleReps(vehicle.id, next);
    setVehicles((prev) =>
      prev.map((v) => (v.id === vehicle.id ? { ...v, reps: users.filter((u) => next.includes(u.id)) } : v))
    );
  }

  return (
    <div>
      <h2>{t('wizard.step.reps')}</h2>
      <p className="settings-hint">{t('wizard.reps.hint')}</p>
      {vehicles.length === 0 && <p className="empty-note">{t('wizard.reps.noVehicles')}</p>}
      {vehicles.map((v) => (
        <div className="wizard-vehicle-card" key={v.id}>
          <strong>{v.label}</strong>
          <div className="wizard-rep-chip-row">
            {users.map((u) => (
              <button
                type="button"
                key={u.id}
                className={'wizard-rep-chip' + (v.reps.some((r) => r.id === u.id) ? ' active' : '')}
                onClick={() => toggleRepOnVehicle(v, u.id)}
              >
                {u.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <StepActions onSkip={onSkip} t={t} disabled={saving} />
      <button type="button" className="gold-btn wizard-standalone-next" onClick={() => onSave({})}>
        {t('wizard.next')}
      </button>
    </div>
  );
}

// ---- Step 8: custody model ----
function CustodyStep({ company, onSave, onSkip, saving, t }) {
  const [model, setModel] = useState(company.custody_model || 'vehicle');

  function handleSubmit(e) {
    e.preventDefault();
    onSave({ custody_model: model });
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>{t('wizard.step.custody')}</h2>
      <p className="settings-hint">{t('wizard.custody.hint')}</p>
      <div className="wizard-radio-group">
        {['vehicle', 'rep', 'mixed'].map((opt) => (
          <label className="wizard-radio-row" key={opt}>
            <input type="radio" name="custody" checked={model === opt} onChange={() => setModel(opt)} />
            {t(`wizard.custody.${opt}`)}
          </label>
        ))}
      </div>
      <StepActions onSkip={onSkip} t={t} disabled={saving} />
    </form>
  );
}

// ---- Step 9: whatsapp (request only — approval is platform admin's job) ----
function WhatsappStep({ onFinish, onSkip, saving, t }) {
  const [number, setNumber] = useState('');
  const [requested, setRequested] = useState(false);

  async function handleRequest(e) {
    e.preventDefault();
    await api.requestWhatsAppLink(number);
    setRequested(true);
  }

  return (
    <div>
      <h2>{t('wizard.step.whatsapp')}</h2>
      <p className="settings-hint">{t('wizard.whatsapp.hint')}</p>
      {requested ? (
        <p className="wizard-tag">{t('wizard.whatsapp.requested')}</p>
      ) : (
        <form onSubmit={handleRequest} className="wizard-inline-form">
          <input placeholder="963xxxxxxxxx" dir="ltr" value={number} onChange={(e) => setNumber(e.target.value)} />
          <button type="submit" className="gold-btn">{t('wizard.whatsapp.request')}</button>
        </form>
      )}
      <div className="wizard-actions">
        <button type="button" className="ghost-btn" onClick={onSkip} disabled={saving}>
          {t('wizard.skipForNow')}
        </button>
        <button type="button" className="gold-btn" onClick={onFinish} disabled={saving}>
          {t('wizard.finish')}
        </button>
      </div>
    </div>
  );
}
