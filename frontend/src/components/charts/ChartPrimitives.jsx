import { useId, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import './chart-primitives.css';

/* Atlas chart foundation — token-driven, plain React + inline SVG, no
   charting library. See CHART FOUNDATION note in the design-system report
   for why this exists instead of Bklit/shadcn (Tailwind-only registry,
   incompatible with this project's plain-CSS architecture). Every color
   here comes from the --atlas-chart-* tokens in theme.css, so a future
   palette change updates every chart at once. Composable building blocks:

   - <ChartFrame>          shared card chrome + title/subtitle + loading/empty states
   - <Sparkline>            small inline trend line (KPI cards, radar cards)
   - <ChartTrendLine>       full-size line/area chart with hover tooltip
   - <ChartBars>            full-size bar chart with gridlines + hover tooltip
*/

const TONE_VAR = {
  blue: 'var(--atlas-chart-primary)',
  green: 'var(--atlas-chart-secondary)',
  amber: 'var(--atlas-chart-tertiary)',
  red: 'var(--atlas-chart-quaternary)',
  muted: 'var(--atlas-text-faint)',
};

function toneColor(tone) {
  return TONE_VAR[tone] || TONE_VAR.blue;
}

/** Shared chart card chrome: title, subtitle, loading skeleton, empty state. */
export function ChartFrame({ title, subtitle, loading, empty, emptyLabel, height = 220, children, className = '' }) {
  const { t } = useLanguage();
  return (
    <div className={`atlas-chart-frame ${className}`} style={{ '--atlas-chart-height': `${height}px` }}>
      {(title || subtitle) && (
        <div className="atlas-chart-frame-head">
          {title && <span className="atlas-chart-frame-title">{title}</span>}
          {subtitle && <span className="atlas-chart-frame-subtitle">{subtitle}</span>}
        </div>
      )}
      <div className="atlas-chart-frame-body">
        {loading ? (
          <div className="atlas-chart-skeleton" role="status" aria-label={t('chart.loading') || 'Loading'}>
            <span className="atlas-chart-skeleton-bar" />
            <span className="atlas-chart-skeleton-bar" />
            <span className="atlas-chart-skeleton-bar" />
          </div>
        ) : empty ? (
          <div className="atlas-chart-empty">{emptyLabel || t('chart.noData') || '—'}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/** Small inline trend line — drop-in replacement for one-off mini-chart SVGs. */
export function Sparkline({ values = [], tone = 'blue', height = 38, filled = true }) {
  const gradientId = useId();
  const width = 120;
  const safe = values && values.length ? values : [0, 0, 0, 0, 0];
  const max = Math.max(...safe.map((v) => Number(v) || 0), 1);
  const min = Math.min(...safe.map((v) => Number(v) || 0), 0);
  const range = Math.max(max - min, 1);
  const points = safe.map((value, index) => {
    const x = (index / Math.max(safe.length - 1, 1)) * width;
    const y = height - ((Number(value || 0) - min) / range) * (height - 6) - 3;
    return [x, y];
  });
  const linePoints = points.map((p) => p.join(',')).join(' ');
  const areaPath = filled
    ? `M ${points[0][0]},${height} L ${linePoints.split(' ').join(' L ')} L ${points[points.length - 1][0]},${height} Z`
    : null;
  const color = toneColor(tone);
  return (
    <svg className="atlas-sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {filled && (
        <>
          <defs>
            <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#spark-${gradientId})`} stroke="none" />
        </>
      )}
      <polyline points={linePoints} fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function useHoverIndex(count, containerRef, rtl) {
  const [index, setIndex] = useState(null);
  const onMove = (event) => {
    const el = containerRef.current;
    if (!el || !count) return;
    const rect = el.getBoundingClientRect();
    let ratio = (event.clientX - rect.left) / rect.width;
    if (rtl) ratio = 1 - ratio;
    const i = Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
    setIndex(i);
  };
  const onLeave = () => setIndex(null);
  return { index, onMove, onLeave };
}

/** Full-size line/area chart with restrained gridlines and a hover tooltip. */
export function ChartTrendLine({ data = [], xKey = 'x', yKey = 'y', tone = 'blue', height = 220, formatValue = (v) => v, formatLabel = (v) => v }) {
  const { lang } = useLanguage();
  const rtl = lang === 'ar';
  const gradientId = useId();
  const ref = useRef(null);
  const width = 600;
  const padX = 8;
  const padTop = 12;
  const padBottom = 22;
  const values = data.map((d) => Number(d[yKey]) || 0);
  const max = Math.max(...values, 1);
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;
  const points = useMemo(
    () =>
      data.map((d, i) => {
        const px = rtl ? width - (padX + stepX * i) : padX + stepX * i;
        const py = padTop + innerH - (Number(d[yKey] || 0) / max) * innerH;
        return [px, py];
      }),
    [data, rtl, stepX, innerH, max, padTop, yKey, width]
  );
  const { index, onMove, onLeave } = useHoverIndex(data.length, ref, false);
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  const floorY = (padTop + innerH).toFixed(2);
  const areaPath = points.length ? `${linePath} L ${points[points.length - 1][0].toFixed(2)} ${floorY} L ${points[0][0].toFixed(2)} ${floorY} Z` : '';
  const color = toneColor(tone);
  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const active = index != null ? data[index] : null;
  const activePoint = index != null ? points[index] : null;

  return (
    <div className="atlas-chart-trend" ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="atlas-chart-trend-svg"
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        role="img"
        aria-label="trend chart"
      >
        {gridLines.map((g) => (
          <line key={g} x1={padX} x2={width - padX} y1={padTop + innerH * g} y2={padTop + innerH * g} className="atlas-chart-grid-line" />
        ))}
        <defs>
          <linearGradient id={`trend-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#trend-${gradientId})`} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {activePoint && <line x1={activePoint[0]} x2={activePoint[0]} y1={padTop} y2={padTop + innerH} className="atlas-chart-hover-line" />}
        {points.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={i === index ? 4 : 0} fill={color} className="atlas-chart-dot" />
        ))}
      </svg>
      {active && activePoint && (
        <div
          className="atlas-chart-tooltip"
          style={{
            insetInlineStart: `${(activePoint[0] / width) * 100}%`,
            top: `${(activePoint[1] / height) * 100}%`,
          }}
        >
          <span className="atlas-chart-tooltip-label">{formatLabel(active[xKey])}</span>
          <strong className="atlas-chart-tooltip-value">{formatValue(active[yKey])}</strong>
        </div>
      )}
    </div>
  );
}

/** Full-size bar chart with gridlines, axis labels and a hover tooltip. */
export function ChartBars({ data = [], xKey = 'x', yKey = 'y', tone = 'blue', height = 220, formatValue = (v) => v, formatLabel = (v) => v }) {
  const { t } = useLanguage();
  const [hover, setHover] = useState(null);
  const max = Math.max(...data.map((d) => Number(d[yKey]) || 0), 1);
  const color = toneColor(tone);
  const empty = !data.length;

  return (
    <div className="atlas-chart-bars" style={{ '--atlas-chart-bar-color': color }}>
      <div className="atlas-chart-bars-plot">
        {empty ? (
          <div className="atlas-chart-empty">{t('chart.noData') || '—'}</div>
        ) : (
          data.map((d, i) => {
            const value = Number(d[yKey]) || 0;
            const pct = Math.max(value ? 4 : 1, (value / max) * 100);
            return (
              <div
                key={i}
                className={'atlas-chart-bar-col' + (hover === i ? ' active' : '')}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              >
                {hover === i && (
                  <div className="atlas-chart-tooltip atlas-chart-tooltip-bar">
                    <span className="atlas-chart-tooltip-label">{formatLabel(d[xKey])}</span>
                    <strong className="atlas-chart-tooltip-value">{formatValue(value)}</strong>
                  </div>
                )}
                <div className="atlas-chart-bar-track">
                  <span className="atlas-chart-bar" style={{ height: `${pct}%` }} />
                </div>
                <small className="atlas-chart-bar-label">{formatLabel(d[xKey])}</small>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
