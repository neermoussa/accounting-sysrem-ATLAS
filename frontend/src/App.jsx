import { useEffect, useState } from 'react';
import ItemCardPage from './pages/stock/ItemCardPage.jsx';
import { Link, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { LanguageProvider, useLanguage } from './i18n/LanguageContext.jsx';
import { isSoundMuted, setSoundMuted, seedSoundDefaultsFromServer } from './lib/celebration.js';
import { api } from './api.js';
import AuthGate from './components/AuthGate.jsx';
import SplashScreen from './components/SplashScreen.jsx';
import RequirePermission from './components/RequirePermission.jsx';
import Sidebar from './components/Sidebar.jsx';
import GlobalSearch from './components/GlobalSearch.jsx';
import AccountMenu from './components/AccountMenu.jsx';
import NotificationsBell from './components/NotificationsBell.jsx';
import OnboardingModal from './components/OnboardingModal.jsx';
import ConnectivityBanner from './components/ConnectivityBanner.jsx';
import YearRolloverBanner from './components/YearRolloverBanner.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import { ThemeProvider, useTheme } from './contexts/ThemeContext.jsx';
import CreateCompanyPage from './pages/CreateCompanyPage.jsx';
import StartupSetupWizard from './pages/StartupSetupWizard.jsx';
import DepartmentDashboardPage from './pages/DepartmentDashboardPage.jsx';
import { NAV_GROUPS, DEPARTMENT_KEYS } from './departments/config.js';
import { APP_ROUTES, FULL_ONLY } from './appRoutes.jsx';
import { APP_CONFIG } from './appConfig.js';
import './styles/app.css';

// `module` names one of lib/companies.js's MODULE_KEYS on the backend — a
// nav item with a module is hidden entirely (not just permission-gated)
// once that module is switched off for the company, per Startup Setup.
// Items with no `module` are core and always visible regardless of module
// toggles (still permission-gated as before).
const navItems = APP_ROUTES.filter((r) => r.nav).map((r) => r.nav);

// The map is a full-app page; the department builds don't ship it at all.
const MapRoute = APP_ROUTES.find((r) => r.id === 'map')?.Component || (() => null);

function AuthenticatedApp() {
  const { user, company, suspended, logout, can, canAny, moduleEnabled } = useAuth();
  const { t, lang, setLang } = useLanguage();
  // The map is the only page whose own surface should show through the
  // topbar — everywhere else the bar needs an opaque background for the
  // page content scrolling underneath it to stay readable.
  const location = useLocation();
  const isMapRoute = location.pathname === '/';
  // A nav item tagged with a `module` disappears entirely (not just
  // permission-gated) once that module is switched off for the company —
  // see lib/companies.js MODULE_KEYS on the backend.
  const visibleNav = navItems.filter(
    (item) =>
      (item.anyOf ? canAny(...item.anyOf) : can(item.permission)) && (!item.module || moduleEnabled(item.module))
  );
  const defaultPath = !APP_CONFIG.full ? `/${APP_CONFIG.department}` : can('view_app') ? '/' : visibleNav[0]?.to || '/no-access';

  // Which department dashboards this user may open — asked of the backend
  // (the single source of truth for department access) rather than
  // re-deriving it from permission lists here.
  const [deptAccess, setDeptAccess] = useState(null); // null = not loaded yet
  useEffect(() => {
    document.title = APP_CONFIG.full ? 'Atlas' : `Atlas · ${t(`dept.${APP_CONFIG.department}`)}`;
  }, [t]);
  useEffect(() => {
    if (!user?.id) return;
    api
      .getDepartments()
      .then((res) => setDeptAccess(res.departments || []))
      .catch(() => setDeptAccess([]));
  }, [user?.id, company?.id]);

  // Sidebar groups: field sales / one group per department / system. A
  // department group shows when the user has its dashboard OR can open any
  // page filed under it; its header only links to the dashboard when they
  // actually have it. Any nav item no group claims lands in the last group.
  const deptList = deptAccess || [];
  const claimed = new Set(NAV_GROUPS.flatMap((g) => g.items));
  const fullGroups = NAV_GROUPS.map((g, i) => {
    const extra = i === NAV_GROUPS.length - 1 ? visibleNav.filter((n) => !claimed.has(n.to)) : [];
    const items = [...g.items.map((to) => visibleNav.find((n) => n.to === to)).filter(Boolean), ...extra];
    const hasDashboard = !!g.dept && deptList.includes(g.dept);
    return { key: g.key, labelKey: g.labelKey, header: hasDashboard ? { to: g.to, icon: g.icon } : null, items, show: hasDashboard || items.length > 0 };
  }).filter((g) => g.show);

  // A department app: its own dashboard + the pages built into it, then a
  // small System group (settings). Same look as the full app's group.
  const deptGroup = NAV_GROUPS.find((g) => g.dept === APP_CONFIG.department);
  const deptGroups = deptGroup
    ? [
        {
          key: deptGroup.key,
          labelKey: deptGroup.labelKey,
          header: deptList.includes(deptGroup.dept) ? { to: deptGroup.to, icon: deptGroup.icon } : null,
          items: visibleNav.filter((n) => n.to !== '/settings'),
          show: true,
        },
        { key: 'system', labelKey: 'dept.group.system', header: null, items: visibleNav.filter((n) => n.to === '/settings'), show: true },
      ].filter((g) => g.header || g.items.length > 0)
    : [];
  const sidebarGroups = APP_CONFIG.full ? fullGroups : deptGroups;

  // Links to the other department apps (department builds only).
  const siblingLinks = Object.entries(APP_CONFIG.siblings || {}).map(([dept, href]) => ({ dept, href }));
  const navTargets = new Set([...visibleNav.map((n) => n.to), ...deptList.map((d) => `/${d}`)]);
  const [muted, setMuted] = useState(isSoundMuted());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const onboardingKey = `onboarding_seen_${user.id}`;
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    setShowOnboarding(!localStorage.getItem(onboardingKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  // Seeds this device's sound prefs (mute/volume/chime) from the
  // server-side defaults once per login — only takes effect for whichever
  // of them this device has never explicitly set (see celebration.js).
  useEffect(() => {
    api
      .getPublicDefaults()
      .then((defaults) => {
        seedSoundDefaultsFromServer(defaults);
        setMuted(isSoundMuted());
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  function dismissOnboarding() {
    localStorage.setItem(onboardingKey, '1');
    setShowOnboarding(false);
  }

  // A company that hasn't finished Startup Setup gets routed straight into
  // the wizard — but only its manager can actually run it (manage_settings);
  // anyone else at an unfinished company just sees a short wait message,
  // since there's nothing for them to do here yet.
  if (suspended) {
    return (
      <div className="auth-loading">
        <p>{t('app.subscriptionSuspended')}</p>
        <button type="button" className="ghost-btn" onClick={logout}>
          {t('platformAdmin.logout')}
        </button>
      </div>
    );
  }

  if (company && !company.setup_completed) {
    if (can('manage_settings')) return <StartupSetupWizard />;
    return (
      <div className="auth-loading">
        <p>{t('wizard.waitingForManager')}</p>
      </div>
    );
  }

  function toggleMuted() {
    const next = !muted;
    setSoundMuted(next);
    setMuted(next);
  }

  return (
    <div className="app-shell">
      {showOnboarding && <OnboardingModal permissions={user.permissions} onDone={dismissOnboarding} />}
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <Sidebar groups={sidebarGroups} siblingLinks={siblingLinks} mobileOpen={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
      <div className="app-content-col">
        <header className={'app-nav' + (isMapRoute ? ' app-nav-floating' : '')}>
          <button
            type="button"
            className="app-sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="toggle menu"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {can('view_app') ? (
            <div className="app-nav-search">
              <GlobalSearch />
            </div>
          ) : (
            <div className="app-nav-search" />
          )}
          <div className="app-user">
            <button type="button" className="app-icon-btn app-lang-toggle" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
              {lang === 'ar' ? 'EN' : 'ع'}
            </button>
            <button
              type="button"
              className="app-icon-btn"
              onClick={toggleMuted}
              aria-label="toggle sound"
            >
              {muted ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </button>
            <NotificationsBell />
            <AccountMenu
              user={user}
              roleLabel={can('manage_permissions') ? t('topbar.systemAdmin') : null}
              onLogout={logout}
            />
          </div>
        </header>
        <main className="app-main">
          <AppErrorBoundary resetKey={location.pathname}>
          <Routes>
          <Route
            path="/"
            element={
              APP_CONFIG.full && can('view_app') && moduleEnabled('customers') ? (
                <MapRoute />
              ) : (
                <Navigate to={APP_CONFIG.full ? visibleNav[0]?.to || '/no-access' : defaultPath} replace />
              )
            }
          />
          {APP_ROUTES.filter((r) => r.route).map((r) => (
            <Route
              key={r.id}
              path={r.nav.to}
              element={
                <RequirePermission {...r.route}>
                  <r.Component />
                </RequirePermission>
              }
            />
          ))}
          {/* Item card (Prompt 8b): a detail page under the stock screen, no nav entry. */}
          <Route path="/stock/items/:id" element={<RequirePermission anyOf={['view_stock_valuation', 'manage_stock_ledger']}><ItemCardPage /></RequirePermission>} />
          {DEPARTMENT_KEYS.filter((d) => APP_CONFIG.departments.includes(d)).map((dept) => (
            <Route
              key={dept}
              path={`/${dept}`}
              element={
                deptAccess === null ? (
                  <div className="auth-loading">{t('app.loading')}</div>
                ) : deptAccess.includes(dept) ? (
                  <DepartmentDashboardPage dept={dept} navTargets={navTargets} deptAccess={deptAccess} siblings={APP_CONFIG.siblings} />
                ) : (
                  <div className="no-access">
                    <p>{t('requirePermission.noAccess')}</p>
                  </div>
                )
              }
            />
          ))}
            {/* Market Intelligence is platform-admin-only now — see
                PlatformAdminApp.jsx — it no longer has a company-facing
                nav entry or route at all. */}
            <Route path="/no-access" element={<div className="no-access">{t('app.noAccess')}</div>} />
            {/* A real (in-app) 404 instead of a silent redirect to the
                dashboard: a mistyped URL or a stale bookmark used to land the
                user on the map with no indication anything was wrong. Stays
                inside the authenticated shell so the sidebar/nav still work. */}
            <Route
              path="*"
              element={
                <div className="not-found-page">
                  <h1 className="not-found-code">404</h1>
                  <p className="not-found-title">{t('app.notFoundTitle')}</p>
                  <p className="not-found-hint">{t('app.notFoundHint')}</p>
                  <Link to={defaultPath} className="gold-btn">{t('app.notFoundBack')}</Link>
                </div>
              }
            />
          </Routes>
          </AppErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function AppLoading() {
  const { t } = useLanguage();
  return <div className="auth-loading">{t('app.loading')}</div>;
}

function AppShell() {
  const { user, loading } = useAuth();
  const isMarketingRoute = window.location.pathname === '/marketing';
  if (isMarketingRoute && FULL_ONLY.MarketingPage) return <FULL_ONLY.MarketingPage />;
  // A platform-admin account never reaches AuthenticatedApp — completely
  // separate shell, no shared sidebar/routes with any company (see
  // PlatformAdminApp.jsx).
  if (user?.is_platform_admin && FULL_ONLY.PlatformAdminApp) return <FULL_ONLY.PlatformAdminApp />;
  return (
    <>
      <ConnectivityBanner />
      {user && !loading && <YearRolloverBanner />}
      {loading ? <AppLoading /> : user ? <AuthenticatedApp /> : <AuthGate />}
    </>
  );
}

const SPLASH_MIN_MS = 1000;
const SPLASH_TIMEOUT_MS = 5500;

// Ties the splash screen to the real session check (useAuth's `loading`)
// instead of a fixed timer: it never disappears before that check resolves,
// but also never sits for less than SPLASH_MIN_MS (so a near-instant load
// doesn't flash) or more than SPLASH_TIMEOUT_MS (a session check that hangs
// entirely — e.g. a request that never resolves or rejects — gets a clear
// error instead of an endless spinner).
function AppWithSplash() {
  const { loading } = useAuth();
  const [minTimeReached, setMinTimeReached] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [splashPhase, setSplashPhase] = useState('visible'); // visible -> fading -> done

  useEffect(() => {
    const minTimer = setTimeout(() => setMinTimeReached(true), SPLASH_MIN_MS);
    const timeoutTimer = setTimeout(() => setTimedOut(true), SPLASH_TIMEOUT_MS);
    return () => {
      clearTimeout(minTimer);
      clearTimeout(timeoutTimer);
    };
  }, []);

  // Trigger the fade-out once the real load is done and the minimum
  // display time has passed.
  useEffect(() => {
    if (splashPhase === 'visible' && !loading && minTimeReached) {
      setSplashPhase('fading');
    }
  }, [loading, minTimeReached, splashPhase]);

  // Kept in its own effect, keyed only on splashPhase: a single combined
  // effect above would have this timer cancelled by its own cleanup the
  // instant setSplashPhase('fading') re-runs it — this one only re-runs
  // when the phase itself actually changes.
  useEffect(() => {
    if (splashPhase !== 'fading') return;
    const t = setTimeout(() => setSplashPhase('done'), 500);
    return () => clearTimeout(t);
  }, [splashPhase]);

  const showError = timedOut && loading && splashPhase === 'visible';

  return (
    <LanguageProvider>
      {splashPhase !== 'done' && <SplashScreen fading={splashPhase === 'fading'} error={showError} />}
      {splashPhase !== 'visible' && <AppShell />}
    </LanguageProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppWithSplash />
      </AuthProvider>
    </ThemeProvider>
  );
}
