# Drill-down convention (Prompt 4)

Every amount a financial report returns carries a `drill` object. It holds
exactly the query parameters of `GET /api/financial-reports/general-ledger`:

| key | meaning |
|---|---|
| `accountId` *or* `type` | one account (its postable descendants when it is a header) or every account of a type (`revenue`, `expense`) |
| `from`, `to` | the period whose lines make up the number (`from=1900-01-01` for balance-sheet balances) |
| `branchId`, `costCenterId`, `projectId` | the same filters the report was run with |
| `excludeClosing` | `1` for P&L views: year-end closing entries are left out |

Rules:

1. **Report -> lines.** The frontend never builds drill URLs itself. It
   passes `drill` to `<DrillLink>` (`frontend/src/pages/ledger/DrillLink.jsx`),
   which opens `/reports/financial?tab=gl&...`.
2. **Line -> source document.** Each general-ledger line carries `entry_id`,
   `entry_number`, `source_type`, `source_id` and `source_number`.
   `<SourceDocLink>` maps `source_type` to its screen (invoice, credit note,
   receipt, collection, cheque, opening balances, year-end). Manual entries
   open the journal entry. To add a document type, add one line to
   `SOURCE_LINK` and, when it has a number, to `SOURCE_DOC_SQL` in
   `lib/financialReports.js`.
3. **Numbers must reconcile.** For a trial-balance row, the drill's period
   debit and credit equal the row's. For an income-statement, balance-sheet
   or budget-vs-actual row, the drill's net (sign by account type) equals the
   row. `test/financialReports.test.js` checks this for every row of every
   report.

## Ready reports (Prompt 12a, `/api/analytics`)

Each row carries one of two drill objects:

- `{ kind: 'gl', accountId, from, to, excludeClosing? }`. This is the same general-ledger query as above, opened with `<DrillLink>`.
- `{ kind: 'facts', fact, filters }`. The page calls `GET /api/analytics/drill?fact=<fact>&filters=<json>` and lists the fact rows behind the amount.
  - Each fact row keeps its `entry_id` and document (`doc_type`/`doc_id`, `source_type`/`source_id`), so the next click opens the entry or document as above.
  - Facts: journal, expenses, receivables, payables, sales, purchases, inventory, production, payroll. The payroll facts need the payroll permissions.
  - Filter keys must be columns of that fact table, plus `from`/`to`. Ids go through tenantRefs.

The drill rows add up to the amount clicked. `test/analytics.test.js` checks this for sales, aging and batch-cost rows.
