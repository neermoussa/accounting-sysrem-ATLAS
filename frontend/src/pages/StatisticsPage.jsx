import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import RadialProgress from '../components/RadialProgress.jsx';
import KpiCard from '../components/KpiCard.jsx';
import SalesReportTab from './statistics/SalesReportTab.jsx';
import BalancesReportTab from './statistics/BalancesReportTab.jsx';
import InventoryReportTab from './statistics/InventoryReportTab.jsx';
import InvoicesTab from './statistics/InvoicesTab.jsx';
import { ChartFrame, ChartTrendLine, ChartBars } from '../components/charts/ChartPrimitives.jsx';
import ExportOptionsModal from '../components/ExportOptionsModal.jsx';
import '../styles/stats.css';
import '../styles/radial-progress.css';
import '../styles/kpi-card.css';

const money = (value) => `${Math.round(Number(value || 0)).toLocaleString('ar-SY')} $`;
const pct = (value) => (value == null ? '—' : `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}%`);

// Tier 3/4 "how did this move over time" section — a line/area chart per the
// design-system rule (time-series never gets a bar chart). Built on the
// shared ChartTrendLine primitive so it stays token-driven.
function TrendSection({ months, t }) {
  const latestMonth = months[months.length - 1];
  const average = months.length ? months.reduce((sum, item) => sum + Number(item.total || 0), 0) / months.length : 0;
  return (
    <ChartFrame
      title={t('stats.monthlyFlow')}
      subtitle={`${t('stats.averageMonthlySales')}: ${money(average)} · ${pct(latestMonth?.changePct)} ${t('stats.vsPreviousMonth')}`}
      height={220}
      empty={!months.length}
      emptyLabel={t('stats.noPeriodData')}
    >
      <ChartTrendLine data={months} xKey="month" yKey="total" tone="blue" height={220} formatValue={money} formatLabel={(m) => (m || '').slice(5)} />
    </ChartFrame>
  );
}

// Tier 3 — operational breakdown. Categorical comparison across shops, so a
// bar chart (not a line) per the chart-type rule. `topShops` is a client-side
// grouping of the already-fetched sales-report rows (pre-existing behavior,
// summing raw order totals per shop — not a new derived metric introduced by
// this redesign; disclosed in the handoff report).
function OperationalSection({ topShops, recentRows, t }) {
  return (
    <div className="stats-tier-grid stats-tier-grid-2">
      <ChartFrame title={t('stats.salesLeaders')} subtitle={t('stats.tab.sales')} height={200} empty={!topShops.length} emptyLabel={t('stats.noPeriodData')}>
        <ChartBars data={topShops} xKey="name" yKey="total" tone="green" height={200} formatValue={money} formatLabel={(name) => name} />
      </ChartFrame>
      <div className="stats-activity-card">
        <h3>{t('stats.recentOperations')}</h3>
        {recentRows.length === 0 && <p className="stats-empty-hint">{t('stats.noPeriodData')}</p>}
        {recentRows.map((row, index) => (
          <div className="stats-activity-row" key={`${row.orderId}-${index}`}>
            <span><i className="stats-activity-dot" />{row.shopName}</span>
            <b>{money(row.orderTotal)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

// Tier 4 — exceptions/alerts. Reuses the existing semantic red/amber status
// tokens (never a chart — these are already flagged items, a list reads
// clearer than a visualization for them).
function AlertsSection({ overdueBalances, lowStockItems, statusCounts, t }) {
  const hasAny = overdueBalances.length > 0 || lowStockItems.length > 0;
  return (
    <div className="stats-tier-grid stats-tier-grid-2">
      <div className="stats-alert-card">
        <div className="stats-alert-card-head">
          <h3>{t('stats.topReceivables')}</h3>
          <span className="stats-alert-count negative">{statusCounts.red || 0}</span>
        </div>
        {overdueBalances.length === 0 && <p className="stats-empty-hint">{t('stats.noExceptions')}</p>}
        {overdueBalances.map((shop) => (
          <div className="stats-alert-row" key={shop.shopId}>
            <span>{shop.name}</span>
            <strong className="negative">{money(shop.balance)}</strong>
          </div>
        ))}
      </div>
      <div className="stats-alert-card">
        <div className="stats-alert-card-head">
          <h3>{t('stats.lowStock')}</h3>
          <span className="stats-alert-count warning">{lowStockItems.length}</span>
        </div>
        {lowStockItems.length === 0 && <p className="stats-empty-hint">{t('stats.noExceptions')}</p>}
        {lowStockItems.slice(0, 6).map((item, index) => (
          <div className="stats-alert-row" key={`${item.item_name || item.name}-${index}`}>
            <span>{item.item_name || item.name}</span>
            <strong className="warning">{item.current_quantity ?? '—'}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StatisticsPage() {
  const { t, lang } = useLanguage();
  const [overview, setOverview] = useState(null);
  const [months, setMonths] = useState([]);
  const [balances, setBalances] = useState([]);
  const [salesRows, setSalesRows] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [factoryInventory, setFactoryInventory] = useState([]);
  const [period, setPeriod] = useState('12m');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [tab, setTab] = useState('overview');
  const [targetProgress, setTargetProgress] = useState(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.getOverviewStats(), api.getMonthlySales(), api.getBalancesReport(), api.getSalesReport(), api.getInventory(), api.getFactoryInventory()])
      .then(([overviewData, monthData, balanceData, salesData, inventoryData, factoryData]) => {
        if (!active) return;
        setOverview(overviewData);
        setMonths(Array.isArray(monthData) ? monthData : []);
        setBalances(Array.isArray(balanceData) ? balanceData : []);
        setSalesRows(Array.isArray(salesData) ? salesData : []);
        setInventory(Array.isArray(inventoryData) ? inventoryData : []);
        setFactoryInventory(Array.isArray(factoryData) ? factoryData : []);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    api.getTargetProgress().then((data) => active && setTargetProgress(data)).catch(() => {});
    return () => { active = false; };
  }, []);

  const TABS = [
    { key: 'overview', label: t('stats.tab.overview') },
    { key: 'sales', label: t('stats.tab.sales') },
    { key: 'balances', label: t('stats.tab.balances') },
    { key: 'inventory', label: t('stats.tab.inventory') },
    { key: 'invoices', label: t('stats.tab.invoices') },
  ];

  const latestMonth = months[months.length - 1];
  const receivables = overview?.totalOutstandingBalance || balances.reduce((sum, shop) => sum + Number(shop.balance || 0), 0);
  const statusCounts = overview?.shopStatusCounts || {};
  const allInventory = [...inventory, ...factoryInventory];
  const lowStockItems = allInventory.filter((item) => item.lowStock);
  const overdue = balances.filter((shop) => shop.status === 'تجاوز الموعد').length;
  // Pre-existing client-side grouping of already-fetched sales-report rows
  // into per-shop totals for the "sales leaders" breakdown — kept as-is
  // from before this redesign (see OperationalSection comment above).
  const topShops = useMemo(
    () =>
      Object.values(
        salesRows.reduce((acc, row) => {
          const key = row.shopId || row.shopName;
          acc[key] ||= { name: row.shopName, total: 0 };
          acc[key].total += Number(row.orderTotal || 0);
          return acc;
        }, {})
      )
        .sort((a, b) => b.total - a.total)
        .slice(0, 6),
    [salesRows]
  );
  const topReceivables = useMemo(
    () => balances.filter((shop) => Number(shop.balance) > 0).slice().sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0)).slice(0, 5),
    [balances]
  );
  const recentRows = useMemo(() => salesRows.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5), [salesRows]);

  async function handleExport({ lang }) {
    setExporting(true);
    try {
      await api.exportStatsReport('monthly-sales', 'xlsx', { lang });
    } finally {
      setExporting(false);
      setShowExportOptions(false);
    }
  }
  if (loading) return <div className="stats-loading">{t('stats.loading')}</div>;
  if (!overview) return <div className="stats-loading stats-error">{t('stats.loadError')}</div>;

  return <div className="stats-page" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
    <header className="stats-header">
      <div>
        <span className="stats-eyebrow">{t('stats.financeControl')}</span>
        <h1>{t('stats.title')}</h1>
        <p>{t('stats.subtitle')}</p>
      </div>
      <div className="stats-header-actions">
        <select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label={t('stats.period')}>
          <option value="12m">{t('stats.last12')}</option>
          <option value="3m">{t('stats.last3')}</option>
          <option value="1m">{t('stats.thisMonth')}</option>
        </select>
        <button type="button" className="stats-primary-action" onClick={() => setShowExportOptions(true)} disabled={exporting}>
          {exporting ? t('stats.exporting') : t('stats.export')}
        </button>
        {showExportOptions && (
          <ExportOptionsModal onClose={() => setShowExportOptions(false)} onConfirm={handleExport} />
        )}
      </div>
    </header>

    <nav className="stats-tabs">
      {TABS.map((tabItem) => (
        <button
          key={tabItem.key}
          type="button"
          className={`stats-tab-btn${tab === tabItem.key ? ' active' : ''}`}
          onClick={() => setTab(tabItem.key)}
        >
          {tabItem.label}
        </button>
      ))}
    </nav>

    {tab === 'sales' && <SalesReportTab />}
    {tab === 'balances' && <BalancesReportTab />}
    {tab === 'inventory' && <InventoryReportTab />}
    {tab === 'invoices' && <InvoicesTab />}

    {tab === 'overview' && <>
      {/* Tier 1 — Executive KPIs */}
      <section className="stats-tier">
        <div className="stats-tier-head">
          <h2>{t('stats.tier.kpis')}</h2>
          <span>{t('stats.tier.kpisSub')}</span>
        </div>
        <div className="kpi-cards-row">
          <KpiCard title={t('stats.totalSales')} value={money(overview.totalSalesAllTime)} sub={`${pct(latestMonth?.changePct)} ${t('stats.vsPreviousMonth')}`} gradient={1} />
          <KpiCard title={t('stats.receivables')} value={money(receivables)} sub={`${overdue} ${t('stats.overdueShops')}`} gradient={2} />
          <KpiCard title={t('stats.activeShops')} value={overview.activeShopsCount.toLocaleString('ar-SY')} sub={`${statusCounts.red || 0} ${t('stats.shopsWithBalances')}`} gradient={3} />
          <KpiCard title={t('stats.lowStock')} value={lowStockItems.length.toLocaleString('ar-SY')} sub={t('stats.belowMinimum')} gradient={4} />
          <KpiCard
            title={t('stats.monthlyTarget')}
            value={overview.monthlyTargetPercent != null ? `${overview.monthlyTargetPercent}%` : '—'}
            sub={overview.monthlyTarget ? `${money(overview.monthlyActualSales)} ${t('stats.of')} ${money(overview.monthlyTarget)}` : t('stats.noMonthlyTarget')}
            gradient={1}
          />
        </div>

        {targetProgress && targetProgress.userId && (
          <div className="target-gauges-row">
            <RadialProgress
              title={t('stats.weeklyTarget')}
              percent={targetProgress.weekly.percent}
              subLabel={targetProgress.weekly.target ? `${money(targetProgress.weekly.actual)} ${t('stats.of')} ${money(targetProgress.weekly.target)}` : t('stats.noWeeklyTarget')}
              footerLabel={targetProgress.weekly.target ? `${targetProgress.weekly.daysRemaining} ${t('stats.daysRemaining')}` : null}
              gradientId="weekly-gauge"
            />
            <RadialProgress
              title={t('stats.monthlyTarget')}
              percent={targetProgress.monthly.percent}
              subLabel={targetProgress.monthly.target ? `${money(targetProgress.monthly.actual)} ${t('stats.of')} ${money(targetProgress.monthly.target)}` : t('stats.noMonthlyTarget')}
              footerLabel={targetProgress.monthly.target ? `${targetProgress.monthly.daysRemaining} ${t('stats.daysRemaining')}` : null}
              gradientId="monthly-gauge"
            />
          </div>
        )}
      </section>

      {/* Tier 2 — Trends */}
      <section className="stats-tier">
        <div className="stats-tier-head">
          <h2>{t('stats.tier.trends')}</h2>
          <span>{t('stats.tier.trendsSub')}</span>
        </div>
        <TrendSection months={months} t={t} />
      </section>

      {/* Tier 3 — Operational performance */}
      <section className="stats-tier">
        <div className="stats-tier-head">
          <h2>{t('stats.tier.operational')}</h2>
          <span>{t('stats.tier.operationalSub')}</span>
        </div>
        <OperationalSection topShops={topShops} recentRows={recentRows} t={t} />
      </section>

      {/* Tier 4 — Exceptions / alerts */}
      <section className="stats-tier">
        <div className="stats-tier-head">
          <h2>{t('stats.tier.alerts')}</h2>
          <span>{t('stats.tier.alertsSub')}</span>
        </div>
        <AlertsSection overdueBalances={topReceivables} lowStockItems={lowStockItems} statusCounts={statusCounts} t={t} />
      </section>

      {/* Tier 5 — Detailed breakdowns (the full tables live in the tabs above) */}
      <section className="stats-tier">
        <div className="stats-tier-head">
          <h2>{t('stats.tier.details')}</h2>
          <span>{t('stats.tier.detailsSub')}</span>
        </div>
        <div className="stats-detail-links">
          <button type="button" onClick={() => setTab('sales')}>{t('stats.jumpToSales')}</button>
          <button type="button" onClick={() => setTab('balances')}>{t('stats.jumpToBalances')}</button>
          <button type="button" onClick={() => setTab('inventory')}>{t('stats.jumpToInventory')}</button>
          <button type="button" onClick={() => setTab('invoices')}>{t('stats.jumpToInvoices')}</button>
        </div>
      </section>
    </>}
  </div>;
}
