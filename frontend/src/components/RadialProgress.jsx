const SIZE = 180;
const STROKE = 14;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function RadialProgress({ title, percent, subLabel, footerLabel, gradientId }) {
  const safePercent = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const offset = CIRCUMFERENCE * (1 - safePercent / 100);
  const gid = gradientId || 'radial-progress-gradient';

  return (
    <div className="radial-progress-card card">
      {title && <h3 className="radial-progress-title">{title}</h3>}
      <div className="radial-progress-ring">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <defs>
            <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#cfd6e0" />
              <stop offset="100%" stopColor="#ffffff" />
            </linearGradient>
          </defs>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="rgb(24 87 201 / 14%)" strokeWidth={STROKE} />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={`url(#${gid})`}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
        <div className="radial-progress-center">
          <span className="radial-progress-percent">{percent == null ? '—' : `${percent}%`}</span>
          {subLabel && <span className="radial-progress-sub">{subLabel}</span>}
          {footerLabel && <span className="radial-progress-footer">{footerLabel}</span>}
        </div>
      </div>
    </div>
  );
}
