# Build Progress

## Baseline (before any changes)
- Backend `npm test`: 31 tests, 31 pass, 0 fail
- Frontend `npm run build`: succeeds (chunk-size warning only)

## Prompt 0 — standing rules added by the owner
- **Tenant references (all new code):** every client-supplied id (account, cost center, project, party, branch, shop, product, warehouse, vehicle, user, order ...) is verified to belong to `req.companyId` through ONE shared helper, `backend/lib/tenantRefs.js` (`requireOwned` / `optionalOwned` / `requireParty`), in every create/update endpoint, with a test per endpoint proving a foreign-company id is rejected. A foreign id is reported exactly like a missing one (400 `invalid_<kind>` for body ids; 404 for ids in the URL path, which are already looked up with `company_id = ?`).
- **Rounding:** round each line to its currency's minor unit; post any residue to the `rounding_difference` system account so the entry balances exactly.
- **ledger_live:** anything that changes existing behaviour (collections, returns, balances) stays behind `companies.modules_json.ledger_live`; with it off, behaviour is unchanged.

| # | Prompt | Status |
|---|--------|--------|
| 1 | Ledger core | done |
| 2 | Auto-posting + sales documents | done |
| 3 | Receivables | done |
| 4 | Financial reports | done |
| 5 | Multi-currency | done |
| 6 | Purchasing | done |
| 7 | Cash & bank | done |
| 8 | Inventory valuation & lots | done (8a + 8b) |
| 9 | Manufacturing | done |
| 10 | Fixed assets & tax | done |
| 11 | HR & payroll — replaced by 11-lite (payroll accounting only) | done (11-lite) |
| 12 | Reporting engine | 12a done; 12b in progress; 12c pending |
| 13 | Roles, approvals, audit | pending |
| 14 | Integrations API | pending |
| 15 | Hardening | pending |

## Prompt 1 — Ledger core (done)

Gate: backend 57/57 pass at Prompt 1 commit (67/67 after the follow-up fixes) (baseline 31 + 26 new), frontend build OK, migration
0002 applied to a copy of a database created and seeded by the baseline code
(schema identical to a fresh DB, 226 objects; demo data intact), and
`ledger_integrity_check` clean on seeded data (`seed-demo-company.js` +
`seed-ledger-demo.js`). Screens checked in Chromium.

- Files added: `backend/db/ledgerSchema.js`, `backend/db/migrations/0002_ledger_core.js`,
  `backend/lib/ledger.js`, `backend/lib/ledgerCurrencies.js`, `backend/lib/coaTemplates/{trading,food_manufacturing}.json`,
  `backend/routes/ledger.js`, `backend/seed-ledger-demo.js`, `backend/test/ledger.test.js`, `backend/test/ledgerMoney.test.js`,
  `frontend/src/pages/ledger/{ChartOfAccountsPage,JournalEntriesPage,FiscalPeriodsPage,OpeningBalancesPage}.jsx`,
  `frontend/src/pages/ledger/ledgerShared.js`, `frontend/src/styles/ledger.css`.
- Files changed: `backend/db/init.js` (calls ledgerSchema), `backend/server.js` (mount `/api/ledger`),
  `backend/lib/permissions.js`, `backend/lib/departments.js` (view_ledger opens the accounting dashboard),
  `backend/test/helpers.js` (returns `dbPath`), `backend/seed-demo-company.js` (clear message instead of trigger error),
  `backend/package.json` (`seed:ledger`), `frontend/src/{api.js,appRoutes.jsx,auth/permissions.js,departments/config.js,i18n/translations.js}`.
- Migrations: `0002_ledger_core.js`.
- Tables: currencies, branches_ref, accounts, fiscal_years, fiscal_periods, cost_centers, projects,
  journal_entries, journal_lines, journal_attachments (+ immutability triggers).
- Permissions: view_ledger, manage_accounts, post_journal_entries, reverse_journal_entries,
  manage_fiscal_periods, lock_fiscal_periods, manage_opening_balances.
- Dependencies added: none.

## Prompt 2 — Auto-posting + sales documents (done)

Gate: backend 121/121 (87 before Prompt 2 + 34 new), frontend build OK.
Migration 0005 applied to a copy of a baseline-created + seeded DB and to the
Prompt-1-era copy: schema identical to fresh (242 objects), data intact.
Integrity clean on seeded data. Go-live executed on the seeded demo copy:
60/60 customers' derived balances equal their pre-go-live snapshots.
Screens checked in Chromium (invoice created+posted from the UI).

- Files added: `backend/db/salesSchema.js`, `backend/db/migrations/0005_sales_documents.js`, `backend/lib/customerLedger.js`,
  `backend/lib/salesPosting.js`, `backend/routes/sales.js`, `backend/scripts/ledger-go-live.js`,
  `backend/test/{sales,ledgerLiveFlag,customerBalance.random}.test.js`, `backend/test/salesHelpers.js`,
  `backend/test/fixtures/legacyScenario.js` + `legacyScenario.golden.json`, `docs/posting-map.md`,
  `frontend/src/pages/ledger/{SalesInvoicesPage,CreditNotesPage,CustomerLedgerPage}.jsx`.
- Files changed: `lib/collections.js` + `routes/returns.js` + `lib/returns.js` + `routes/import.js` (live-only branches),
  `lib/ledger.js` (balance refresh hook, new system keys, `transaction` export), `lib/companies.js` (modules endpoint can't set ledger_live),
  `lib/documentRenderer.js` (invoice printer accepts documentNumber/title/extraTotals; order printing unchanged),
  `lib/ledgerCurrencies.js` (`roundToMinor`), `lib/tenantRefs.js`, COA templates, `seed-ledger-demo.js`, permissions, frontend routes/nav/api/translations.
- Tables: sales_invoices, sales_invoice_lines, sales_credit_notes, sales_credit_note_lines, product_category_accounts, external_balance_snapshots.
- New system accounts: output_tax (2140), sales_returns (4200), bank_in_transit (1115 new).
- Permissions: view_sales_invoices, create_sales_invoices, post_sales_invoices, create_credit_notes (granted to owners by 0005).
- Dependencies added: none.

## Prompt 3 — Receivables, collections control, credit (done)

Gate: backend 157/157 (132 before Prompt 3 + 25 new), frontend build OK.
Migrations 0006–0007 applied to a baseline-created + seeded DB and to the
Prompt-2-era live copy: schema identical to fresh (253 objects), data intact,
aging total = AR control, reconciliation clean, integrity clean. Screens
checked in Chromium (manual receipt created and posted from the UI).
PDF statement verified with PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium.

- Item 1 (owner): draft invoice from a delivered order — `GET /api/sales/invoiceable-orders`,
  `POST /api/sales/invoices/from-order/:orderId` (customer, DELIVERED quantities from the latest
  delivery, ORDER prices, free lines at 0, order id linked; one live invoice per order).
- Files added: `backend/db/receivablesSchema.js`, `db/migrations/0006_go_live_runs.js` (pre-work), `0007_receivables.js`,
  `backend/lib/receivables.js`, `backend/routes/receivables.js`, `backend/test/{receivables,receivablesSweep}.test.js`,
  `frontend/src/pages/ledger/{ReceiptsPage,ChequesPage,ReceivablesReportsPage}.jsx`.
- Files changed: `lib/salesPosting.js` (from-order, credit check on post, credit-note open-amount guard, collection -> receipt),
  `lib/ledger.js` (reversal hook to receipts, new system key), `lib/collections.js` (overdue-invoice reminders, live only),
  `lib/departments.js` (receivables/overdueShops from the ledger, live only; keys unchanged), `routes/orders.js` + `routes/shops.js`
  (hard credit block overridable with override_credit_limit + reason), `server.js` (daily AR reconciliation sweep),
  COA templates (1145), permissions, frontend pages/routes/api/translations, `docs/posting-map.md`.
- Tables: customer_receipts, receipt_allocations, cheques_received, ar_reconciliation_checks.
- New system account: cheques_in_portfolio (1145).
- Permissions: view_receivables, manage_receipts, override_credit_limit (granted to owners by 0007).
- Dependencies added: none.

## Prompt 4 — Financial reports, budgets, closing (done)

Gate: backend 183/183 (168 before Prompt 4 + 15 new; PDF strict with
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium), frontend build OK.
Migration 0010 applied to a baseline-cfd63a6-created + seeded DB: schema identical
to fresh init (only the runner's own schema_migrations table differs, as before),
second run = no-op, integrity clean. Screens checked in Chromium (all 6 report
tabs, drill-down report -> ledger lines -> journal entry, budgets, year-end).

- Done-when, each backed by `backend/test/financialReports.test.js`:
  - BS balances for every month end of two years, with prev-year/prev-period columns, before and after close.
  - TB debits = credits (opening, period, closing) for every month, the year, cross-year and by branch.
  - IS net result = change in retained earnings after close (and IS still shows the closed year; P&L accounts are zero at year end).
  - Drill-down: every row of TB / IS / BS / CF / expense analysis / budget-vs-actual opens ledger lines whose total equals the row; each line carries its entry and source document (the sales-invoice line names the invoice number).
  - Benchmark: `npm run bench:reports` seeds 200,002 journal lines through `lib/ledger.js` and times every report: all under 2 s (slowest: cash flow 0.55 s; TB 0.22 s; monthly IS 0.26 s). A 20k-line run of the same script is a test.
  - Exports: Excel (RTL sheet, Arabic + `lang=en`) for all six reports + budget vs actual; PDF opens (`%PDF`).
- API `/api/financial-reports/*` (`/api/reports` was already the operational-reports router): trial-balance, general-ledger, income-statement (compare=prev_period|prev_year, monthly=1), balance-sheet (asOf, compare), cash-flow (direct + indirect, must reconcile), expense-analysis (by=account|cost_center|project|branch), budgets CRUD + status + vs-actual, year-end (status/close/reopen), month-end/:periodId. Every GET report takes `format=xlsx|pdf&lang=`.
- Files added: `backend/db/reportsSchema.js`, `db/migrations/0010_financial_reports.js`, `lib/financialReports.js`, `routes/financialReports.js`, `scripts/benchmark-reports.js`, `test/financialReports.test.js`, `frontend/src/pages/ledger/{FinancialReportsPage,BudgetsPage,YearEndPage,DrillLink}.jsx`, `docs/drill-down.md`.
- Files changed: `db/init.js`, `server.js` (mount), `lib/ledger.js` (year_end_close reverse message), permissions (back + front), `package.json` (bench:reports script), frontend api/routes/department NAV/translations (ar + en)/ledger.css.
- Tables: budgets, budget_lines. Indexes on journal_lines(account_id, entry_id), journal_lines(entry_id, account_id, debit_minor, credit_minor), journal_entries(company_id, entry_date, status).
- Permissions: view_financial_reports, manage_budgets, run_year_end_close (granted to owners by 0010). Reports also open with view_ledger.
- Dependencies added: none.

## After Prompt 4 — small commits (before Prompt 5)

- `36f7497` accounts.report_class (cash, current_asset, fixed_asset, contra_asset, current_liability, long_term_liability, equity, revenue, cogs, opex, other) drives every statement section, cost of sales, other income/expenses, cash accounts and cash-flow categories — reports no longer read code prefixes (`grep` of lib/routes is clean). Templates carry it; the chart-of-accounts form edits it (validated against the type, audited); new accounts default to: credit-normal asset -> contra_asset, else parent's class, else type default. Migration 0011 (ALTER on both fresh and migrated paths -> identical schema) backfills from the old code rules; test proves the backfill equals the template file. `test/reportClass.test.js` builds a custom chart whose codes contradict the templates ("5000" fixed asset, "4100" cost of sales, "1120" not cash, "2110" long-term) and checks IS/BS/CF.
  - Decision: contra_asset is always shown with fixed assets and is an operating add-back in the indirect cash flow (was investing); a current allowance (doubtful debts) should be classed current_asset.
  - IS gains "operating income" and an "other income/expenses" section (class `other`, income-positive).
- `464e2c0` Locking a period (not closing) is refused with 409 `lock_blocked_drafts` (drafts dated in the period) or `lock_blocked_ar_reconciliation` (AR control != customer sub-ledgers). Closing stays advisory. **Fixed after Prompt 5:** the reconciliation is computed AS OF THE PERIOD END (entries dated <= end), not today; a difference created later does not block an earlier period (test fails on the old code). `GET /api/receivables/reconciliation?asOf=` and the month-end checklist use the same as-of rule; the displayed-balance comparison and the stored daily check only run for today.
- `c997314` IS/BS return `inventory_opening_missing` until the `inventory` system account has a posted opening (source `opening_balance` or `inventory_opening` — **Prompt 8 must use one of these**); banner "المخزون بلا رصيد افتتاحي - الأرقام غير نهائية" on screen and in Excel/PDF.
- Gate: backend 189/189, frontend build OK, 0011 applied to the baseline-created DB and to the post-0010 copy: schema identical to fresh, integrity clean.

### Pre-Prompt-3 fixes — verification
All four are committed and pushed on `claude/new-session-2ye601`. **None is merged into `main`** (origin/main is still the initial commit; no PR has been opened — nothing on this branch is merged yet).
| Fix | Commit | Tests |
|---|---|---|
| Legacy/undated aging bucket + overdue policy; go-live open-items import | `51a388e` | openItems.test.js (5), receivablesSweep.test.js "legacy debt triggers an overdue reminder…" |
| Source-linked entries reversible only via their source action | `2efec0f` | receivables.test.js "every document-sourced entry type is refused…", "a collection entry cannot be reversed from the journal screen…", sales.test.js, ledger.test.js, faultInjection "collection reversal rolls back…", financialReports "closing entry reversible only through its source action" |
| Idempotent receipt backfill | `001a5bf` | receivables.test.js "receipt backfill … is idempotent …" |
| README Chromium / PLAYWRIGHT_CHROMIUM_PATH | `cd531d2` | docs only (README "PDF export" section); PDF tests are strict when the variable is set |

### Exchange-rate audit (before Prompt 5) — `FAILED`, fixed by migration 0012
Findings on the Prompt 1 storage (`journal_lines.exchange_rate_ppm`, `lib/ledgerCurrencies.js`):
- **Scale 1e6** (required >= 1e8).
- **Direction fixed as base-per-foreign.** A USD company posting SYP had to type 0.000074 -> stored 74 ppm (2 significant digits); 1e10 SYP at that rate is off by ~0.4% (the test shows the old result differs from the exact one).
- Arithmetic was already BigInt with one rounding, but the result was returned as Number without a safe-integer check.
- FX entries had no rounding plug: per-line rounding could make a balanced foreign entry fail `unbalanced`.
- Integer overflow: none in storage (int64), but node:sqlite reads INTEGER as JS Number, so stored values must stay <= 2^53: rate_e8 limits rates to < 9e7 (fine for SYP/USD ~1.3e4), amounts to 9e15 minor units.
Fix: `lib/fxRate.js` — rate = `rate_e8` (x1e8) + `rate_quote` (`base_per_foreign` | `foreign_per_base`); rates < 1 are refused with an Arabic hint to enter the other direction (so the stored direction is always the significant one); conversion BigInt, rounded once half-away-from-zero, refused if not a safe integer. Posting adds a `rounding_difference` line when the base residue is <= half a minor unit per converted line (bigger = real imbalance, still refused); draft->post adds it to the draft first. Migration 0012 adds the two columns (ALTER, same on fresh DBs); posted lines are immutable so old rows keep rate_e8 NULL and are read from the ppm column (exactly what was typed then — input was limited to 6 decimals). `exchange_rate_ppm` is still written (rounded, informational). Journal-entry screen: rate + direction selector, live totals use the same maths. Tests `test/fxRate.test.js`: SYP ~1e10 amounts, 4–8 decimal rates both directions vs an independent rational reference, half-unit rounding, overflow refusal, 120-entry property test (USD and SYP base, direct and draft->post) that every entry balances exactly with the residue in rounding_difference, real imbalance refused, legacy-row reader.

## Deferred to Prompt 7 (owner's list, after Prompt 5) — done in Prompt 7, see below
- Rep collections and cheques received must accept foreign currency: currency + rate captured on the collection/cheque and **locked at confirmation** (today `createReceipt` refuses foreign currency for collection/cheque receipts and `collections.amount` is base-only).
- Cash boxes per currency (one cash/bank account per currency, `accounts.currency_code` set), so foreign cash is held and revalued in its own box.
- Rep cash handover per currency (a rep hands over USD and SYP separately; the handover posts each currency at its locked rate; differences go to fx_realized).

## Deferred to Prompt 8 (owner's list, after Prompt 6)
- **Debit notes must reverse inventory at the original cost layer, including landed costs.** Today a debit note with returned goods credits `inventory` at the supplier-invoice value of the returned qty; the receipt value plus the landed cost allocated to that receipt line (`goods_receipt_lines.landed_base_minor`) stays in inventory/cost. Prompt 8's stock ledger must take the returned qty out of the cost layer it came in on (receipt + its landed share), with the difference vs the invoice value going to PPV.

## Deferred to Prompt 15 (owner's list)
- Incoming cheques: a "cancelled" status (cheque returned to the customer before deposit) — needs a rebuild of `cheques_received` (its CHECK constraint lists the statuses; SQLite cannot alter a CHECK), done as a table-rebuild migration with a backup and a row-count check.
- Playwright smoke tests for key screens (login, ledger entries, invoices, receipts, aging, financial reports + drill-down, budgets, year-end) in CI — today they are ad-hoc scripts run by hand.
- Re-run the report benchmark over HTTP (JSON serialisation + Express), not just in-process.
- Move heavy reports (cash flow, monthly IS, long account statements, exports) to a worker thread so one large report cannot block the event loop.

## Deferred to Prompt 16 — automatic costing (owner's list)
- **Rework cost tracking.** Today rework is recorded as a quantity on the production order (yield report only); its cost (re-issued materials, extra labour and energy) is absorbed into the batch like any other cost. Prompt 16 should track rework as its own cost element (or rework order) so batch cost and the variance report show what rework cost.
- Builds on the effective-dated cost inputs from Prompt 9 (`mfg_cost_rates`, rate row stored per order cost line).

## Prompt 5 — Multi-currency (done)

Gate: backend 208/208 (196 after the rate fix + 12 new in `test/multiCurrency.test.js`), ledger_live golden test unchanged, frontend build OK. Migration 0013 applied to the baseline-cfd63a6-created DB and to the post-0012 copy: schema identical to fresh init (schema_migrations aside), second run no-op, integrity clean, 3 permissions granted to the owner. Screens checked in Chromium on a seeded demo (USD base, SYP invoices, USD receipt, revaluation): rates, balances by currency, FX report, revaluation preview, invoice/receipt with currency — no page errors.

- Done-when, each backed by a test:
  - USD invoice paid in SYP at a different rate (SYP base): 100 USD @13,000 = 1,300,000; paid 1,400,000 SYP @14,000 -> settles USD 100.00 exactly, FX gain entry Dr AR 100,000 / Cr fx_gain_loss 100,000 dated at the receipt, customer AR exactly 0, aging empty; reversing the receipt reverses the FX entry and reopens the invoice. Also: USD invoice in a USD company paid in SYP (no FX); EUR invoice paid in three EUR receipts at three rates (loss, no base dust).
  - Revaluation: preview (stores nothing) of an open USD invoice + a USD bank balance; posting dated the period end with the automatic reversal dated the next day; AR and bank in base are back to their pre-revaluation values after the reversal; same date twice -> 409; permission enforced.
  - Every entry balances in base to the minor unit: checked after every scenario + a property run (both bases, 12 invoices / 15 receipts / credit notes across 3 currencies, 14–15 cross-currency allocations and 17–19 FX entries per run): AR control = customer sub-ledgers = open documents' base = aging total; settled invoices carry exactly 0 base.
  - Rounding edge cases: rates with 4–8 decimals, per-line conversion residue to rounding_difference, closing credit notes/allocations relieve the exact remaining base, invoice override 5 USD x 15,000.75 = 75,003.75 -> 75,004.
- Also tested: rate history/lookup by date and time, rate < 1 refused, rate locked at posting (a later rate does not change a posted invoice), missing rate blocks posting (`rate_missing`), override needs `override_exchange_rate` (403 otherwise) and is audited, credit note at the invoice rate, USD/SYP daily fetch writes the history (direction per base), pre-Prompt-5 rows (NULL columns) behave as base, atomicity of the FX step (fault injection), FX falls back to the allocation date when the receipt-date period is closed.
- API: `/api/currency` — `GET/POST /rates`, `GET /rates/current`, `GET /balances` (+xlsx/pdf), `GET /fx-report` (+xlsx/pdf), `GET /revaluations`, `POST /revaluations/preview`, `POST /revaluations`. Invoices: `currencyCode` on create; `POST /api/sales/invoices/:id/post {exchangeRate, rateQuote}` override. Receipts: `currencyCode`, `amount` in that currency, optional override; allocations take the RECEIPT-currency amount (+ optional `settlementRate`).
- Files added: `backend/db/currencySchema.js`, `db/migrations/0013_multi_currency.js`, `lib/currency.js`, `routes/currency.js`, `test/multiCurrency.test.js`, `frontend/src/pages/ledger/{ExchangeRatesPage,CurrencyReportsPage}.jsx`.
- Files changed: `lib/salesPosting.js` (document currency, fxEntryLines, rate lock, credit notes at invoice rate), `lib/receivables.js` (foreign receipts, cross-currency allocation, realized FX, aging/forecast on base paid), `lib/ledger.js` (getCurrency export, source-reverse messages), `lib/exchangeRate.js` (writes history), `routes/sales.js`, `server.js`, permissions, `docs/posting-map.md` §9, frontend invoices/receipts/credit notes/api/routes/NAV/translations.
- Tables: exchange_rates, fx_settlements, fx_revaluations; columns on sales_invoices / sales_credit_notes (rate_e8, rate_quote, total_base_minor), customer_receipts (currency_code, amount_original_minor, rate_e8, rate_quote), receipt_allocations (receipt_amount_minor, base_paid_minor, base_relieved_minor, settlement_rate_e8/quote).
- Permissions: manage_exchange_rates, override_exchange_rate, run_fx_revaluation (granted to owners by 0013).
- Dependencies added: none (rate chart is inline SVG).
- Decisions:
  - `receipt_allocations.amount_minor` now means the INVOICE-currency amount settled (identical to before for base invoices); the receipt-currency amount and both base amounts are separate columns. FX = base paid (receipt rate) - invoice base relieved (invoice rate); the settled invoice amount uses the invoice currency's rate at the receipt date.
  - Realized FX is dated at the receipt date (its rate's date); falls back to the allocation date if that period is closed. Re-allocation removes the old allocation and reverses its FX entry, then allocates again.
  - ~~Revaluation uses the same `fx_gain_loss` account as realized FX~~ — changed after Prompt 5 (`a37e104`): `fx_realized` (6800, the old account, history kept) and `fx_unrealized` (6810, migration 0014). Revaluations posted before the split stay on 6800 and are classified by source in the FX report. The reversal date (as-of + 1 day) must be in an open period. Revaluation entries appear in aging as their own item and net to zero after the reversal.
  - Customer balances in document currency are computed from documents (open invoices in their currency, unallocated receipts in theirs); base balances stay ledger-derived.
  - Standing tenant-ref rule: the new endpoints take no client ids except currency codes (validated against the company's currencies) and invoice ids on allocation (existing `tenantRefs` check + tests).
- Limitations: collections and cheques stay base-currency only (refused in foreign currency); no supplier documents yet, so no payables revaluation (Prompt 6); customer statement and aging are in base currency; credit notes without an invoice are base currency.

## After Prompt 5 — small commits (before Prompt 6)
- Tags `prompt-1-done` … `prompt-5-done` created on `0f304af`, `5929d39`, `fdd466c`, `4f616ce`, `2edc335`. **Pushing tags is refused by this environment's git proxy (HTTP 403, policy)** — they exist only in this clone; recreate them with `git tag -a prompt-N-done <sha>` and `git push origin --tags` from a machine with normal GitHub access. Draft PR to `main` (not merged): https://github.com/hamada010502/accounting-sysrem-ATLAS/pull/1
- `22d103b` Period-lock AR reconciliation as of the period end.
- `a37e104` `fx_gain_loss` split into `fx_realized` / `fx_unrealized` (templates + migration 0014; report reads both).
- `90f9f0c` FX tests for both base currencies + rule table in docs/posting-map.md §9. The original $100 / 13,000 / 14,000 test is the **SYP-base** case.

## Prompt 6 — Suppliers and purchasing (done)

Gate: backend 224/224 (212 after the post-Prompt-5 fixes + 12 new in `test/purchasing.test.js`), ledger_live golden test unchanged, frontend build OK. Migrations 0014–0015 applied to the baseline-cfd63a6-created DB, to the post-0013 copy and to a Prompt-5 demo DB with a real chart: schema identical to fresh init (schema_migrations aside), second run no-op, purchasing system accounts added under the right parents, integrity clean. Browser (Chromium, seeded demo): receive -> invoice -> post -> pay done through the UI, mismatch review + approval + post through the UI, supplier opening-balance spread through the UI, all report tabs and the Vendors dashboard — no page errors.

- Done-when, each backed by a test:
  - Full cycle request -> approval -> 2 quotations + comparison (EUR quote converted) -> PO from quotation -> threshold + named-approver approval -> goods receipt (with rejected qty) -> landed cost -> three-way-matched invoice -> payment; every entry checked line by line (inventory/GRNI, GRNI/input tax/AP, AP/bank).
  - Payables control = supplier sub-ledger after every scenario (aging unassigned 0, per-supplier aging = ledger, AP reconciliation 0, integrity clean, every entry balances).
  - Three-way match blocks a mismatched invoice (qty + price) with 409 `three_way_mismatch`, nothing posted; approval needs `approve_purchase_mismatch` and a reason; tolerance settings (qty/price) respected; over-receipt refused.
  - Landed cost changes item cost correctly by value (100/15.20 -> 11.00 and 4.40), by quantity and by weight (typed kg or product weight).
  - Payables aging matches the ledger (all buckets, as of a past date), Excel export opens with Arabic.
- Also: EUR supplier on the Prompt 5 engine (GRNI at the receipt rate, AP at the invoice rate, PPV for the rate move, realized FX loss on payment, reversal reopens), payables revaluation through `/api/currency/revaluations` (AP side, auto-reversal), debit notes (stock down, no base dust), expense invoices, supplier opening balances (reclass of a lump AP opening balance), atomicity (receipt / invoice / payment fault injection), permissions, and the tenant-ref rule on every supplier-facing endpoint (28 foreign-id checks + supplier party on manual entries).
- API: `/api/purchasing` — suppliers (+statement xlsx/pdf, price history), requests (submit/approve/reject/cancel, comparison), quotations, orders (submit/approve/reject/cancel/receive), receipts, invoices (match, approve-mismatch, post), payments (auto-allocate, allocations, reverse), debit notes, opening-balances, reports (aging xlsx/pdf, reconciliation, ppv, purchases by supplier/item, ratings), dashboard, settings (approval threshold, tolerances).
- Files added: `backend/db/purchasingSchema.js`, `db/migrations/0014_split_fx_accounts.js`, `0015_purchasing.js`, `lib/purchasing.js`, `lib/payables.js`, `routes/purchasing.js`, `test/purchasing.test.js`, `frontend/src/pages/purchasing/{PurchasingPage,SuppliersPage,PayablesReportsPage,purchasingShared}.jsx`.
- Files changed: `lib/ledger.js` (system keys, source-reverse messages), `lib/tenantRefs.js` (purchasing refs; supplier party now resolves to `suppliers`), `lib/currency.js` (payables in revaluation, balances by currency, FX report), `lib/departments.js` (activeVendors / incomingPurchases / payables computed, `tracked` flipped, keys kept), `lib/financialReports.js` (month-end: AP reconciliation, mismatched invoices, uninvoiced receipts), COA templates, permissions, `server.js`, `docs/posting-map.md` §10, frontend routes/NAV (accounting group)/translations/department tiles.
- Tables: suppliers, supplier_price_history, purchase_requests(+lines), supplier_quotations(+lines), purchase_orders(+lines), goods_receipts(+lines), supplier_invoices(+lines), landed_cost_allocations, supplier_payments, supplier_payment_allocations, supplier_debit_notes(+lines), ap_fx_settlements.
- System accounts: input_tax (1180), grni (2160), purchase_price_variance (5900, cogs).
- Permissions: view_purchases, create_purchase_requests, approve_purchase_orders, receive_goods, post_supplier_invoices, make_supplier_payments, approve_purchase_mismatch, manage_suppliers (granted to owners by 0015).
- Dependencies added: none.
- Decisions:
  - Item cost until Prompt 8 = moving weighted average on `products.cost_price` (base, major units) over `factory_inventory` quantity (company-level stock); receipts add to `factory_inventory` (row created per product when missing). Landed cost spreads over the qty on hand (or the received qty when none is left). Prompt 8 replaces both with the stock ledger.
  - GRNI is cleared at the receipt value (FIFO over the PO line's receipts); ~~PPV takes everything else, including the exchange-rate move~~ — split after Prompt 6 (see below): price -> PPV, rate -> fx_realized. An approved over-invoice (qty beyond receipts) goes to PPV, not inventory.
  - PO approval: threshold 0 (default) = every PO needs approval; at/under a set threshold POs auto-approve on submit; a named approver (`approver_user_id`) must approve their own PO. Separation of duties added after Prompt 6 (see below); multi-level rules remain a PROMPT 13 HOOK.
  - Payments credit `cash_default` (cash) or `bank_in_transit` (transfer/cheque) until Prompt 7's bank accounts; issued cheques are not tracked separately.
  - Debit notes credit inventory at the invoice value, not the receipt + landed value (difference stays in inventory until Prompt 8 valuation).
  - Supplier opening balances (not in the prompt): the ledger opening-balances screen cannot name a supplier, so AP opening balances landed unassigned and broke "AP = sub-ledger" on real data (seen on the demo DB). New tool spreads them onto suppliers as `opening` invoices.
- Limitations: no supplier cheques register / bank reconciliation (Prompt 7); no multi-warehouse stock (stock is company-level); the separate Vendors app still has no screens of its own (uses this backend later); quotations are entered manually (no RFQ e-mail).

## After Prompt 6 — small commits (before Prompt 7)
- `0bb9f92` CI: `.github/workflows/ci.yml` (Node 22, push + pull_request): backend `npm ci` + `npm test`, frontend `npm ci` + `npm run build`. Green on 0bb9f92 (result posted on PR #1). Tags `prompt-1-done`..`prompt-6-done` exist locally only — the session's git proxy refuses tag pushes (HTTP 403); branch pushes work.
- `546d593` Purchasing separation of duties, company setting `enforce_purchasing_separation` (default ON, changeable only with `manage_settings`, audited): the PO creator cannot approve it (`sod_po_creator`; rejecting is still allowed); the user who posted a supplier invoice cannot pay it (`sod_invoice_poster` on an explicit allocation; auto-allocation skips that invoice and leaves the payment as an advance). Applies to opening-balance bills too (the user who posted them). Tests ON and OFF (`test/purchasingSeparation.test.js`). No settings screen yet — API `PUT /api/purchasing/settings { enforcePurchasingSeparation }`. Risk: a one-user company must switch it off or add a second user before any PO can be approved.
- `2694290` Goods invoice difference split: price (invoice amount at the receipt rate − GRNI) -> PPV; rate (invoice rate vs receipt rate on the same qty) -> `fx_realized` (crystallised into AP at posting = realized; FX report lists it as realized with the invoice); dust -> `rounding_difference`. Column `supplier_invoice_lines.fx_base_minor` (migration 0016). `test/purchasingFxSplit.test.js`.
- `625ed96` Goods receipt and physical stock, stated and tested (`test/purchasingStock.test.js`): accepted qty added to the product's existing `factory_inventory` row in the same transaction as the entry (checkpoints before and after the entry, both roll back fully); invoice and landed cost never move qty; debit note with returned goods removes it. Gap found and fixed: the inventory screen could add a second stock row for a product that already had one (double count) — now 409 `product_already_in_inventory`.
- `b3dc56c` Supplier opening balances: undated rows (no bill/due date) age in a `legacy` bucket like customer_opening (included in payables "overdue"); new open-bills import `POST /api/purchasing/opening-balances/bills` (supplier, bill number, bill date, due date, amount) with a per-supplier sum check against typed opening balances (`supplier_sum_mismatch`, all-or-nothing), screen on Suppliers -> opening balances (paste from a spreadsheet). `test/supplierOpening.test.js`.

## Prompt 7 — Cash boxes, banks, vouchers, cheques (done)

Gate: backend 249/249 (234 before + 15 in `test/treasury.test.js`), ledger_live golden test unchanged (`ledgerLiveFlag.test.js` byte-identical), frontend build OK. Migrations 0016–0017 applied to a copy of the baseline-cfd63a6 DB: schema identical to a fresh init (626 schema lines); integrity check clean on the migrated copy and on the demo company. Browser check (Chromium, Arabic RTL) on a freshly seeded demo company: boxes list + new bank account (ledger account 1121 created), voucher draft, self-approval refused with the Arabic separation-of-duties message, issued cheques, rep cash, daily report, bank statement CSV upload -> column mapping -> import -> exceptions view, received cheques with currency, collections form with currency; daily-cash Excel export opens (xlsx). No page errors except the two expected 409 refusals.

- Done-when, each backed by a test (`test/treasury.test.js`):
  - Every voucher / transfer / cheque event posts a balanced entry: RV, PV, EV (with input tax), BF, same-currency TR, cross-currency TR, voucher reversal, cheque issue (supplier and account), clear, bounce, cancel, received-cheque clear, rep handover and its reversal — each entry asserted line by line and balanced; integrity check clean after each scenario.
  - Bank reconciliation: CSV import with auto column mapping; 4 of 6 lines auto-matched (100 % for amount + date + cheque reference); exceptions = exactly the unbooked fee and the unknown deposit; outstanding book item (USD 12 transfer) listed; report difference 0; manual match after booking the fee, ignore / un-ignore, amount mismatch refused, a ledger line cannot be matched twice, a reconciled voucher cannot be reversed; two equal candidates -> "suggested", not auto.
  - Cheque bounce reverses correctly: issued supplier cheque bounce reverses the supplier payment (AP owed again, invoice open again, notification); received EUR cheque bounce restores the customer balance exactly; a cleared cheque cannot bounce.
  - Cross-currency transfer posts an FX line when needed: USD 240 -> EUR 195 at 1.20 posts 6.00 to `fx_realized`; no FX line for same-currency or rate-converted transfers.
- Owner's extras:
  - Rep collections in a foreign currency: `currencyCode` on the collection; the rate is locked at confirmation (`collection_fx`, rate + base + locked_at/by); the entry and the Prompt 3 receipt carry the currency at that rate. Kept out of the `collections` table so base collections are byte-identical (golden test). Refused (409 `foreign_collection_requires_ledger`) on a company that is not ledger-live.
  - Received cheques in a foreign currency: rate locked when recorded; clearing into a bank box in the same currency books the rate difference to `fx_realized`; a foreign cheque must clear into a box.
  - Cash boxes per currency: each box/bank its own ledger account; foreign box accounts are locked to their currency; balances shown in the box currency and in base.
  - Rep cash handover per currency (setting `rep_cash_handover`, default OFF = old behaviour): confirmed rep cash sits on `rep_cash_custody` per rep; one handover per rep per currency; over/short per currency to `cash_over_short`; rate difference to `fx_realized` (test: EUR 150 expected, 148 counted, short 2.50, FX gain 7.50; USD over 1.00).
  - Failure injection on every money path: voucher approve / reverse, cheque issue (supplier and account), clear, bounce, cancel, received-cheque record and clear, foreign collection confirm (both checkpoints), handover and its reversal — each armed and asserted to leave entries, lines, documents and statuses unchanged, then succeeds once unarmed.
  - Vouchers use the same separation-of-duties setting (`enforce_purchasing_separation`): creator cannot approve (`sod_voucher_creator`); supplier cheques inherit the "poster cannot pay" rule through the supplier payment.
- Also: per-user box access (`cash_box_users`; without `manage_cash_boxes` a user sees/uses only assigned boxes); due-cheques alert sweep every 15 min (received and issued, `cheque_due_alert_days`, default 3; one unread notification per cheque); daily cash report per box with Excel; permissions `view_treasury`, `manage_cash_boxes`, `create_vouchers`, `approve_vouchers`, `manage_cheques`, `reconcile_bank` (migration grants them to manage_permissions holders); tenant-ref test covering every treasury endpoint (boxes, users, vouchers incl. employee party, cheques, handovers, rep-cash items, daily report, statements, lines, journal line, received-cheque clear box).
- Schema (migration 0017, `db/treasurySchema.js`): `cash_boxes`, `cash_box_users`, `treasury_vouchers`, `cheques_issued`, `bank_statements`, `bank_statement_lines`, `rep_cash_handovers`, `rep_cash_handover_items`, `collection_fx`; columns on `cheques_received` (currency, original, rate, cash_box_id, clear_fx_minor). System accounts: `rep_cash_custody` 1112 (report class current_asset — rep-held cash counts as cash only once handed over), `cheques_payable` 2125, `cash_over_short` 6960, `bank_charges` = the template's 6900. Screens: `/treasury` (boxes, vouchers, issued cheques, rep cash, daily report), `/treasury/bank` (import, review, report); received-cheques screen gains currency + clear-into-bank; collections form gains currency.
- Decisions / limits:
  - Received cheques keep their Prompt 3 statuses (in_portfolio = received, deposited = in transit, cleared, bounced); "cancelled" exists only for issued cheques — changing the received-cheques CHECK constraint would need a table rebuild (not additive).
  - Vouchers cannot hit control accounts (AR, AP, GRNI, inventory, cheque/custody accounts, taxes); customer and supplier money goes through receipts / supplier payments / cheques so the sub-ledgers stay equal to control.
  - Collection `amount` (base, REAL) is overwritten with the locked base at confirmation for foreign collections, so older screens keep showing a consistent base figure.
  - Foreign cash/bank boxes (and the foreign lines on cheques payable / in portfolio / rep custody) are revalued by the existing Prompt 5 period-end tool, which already covers every foreign asset/liability account balance (test: EUR bank appears in the revaluation preview at the closing rate).
  - No purchasing/treasury settings screen for the separation-of-duties toggle (API only); treasury settings (rep cash handover) have a toggle on the rep-cash tab.

### Prompt 7 requirement -> test (`T` = test/treasury.test.js, `T2` = test/treasuryMore.test.js, `S` = test/sodAdaptive.test.js, `G` = test/ledgerLiveFlag.test.js)

| Requirement | Test |
|---|---|
| Multiple cash boxes / banks, each on a ledger account with a currency | T "cash boxes per currency: main box on cash_default, new boxes get their own ledger account…" |
| Per-user access to specific boxes | T "cash boxes per currency … per-user access" |
| RV / PV / expense vouchers / bank fees log post balanced entries | T "vouchers RV / PV / EV / BF post balanced entries on approval…" |
| Transfers incl. cross-currency with an FX line when needed | T "transfers: same currency (no FX line) and cross-currency…" |
| Cheques issued: issued / in transit / cleared / bounced / cancelled; bounce reverses correctly | T "cheques issued: to a supplier…, clear, cancel, bounce reverses correctly; foreign cheque clears with an FX line" |
| Cheques received (incl. foreign currency, rate locked); bounce reverses | T "received cheque in a foreign currency: rate locked at recording…; bounce reverses the receipt" |
| Due-cheques alert (notifications + sweep) | T "due-cheques alert: one unread notification per due cheque…" |
| Bank statement import, auto-match with confidence, exceptions only, reconcile, report | T "bank reconciliation: import CSV, auto-match with confidence, exceptions only for review…" |
| Re-import creates no duplicate lines | T2 "re-importing the same bank statement creates no duplicate lines…" |
| Same-amount lines on one day match correctly | T2 "several same-amount bank lines on one day…" |
| Rep collections in foreign currency, rate locked at confirmation | T "rep collections in a foreign currency: rate locked at confirmation; base collections unchanged" |
| Rep cash handover per currency, over/short per currency | T "rep cash handover per currency: custody per rep, over/short per currency…" |
| Flag-off behaviour of existing collections unchanged | G (golden snapshot) + T "collections in a foreign currency need the ledger…" |
| Daily cash report per box | T "daily cash report per box…" |
| Cash boxes = ledger cash (property) | T2 "property: across 120 random treasury operations…" |
| Foreign boxes revalued | T "foreign boxes are revalued by the existing period-end tool…" |
| Failure injection on every money path | T "failure injection: every money path rolls back completely…" |
| Vouchers under separation of duties (adaptive + break-glass) | T "vouchers RV / PV / EV / BF … separation of duties", S both tests |
| Permissions | T "permissions: treasury endpoints are refused…" |
| Tenant refs on every endpoint | T "tenant refs: every treasury endpoint rejects another company's ids" |

## After Prompt 7 — small commits (before Prompt 8)
- `341964e` Separation of duties is adaptive: enforced per step (PO create→approve, invoice post→pay, voucher create→approve) only when the setting is on AND another active user holds the second-step permission (= 2+ active users for that step); a one-user company operates normally. Owner break-glass (manage_permissions holder) with a written reason ≥ 10 characters: allowed, `sod.break_glass` audit row (reason, step, rule), notification to the company; non-owners get `break_glass_owner_only`. Screens retry with a reason prompt when the server offers break-glass. New "Approval controls" screen `/purchasing/settings` (threshold, tolerances, separation toggle, per-step status with who holds each side). Tests `test/sodAdaptive.test.js`.
- `d12a7da` Go-live switches `rep_cash_handover` ON (listed in the dry run's `settings_changes`, audited `ledger.go_live.setting`); a non-live company cannot switch it on (409).
- Checkpoint branches `checkpoint/prompt-1-done` … `checkpoint/prompt-7-done` pushed (tags still refused by the proxy).
- `5b6e062` One stock row per product per holder table (`factory_inventory`, `car_inventory` — both company-level until Prompt 8): unique partial indexes; migration 0018 merges existing duplicates only after a recorded dry run (`node scripts/inventory-dedupe.js`) whose fingerprint still matches — quantities summed into the oldest row, merged rows archived whole (`inventory_merged_rows`), one audit row per group, notifications repointed; startup never merges. Writers (custody transfer, return restock, offline count) now match by product (`lib/holderStock.js`), not name. Tests `test/inventoryDedupe.test.js` on seeded duplicates.
- Bank statement re-import adds no line twice (occurrence-counted; whole duplicate -> 409 `statement_already_imported`). Auto-match bug fixed: identical same-amount lines were judged ambiguous only while candidates remained, so the last one was auto-"matched" arbitrarily; ambiguity is now judged on the full candidate set (all three become suggestions). Tests `test/treasuryMore.test.js` incl. a 120-operation property test (box balances = ledger cash accounts, per box in its currency).

## Prompt 8a — Stock ledger and valuation (done)

Gate: backend 268/268 (+ test/stockLedger.test.js 7, test/stockLedgerProperty.test.js 3, test/warehouseGolden.test.js 2), warehouse golden and ledger_live golden unchanged, frontend build OK. Migrations 0016–0019 on a copy of the baseline-cfd63a6 DB: schema identical to a fresh init (660 lines), integrity clean. Browser (Arabic RTL): /stock dry run -> activate -> valuation / moves / reconciliation; factory screen after activation writes moves; approval controls screen; no page errors.

- Step 1, before any warehouse change: `test/warehouseGolden.test.js` + `fixtures/warehouseScenario(.golden).json` — factory/car screens (create, duplicate refusal, edit, quantity, alerts, delete), a stock count, a custody transfer with a resolved discrepancy, returns restock, offline count; recorded at 37e8948, replayed at d12a7da (before the one-row-per-product change): identical except one autoincrement id the old name-keyed upsert used up. Found and fixed on the way: an invalid count classification made the count-confirm request hang forever (unhandled rejection) -> now 400.
- Stock ledger (`lib/stockLedger.js`, `lib/stockDocs.js`, `db/stockSchema.js`, migration 0019): `stock_moves` per product per HOLDER (warehouse / vehicle / rep / car pool), `stock_pools` (qty + value per holder), `stock_layers` (FIFO, origin kept through transfers), `stock_move_layers`, method per company or category (average default, FIFO, standard with `product_standard_costs`; method locked while a product holds stock), daily `stock_reconciliation_checks`, activation runs. System accounts `inventory_custody` 1155, `inventory_adjustments` 5800, `inventory_wastage` (food template 5500 / else 5550). Permissions `view_stock_valuation`, `manage_stock_ledger`.
- Activation per company, dry run first (24 h, fingerprinted plan; refused on negative quantities, missing standard costs, no open period; warnings for rows without a product or cost). Executing posts the opening moves and one `inventory_opening` entry -> the inventory banner on IS/BS goes away (also when the opening delta is zero/credit).
- Every writer wrapped, same transaction, only when activated: factory/car screens (create / edit / quantity / delete), stock counts (`count` moves with the count's reason), offline counts, custody transfer close (warehouse -> vehicle/rep at cost; retry endpoint `/custody-transfers/:id/close` when the move is refused), returns restock (filing rep's custody), goods receipts, landed costs, debit notes, sales invoices, credit notes with restock. Postings: docs/posting-map.md §12.
- Debit notes at the ORIGINAL cost layer incl. landed cost (owner's Prompt 8 item): FIFO consumes the receipt's own layers (landed cost was added to those layers); average uses (receipt value + landed share) / qty; difference vs invoice value -> purchase price variance. Tests: FIFO 4 x 6.00 = 24.00 out vs 20.00 invoiced (PPV 4.00); average 5 x 3.70 vs 17.50.
- Daily reconciliation in the 15-minute sweep (once per company per day), notification on failure; endpoint `/api/stock/reconciliation`.
- Property test (`test/stockLedgerProperty.test.js`), 200+ moves per method through real documents (receipts, landed costs, supplier invoices, debit notes, sales, credit notes, transfers between 2 warehouses / a vehicle / the car pool, adjustments, counts): after EVERY operation Σ moves = Σ pools = inventory + custody accounts, each account = its holders, screen quantities = moves, no negative holder, FIFO layers = pools, entries balance; plus an independent costing oracle replaying all moves (average out = replayed average; standard = std × qty; FIFO = oldest open layers in order). The oracle was added after a mutation (average out +1 minor unit) passed the first version unnoticed; with it, that mutation and a FIFO newest-first mutation both fail.
- Decisions / limits:
  - Standard cost lives in `product_standard_costs`, not a products column (a new products column changed the products API response and broke the golden).
  - Non-product lines on a goods receipt are refused once the stock ledger is active (they would put value into inventory with no stock) — use an expense invoice.
  - A custody transfer is refused (409, transfer stays confirmed, retry via /close) when the source warehouse lacks the stock.
  - Landed cost under average with the receipt holder empty, and under standard, goes to COGS / PPV rather than stock.
  - No negative stock in any method.
  - Wastage/damage documents, lots, FEFO, reports and the item card are 8b; in 8a a damage write-off is an adjustment with a reason (posted to `inventory_adjustments`).

## Prompt 8b — Lots, expiry, FEFO, counts, wastage, reorder, trace and recall (done)

Gate: backend 276/276 (+ test/stockLots.test.js 8), stock ledger tests, property test (3 methods × 200+ moves) and both goldens unchanged, frontend build OK. Migrations 0016–0020 on a copy of the baseline DB: schema identical to a fresh init (676 lines), integrity clean. Browser (Arabic RTL, demo DB): lots / counts / wastage / reports tabs, count created and approved from the screen, wastage document listed, item card `/stock/items/:id`, reconciliation still matched; no page errors.

- Schema (`db/stockLotsSchema.js`, migration 0020): `product_stock_settings` (track_lots, reorder point / qty — a side table, the products API stays byte-identical), `stock_lots` (code, expiry, production date, supplier, supplier lot, status available / quarantine / rejected / expired), `stock_lot_balances` (qty per lot per holder; cost stays in the holder's pool), `stock_counts` + lines, `stock_documents` + lines (wastage, repack). Permissions `manage_stock_counts`, `approve_stock_counts`, `post_stock_wastage`, `manage_lots` (granted to manage_permissions holders).
- Lots: a tracked product needs a lot on the goods receipt line (lotCode, expiryDate, productionDate, supplierLot). Turning tracking on for a product that already holds stock puts that stock in an `UNASSIGNED` lot.
- FEFO: every stock-out (sale, transfer, purchase return, count shortage, wastage) picks the earliest-expiry AVAILABLE lot first, splitting across lots; quarantined / rejected / expired lots are never picked. Purchase returns prefer the receipt's own lots; a credit-note restock goes back to the lot it was sold from.
- Counts: draft (expected = balance now, per lot for tracked products, reason code required on any difference) -> approve (posts against the CURRENT balance; one entry Dr/Cr holder inventory account vs `inventory_adjustments`) or reject. Separation of duties: new SOD kind `count` (manage_stock_counts / approve_stock_counts) through the same adaptive guard and owner break-glass as PO / payments / vouchers.
- Wastage (damage / expiry / loss / theft / other): Dr `inventory_wastage` / Cr the holder's inventory account. Repack / reclassification: out of one product, into another at the same value (standard-cost target: difference to PPV).
- Reorder: available = warehouse on hand − reserved (approved / processing / out-for-delivery orders) + open PO quantity; suggestion when available ≤ reorder point. Alerts in the 15-minute sweep, one unread notification per subject: `lot_expired` (lot marked expired), `lot_near_expiry` (setting `expiry_alert_days`, default 30), `reorder_needed`.
- Trace: forward (lot -> receipts -> holders -> customers, net of returns), reverse (customer or invoice -> lots -> supplier lot / receipt), recall report (every customer that received the lot with phone and documents, quantity still in stock and where to pull it from).
- Reports (`/api/stock/reports/:name`): item balance (with reserved / available), stock ageing, slow-moving, near-expiry, count variances, inventory cost, turnover, product profitability, wastage analysis; plus `/api/stock/reorder`. Item card `/api/stock/items/:id` (balances per holder, cost, reserved, on order, lots, suppliers with last price, 90-day sales / margin, latest moves, lot and reorder settings).
- Found and fixed on the way: stock errors raised inside sales / purchasing documents (lot required, insufficient valid lots) surfaced as a generic `request_failed`; those routes now return the stock error code. The demo DB needs `node db/migrate.js` (the server does not migrate on start).

### Prompt 8 requirement -> test (`L` = test/stockLedger.test.js, `P` = test/stockLedgerProperty.test.js, `K` = test/stockLots.test.js, `W` = test/warehouseGolden.test.js)

| Requirement | Test |
|---|---|
| Valuation total = ledger inventory after 200 random moves per method | P: `average` / `fifo` / `standard` property tests (oracle + per-step reconciliation) |
| Count adjustment posts correct entries | L: activation/count test; K: `count approval posts the differences; separation of duties…` |
| Damage write-off posts correct entries | K: `wastage posts Dr inventory_wastage / Cr inventory; repack keeps the value` |
| Transfer posts correct entries | L: transfers test (custody transfer + transfer document) |
| FEFO picks the earliest expiry | K: `FEFO picks the earliest expiry first and splits across lots; quarantined lots skipped`; expired skipped in the expiry-sweep test |
| Recall lists every customer that received the lot | K: `recall lists every customer that received the lot (net of returns); reverse trace…` |
| Existing warehouse screens and custody transfers still pass | W: warehouse golden (both tests) + the full suite |
| Opening stock valuation entry, banner gone | L: `activation: … inventory_opening entry, banner gone` |
| Debit note at the original cost layer incl. landed | L: purchasing test (FIFO and average) |
| Reorder alerts, expiry alerts | K: `reorder suggestion + alert; expiry sweep…` |
| Reports, item card | K: `reports and item card` |
| Tenant refs / permissions | L + K: `tenant refs and permissions` |

- Not done in Prompt 8 (honest list): serial numbers (`track_serial`) — no table or screen yet; production batches belong to Prompt 9; reserved stock is reported and used in reorder, but does not yet block a sale of reserved quantity.

## After Prompt 8 — small commits (before Prompt 9)

- CI for 46efa6f (8b): green on all three runs (push, checkpoint branch, PR #1).
- Pending-migrations guard: `db/migrationStatus.js`. A brand-new database built by init.js is stamped with every migration (verified: fresh init and fresh init + migrate.js give the same schema and the same rows apart from timestamps). With any migration pending, the server answers 503 `migrations_pending` (naming the files) to every request except `/api/health`, logs `REFUSING TO SERVE` and starts no sweeps; it never auto-migrates. `/api/health` returns `schema_version`, `applied_migrations`, `pending_migrations`, `pending` (503 while pending). `scripts/deploy.sh`: `VACUUM INTO` backup (integrity-checked) -> `node db/migrate.js` -> `exec node server.js` (`--no-start` stops after migrating); stops at the first failure. Test: test/migrationGuard.test.js (in-process 503s, a real `node server.js` refusal, deploy backup = pre-migration state, app unblocks after migrate, second deploy is a no-op).
- Stock-count variance test, exact: gain (+3 × 3.00: Dr inventory 9.00 / Cr inventory_adjustments 5800 9.00) and loss (−5 × 3.00: the reverse, 15.00) — account codes, sides, amounts, move rows, pool qty/value, screen quantity, report rows; rejected count: no move, no entry, balances unchanged, cannot be approved later. Mutation (adjustment side off by 1 minor unit) fails it.
- Activation dry run lists every product with stock and a missing / zero cost (`cost_issues`, warehouse + car stock summed) and blocks activation (`cost_missing`) until the cost is entered or the zero value is acknowledged with a reason ≥ 10 characters (`POST /api/stock/activation/cost-acknowledgements`, table `stock_cost_acknowledgements`, migration 0021, audit `stock.activation.zero_cost_ack`). Shown on the stock Setup tab with an acknowledge button. Test: test/stockActivationCost.test.js.
- Property test extended (test/stockLedgerProperty.test.js): one product lot-tracked from the start (receipts carry lots), wastage documents and approved count documents added to receipts / landed / debit notes / sales / credit notes / transfers / adjustments / counts; after every operation, per holder: sum(lot balances) = sum(moves) = pool row, each lot's balance = its moves, no negative lot. Mutation (lot balance +0.5 on large deltas) fails all three methods.
- `track_serial`: there is no such field anywhere in the UI or the API (nothing to hide); recorded as a known gap below.
- Go-live dry run shows the stock mode (`stock_mode`): stock ledger (custody transfers reduce warehouse stock) or legacy. Test in test/stockActivationCost.test.js.

## Before Prompt 9 — SQLite transactions (925ac85)

- **WAL and busy timeout:** journal mode is WAL; busy timeout is 5000 ms from one constant, `db/sqliteConfig.js`. The server, `scripts/backup.js` (which now also honours ATLAS_DB_PATH), `scripts/deploy.sh`, the go-live backup check and the tests all use it.
- **What was wrong:** the `db.transaction` shim used a deferred `BEGIN`, and `ledger.tx` used a top-level `SAVEPOINT` (also deferred). Both could start as a read and upgrade to a write; in WAL mode that upgrade fails immediately with `SQLITE_BUSY_SNAPSHOT`, which no timeout fixes.
- **Fix:** both helpers now start with `BEGIN IMMEDIATE`; nested ledger calls keep using savepoints.
- **Test:** `test/sqliteLocking.test.js`.
  - Both helpers hold the write lock before their first write; this fails with a deferred `BEGIN`.
  - A request waits about 1 s for another process's write lock and then succeeds.
  - `deploy.sh` waits for a held lock too.
- **CI:** 925ac85 ran green three times: #23 attempts 1–3, plus #24 on the PR.

## Prompt 9 — Manufacturing for nuts and mixes (done)

Gate summary:
- **Tests:** backend 299/299, including:
  - `test/manufacturing.test.js` (11);
  - `test/migration0022.test.js`;
  - `test/productionGolden.test.js`, recorded before any production code (feb91d2, CI green #25/#26).
- **Goldens:** the warehouse, ledger_live and production goldens are unchanged.
- **Frontend:** the build is OK.
- **Migrations:** 0016–0022 on a copy of the baseline DB give a schema identical to a fresh init (714 lines), with integrity clean.
- **Demo DB with real rows:** 0022 kept all stock moves, foreign keys are clean, reconciliation is OK, and the schema is identical.
- **Browser:**
  - all six tabs of `/manufacturing`;
  - the order flow, driven through the UI: release → FEFO issue → output recorded on the workshop tablet (`/manufacturing/floor`, sent through `/api/sync/batch`) → close;
  - stock reconciliation still matched; no page errors.

- **Schema** (`db/manufacturingSchema.js`, migration 0022; no new columns on existing tables):
  - recipes and immutable versions;
  - components, with loss per stage in basis points;
  - by-products and secondary outputs;
  - effective-dated cost inputs (`mfg_cost_rates`);
  - product allergens and quality checks;
  - plans and plan lines (production / sanitation);
  - production orders, their materials and events (issue / return / output / by-product / wastage / rework, with a `client_key` for offline idempotency);
  - QC results and order cost lines (each with the rate row used).

  0022 also adds the system accounts `wip`, `production_labour`, `production_overhead` and `production_energy` (adopting the food template's 1152 / 5300 / 5400), seven permissions, and widens two CHECK lists by table rebuild: `stock_moves.move_type` gains the production moves and `sync_operations.entity_type` gains the tablet types.
- **Quantities:**
  - Component quantity is NET; gross = net / (1 − sum of stage losses), rounded to 0.001.
  - Multi-level: a component with its own recipe is an intermediate. MRP explodes its shortfall, and a recipe can never contain itself.
- **Versions:** a version becomes immutable once a production order uses it (`version_locked`). Changes go through "copy as new version" and activate; activating archives the previous version.
- **Costs:**
  - Every input is effective-dated: material price, labour per hour, energy and overhead per kg / hour / batch (the allocation basis), and by-product value.
  - Theoretical cost prices materials at the latest purchase, the stock average, or the effective material rate.
  - Actual cost is the issued lots' cost (stock ledger, FEFO) plus labour at actual hours, energy and overhead at the rates in effect on the production date, minus by-products.
  - Output below expected is abnormal loss and goes to `inventory_wastage`.
  - Reports cost per unit and per kg, yield, and margin at a selling price.
  - Rates are insert-only; a rate used by a closed order cannot be deleted.
- **Flow:**
  - **Plan:** allergen sequencing, MRP (required vs available = on hand − reserved by open orders, with the shortfall marked produce or purchase), and a purchase request into Prompt 6.
  - **Order:** release (materials reserved; refused when short; QC pending if the product has checks, including checks defined later) → FEFO issue (a lot can be named) → output / by-products / wastage per stage / rework / labour hours.
  - **Close or reject:** QC (range or pass/fail) → close (new lot = order number or a given code; expiry = production date + shelf life, else the earliest component expiry; quarantine receipt allowed when QC failed), or reject (everything written off). Postings: docs/posting-map.md §13.
- **Allergens:**
  - Per-product flags: contains or may contain (milk, peanuts, tree nuts, sesame, gluten, soy, eggs, other).
  - The effective set includes components, recursively.
  - Sequencing rule: allergens produced since the last sanitation step stay on the line, so a product that does not itself contain one gets a warning. The suggested order lists the product with the fewest allergens first.
  - Confirming a plan that breaks the rule needs a written override reason (audited).
  - The label declaration is in ar/en and points to the existing `/api/products/:id/barcode` instead of duplicating it.
- **Lot trace both ways:**
  - Forward and recall: a component lot reaches the customers of the lots produced from it, recursively.
  - Reverse: customer → produced lot → component lots → supplier lots and suppliers.
- **Certificate of analysis:** new document type `coa` in the document-template system (HTML, or PDF where Chromium is available).
- **Workshop tablet:** `/manufacturing/floor` has large touch targets for issue, output and wastage. Records go through `/api/sync/batch` (entity types `production_issue` / `production_output` / `production_wastage`), are queued locally while offline, and replays are idempotent; they require `record_production`.
- **Reports:** batch cost, yield vs expected, wastage, raw-material consumption, cost variances (actual vs theoretical), and product / customer profitability including production cost.

### Prompt 9 requirement -> test (`T` = test/manufacturing.test.js, `G` = test/productionGolden.test.js, `M` = test/migration0022.test.js, `L` = test/sqliteLocking.test.js)

| Requirement | Test |
|---|---|
| Premium-mix example reproduces by hand-calculation to the minor unit | T: `premium nuts mix: theoretical cost…` (component quantities, losses, prices, labour / energy / overhead, by-product, total 1,129.31, per kg 11.29, margin 6.71 = 37.28%) and `production order: … close posts exactly the hand-calculated entry` (actual 1,135.22, abnormal 22.66, finished goods 1,110.16, 11.33 / kg, margin 6.67 = 37.06%, every line of the closing entry) |
| A version used in an order cannot be edited | T: production order test (`version_locked`; copy → v2 editable) |
| MRP flags shortages | T: `MRP flags shortages over several levels…` (intermediate produced, components purchased, purchase request, release refused when short) |
| Wastage and by-products post to the correct accounts | T: close entry (by-product → inventory, abnormal loss → 5500 wastage, WIP / labour / energy / overhead cleared); `rejected batch writes everything off to inventory_wastage…` |
| Lot trace works both ways | T: `lot trace both ways…` |
| Allergen sequencing warns on violation | T: `allergen sequencing warns on violation…` |
| Lots / FEFO from 8b for production batches | T: issue takes the earlier-expiry almond lot first; output into a new lot with expiry |
| Effective-dated cost inputs (Prompt 16) | T: future labour rate not used, no rate before the effective date, rate rows stored per cost line, used rate not deletable |
| Failure injection on every money path | T: `failure injection: issue, return, close and reject roll back completely` |
| tenantRefs on every client-supplied id | T: `tenant refs and permissions` (19 endpoints) |
| Existing production behaviour unchanged (flag-off goldens) | G + warehouse / ledger_live goldens |
| Tablet works with offline sync | T: `workshop tablet…` (idempotent replay, permission) |
| Migration rebuild keeps rows | M |

- Not done / limits:
  - **Label output:** no printable label layout; the declaration text and the existing barcode endpoint only.
  - **Rework:** recorded as a quantity (yield report); there is no separate rework order.
  - **MRP:** availability ignores open purchase orders (on order) and sales reservations; it uses warehouse stock minus open production reservations.
  - **Cost bases:** the "hour" basis for energy / overhead uses labour hours (machine hours are stored but not used yet).
  - **Production requests:** existing production requests (from order shortages) are not linked to production orders.
  - **Customer profitability:** only invoices carrying stock moves have a cost; for products sold before the stock ledger was active, the cost is unknown.

## After Prompt 9 — small commits (before Prompt 10)

| Commit | What | CI |
|---|---|---|
| 74e6fb6 | The 2.40 between (actual 1,135.22 - abnormal loss 22.66 = 1,112.56) and finished goods 1,110.16 is the documented by-product credit (1.2 kg broken nuts x 2.00); it is its own line in the closing entry (Dr 1153 2.40 "منتج ثانوي"); the test now asserts the identity, the by-product line and its stock value. Not a bug. | green #30 push, #31 PR |
| 78aaca9 | MRP: open purchase orders due by the plan date (expected date on or before it, or none) reduce the shortfall; later ones are shown, not netted; open purchase requests (draft / submitted / approved) are subtracted before a new request, so running MRP twice never asks twice (409 `no_shortage`); open sales reservations as demand, optional per company (`/api/manufacturing/settings`, off by default, audited). Test: re-run with no duplicate, PO in transit, multi-level still correct, sales reservations on/off. | green #32 push, #33 PR |
| 3e0d206 | Production order from a production request (`POST /api/manufacturing/orders/from-request/:id`): batches = shortage / batch output unless given; one order per request (`mfg_order_requests`, UNIQUE, migration 0023); request -> in_production, back to pending when the order is cancelled, ready when it closes; closed / cancelled requests refused (the close -> ready step is in code but not covered by a test). | green #34 push, #35 PR |

- PR #1 title and description updated to Prompts 1–9. From Prompt 10 on, updating the PR title / description and BUILD_PROGRESS is part of every prompt's "Done when".

## Prompt 10 — Fixed assets, tax codes, adjusting and recurring entries (done)

Commits: f85d61e (tax golden, before any code), 57a5f1e (backend + tests), d74c1b0 (UI), this docs commit.

- **Tax codes** (`lib/taxCodes.js`, `manage_tax_codes`):
  - a table of codes (code, name, sales / purchase, tax account) with effective-dated rates; no rate is hardcoded;
  - sales invoice, credit note and supplier **expense** invoice lines may name a code: the rate in effect on the document date applies, and the tax posts to the code's account;
  - price mode from `companies.price_display_mode` (coded sales lines only): `with_tax` = price includes tax (net = price / (1 + rate)), `without_tax` = tax on top; purchase lines are always exclusive;
  - links live in a side table (`document_line_tax`), so a company with no codes is byte-identical (tax golden unchanged; coded sales lines alone carry `tax_code_id`);
  - **tax report** by period from the ledger: movement per tax account (code accounts + output_tax / input_tax), base and tax per code and rate, output / input / net payable, and a reconciliation of every code account against its coded documents (difference = manual journals or foreign-currency documents).
- **Fixed assets** (`lib/fixedAssets.js`, `manage_fixed_assets`):
  - categories name their own asset, accumulated depreciation, expense and disposal gain/loss accounts (no new system account);
  - register: cost, salvage, purchase date, depreciation start (default: purchase month), life in months, straight line or declining balance, opening accumulated depreciation for existing assets, optional funding account (Dr asset / Cr funding);
  - an expense-invoice line marked as an asset is debited to the category's asset account and registers the asset when the invoice posts (cost = the line's base amount); a debit note on that line is refused (dispose instead);
  - monthly depreciation: straight line with cumulative rounding (total = cost − salvage − opening exactly); declining balance NBV × rate / 12 (default 2 / life, capped at 100 %), the last month takes NBV down to salvage;
  - one `fa_depreciation` row per asset per month (UNIQUE): re-runs, earlier periods and parallel runs post nothing new; a run catches up every missing month in order; background sweep for the last complete month;
  - disposal / sale: catch-up to the month before the disposal month, then Dr accumulated, Dr proceeds, Cr cost, gain Cr / loss Dr the disposal account; a disposal dated before an already-depreciated month is refused;
  - asset schedule report (cost, period depreciation, accumulated, NBV, disposal gain/loss) and a per-asset projected schedule.
- **Adjusting and recurring entries** (`lib/recurringEntries.js`, `manage_recurring_entries`):
  - recurring templates (rent, subscriptions): the same balanced lines every 1 / 3 / 12 months on a day of month (clamped to month end), until an end date or N occurrences;
  - accruals: posted on the scheduled date, reversed automatically on the 1st of the next month;
  - prepayments: a total amortised over N periods (Dr expense / Cr prepaid), cumulative rounding;
  - one `recurring_runs` row per template per date (UNIQUE): never twice; schedule changes that would move posted dates are refused; background sweep.
- **Month-end checklist** (Prompt 4): `depreciation_not_posted` and `recurring_entries_due` blockers, shown only for companies that use assets / templates (other companies' checklist unchanged).
- **UI:** `/accounting/adjustments` (assets, depreciation & schedule, tax, recurring) and a tax-code / asset-category column on the sales and expense-invoice forms, shown only when the company has codes / categories; ar + en.
- **Migration 0024:** schema + the 3 permissions for `manage_permissions` holders; upgraded baseline schema identical to a fresh init, re-run no-op, `integrity_check` ok, `foreign_key_check` clean.
- **Browser check (demo copy):** category + asset registered through the form; depreciation to Sep: 9 entries, 4,050.00 (27,000 / 60 × 9), re-run 0; tax report "reconciles"; recurring rent Aug–Oct: 3, re-run 0; expense invoice from the form with an 11 % purchase code and an asset category: tax 550.00, asset 5,000.00 / 48 months.

### Prompt 10 requirement -> test (`A` = test/accountingExtras.test.js, `G` = test/taxGolden.test.js)

| Requirement | Test |
|---|---|
| Depreciation posts once per period (idempotent) | A "straight line ... posted once per period (re-run, catch-up, parallel runs)", A "declining balance ends exactly at salvage" |
| Disposal posts the correct gain / loss | A "disposal: sale posts the gain, scrapping posts the loss" (entry lines asserted) |
| Tax report reconciles to the tax accounts | A "tax codes: ... tax report reconciles" (report = ledger balance; manual journal shows as a difference) |
| Recurring templates on schedule, never twice | A "recurring templates: on schedule, never twice ..." (re-run + parallel run) |
| No hardcoded rate; company with no codes behaves as today | G (golden recorded before any Prompt 10 code, unchanged) |
| Price modes inclusive / exclusive; effective dates | A "tax codes" (15 % in March exclusive, 10 % from June inclusive, no rate before the first date) |
| Purchase on a supplier invoice creates the asset | A "tax codes" (asset line), browser check |
| Closing-adjustments checklist | A "month-end checklist" |
| Failure injection on every money path | A "failure injection" (asset create, depreciation, disposal, recurring run, accrual reversal, invoice with asset line) |
| tenantRefs on every client-supplied id; permissions | A "tenant refs and permissions" |

### Prompt 10 limits (documented, not fixed)
- ~~Tax codes on expense invoices only~~ — goods invoices may use a code in the base currency (df43c10); foreign-currency goods and landed-cost invoices keep the free rate, and the tax report shows them as explicit rows.
- ~~Tax report: per-code columns base-currency only~~ — fixed in df43c10: every tax-account line is a row, foreign documents at the document rate.
- Depreciation is monthly with a full-month convention (no daily proration, no depreciation in the disposal month); no revaluation or impairment; partial disposal is not supported.
- One disposal account per category for gains and losses (net).
- Accrual reversal is always on the 1st of the next month; a template cannot change its amount / schedule after runs (stop it and create a new one).

## After Prompt 10 — small commits (before Prompt 11-lite)

**CI recording rule (from now on):** a commit never records its own CI result. The SHAs of a prompt's pushes are verified on GitHub Actions after they finish and recorded in the FIRST commit of the next prompt (or the next small-commits round). PR #1 title / description are kept current with every prompt.

Verified CI (push run / PR run), recorded here after the fact:

| Commit | What | CI |
|---|---|---|
| f85d61e | Prompt 10: tax golden recorded before any code | green #36 / #37 |
| 57a5f1e | Prompt 10 backend + tests | green #38 / #39 |
| d74c1b0 | Prompt 10 UI | green #40 / #41 |
| 557774e | Prompt 10 docs (head of Prompt 10; also checkpoint/prompt-10-done #44) | green #42 / #43 / #44 |
| 7e16bf5 | 1. Test clock: lib/clock.js (test-only, NODE_ENV=test + ATLAS_TEST_NOW) shifts JS Date and SQLite 'now' together; npm test pins 2026-11-20; tax golden normalizes its only date-derived values. Proof: whole suite under libfaketime at 2027-01-15 and 2027-09-15 and at the real date, 310/310 each (before: shifting the clock to January failed 82 tests, 60 x no_period). | green #45 / #46 |
| eb42ebe | 2. Price mode is an explicit choice with the first tax code (migration 0025, company_tax_settings); taxed documents refused with 409 price_mode_not_chosen until chosen; badge on every invoice screen; no codes = unaffected. | green #47 / #48 |
| df43c10 | 3. Tax report built from the ledger: coded / free-rate (goods, landed cost, expense, sales, notes) / other rows add up to the total movement of the tax accounts; foreign documents at the document rate; goods invoices may use a purchase code (base currency only). | green #49 / #50 |
| 372a9f7 | 4. Locked / closed periods: depreciation (run and catch-up), disposals, recurring entries and accrual reversals refuse with a clear message and post nothing (lib/periodGuard.js). | green #51 / #52 |
| 33c1299 | 5. Property tests (depreciation, inclusive/exclusive round trip, effective dates); fix found: inclusive lines could total one unit above the price (net now rounded first, tax = remainder). | green #53 / #54 |
| (this commit) | 6. This section; its CI is recorded in Prompt 11-lite's first commit. | — |

### Prompt 10 requirement -> test name (complete)

Files: `A` accountingExtras, `PM` taxPriceMode, `TR` taxReportComplete, `LP` lockedPeriods, `PR` accountingProperty, `G` taxGolden, `C` clock.

| Requirement | Test(s) |
|---|---|
| Depreciation posts once per period (idempotent) | A "fixed assets: straight line with cumulative rounding, posted once per period (re-run, catch-up, parallel runs)" |
| Straight line / declining balance correct to the unit | A "fixed assets: declining balance ends exactly at salvage ..."; PR "(a) depreciation: exact total, last month absorbs the remainder, never below salvage" |
| Disposal / sale posts the correct gain / loss | A "disposal: sale posts the gain, scrapping posts the loss, a second disposal is refused" |
| Asset schedule report | A "disposal: ..." (schedule report part), A "fixed assets: straight line ..." (per-asset schedule) |
| Purchase on a supplier invoice creates the asset | A "tax codes: ... asset from a supplier invoice line ..." |
| Tax codes table, effective dates, no hardcoded rate | A "tax codes: effective-dated rates ..."; PR "(c) the rate used is the one in effect on the document date" |
| Company without tax codes behaves as today | G "company with no tax codes: ... byte-for-byte unchanged"; PM "company with no tax codes: no choice needed ..." |
| Price modes inclusive / exclusive | PM "the first tax code requires an explicit choice ..."; PR "(b) inclusive and exclusive coded lines round-trip ..." |
| Price mode chosen explicitly; taxed documents blocked until chosen | PM "codes without a choice (created before migration 0025): every taxed document is blocked ..." |
| Tax report by period from the ledger, reconciles to the tax accounts | A "tax codes: ... tax report reconciles ..."; TR "USD-base company: ... rows add up to the tax accounts exactly"; TR "SYP-base company: a USD invoice with tax ..." |
| Adjusting entries: accruals (auto-reversal), prepayments (amortisation) | A "recurring templates: on schedule, never twice; accrual reversed ...; prepayment amortised ..." |
| Recurring templates on schedule, never twice | A "recurring templates: ..." (re-run + parallel run) |
| Closing-adjustments checklist in the month-end checklist | A "month-end checklist: missing depreciation and due templates block ..." |
| Locked periods respected by every automatic posting | LP "depreciation: ... locked ... catch-up ...", LP "disposal dated in a locked period ...", LP "recurring templates: ...", LP "accrual reversal landing in a locked period ..." |
| Failure injection on every money path | A "failure injection: every money path rolls back completely" |
| tenantRefs on every client-supplied id; permissions | A "tenant refs and permissions"; PM (permission of PUT price-mode) |
| Tests independent of the real date | C "ATLAS_TEST_NOW shifts JS Date and SQLite now ...", C "... ignored outside NODE_ENV=test"; libfaketime runs (7e16bf5) |

## Prompt 11-lite — Payroll accounting (done; replaces Prompt 11 as written)

Attendance, leave, shifts and the payroll calculation are NOT built: they live in the separate HR program. Only the accounting side is here (`lib/payroll.js`, `/api/payroll`, `/payroll`).

CI of the previous round's last commit, verified after it finished: b2e95f3 (after-Prompt-10 BUILD_PROGRESS) green #55 / #56.

| Commit | What | CI (verified after the fact) |
|---|---|---|
| da35a92 | Step 1: treasury golden (all voucher types, SYP box, a payment on salaries payable 2130, transfer, bank fee, reversal, SoD refusal) recorded before any payroll code; stable across 3 runs | green #57 / #58 |
| 040fcd1 | Backend + tests | green #59 / #60 (verified in the next round) |
| 5027786 | UI | green #61 / #62 (verified in the next round) |
| 0d1ddfb | Docs (head of 11-lite; also checkpoint/prompt-11-lite-done #65) | green #63 / #64 / #65 (verified in the next round) |

- **Import** (manage_payroll_intake): per period / department / cost center / currency (USD, SYP): gross, deductions, employer contributions, net, headcount; net must equal gross - deductions exactly. Idempotent by (company, period, external id): the same content again is a replay (200, nothing written); a changed re-import is refused (409 `payroll_changed_reimport`) unless the period was reopened with a reason. Advance recoveries travel with the import (part of the deductions of their currency).
- **Accrual** (approve_payroll_posting; the importer cannot post when another holder exists — SoD step `payroll`, owner break-glass): ONE entry per period, source `payroll_period`, on the posting date (default: the period's last day), each currency at its rate on that date — Dr payroll expense and employer-contribution expense per cost center; Cr salaries payable and deductions payable per currency; Cr employee advances at their own base value, the rate difference to `fx_realized`; per-line conversion residue to `rounding_difference`. Locked / closed periods refused before anything is written (lib/periodGuard.js).
- **Corrections are reversal-only:** reopen (reason required) reverses a posted period's entry and releases its advance recoveries; refused while the period has live payment vouchers. Re-import, then post again.
- **Payments:** a treasury payment voucher on salaries payable from a box in the period's currency (`payroll_payments` links it to the period; amount ≤ remaining net). Approved in treasury (approve_vouchers, its own SoD) → one entry. A foreign-currency payment relieves the payable at its accrual value (pro rata, last payment takes the rest) and posts the difference to `fx_realized` — a hook in `approveVoucher` that returns null for every other voucher (treasury golden unchanged). Linked vouchers cannot be edited in treasury.
- **Employee advances:** paid through a treasury voucher on the advances account (`employee_advances`, by the HR program's employee reference), recovered through the import; balance report per employee and currency.
- **Labour cost rates** per cost center / product line, effective-dated, most specific match (both → cost center → product line → company); `GET /api/manufacturing/orders/:id/labor-rate` reads them (order costing unchanged until Prompt 16; production golden unchanged).
- **Reports:** payroll cost by department and period (base, at the period's posting rate), payroll payables per period / currency vs the ledger, advances outstanding.
- **Accounts** are chosen per company (`payroll_settings`; no new system account, so no chart / golden change); migration 0026 adds the tables and grants manage_payroll_intake / approve_payroll_posting to `manage_permissions` holders. Upgraded baseline = fresh init, re-run no-op, integrity / foreign keys clean.
- **Browser check (demo copy):** accounts saved through the form; the sample batch imported from the textarea, imported again → "already imported, nothing changed"; accrual posted (JE-00001); payment voucher created from the period row and approved; payables report 2,700.00 net / 2,700.00 paid / 0 outstanding; no page errors.

### Prompt 11-lite requirement -> test (`PY` = test/payroll.test.js, `TG` = test/treasuryGolden.test.js)

| Requirement | Test |
|---|---|
| Import per period / department or cost center / currency (USD/SYP): gross, deductions, employer contributions, net | PY "import: net must equal gross - deductions ..." |
| Idempotent import by (company, period, external id); changed re-import rejected unless reopened with a reason | PY "import: ... same batch again is a replay; a changed re-import is refused until reopened with a reason" |
| Accrual: expense Dr, salaries / deductions payable Cr, one entry with the source link | PY "accrual: separation of duties, one entry per period with cost centers and per-currency payables ..." |
| Payment through treasury vouchers, one entry with the source link; FX like other documents | PY "payments through treasury: USD at par; SYP at the payment-date rate relieves the payable at accrual value and posts realized FX" |
| Reversal-only corrections | PY "reversal-only corrections: a paid period cannot be reopened; reopening reverses the entry ..." |
| Locked periods respected | PY "locked period: posting the accrual refuses and posts nothing" |
| Employee advances: record, recover through the deduction line, balance report | PY "advances: paid through treasury, recovered through the deduction lines (FX at the advance value), balance report; over-recovery refused" |
| Labour cost rates per cost center / product line, effective-dated; production orders read them | PY "labour cost rates: effective-dated, most specific match; production orders read them" |
| Reports: cost by department and period, payable balances, advances outstanding | PY "reports: payroll cost by department and period", PY "payments ..." (payables), PY "advances ..." (advances report) |
| Separation of duties, permissions, audit trail | PY "accrual: separation of duties ...", PY "tenant refs and permissions", PY "import ..." (audit rows) |
| Failure injection on every money path | PY "failure injection: accrual, reopen, payroll payment (FX path) and advance roll back completely" |
| tenantRefs on every client-supplied id | PY "tenant refs and permissions" |
| Flag-off goldens unchanged (company without payroll) | TG "company without payroll: treasury vouchers ... byte-for-byte unchanged"; production / tax / warehouse / ledger_live goldens unchanged |

### Prompt 11-lite limits (documented)
- Payroll lines are aggregates per department / cost center / currency; per-employee pay is in the HR program. Only advances are tracked per employee (by the HR program's reference, not a user account).
- Deductions payable (taxes, social security …) is one account per company, settled with ordinary treasury vouchers; it is not tracked per period or authority.
- Advance recoveries use the average base of the employee's outstanding advances in that currency (exact when fully recovered).
- Labour cost rates are entered, not derived from payroll cost / hours; production costing keeps its own effective-dated labour rates until Prompt 16.

## Before Prompt 12 — small commits

CI verified after the pushes finished (recorded in Prompt 12a's first commit): all green.

| Commit | Item |
|---|---|
| 6353c08 | 6. Verified CI of Prompt 11-lite recorded (first commit of the round) — CI green #66 / #67 |
| 0dc07b8 | 1. Year rollover: next fiscal year + periods auto-created from the last month (1 Dec), idempotent, audited; banner 60 days before year end; failed-posting queue (`posting_failures`, migration 0027) with retry for postings refused with no_period (refusal unchanged); tests on the injected clock across 31 Dec -> 1 Jan (posting, numbering, depreciation, recurring + accrual reversal, receipts, balances carried, year-end close) — CI green #68 / #69 |
| 5975152 | 2. Payroll deduction types (several payable accounts), split per line, accrual and payment per type (FX like salaries), balance per type; existing setups migrate to one default type (migration 0028) — CI green #70 / #71 |
| 4fea5bb | 3. Property test: random partial advance recoveries USD / SYP — advances control == sum of employee balances at every step; all differences in realized FX — CI green #72 / #73 |
| c8a8900 | 4. Payroll import format: docs/payroll-import-format.md, CSV template, JSON schema; CSV import; whole-file validation, rejected entirely with row-level errors — CI green #74 / #75 |
| 34dab34 | 5. Payroll isolation: 403 on every payroll endpoint without payroll permissions (enumerated from the router); no employee / HR-department data in any other response (every parameter-less GET of the app, entries, GL, vouchers, audit log) — CI green #76 / #77 |

Notes:
- Moving the test clock beyond 30 days expires the session (sessions last 30 days) — the rollover test logs in again; production behaviour is unchanged.
- `no_period` keeps its existing 400 status; the queue only adds a visible, retryable record.
- Payroll reports are now payroll-permission only (previously also open to view_financial_reports).

## Prompt 12a — Analytics: fact tables, ready reports, worker thread (done; 12b / 12c wait for go-ahead)

| Commit | Step | CI |
|---|---|---|
| 580707a | Golden of the existing reports, recorded BEFORE any analytics code (`test/reportsGolden.test.js`) | green #80 / #81 |
| 8522c70 | 9 fact tables + change-capture triggers + incremental refresh / full rebuild (same per-document builders); migration 0029 (queues one rebuild per existing company); 0022 now keeps triggers on its stock_moves rebuild | green on head #82 / #83 |
| f5819df | Ready reports (33 + 2 live) in a worker thread on a read-only connection, timeout 504, row cap; `/api/analytics`; freshness stamp; drill; 60 s background refresh | green on head #82 / #83 |
| b6cb0a0 | Ready-reports page (ar/en) | green #82 / #83 |
| (this commit) | Report names in the catalog (found in the browser check), dimension column labels, docs | recorded next round |

Requirement -> test (`test/analytics.test.js` unless noted):

| Requirement | Test |
|---|---|
| Nine fact tables, incremental refresh == full rebuild | "incremental refresh == full rebuild, row for row, at every checkpoint" (scenario, new sale, manual entry, its reversal, receipt + payment, FX settlement, production, recovery after failure, migration rebuild) |
| Financial family == ledger | "financial family" — TB per account == ledger and == existing TB (closing + period); IS / BS / cash flow == existing reports; monthly / yearly == P&L; expense analysis == expense accounts; FX report == fx_realized/fx_unrealized after a real SYP settlement |
| Sales family | "sales family" — net == revenue of sales documents; cost == stock ledger sale / sale_return moves; every dimension sums to the same total; rep performance |
| Purchases / payables | "purchases family" — net == AP minus tax of supplier documents; payables facts == AP control == existing AP aging control |
| Inventory | "inventory family" — stock on hand == stock valuation == inventory control; movement == stock moves; count variances |
| Receivables | "receivables family" — aging == AR control == existing aging; collections == receipts credited to AR |
| Payroll (+ permission) | "payroll family" — payroll cost == payroll expense; report and payroll facts hidden (404) without payroll permissions; 403 without view_financial_reports |
| Manufacturing | "manufacturing family" — batch FG value == output moves; WIP relieved; consumption == issue moves; mix / yield; live cost variances; lot trace / recall |
| Drill-down convention | "drill-down" — gl drill totals == TB row; fact drill rows add up to the amount (sales, aging, batch) |
| Freshness stamp on every report | "every report carries a freshness stamp" (all catalog reports; live ones carry a live stamp) |
| Worker thread, read-only, timeout, row cap, main thread not blocked | "worker thread" |
| Failure injection | "failure injection: a refresh that fails midway rolls back" |
| tenantRefs on every client-supplied id | "tenant isolation" |
| Migration | "migration 0029 queues a full rebuild"; gate below |
| Existing reports unchanged | `test/reportsGolden.test.js` (+ all earlier goldens) |

Gate: `npm test` 369/369; `npm run build` ok. Migration gate: database built and seeded (demo company + ledger demo) at 580707a -> `node db/migrate.js` with the new code -> schema identical to a fresh init (416 objects, 0 diff), integrity ok, 0 FK violations, re-run "up to date"; the queued rebuild on that data: 15 accounts, 0 mismatches vs the ledger. Browser check: /reports/ready — trial balance and sales by item with the stamp, totals, drill rows; it found the missing report names (fixed in this commit).

Decisions:
- Sales cost follows the stock moves, not the line's unit cost: a credit note that does not restock leaves the cost booked, as in the ledger. A stock move re-queues its sales document.
- Cost variances run live (the existing `manufacturingOrders.variances`): theoretical cost uses the latest purchase prices, so it cannot be a stored fact without breaking rebuild == incremental.
- Lot trace / recall run live on the main connection (graph traversal over live tables).
- A report run refreshes the facts first (bounded, 5000 queue rows); if that refresh fails the report still answers from the old facts and its stamp says up_to_date: false.
- Timeout default 30 s (`ATLAS_REPORT_TIMEOUT_MS`), row cap 5000 (`ATLAS_REPORT_ROW_CAP`), fact sweep every 60 s (`ATLAS_FACT_SWEEP_MS`).
- One worker per report request (no pool yet); a pool belongs to Prompt 15's load work.

## Repository move (2026-10-19) and NEXT ACTION round

The original repository (`hamada010502/accounting-sysrem-ATLAS`) was not reachable from the new session's GitHub account. The project was imported from the owner's zip (`ATLAS-ACCOUNTING-CODE.zip`, = 73b44db + the handoff docs commit) into `neermoussa/accounting-sysrem-ATLAS` as ONE commit; the zip has no git history. **Every SHA and CI run number above this section refers to the old repository**; from here on they refer to the new one.

| Commit | Item | CI |
|---|---|---|
| 505b407 | Baseline import (files identical to the zip, verified file by file); local `npm test` 369/369 (also strict PDF with `PLAYWRIGHT_CHROMIUM_PATH`), `npm run build` ok | green #1 (main) / #2 (branch) — all steps; test counts not readable here (log host blocked) |

Item 0 — the six pre-12a items are present in this import (tests run locally, 17/17 pass): year rollover (`test/yearRollover.test.js`), deduction types (`test/payrollDeductions.test.js`), advance-recovery property (`test/payrollAdvancesProperty.test.js`), import format (`test/payrollImportFormat.test.js` + `docs/payroll-import-*`), payroll 403 / isolation (`test/payrollIsolation.test.js`), CI SHAs recorded (table "Before Prompt 12" — old-repo SHAs).

### Item 1 — cost-variance report stable for closed periods

- **What actually moved (premise check):** the "latest" price already reads only goods receipts dated on or before the production date. What moved a closed period: a material with NO receipt by then (opening stock, count surplus) falls back to the CURRENT stock average, and `basis=average` is always the current average. Shown on the old code: October's theoretical materials went 19.00 -> 26.69 after a November purchase (`test/costVarianceStable.test.js` with the snapshot assertions removed, run before the fix).
- **Fix:** closing an order stores its theoretical cost for all three bases (`latest`, `average`, `standard`) on the production date, in the same transaction as the close (`mfg_order_theoretical_costs`, source `close`). `variances()` reads that snapshot; an order without one (none should remain) is computed live and marked `theoretical_source: 'live'`. An unknown `basis` is now refused (400 `invalid_basis`); it used to be silently treated as `latest`.
- **Migration 0030:** creates the table and snapshots every already-closed order (source `migration`) from the data as it stands when it runs. `latest` equals what the report showed; `average` is frozen at that moment.
- **Tests (`test/costVarianceStable.test.js`, 4):** failure injection at `mfg.close.after_moves` leaves no snapshot; close stores 3 snapshots and the October report (default, `basis=average`, and `/api/analytics/run/cost_variances`) is identical after October is closed and November purchases + a new labour rate are posted, while the live calculation for that date has moved; an order without a snapshot is marked `live`; snapshot company = order company. Existing variance numbers in `test/manufacturing.test.js` unchanged.
- **Gate:** `npm test` 373/373 (strict PDF); build ok. Migration gate: database built by the BASELINE code (505b407 worktree: `migrate` + `seed-demo-company` + `seed-ledger-demo` + a manufacturing company with 2 closed orders through the API) -> copy -> `node db/migrate.js` with the new code: applied 0030, re-run "up to date", schema identical to a fresh init (416 objects excl. `schema_migrations`, 0 diff), integrity 0 violations for both companies, 0 FK violations, row counts unchanged, 6 snapshot rows; the variance report after migration == before migration for all three bases.

## CI status

| Commit | What | CI |
|---|---|---|
| 46efa6f | Prompt 8b | green (push, checkpoint/prompt-8b-done, PR) |
| 10f0780 → a8c253a | After-Prompt-8 items 1–6 (pushed together; CI ran on the head a8c253a) | **#16 push: red** (backend: 5 tests in receivables.test.js); #17 PR on the same commit: green |
| bd1f4e5 | Fix for #16 | green: #18 push (branch), #19 push (checkpoint/prompt-8-fixes), #20 PR |

- **#16 root cause (test timing, plus a real config gap):**
  - receivables.test.js wrote to the running server's SQLite file through a second connection that had no busy timeout.
  - When that write landed inside a server write (the background sweeps start 3 s after boot), it failed at once with `database is locked`. Test 136 failed; tests 138, 139, 153 and 155 then failed on the missing order and receipt data.
  - The server connection had no busy timeout either.
  - Reproduced with a probe that writes during the sweep window: 2 of 3 runs hit SQLITE_BUSY, 0 of 4 after the fix.
- **Fix (bd1f4e5):**
  - `PRAGMA busy_timeout = 5000` on the server connection.
  - Every test connection to a live server DB goes through `test/liveDb.js` (same 5 s timeout).
  - No test skipped, loosened or retried.
  - Verified on a clean clone with `npm ci` and `TZ=UTC`: 282/282.

## Known limitations
- **Known gap — reserved stock does not block sales.** Approved / processing / out-for-delivery orders are counted as reserved in reports, the item card and reorder suggestions, but an invoice can still sell reserved quantity. To be enforced together with the order-to-delivery flow.
- **Known gap — `track_serial` (serial numbers) is not implemented.** No field, table or screen exists; lots and expiry are the only tracking.
- ~~**Inventory has no opening value in the ledger until Prompt 8.**~~ FIXED in 8a for companies that activate the stock ledger (opening `inventory_opening` entry); companies that have not activated keep the old behaviour. The `inventory` account only moves by COGS postings (invoices credit it at `products.cost_price`, restocked credit notes debit it back). With no opening stock valuation it runs negative and gross margins / balance sheet inventory are unreliable until then. **Prompt 8 must post the opening stock valuation** (Dr inventory / Cr opening_balance_equity per warehouse, from the valued stock count) before margins are used.

- ~~Migrated customer balances are aged from the go-live date~~ — FIXED after P3: residual go-live openings are a separate `legacy` (undated) bucket, never 0–30; an optional open-items import gives real ages (see decisions).
- **Collections confirmed between Prompt 2 and Prompt 3 on a live company have no receipt row**, so they show as unallocated credits in aging and can't be allocated to invoices (the ledger balance is correct). New confirmations create receipts.
- **PDF exports need a Chromium for playwright.** `lib/pdfExport.js` launches playwright's bundled browser unless `PLAYWRIGHT_CHROMIUM_PATH` is set; without one the statement PDF returns `pdf_export_failed` (Excel still works). The statement PDF test is strict whenever that variable is set.

## Decisions and deviations
- Project imported from `atlas-accounting.zip` into the repo root (repo was empty).
- P1: The ledger DDL lives in `db/ledgerSchema.js` and is called from both `init.js` and migration 0002, so fresh and upgraded schemas cannot drift (verified identical).
- P1: Migration 0002 grants the 7 ledger permissions to every existing holder of `manage_permissions` (company owners); nobody else gains anything. New companies get them automatically.
- P1: Exchange rates are stored as INTEGER ppm (`exchange_rate_ppm`), base amounts computed with BigInt, half away from zero. API amounts are decimal strings in the LINE currency; more decimals than the currency allows are rejected, not rounded.
- P1: Drafts may be saved unbalanced (UI shows the indicator); posting requires exact balance. Draft entries get no number; the JE number is issued at posting, so deleted drafts leave no gaps. Default prefix `JE-` is set only when the company has no JE numbering config.
- P1: Manual entries via the API are always `source_type='manual'`; system source types are reserved for modules calling `lib/ledger.js`. Idempotency is enforced by a partial unique index on (company, source_type, source_id) WHERE status='posted'.
- P1: A reversal entry cannot itself be reversed (re-post instead). Reversal date defaults to today and must be in an open period.
- P1: Opening balances: if the rows do not balance, the user must explicitly tick "post difference to opening balance equity" (`plugToOpeningEquity`), otherwise 400 `opening_unbalanced`. One per fiscal year via source idempotency; can be redone only after reversing.
- P1: Applying a COA template upserts by code and deactivates (never deletes) accounts outside the template; refused once any entry is posted.
- P1: Branches are not first-class (`branches_json` string array), so `branches_ref` mirrors the names and is synced on demand.
- P1: Company deletion is blocked by the triggers once it has posted entries (books are immutable). Only `seed-demo-company.js` deletes companies; it now prints a clear message. Dev reset = delete `data.sqlite*`.
- P1: Journal attachments are stored in `uploads/journal-attachments/` and served only via the permission-checked `GET /api/ledger/attachments/:id` (not static).
- P1: Pre-existing, not touched: `GET /api/audit-log` does not filter by company (seen while writing the audit test). Flag for Prompt 13.
- Fix 1 (after P1): `GET /api/audit-log` now always filters `al.company_id = req.companyId`. Test `test/tenantIsolation.test.js` (fails on the old code, passes now).
- Fix 1 tenant scan (`scripts/scan-tenant-queries.js`): 369 SQL literals touch tenant tables without naming company_id. Reviewed: 87 are child-row lookups by an already company-scoped parent id (shop_id, order_id, transfer_id, price_list_id, entry_id ...), the caller's own user/device rows, `public.js` lookups by unguessable `public_token`, platformAdmin views (cross-company by design, gated by `requirePlatformAdmin`), and background sweeps that carry each row's own company_id. 282 are `WHERE id = ?` lookups; the 9 with no company check within 25 lines above were read by hand: enrichment of an already-scoped row (custodyTransfers.withItems, shops free-item product name), the caller's own password row (auth.js), platformAdmin (by design). No further leak found. Limitation: this is a static heuristic — ids taken from the request body on INSERT (e.g. a warehouse_id/vehicle_id sent on create) are NOT covered by it and were not audited here.
- Fix 3 (after P1): `rounding_difference` system account (6850, expense, under 6) added to both COA templates and to SYSTEM_KEYS; migration `0003_rounding_account_branch_sync.js` adds it to companies that already have a chart. Rounding policy for Prompt 2 (from the owner): round each line to the currency minor unit; post any residue to `rounding_difference` so the entry balances exactly.
- Fix 3: branches_ref was NOT kept in sync before (insert-only, lazy). Now triggers on `companies` (AFTER INSERT / AFTER UPDATE OF branches_json) insert new names and deactivate removed/renamed ones (never delete; ids are stable, a re-added name is reactivated with its old id). Inactive branches are rejected on new entries. A rename is treated as remove + add — the old branch stays on historical entries.
- Open risk (not fixed, outside scope): `PUT /api/companies/me` can change `companies.currency` at any time. Once entries are posted that silently changes the ledger's base currency (`currencies.is_base` follows it on next access) and corrupts the meaning of every stored minor amount. FIXED: refused with 409 `currency_locked` (Arabic message) in lib/companies.js for both PUT /companies/me and the setup wizard, plus DB trigger `trg_companies_currency_locked` (migration 0004).
- Tenant-ref rule applied to existing ledger endpoints: line account / cost center / project / party (customer -> shops, employee -> users; supplier rejected until a supplier table exists) / branch / parent account / opening-balance accountId go through `lib/tenantRefs.js`. Before this, `party_id` was stored unchecked. 22 new tests in `test/tenantIsolation.test.js`.
- P2: Revenue is recognised at INVOICE time only; delivered/paid orders post nothing (an invoice may reference one order; one live invoice per order). See docs/posting-map.md §5.
- P2: `ledger_live` gates every behaviour change. Off = the exact original code path; proven by a golden snapshot recorded from the baseline commit (test/ledgerLiveFlag.test.js), which I verified fails when the legacy path is mutated. It can only be set by the go-live backfill (not by PUT /companies/modules) and there is no "go back" path.
- P2: Go-live opening per customer = latest `balances` snapshot − what the ledger already holds for that customer (e.g. invoices posted before go-live), so the derived balance equals the snapshot exactly. One transaction: opening entries + flag + balance refresh.
- P2: Derived balance = Σ AR(customer) lines dated ≤ today, written to today's `balances` row (`source_file='ledger'`). Entries dated in the future are not in today's balance; past-dated postings update today's row, older snapshot rows are left as history.
- P2: Return financial adjustment (live) becomes a credit note linked to the return (unique per return). `creditApplied` keeps its shape but is now the rounded credit-note total (old flow returned an unrounded float).
- P2: Collection amount (REAL) is rounded to minor units for posting; credit notes for returns compute the exact total from `unit_value × qty` and apply the rounding policy.
- P2: COGS on invoices uses `products.cost_price` (converted to the sold unit) at posting time; restocked credit notes reverse COGS at the same basis. Inventory QUANTITIES are not moved by invoices (orders/deliveries already do that; Prompt 8 owns valuation).
- P2: Foreign-currency invoices are refused (`foreign_currency_not_supported`) until Prompt 5; hook is `requireBaseCurrency()` in lib/salesPosting.js.
- P2: Supplier parties stay rejected (no supplier table until Prompt 6).
- P2: The "Customer ledger tab on the customer view" is a page `/sales/customers` in the accounting app (the shop detail view lives in the sales app, not in this department app). It also hosts the Amin reconciliation and Go-live tabs.
- P2: Revenue-by-category mapping is API-only for now (`PUT /api/sales/category-accounts`); no screen yet.
- P2: Rep cash handover, expenses and commissions are stubs (501) in lib/salesPosting.js for Prompts 7/11.
- P2: `confirmCollection` (not live) was not wrapped in a transaction. FIXED after P2: both paths now run in one (savepoint) transaction; the golden test still passes.
- Fix (after P2) go-live safety: execution requires a recorded dry run (< 24h, same company, plan unchanged) and the exact text "Invoices will be created in Atlas from now on"; a verified VACUUM INTO backup is taken first and its path returned and stored on the `executed` record (with the dry-run report). Table `ledger_go_live_runs` (migration 0006). Rollback procedure: docs/go-live-rollback.md (restore = whole database, all companies).
- Fix (after P2) atomicity: `lib/faultInjection.js` checkpoints (test-only, no-op unless NODE_ENV=test) between writes; `test/faultInjection.test.js` (in-process; `server.js` now exports `app` and only listens/starts sweeps when run directly) proves nothing persists when failing after the first write: collection confirm (not live + live), return approval/credit note (3 points), invoice posting. Mutation-checked: removing the wrap fails 4 tests.
- P3: Receivable allocation is sub-ledger matching only (no journal entry): AR stays one control account per customer.
- P3: Aging is built from the AR ledger lines, grouped per document (invoice / receipt / credit note / other entry); credits tied to an invoice (its credit notes, receipt allocations dated <= as-of, reversals of its entry) land on it; other credits show in a separate "unallocated credits" column (negative). So aging total == AR control by construction on any date; AR lines without a customer are shown as `unassigned` instead of disappearing.
- P3: Buckets are by days past DUE date (invoice due_date, else invoice date); not-yet-due items are in 0–30.
- P3: A credit note against an invoice can't exceed its open amount (total − credited − allocated). On a paid invoice the user must un-allocate the receipt first (money stays as customer credit). Cancel-invoice follows the same rule.
- P3: Reversing a receipt/collection entry from ANY screen (receipt, cheque bounce, generic journal reverse) marks the receipt reversed and deletes its allocations in the same transaction (hook in lib/ledger.js reverseEntry). The collection itself stays `confirmed` (its money did not come back to the customer; only the accounting did) — decide in Prompt 7 if a "collection reversed" status is needed.
- P3: Cheques: deposit is a status change only; clear posts Dr bank_in_transit / Cr cheques_in_portfolio (real bank accounts in Prompt 7); a cleared cheque can't bounce here. Duplicate cheque = same company + customer + number + bank.
- P3: Credit control reuses lib/orderLifecycle.js limits (shop debt_threshold_override, else default_credit_limit) and the displayed balance. Invoices: company setting invoice_credit_policy warn (default) | block; block is overridable only by override_credit_limit with a reason (stored in the audit row). Orders: the existing modes are unchanged except a hard `blocked` can now be overridden the same way (reason saved on the order).
- P3: Overdue-debt alerts reuse payment_reminders (reason `overdue_invoices`, threshold setting overdue_invoice_reminder_days, default 30) + notifications, live companies only.
- P3: Forecast = open debit items, expected date = due + the customer's amount-weighted historical delay (from allocations), else company average, else 0; overdue items count in the current week.
- P3: Reconciliation daily check (stored per company/day by a 24h sweep + "run now"): AR control vs Σ customer sub-ledgers, listing AR lines without a customer, unknown parties, and (live) customers whose displayed balance differs from the ledger.
- P3: Statement sending via WhatsApp is a new endpoint guarded by the existing send_account_statements and logged like the existing statement message; the old endpoint (balance only) is unchanged.
- P3: New permissions beyond the prompt's list: view_receivables and manage_receipts (the prompt named only override_credit_limit / send_account_statements). Reports also open with view_ledger.
- Fix (after P3) legacy debt: `customer_opening` entries age into their own **legacy** bucket (column in every aging view and the new aging Excel/PDF export). Company setting `legacy_debt_policy` = `overdue` (default) | `current` decides whether legacy counts as overdue for payment reminders, invoice credit control (new: overdue debt triggers the same warn/block as a limit breach, with `reasons`), and the overdueShops dashboard count.
- Fix (after P3) open-items import (`POST /api/sales/go-live/open-items`, Excel: customer = id|exact name|phone, invoice number, invoice date, due date, amount; dd/mm/yyyy accepted). Any row error = nothing staged. Per customer: items vs latest snapshot minus existing ledger; residual = legacy line (negative residual is flagged `items_exceed_snapshot` and posted as a customer credit). The staged import is used automatically by the next dry run and is part of the plan fingerprint; execution posts one entry per open item (`customer_open_item`, aged by its own due date) + the legacy line, then marks the import `used`. Tables open_item_imports/open_items (migration 0008).
- Fix (after P3) source-only reversal: `lib/ledger.js reverseEntry` refuses any entry whose source_type is not manual/reversal unless called by the document's own action (`fromSource`), with an Arabic message naming that action (409 `reverse_via_source`). New actions: collection reverse (status `reversed`; needs confirm_collections + reverse_journal_entries; reason in collection_changes + audit) and opening-balances reverse. A collection-based receipt is reversed through its collection. Dashboard `pendingTotal` now counts only pending statuses (it used to be "not confirmed and not rejected", which would have counted reversed ones); other totals already used `status = 'confirmed'`.
- Fix (after P3) `collections.status` gains 'reversed' via a table rebuild (migration 0009; DDL shared with init.js in `db/collectionsTable.js`). No new columns, so flag-off API rows stay byte-identical (golden test).
- **Migration runner fix — please review.** Table rebuilds inside the runner's transaction ran with foreign keys ON (SQLite ignores `PRAGMA foreign_keys` inside a transaction): renaming a table rewrote the children's REFERENCES to the renamed table, and dropping one cascaded deletes. `db/migrate.js` now supports `module.exports.foreignKeysOff = true` (FKs off around the transaction, commit refused if `foreign_key_check` shows NEW violations). Applied to 0009 and to the pre-existing **0001**, which on any database where it actually runs (visit_records.wave_point_id still NOT NULL) would have **deleted every visit_media row** via ON DELETE CASCADE. `test/migrations.test.js` proves both (mutation-checked: without the flag on 0001, visit_media rows are lost). Databases that already applied 0001 are unaffected by the change; if any live DB applied 0001 when it was not a no-op, check whether its visit_media rows survived.
- Test infra: `test/helpers.js` now asks the OS for a free port (parallel test files could collide on the old random range).
- Fix (after P3) receipt backfill: `POST /api/receivables/backfill-receipts` (dry run unless `{execute:true}`) and `scripts/backfill-collection-receipts.js` create receipts (no new journal entries) for confirmed collections of live companies that have a posted entry but no receipt; auto-allocated per the company setting. Idempotent (unique collection_id); collections whose entry was reversed are reported as skipped.
- P4: Statement signs are by account TYPE, not normal_balance, so contra accounts (4200 sales returns, 1290 accumulated depreciation) reduce their section.
- P4: Cost of sales = expense accounts under root code 5; other expenses are operating expenses. BS current/long-term split by second-level group (12 = fixed assets, 22 = long-term liabilities).
- P4: The balance sheet shows unclosed P&L of all years as "current earnings" inside equity, so it balances whether or not a year was closed.
- P4: Year-end close = ONE posted entry (source `year_end_close`) dated the year's last day, moving cumulative revenue/expense balances (prior unclosed years too) to retained_earnings, and sets fiscal_years.status = closed. Reopen reverses it (via the source action only) and is refused once any entry is dated after that year end. P&L reports exclude closing entries.
- P4: Cash accounts for the cash flow = setting `cash_account_ids` (JSON) else cash_default + bank_in_transit + 1120 Banks. Direct method = non-cash lines of entries that touch cash; indirect = net income + changes in non-cash BS accounts. Investing = group 12, financing = group 22 + equity except retained earnings.
- P4: Budgets: revenue/expense postable accounts only, monthly per fiscal period, optional cost center; approved budgets are read-only until set back to draft. Variance = actual - budget; favourable = revenue over / expense under.
- P4: Month-end checklist is advisory (does not block period close): draft entries/invoices, pending collections/returns, uninvoiced deliveries, due cheques, unallocated receipts, AR reconciliation, integrity.
- P4: Benchmark times are the report functions in-process (no HTTP/JSON); the seed is ~75 s for 200k lines.
