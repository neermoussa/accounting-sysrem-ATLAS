import { formatMinor } from '../ledger/ledgerShared.js';

// Shared bits for the purchasing screens (Prompt 6).

export const digitsOf = (meta, code) => ((meta?.currencies || []).find((c) => c.code === code) || meta?.base_currency || { minor_unit_digits: 2 }).minor_unit_digits;
export const money = (meta, minor, code) => (minor === null || minor === undefined ? '' : `${formatMinor(minor, digitsOf(meta, code || meta?.base_currency?.code))}${code && code !== meta?.base_currency?.code ? ` ${code}` : ''}`);
export const baseMoney = (meta, minor) => formatMinor(minor || 0, meta?.base_currency?.minor_unit_digits ?? 2);

export function Badge({ t, status }) {
  return <span className={`ledger-badge ledger-badge-${['posted', 'approved', 'matched', 'closed', 'received', 'ordered'].includes(status) ? 'posted' : ['mismatch', 'rejected', 'cancelled', 'reversed'].includes(status) ? 'reversed' : 'draft'}`}>{t(`pur.status.${status}`)}</span>;
}

export const emptyLine = () => ({ productId: '', description: '', qty: '1', unitPrice: '', taxRate: '' });

// Editable lines: product or description, qty, unit price, tax %.
export function LineEditor({ t, meta, lines, setLines, priced = true }) {
  const set = (i, k) => (e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));
  return (
    <div className="ledger-table-wrap">
      <table className="ledger-table ledger-lines-table">
        <thead><tr><th>{t('sales.product')}</th><th>{t('sales.description')}</th><th>{t('sales.qty')}</th>{priced && <><th>{t('sales.unitPrice')}</th><th>{t('sales.taxRate')}</th></>}<th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select value={l.productId} onChange={set(i, 'productId')}>
                  <option value="">—</option>
                  {meta.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </td>
              <td><input value={l.description} onChange={set(i, 'description')} /></td>
              <td><input dir="ltr" style={{ width: 80 }} value={l.qty} onChange={set(i, 'qty')} /></td>
              {priced && (
                <>
                  <td><input dir="ltr" style={{ width: 100 }} value={l.unitPrice} onChange={set(i, 'unitPrice')} /></td>
                  <td><input dir="ltr" style={{ width: 60 }} value={l.taxRate} onChange={set(i, 'taxRate')} /></td>
                </>
              )}
              <td>{lines.length > 1 && <button type="button" className="ghost-btn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="ghost-btn" style={{ marginTop: 8 }} onClick={() => setLines((ls) => [...ls, emptyLine()])}>{t('ledger.form.addLine')}</button>
    </div>
  );
}

export const cleanLines = (lines) =>
  lines
    .filter((l) => l.productId || l.description)
    .map((l) => ({ productId: l.productId ? Number(l.productId) : null, description: l.description || undefined, qty: l.qty, unitPrice: l.unitPrice, taxRate: l.taxRate || undefined }));
