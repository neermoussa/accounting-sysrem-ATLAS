import { useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/onboarding.css';

function buildSteps(t) {
  return {
    admin: [
      { icon: '🗺️', title: t('onboarding.admin.map.title'), body: t('onboarding.admin.map.body') },
      { icon: '🧭', title: t('onboarding.admin.dayplan.title'), body: t('onboarding.admin.dayplan.body') },
      { icon: '📋', title: t('onboarding.admin.audit.title'), body: t('onboarding.admin.audit.body') },
      { icon: '⚙️', title: t('onboarding.admin.settings.title'), body: t('onboarding.admin.settings.body') },
    ],
    rep: [
      { icon: '🗺️', title: t('onboarding.rep.map.title'), body: t('onboarding.rep.map.body') },
      { icon: '🧭', title: t('onboarding.rep.dayplan.title'), body: t('onboarding.rep.dayplan.body') },
      { icon: '🧾', title: t('onboarding.rep.order.title'), body: t('onboarding.rep.order.body') },
    ],
    warehouse: [
      { icon: '🏭', title: t('onboarding.warehouse.factory.title'), body: t('onboarding.warehouse.factory.body') },
      { icon: '⚠️', title: t('onboarding.warehouse.lowStock.title'), body: t('onboarding.warehouse.lowStock.body') },
    ],
    import_manager: [
      { icon: '📤', title: t('onboarding.import.upload.title'), body: t('onboarding.import.upload.body') },
    ],
  };
}

// No more fixed roles to key off of — pick the closest matching step set
// from whatever permissions this particular user actually holds.
function pickSteps(permissions, t) {
  const steps = buildSteps(t);
  const defaultSteps = [{ icon: '👋', title: t('onboarding.default.welcome.title'), body: t('onboarding.default.welcome.body') }];
  const has = (p) => permissions?.includes(p);
  if (has('manage_permissions') || has('manage_users') || has('manage_settings')) return steps.admin;
  if (has('view_app')) return steps.rep;
  if (has('manage_factory_inventory')) return steps.warehouse;
  if (has('import_amin')) return steps.import_manager;
  return defaultSteps;
}

export default function OnboardingModal({ permissions, onDone }) {
  const { t } = useLanguage();
  const steps = pickSteps(permissions, t);
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card card">
        <button type="button" className="onboarding-skip" onClick={onDone}>
          {t('onboarding.skip')}
        </button>
        <div className="onboarding-icon">{step.icon}</div>
        <h2 className="onboarding-title">{step.title}</h2>
        <p className="onboarding-body">{step.body}</p>

        <div className="onboarding-dots">
          {steps.map((_, i) => (
            <span key={i} className={'onboarding-dot' + (i === stepIndex ? ' active' : '')} />
          ))}
        </div>

        <div className="onboarding-actions">
          {stepIndex > 0 && (
            <button type="button" className="ghost-btn" onClick={() => setStepIndex((i) => i - 1)}>
              {t('onboarding.prev')}
            </button>
          )}
          <button
            type="button"
            className="gold-btn onboarding-next"
            onClick={() => (isLast ? onDone() : setStepIndex((i) => i + 1))}
          >
            {isLast ? t('onboarding.start') : t('onboarding.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
