import '../styles/kpi-card.css';

export default function KpiCard({ title, value, sub, gradient = 1 }) {
  return (
    <div className={`kpi-card kpi-grad-${gradient}`}>
      <span className="kpi-card-title">{title}</span>
      <strong className="kpi-card-value">{value}</strong>
      {sub && <span className="kpi-card-sub">{sub}</span>}
    </div>
  );
}
