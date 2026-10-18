# Payroll import format (HR program → Atlas)

Atlas does **not** calculate payroll. The HR program (attendance, leave,
shifts, calculation) exports one batch per period; Atlas imports it, posts
the accrual and pays it through treasury (`docs/posting-map.md` §15).

Two equivalent forms:

| Form | Endpoint | Body |
|---|---|---|
| JSON | `POST /api/payroll/periods/import` | the batch (schema: `docs/payroll-import.schema.json`) |
| CSV | `POST /api/payroll/periods/import-csv` | `{ "period", "externalId", "postingDate"?, "csv": "<file text>" }` (template: `docs/payroll-import-template.csv`) |

Permission: `manage_payroll_intake`. The person who imports cannot post the
same batch (separation of duties; posting needs `approve_payroll_posting`).

## Batch

| Field | Rule |
|---|---|
| `period` | `YYYY-MM` |
| `externalId` | the HR program's batch id; **(company, period, externalId) is the idempotency key** |
| `postingDate` | optional, default = last day of the period; must fall in an open fiscal period when posted |

Re-importing the **same** content is a no-op (200, `replay: true`). Different
content for the same key is refused (409 `payroll_changed_reimport`) until
the period is reopened with a reason (a posted period's entry is then
reversed).

## Lines (one per department / cost center / currency)

| JSON field | CSV column | Rule |
|---|---|---|
| `department` | `department` | required |
| `costCenterId` | `cost_center_code` | optional; must be an active cost center of the company |
| `currencyCode` | `currency` | required; an active currency of the company (e.g. USD, SYP) |
| `gross` / `grossMinor` | `gross` | ≥ 0; decimals ≤ the currency's |
| `deductions` / `deductionsMinor` | `deductions` | ≥ 0; includes advance recoveries |
| `employerContributions` / `…Minor` | `employer_contributions` | ≥ 0 |
| `net` / `netMinor` | `net` | **must equal gross − deductions exactly** |
| `headcount` | `headcount` | optional integer ≥ 0 |
| `deductionsByType[]` | `ded:<type>` columns | optional split; **must add up to `deductions`**; type = a deduction type code of the company, or `advance_recovery` |
| `employerContributionsByType[]` | `emp:<type>` columns | optional split; must add up to `employer_contributions` |

A line without a split goes entirely to the company's `default` deduction
type.

## Advance recoveries

| JSON field | CSV (record_type = `recovery`) | Rule |
|---|---|---|
| `employeeRef` | `employee_ref` | the HR program's employee reference (as used when the advance was paid) |
| `currencyCode` | `currency` | the advance's currency |
| `amount` / `amountMinor` | `amount` | > 0; per currency, recoveries ≤ the deductions set aside for them (`default` + `advance_recovery`); at posting, ≤ the employee's outstanding advances |

## CSV specifics

- UTF-8 (BOM allowed), comma-separated, first row = header, quotes for
  values with commas. Column order is free; unknown columns are errors.
- `record_type`: `line` (default) or `recovery`.
- Empty cells = 0 / absent.

## Validation: all or nothing

The whole file is checked before anything is written. If **any** row is
bad, the import is refused with **400 `import_invalid`** and every problem
is listed:

```json
{
  "error": "import_invalid",
  "message": "الملف مرفوض بالكامل: 2 خطأ — صحّحها وأعد الاستيراد",
  "errors": [
    { "section": "lines", "row": 3, "error": "net_mismatch", "message": "السطر 3: الصافي …" },
    { "section": "advanceRecoveries", "row": 5, "error": "employee_ref_required", "message": "…" }
  ]
}
```

`row` is the CSV row number (header = row 1) for CSV imports, the 1-based
position in `lines` / `advanceRecoveries` for JSON.

Batch-level problems (bad `period`, missing `externalId`, no lines) are
refused with their own error code before row checks.
