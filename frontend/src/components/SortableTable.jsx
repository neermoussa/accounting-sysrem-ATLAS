import { useMemo, useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/sortable-table.css';

// columns: [{ key, header, sortable = true, render?(row) }]
// Sorting is generic (locale-aware string compare, numeric compare
// otherwise) so every report tab gets the same click-header-to-sort
// behavior without re-implementing it per table.
export default function SortableTable({
  columns,
  rows,
  defaultSortKey,
  defaultSortDir = 'desc',
  rowKey,
  onRowClick,
  rowClassName,
  emptyText,
}) {
  const { t } = useLanguage();
  const [sortKey, setSortKey] = useState(defaultSortKey ?? columns[0]?.key);
  const [sortDir, setSortDir] = useState(defaultSortDir);

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? ''), 'ar');
      }
      return (Number(av) || 0) - (Number(bv) || 0);
    });
    if (sortDir === 'desc') sorted.reverse();
    return sorted;
  }, [rows, sortKey, sortDir]);

  function toggleSort(col) {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
  }

  return (
    <div className="sortable-table-wrap">
      <table className="sortable-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={[col.sortable === false ? '' : 'sortable', col.numeric ? 'num-col' : ''].filter(Boolean).join(' ')}
                onClick={() => toggleSort(col)}
              >
                {col.header}
                {sortKey === col.key && <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={[onRowClick ? 'clickable-row' : '', rowClassName ? rowClassName(row) : ''].filter(Boolean).join(' ')}
            >
              {columns.map((col) => (
                <td key={col.key} className={col.numeric ? 'num-col' : ''}>
                  {col.render ? col.render(row) : row[col.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
          {sortedRows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="empty-note">
                {emptyText || t('sortableTable.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
