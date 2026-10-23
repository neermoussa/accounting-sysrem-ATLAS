# Report Builder and the query spec (Prompt 12b)

The Report Builder (`/reports/builder`) and, from 12c, the natural-language questions use ONE query format: a JSON spec, validated against a catalog (`backend/lib/analytics/query.js`). Nothing a client sends ever becomes SQL text. Only catalog column names are used, and every value is a bound parameter.

## The spec

```json
{
  "source": "sales",
  "measures": ["net", "qty", "cost"],
  "calcs": [{ "key": "margin_pct", "label": "هامش %", "expr": "(net - cost) / net * 100", "format": "percent" }],
  "dimensions": ["branch", "month"],
  "filters": [{ "dim": "branch", "op": "in", "values": [3, null] }],
  "period": { "preset": "last_month" },
  "compare": "previous_year",
  "sort": { "by": "net", "dir": "desc" },
  "limit": 1000
}
```

| Field | Rule |
|---|---|
| `source` | one of the catalog sources below |
| `measures` | 1–10 measures of that source |
| `calcs` | up to 5 ratios; `key` is lower-case latin; `expr` uses `+ - * /`, parentheses, numbers and ONLY the measures listed in this spec; `format` is `number`, `percent` or `money` (rounded to minor units); division by zero gives `null` |
| `dimensions` | 0–3 dimensions of that source |
| `filters` | up to 10; `op` is `in` (default) or `not_in`; 1–200 values; `null` means "empty"; `not_in` keeps empty rows unless `null` is listed; ids are checked against the company (tenantRefs) |
| `period` | `{ from, to }` (≤ 10 years) or `{ preset }`: `this_month`, `last_month`, `mtd`, `this_quarter`, `last_quarter`, `this_year`, `last_year`, `ytd`, `last_n_days` (+ `n` 1–366). Presets resolve on "today" (a scheduled run uses its slot's local date) |
| `compare` | `previous_period`: the same number of whole months before when the period is whole months, else the same number of days just before. `previous_year`: the same dates a year earlier (29 Feb → 28 Feb). Adds `<key>__cmp`, `__chg`, `__pct` per measure and calc; `__pct` is `null` when the base is 0 |
| `sort` | `by` is a selected dimension, measure or calc |
| `limit` | 1–5000 rows (default 1000); `truncated` says when rows were cut |
| `includeClosing` | journal source only; year-end closing entries are left out unless `true` |

Unknown keys anywhere are refused (400). The response contains the normalized spec, `columns` (role: dimension / measure / calc / compare / change / change_pct), `rows` (labels plus `<dim>__id`, the values, and a `drill`), `totals` (from an ungrouped query, so document counts are not double-counted), `period`, `compare_period` and the facts' freshness stamp.

## Catalog (sources)

| Source | Fact table | Needs |
|---|---|---|
| `sales` | fact_sales_lines | `cost`, `margin` need **view_costs** |
| `purchases` | fact_purchase_lines | **view_costs** (purchase prices) |
| `journal` | fact_journal_lines | — (account totals = financial statements) |
| `expenses` | fact_expenses | the `employee` dimension needs **payroll** |
| `receivables` | fact_receivables | — |
| `payables` | fact_payables | **view_costs** |
| `inventory` | fact_inventory_moves | `value` needs **view_costs** (quantities do not) |
| `production` | fact_production_batches | cost measures need **view_costs** |
| `payroll` | fact_payroll | **payroll** (`manage_payroll_intake` or `approve_payroll_posting`) |

Every source also needs `view_financial_reports`. `GET /api/report-builder/catalog` returns only what the caller may use. The check sits INSIDE the engine (`validate()`), so the builder, the pivot / heatmap facts mode, saved and scheduled reports, exports and 12c all go through it.

## API (`/api/report-builder`)

| Endpoint | What |
|---|---|
| `GET /catalog` | sources, dimensions and measures the caller may use; base currency digits |
| `POST /run` `{ spec }` | runs in a report worker (cap / queue / 503 + Retry-After) |
| `GET /drill?source=&filters=` | fact rows behind a row; cost / payroll columns removed without the permission |
| `GET /dimension-values?source=&dim=` | values for the filter picker |
| `POST /export` `{ spec, format, lang }` | xlsx / pdf / csv now; nothing stored; audited |
| `GET/POST /saved`, `GET/PUT/DELETE /saved/:id` | saved reports |
| `POST /saved/:id/run` | rows of a saved report |
| `POST /saved/:id/runs`, `GET /saved/:id/runs`, `GET /runs/:id/file` | files (manual runs) and downloads |
| `GET/POST /saved/:id/schedules`, `PUT/DELETE /schedules/:id` | schedules (`schedule_reports`) |
| `GET /recipients` | company users a send can name (no contact details) |
| `POST /runs/:id/sends`, `GET /sends`, `GET /sends/:id/file`, `POST /sends/:id/approve`, `POST /sends/:id/reject` | sends (`send_reports`) |

Also `GET /api/reports/pivot/table?source=facts&spec=` (two dimensions, one measure; same shape as the legacy pivot) and `GET /api/reports/heatmap/data?source=facts&spec=` (cells with an intensity 0–1). Without `source=facts` both answer exactly as before (`test/pivotGolden.test.js`).

## Saved, scheduled and sent reports

- **Saved:** private (owner only) or shared. Sharing needs `share_reports`. A shared report is visible to users holding `view_financial_reports` and what its spec needs. Only the owner edits. The owner or a `share_reports` holder deletes (soft delete; the report's schedules stop).
- **Files:** a run writes one file under `uploads/report-runs/<company>/` (`ATLAS_REPORT_RUNS_DIR`). It is never served statically. Downloads are permission-checked and audited. CSV is UTF-8 with a BOM and RFC 4180 quoting; a text cell starting with `= + - @` gets a leading `'`.
- **Schedules:** daily / weekly / monthly (31 = last day of the month) at a local time with a fixed UTC offset (default +180 minutes, Damascus).
  - The sweep runs every minute (`ATLAS_REPORT_SCHEDULE_MS`) and claims a due slot in one `BEGIN IMMEDIATE` transaction. `UNIQUE (schedule_id, scheduled_for)` means a slot runs once.
  - After downtime, only the latest missed slot runs, and `missed_slots` records how many were skipped.
  - A run uses the schedule owner's CURRENT permissions. If they no longer allow it, the run is recorded as failed without a file.
  - Schedules never send anything.
- **Sends:** a request names 1–20 explicit recipients: a company user, a WhatsApp number or an e-mail address. Nothing is delivered until another `send_reports` holder approves it.
  - Separation of duties is adaptive (step `report_send`); the owner can break glass with a written reason, which is audited.
  - The approver must hold the data's permissions and may review the file first.
  - A file with cost or payroll data goes only to company users holding that permission. This is checked at the request and again at approval.
  - E-mail has no transport in Atlas yet, so an approved e-mail send is recorded as failed (`email_not_configured`).
