import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { FIELD_META } from '../departments/config.js';
import '../styles/department.css';

const DEPT_ICON_PATHS = {
  warehouse: 'M3 10.5 12 4l9 6.5M5 9.5V20h14V9.5M9.5 20v-6h5v6',
  accounting: 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h4',
  vendors: 'M3 7h18l-1.5 5H4.5zM5 12v8h14v-8M10 20v-4h4v4',
};

// Which pages a department offers as shortcuts, in order. Only the ones the
// user can actually open (navTargets) are rendered.
const SHORTCUTS = {
  warehouse: ['/factory-inventory', '/inventory', '/custody-transfers', '/returns', '/products-master'],
  accounting: ['/collections', '/uploads', '/orders', '/statistics'],
  vendors: [],
};
const SHORTCUT_LABEL = {
  '/factory-inventory': 'nav.factoryInventory',
  '/inventory': 'nav.carInventory',
  '/custody-transfers': 'nav.custodyTransfers',
  '/returns': 'nav.returns',
  '/products-master': 'nav.productsMaster',
  '/collections': 'nav.collections',
  '/uploads': 'nav.uploads',
  '/orders': 'nav.orders',
  '/statistics': 'nav.statistics',
};

function Stat({ field, t, fmt, navTargets, deptLinks }) {
  const meta = FIELD_META[field.key] || {};
  const link = meta.to && navTargets.has(meta.to) ? meta.to : null;
  const value = !field.tracked ? '—' : field.kind === 'money' ? fmt.money(field.value) : fmt.num(field.value);
  const warn = field.tone === 'warn' && field.tracked && Number(field.value) > 0;
  const subParts = [];
  if (!field.tracked) subParts.push(t('dept.notTracked'));
  if (field.key === 'stockValue' && field.meta?.uncosted > 0) subParts.push(`${fmt.num(field.meta.uncosted)} ${t('dept.sub.uncosted')}`);
  if (field.key === 'openOrders' && field.meta) subParts.push(`${fmt.num(field.meta.count)} ${t('dept.sub.orders')}`);
  if (field.key === 'pendingCollections' && field.meta) subParts.push(`${fmt.num(field.meta.count)} ${t('dept.sub.collections')}`);
  if (field.key === 'receivables' && field.meta) subParts.push(`${fmt.num(field.meta.shops)} ${t('dept.sub.shops')}`);

  const body = (
    <>
      <span className="dept-stat-label">{t(`dept.field.${field.key}`)}</span>
      <strong className={'dept-stat-value' + (warn ? ' is-warn' : '') + (!field.tracked ? ' is-muted' : '')} dir="ltr">
        {value}
      </strong>
      {subParts.length > 0 && <span className="dept-stat-sub">{subParts.join(' · ')}</span>}
    </>
  );

  return (
    <div className={'dept-stat' + (field.sharedWith.length ? ' is-shared' : '')}>
      {link ? (
        <Link to={link} className="dept-stat-main">
          {body}
        </Link>
      ) : (
        <div className="dept-stat-main">{body}</div>
      )}
      {field.sharedWith.length > 0 && (
        <div className="dept-stat-shared">
          <span>{t('dept.sharedWith')}</span>
          {field.sharedWith.map((d) =>
            deptLinks[d] && /^https?:/.test(deptLinks[d]) ? (
              <a key={d} href={deptLinks[d]} className="dept-chip">
                {t(`dept.${d}`)}
              </a>
            ) : deptLinks[d] ? (
              <Link key={d} to={deptLinks[d]} className="dept-chip">
                {t(`dept.${d}`)}
              </Link>
            ) : (
              <span key={d} className="dept-chip">
                {t(`dept.${d}`)}
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}

function Rows({ title, rows, empty, render, to, t }) {
  return (
    <section className="dept-card">
      <div className="dept-card-head">
        <h2>{title}</h2>
        {to && (
          <Link to={to} className="dept-card-link">
            {t('dept.openAll')}
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="dept-empty">{empty}</p>
      ) : (
        <ul className="dept-rows">
          {rows.map((row, i) => (
            <li key={row.id ?? row.shopId ?? i} className="dept-row">
              {render(row)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function DepartmentDashboardPage({ dept, navTargets, deptAccess, siblings = {} }) {
  const { t } = useLanguage();
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    setData(null);
    api
      .getDepartmentDashboard(dept)
      .then(setData)
      .catch(() => setError(true));
  }, [dept]);

  useEffect(load, [load]);

  // Latin digits in both languages, matching the orders/collections tables.
  // Rendered inside a dir="ltr" span (see Stat) so "5,190 USD" never gets
  // its currency code flipped to the wrong side in a right-to-left page.
  const currency = data?.currency || '';
  const fmt = {
    num: (v) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }),
    money: (v) => `${Math.round(Number(v || 0)).toLocaleString('en-US')}${currency ? ` ${currency}` : ''}`,
  };
  // Same-app departments link in-app; departments that live in a sibling app link to it.
  const deptLinks = { ...siblings, ...Object.fromEntries((deptAccess || []).filter((d) => !siblings[d]).map((d) => [d, `/${d}`])) };
  const shortcuts = (SHORTCUTS[dept] || []).filter((to) => navTargets.has(to));

  return (
    <div className="dept-page">
      <header className="dept-head">
        <span className="dept-head-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d={DEPT_ICON_PATHS[dept]} />
          </svg>
        </span>
        <div>
          <p className="dept-eyebrow">{t('dept.eyebrow')}</p>
          <h1 className="dept-title">{t(`dept.${dept}`)}</h1>
          <p className="dept-lede">{t(`dept.${dept}.desc`)}</p>
        </div>
      </header>

      {error && (
        <div className="dept-card dept-error" role="alert">
          <p>{t('dept.loadError')}</p>
          <button type="button" className="ghost-btn" onClick={load}>
            {t('dept.retry')}
          </button>
        </div>
      )}
      {!error && !data && <p className="dept-empty">{t('app.loading')}</p>}

      {data && (
        <>
          <section className="dept-section" aria-label={t('dept.ownTitle')}>
            <h2 className="dept-section-title">{t('dept.ownTitle')}</h2>
            <div className="dept-stats">
              {data.fields
                .filter((f) => f.sharedWith.length === 0)
                .map((f) => (
                  <Stat key={f.key} field={f} t={t} fmt={fmt} navTargets={navTargets} deptLinks={deptLinks} />
                ))}
            </div>
          </section>

          <section className="dept-section" aria-label={t('dept.sharedTitle')}>
            <h2 className="dept-section-title">{t('dept.sharedTitle')}</h2>
            <div className="dept-stats">
              {data.fields
                .filter((f) => f.sharedWith.length > 0)
                .map((f) => (
                  <Stat key={f.key} field={f} t={t} fmt={fmt} navTargets={navTargets} deptLinks={deptLinks} />
                ))}
            </div>
            <p className="dept-note">{t('dept.sharedNote')}</p>
          </section>

          {shortcuts.length > 0 && (
            <section className="dept-section" aria-label={t('dept.shortcuts')}>
              <h2 className="dept-section-title">{t('dept.shortcuts')}</h2>
              <div className="dept-shortcuts">
                {shortcuts.map((to) => (
                  <Link key={to} to={to} className="dept-shortcut">
                    {t(SHORTCUT_LABEL[to])}
                  </Link>
                ))}
              </div>
            </section>
          )}

          <div className="dept-grid">
            {dept === 'warehouse' && (
              <>
                <Rows
                  t={t}
                  title={t('dept.list.lowStock')}
                  rows={data.lists.lowStock}
                  empty={t('dept.list.lowStockEmpty')}
                  to={navTargets.has('/factory-inventory') ? '/factory-inventory' : null}
                  render={(r) => (
                    <>
                      <span>{r.name}</span>
                      <span className="dept-row-val is-warn">
                        {fmt.num(r.qty)} / {fmt.num(r.min)}
                      </span>
                    </>
                  )}
                />
                <Rows
                  t={t}
                  title={t('dept.list.transfers')}
                  rows={data.lists.transfers}
                  empty={t('dept.list.transfersEmpty')}
                  to={navTargets.has('/custody-transfers') ? '/custody-transfers' : null}
                  render={(r) => (
                    <>
                      <span>#{r.id}</span>
                      <span className={'dept-row-val' + (r.status === 'discrepancy' ? ' is-warn' : '')}>{t(`custody.status.${r.status}`)}</span>
                    </>
                  )}
                />
              </>
            )}
            {dept === 'accounting' && (
              <>
                <Rows
                  t={t}
                  title={t('dept.list.topDebtors')}
                  rows={data.lists.topDebtors}
                  empty={t('dept.list.topDebtorsEmpty')}
                  to={navTargets.has('/collections') ? '/collections' : null}
                  render={(r) => (
                    <>
                      <span>{r.name}</span>
                      <span className={'dept-row-val' + (r.overdue ? ' is-warn' : '')}>{fmt.money(r.balance)}</span>
                    </>
                  )}
                />
                <Rows
                  t={t}
                  title={t('dept.list.pendingCollections')}
                  rows={data.lists.pendingCollections}
                  empty={t('dept.list.pendingCollectionsEmpty')}
                  to={navTargets.has('/collections') ? '/collections' : null}
                  render={(r) => (
                    <>
                      <span>{r.shop_name}</span>
                      <span className="dept-row-val">{fmt.money(r.amount)}</span>
                    </>
                  )}
                />
              </>
            )}
            {dept === 'vendors' && (
              <>
                <Rows
                  t={t}
                  title={t('dept.list.reorder')}
                  rows={data.lists.reorder}
                  empty={t('dept.list.reorderEmpty')}
                  to={navTargets.has('/factory-inventory') ? '/factory-inventory' : null}
                  render={(r) => (
                    <>
                      <span>{r.name}</span>
                      <span className="dept-row-val is-warn">
                        {t('dept.list.short')} {fmt.num(r.shortfall)}
                      </span>
                    </>
                  )}
                />
                <section className="dept-card">
                  <div className="dept-card-head">
                    <h2>{t('dept.vendors.ledgerTitle')}</h2>
                  </div>
                  <p className="dept-empty">{t('dept.vendors.ledgerBody')}</p>
                </section>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
