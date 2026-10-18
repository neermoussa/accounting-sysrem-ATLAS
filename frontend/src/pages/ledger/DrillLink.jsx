import { Link } from 'react-router-dom';

// Drill-down convention (docs/drill-down.md): every report amount carries a
// `drill` object = the query of GET /api/financial-reports/general-ledger.
// DrillLink opens the ledger lines behind the number; each line then opens
// its source document with SourceDocLink.
export function drillHref(drill) {
  const p = new URLSearchParams({ tab: 'gl' });
  for (const [k, v] of Object.entries(drill || {})) if (v !== null && v !== undefined && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  return `/reports/financial?${p.toString()}`;
}

export function DrillLink({ drill, children, className = 'ledger-drill' }) {
  if (!drill) return <span>{children}</span>;
  return <Link className={className} to={drillHref(drill)}>{children}</Link>;
}

const SOURCE_LINK = {
  sales_invoice: (id) => `/sales/invoices?id=${id}`,
  sales_credit_note: (id) => `/sales/credit-notes?id=${id}`,
  customer_receipt: (id) => `/receivables/receipts?id=${id}`,
  collection: () => '/collections',
  cheque_received: () => '/receivables/cheques',
  opening_balance: () => '/ledger/opening-balances',
  year_end_close: () => '/reports/year-end',
};

// Opens the source document of a ledger line; manual entries open the entry.
export function SourceDocLink({ line }) {
  const make = SOURCE_LINK[line.source_type];
  const to = make && line.source_id ? make(line.source_id) : `/ledger/entries?id=${line.entry_id}`;
  return <Link to={to}>{line.source_number || line.entry_number}</Link>;
}
