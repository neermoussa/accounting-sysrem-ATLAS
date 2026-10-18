import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { api } from '../api.js';
import '../styles/sidebar.css';

const ATLAS_LOCKUP_URL = '/atlas-lockup-white.png';
const ATLAS_ICON_URL = '/atlas-icon-mark.png';

const ICONS = {
  map: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2Z" />
      <path d="M9 3v16M15 5v16" />
    </svg>
  ),
  route: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 7.5C10 10 14 14 15.8 16.5" />
      <path d="M6 8.5v3a3 3 0 0 0 3 3h2" />
    </svg>
  ),
  visit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z" />
      <path d="m9.5 10 1.8 1.8L14.8 8.3" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V4M8 8l4-4 4 4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  ),
  import: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-5Z" />
      <path d="M14 3v5h5M9.5 15.5l2 2 3-3" />
    </svg>
  ),
  truck: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8h11v9H2zM13 11h4l4 3.2V17h-8z" />
      <circle cx="6.5" cy="18.5" r="1.6" />
      <circle cx="16.5" cy="18.5" r="1.6" />
    </svg>
  ),
  warehouse: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 4l9 6.5" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M9.5 20v-6h5v6" />
    </svg>
  ),
  box: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  ),
  stats: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M11 20V4M18 20v-7" />
      <path d="M3 20h18" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1Z" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16.5 5.5a3 3 0 0 1 0 5.9M20 20c0-2.8-2-5.1-4.7-5.8" />
    </svg>
  ),
  audit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-5Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 4.5 6v6c0 5 3.2 8.4 7.5 9 4.3-.6 7.5-4 7.5-9V6L12 3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  swap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h13l-3-3M20 17H7l3 3" />
    </svg>
  ),
  collapse: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4v16M15 9l-3 3 3 3" />
    </svg>
  ),
  whatsapp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4A8.6 8.6 0 0 1 8 19L4 20l1.1-3.9A8.4 8.4 0 1 1 21 11.5Z" />
      <path d="M8.5 10.5c.3 2 2.5 4.2 4.5 4.5.9.1 1.6-.5 1.8-1.2l.2-.6-2-1-.5.8c-1-.4-1.9-1.3-2.3-2.3l.8-.5-1-2-.6.2c-.7.2-1.2.9-1.1 1.8Z" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3M12 18v3M4.2 4.2l2.2 2.2M17.6 17.6l2.2 2.2M3 12h3M18 12h3M4.2 19.8l2.2-2.2M17.6 6.4l2.2-2.2" />
      <circle cx="12" cy="12" r="3.4" />
    </svg>
  ),
  ledger: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 7h8M8 11h8M8 15h4" />
    </svg>
  ),
  vendors: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h18l-1.5 5h-15z" />
      <path d="M5 12v8h14v-8M10 20v-4h4v4" />
    </svg>
  ),
  market: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20h18" />
      <path d="M5 20v-6M10 20V9M15 20v-9M20 20V5" />
    </svg>
  ),
};

// On desktop this is an always-visible column that the user can shrink to
// icon-only via `collapsed`. On mobile (see the max-width media query in
// sidebar.css) it becomes a fixed off-canvas drawer instead — `collapsed`
// is ignored there and `mobileOpen`/`onNavigate` take over: the parent
// (App.jsx) owns the open/closed state and a backdrop click, while this
// component closes itself on every link tap so picking a page also closes
// the drawer, matching how a mobile nav drawer is expected to behave.
export default function Sidebar({ groups, siblingLinks = [], mobileOpen, onNavigate }) {
  const [collapsed, setCollapsed] = useState(false);
  const { t } = useLanguage();
  const { pathname } = useLocation();
  // A department group shows its pages only while open. It opens by itself
  // when the current page belongs to it, and can be toggled by hand (the
  // manual choice wins until the user navigates to another group's page).
  const [manual, setManual] = useState({});
  const isActiveGroup = (g) => (g.header && pathname === g.header.to) || g.items.some((i) => (i.end ? pathname === i.to : pathname === i.to || pathname.startsWith(i.to + '/')));
  const isOpen = (g) => !g.header || (manual[g.key] ?? isActiveGroup(g));
  useEffect(() => setManual({}), [pathname]);
  // Falls back to the static asset/translation when no custom branding has
  // been set (or the fetch fails) — every approved user sees this
  // regardless of their permission set, so it's read from the open
  // public-defaults endpoint rather than the permission-gated full settings.
  const [branding, setBranding] = useState(null);

  useEffect(() => {
    api
      .getPublicDefaults()
      .then((defaults) => setBranding(defaults))
      .catch(() => {});
  }, []);

  const brandName = branding?.company_name || t('app.brand');
  const brandLogo = branding?.company_logo_url || null;

  return (
    <aside className={'app-sidebar' + (collapsed ? ' collapsed' : '') + (mobileOpen ? ' mobile-open' : '')}>
      <div className="sidebar-brand">
        <span className="sidebar-brand-chip">
          {brandLogo ? (
            <img src={brandLogo} className={collapsed ? 'sidebar-brand-mark' : 'sidebar-brand-wordmark'} alt={brandName} />
          ) : (
            <img src={collapsed ? ATLAS_ICON_URL : ATLAS_LOCKUP_URL} className={collapsed ? 'sidebar-brand-mark' : 'sidebar-brand-wordmark'} alt={brandName} />
          )}
        </span>
      </div>
      <nav className="sidebar-nav">
        {groups.map((group) => {
          const open = isOpen(group);
          return (
            <div className={'sidebar-group' + (group.header ? ' is-dept' : '')} key={group.key} role="group" aria-label={t(group.labelKey)}>
              {group.header ? (
                <div className="sidebar-group-row">
                  <NavLink
                    to={group.header.to}
                    onClick={onNavigate}
                    className={({ isActive }) => 'sidebar-link sidebar-group-head' + (isActive ? ' active' : '')}
                    title={collapsed ? t(group.labelKey) : undefined}
                  >
                    <span className="sidebar-icon">{ICONS[group.header.icon]}</span>
                    {!collapsed && <span className="sidebar-label">{t(group.labelKey)}</span>}
                  </NavLink>
                  {!collapsed && group.items.length > 0 && (
                    <button
                      type="button"
                      className={'sidebar-group-toggle' + (open ? ' is-open' : '')}
                      aria-expanded={open}
                      aria-label={t(group.labelKey)}
                      onClick={() => setManual((m) => ({ ...m, [group.key]: !open }))}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  )}
                </div>
              ) : (
                !collapsed && <span className="sidebar-group-label">{t(group.labelKey)}</span>
              )}
              {open &&
                group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) => 'sidebar-link' + (group.header ? ' sidebar-link-child' : '') + (isActive ? ' active' : '')}
                    title={collapsed ? t(item.labelKey) : undefined}
                  >
                    <span className="sidebar-icon">{ICONS[item.icon]}</span>
                    {!collapsed && <span className="sidebar-label">{t(item.labelKey)}</span>}
                  </NavLink>
                ))}
            </div>
          );
        })}
        {siblingLinks.length > 0 && (
          <div className="sidebar-group" role="group" aria-label="Atlas">
            {!collapsed && <span className="sidebar-group-label">Atlas</span>}
            {siblingLinks.map((l) => (
              <a key={l.dept} href={l.href} className="sidebar-link" title={collapsed ? t(`dept.${l.dept}`) : undefined}>
                <span className="sidebar-icon">{ICONS[l.dept === 'warehouse' ? 'warehouse' : l.dept === 'accounting' ? 'ledger' : 'vendors']}</span>
                {!collapsed && <span className="sidebar-label">{t(`dept.${l.dept}`)}</span>}
              </a>
            ))}
          </div>
        )}
      </nav>
      <button
        type="button"
        className="sidebar-collapse-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? 'expand' : 'collapse'}
        title={collapsed ? 'expand' : 'collapse'}
      >
        <span className={'sidebar-icon' + (collapsed ? ' flipped' : '')}>{ICONS.collapse}</span>
      </button>
    </aside>
  );
}
