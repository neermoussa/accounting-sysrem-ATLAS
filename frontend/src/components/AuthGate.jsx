import { useState } from 'react';
import LoginPage from '../pages/LoginPage.jsx';
import CreateCompanyPage from '../pages/CreateCompanyPage.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/auth.css';

// Note: the old "request to join an existing company" self-serve register
// flow (RegisterPage.jsx) isn't wired in here anymore — in the multi-tenant
// model there's no way to pick which company to join from a bare login
// screen without an invite link (a separate, later feature). Joining an
// existing company today happens via that company's own Startup Setup
// "Users & Roles" step (a manager adds you directly) — this screen only
// offers logging in or creating a brand-new company.
export default function AuthGate() {
  const [mode, setMode] = useState('login');
  const { t, lang, setLang } = useLanguage();

  return (
    <main className="auth-shell">
      {/* The background itself is the real reference photograph (see
          auth.css .auth-shell), with the "ATLAS" wordmark already baked
          into the image mid-beam — no separate logo element drawn over
          it. This scrim is just a readability gradient, not a re-creation
          of the beam/splash. */}
      <span className="auth-scene-scrim" aria-hidden="true" />
      <span className="sr-only">Atlas</span>
      <div className="auth-frame">
        <section className="auth-panel">
          <header className="auth-panel-brand">
            <button type="button" className="auth-lang-toggle" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
              {lang === 'ar' ? 'EN' : 'ع'}
            </button>
          </header>
          <div className="auth-panel-body">
            {mode === 'login' && (
              <>
                <LoginPage onSwitchToRegister={() => setMode('createCompany')} />
                <button type="button" className="ghost-btn auth-switch" onClick={() => setMode('createCompany')}>
                  {t('authGate.createCompanyCta')}
                </button>
              </>
            )}
            {mode === 'createCompany' && <CreateCompanyPage onSwitchToLogin={() => setMode('login')} />}
            <p className="auth-note">{t('authGate.footerNote')}</p>
          </div>
        </section>
      </div>
    </main>
  );
}
