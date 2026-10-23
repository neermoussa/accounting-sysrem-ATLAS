# Atlas Accounting: ERP Build Prompts (updated copy)

This is the updated copy of the original `ATLAS-ERP-BUILD-PROMPTS.pdf`. Every prompt keeps its original text, extracted from the PDF.

What this copy changes:
- **Prompt 11** is replaced by **11-lite**, as built.
- **Prompt 12** is split into **12a / 12b / 12c**. The original 12 text is kept underneath for reference.
- **Prompt 16** (automatic costing) is added.
- A **Standing rules** section is added.

Extraction note: the PDF's Arabic text did not survive text extraction. It was restored by hand from the owner's original wording: the word الأمين and the six example questions in Prompt 12. The English text is unchanged.

Updated 2026-10-18. HEAD at the time of writing: see the commit that adds this file.

## Status

How the columns were filled:
- **Final commit:** the tip of the `checkpoint/prompt-<n>-done` branch. Tags cannot be pushed from this environment, so checkpoint branches replace them.
- **CI:** GitHub Actions run numbers, as push / PR / checkpoint push.
- **No CI:** the CI workflow was added in `0bb9f92` (runs #1/#2), after Prompt 6. Prompts 1–6 were verified with local `npm test` + `npm run build`, as recorded in BUILD_PROGRESS.

| Prompt | Status | Final commit | CI runs |
|---|---|---|---|
| 0 Rules | DONE (standing) | — | — |
| 1 Ledger core | DONE | 0f304af | no CI yet (local gate) |
| 2 Auto-posting + sales | DONE | 5929d39 | no CI yet (local gate) |
| 3 Receivables | DONE | fdd466c | no CI yet (local gate) |
| 4 Financial reports | DONE | 4f616ce | no CI yet (local gate) |
| 5 Multi-currency | DONE | 2edc335 | no CI yet (local gate) |
| 6 Purchasing | DONE | b9a16fd | no CI yet; first CI #1/#2 on 0bb9f92 green |
| 7 Cash & bank | DONE | 44a3be9 | #5 / #6 / #7 green |
| 8a Stock ledger & valuation | DONE | d23b34e | #10 / #12 / #11 green |
| 8b Lots, expiry, counts | DONE | 46efa6f | #13 / #15 / #14 green |
| 8 fixes (CI #16 red → fixed) | DONE | bd1f4e5 | #16 red on a8c253a (test timing + no busy timeout); fix #18 / #20 / #19 green |
| 9 Manufacturing | DONE | 1e66e72 | #27 / #29 / #28 green |
| 10 Fixed assets & tax | DONE | 557774e | #42 / #43 / #44 green |
| 11-lite Payroll accounting | DONE | 0d1ddfb | #63 / #64 / #65 green |
| Before-12 items (rollover, deductions, …) | DONE | 6353c08 … 34dab34, 522ebab | #66–#79 all green |
| 12a Facts + ready reports | DONE | 73b44db | #84 / #86 / #85 green |
| NEXT ACTION items 0–4 (new repo) | BUILT — awaiting review | c6b0d29, ebecacb, 54a9a68, 2689600, 574afe9 (new repo; old SHAs above refer to the old repo) | #3–#12 green |
| 12b Report Builder, saved/scheduled, exports | BUILT — awaiting review | a028465, 90d2f1b, 843fb54 + the screen commit | #13–#18 green; screen commit: see PR |
| 12c Natural language + smart alerts | TODO | — | — |
| 13 Roles, approvals, audit | TODO | — | — |
| 14 Mobile / offline / API | TODO | — | — |
| 15 Hardening | TODO (partly moved forward: worker thread done in 12a) | — | — |
| 16 Automatic costing | TODO (details from Hamada) | — | — |

## Standing rules (apply to every prompt)

**Tests**
1. Golden tests are recorded BEFORE touching existing behaviour, and flag-off golden tests must stay unchanged.
2. Failure injection on every money path: an injected failure persists nothing.
3. Tests use the injected test clock (`lib/clock.js`). No test depends on the real clock.
4. BUILD_PROGRESS carries a requirement → test table for every prompt.

**Data and ledger**
5. `tenantRefs` on every client-supplied id.
6. Write transactions use `BEGIN IMMEDIATE`; nested ones use savepoints.
7. Migrations are numbered and idempotent. Each is verified on a copy of a baseline database: after migrating, the schema must be identical to a fresh init.
8. Corrections are reversal-only: posted entries are never edited or deleted.
9. `lib/ledger.js` is the only writer to the journal tables.

**Commits, CI and reporting**
10. Push EACH commit separately and report CI per push.
11. PR title and description, and BUILD_PROGRESS, are current at the end of every prompt.
12. The next prompt's first commit records the previous prompt's verified CI SHAs. A commit never records its own CI.
13. One prompt at a time, then stop and report.

**Operations**
14. The real database is never used to try go-live. Dry runs happen on a copy.
15. Run `node db/migrate.js` (or `scripts/deploy.sh`: backup → migrate → start) on every deploy. The server answers 503 while migrations are pending.

---

## Original prompts (text from the PDF)

```text
RUNNER INSTRUCTIONS — READ THIS FIRST (you
are Claude Code)
You have been given this whole file and the Atlas Accounting project. Your job is to
implement PROMPT 1 through PROMPT 15, one after another, then produce a final report.
Prompt 0 is the standing rulebook for all of them. Follow these run rules exactly.

1. Setup (once):
       Unzip the project into a working folder, git init if it is not a repo, and make a first
       commit "baseline" before changing anything.
       Run the existing backend tests ( cd backend && npm install && npm test ) and cd
       frontend && npm install && npm run build . Record which tests pass/fail BEFORE
       your changes in BUILD_PROGRESS.md . Pre-existing failures are not yours to fix, but
       you must not add new ones.
       Create BUILD_PROGRESS.md at the project root with one row per prompt (status:
       pending / in progress / done / blocked), plus a running "decisions and deviations"
       list.

2. Per-prompt loop (repeat for Prompt 1 → 15, strictly in order):
   a. Re-read Prompt 0 and the current prompt from this file. Re-read BUILD_PROGRESS.md
   and the files the previous prompts created that this prompt depends on (do not rely on
   memory of earlier work).
   b. Delegate each prompt to a fresh sub-agent with clean context if sub-agents are
   available, giving it Prompt 0, the prompt text, and BUILD_PROGRESS.md . Otherwise work
   on it yourself, but treat each prompt as a separate task.
   c. Implement. Add migrations AND init.js schema, backend, tests, frontend, translations,
   permissions, nav entries.
   d. GATE. All of these must be true before moving on:
       the prompt's "Done when" list is satisfied, each item backed by a test or a
       documented manual check;
        cd backend && npm test shows no new failures versus baseline;

        cd frontend && npm run build succeeds;

       the migration runs cleanly on a COPY of a database created by the baseline version
       (existing-data upgrade path), not only on an empty database;
       from Prompt 1 onward, ledger_integrity_check is clean on seeded data.
       e. If the gate fails: fix and retry up to 3 times. If it still fails, mark the prompt blocked
       in BUILD_PROGRESS.md with the exact error, DO NOT continue to later prompts that
       depend on it, and jump to the final report. Never skip a failing gate, never delete or
       weaken a test to make it pass, never fake data to satisfy a check.
       f. Commit: git add -A && git commit -m "Prompt N: <title>" . Update
        BUILD_PROGRESS.md (status, files added/changed, migrations, permissions,
       decisions).

3. Conflicts with the code: if a prompt contradicts what the code really does, apply the
   smallest safe interpretation, write it under "decisions and deviations", and continue.
   Only stop (mark blocked) when no safe interpretation exists or data could be lost.
4. Never do any of these: rewrite the stack, redesign existing screens, drop or alter existing
   tables destructively, touch unrelated modules, add a dependency without noting it,
   hardcode secrets, or write to ledger tables outside backend/lib/ledger.js .
5. Final report (write FINAL_REPORT.md and also print it). Be honest, not promotional:
       Table: prompt, status (done / partly / blocked), tests added, tests passing.
       Test results: baseline vs final (counts of pass/fail), frontend build status.
       Everything built, per module, in 2–3 lines.
       Everything NOT built or only partly built, and why. Do not claim a feature that has no
       test or no working screen.
       Decisions and deviations from the prompts that I must review.
       Known risks: performance numbers from the benchmark, any query over 2 seconds,
       anything that touches money without a test.
       Reconciliation status on the demo dataset: ledger integrity, AR/AP/inventory control
       vs sub-ledger differences.
       Migration notes for an existing live database, and the exact backup-then-upgrade
       steps.
       How to run and try each module (URLs/routes, demo logins from the seed script).
       Suggested next steps, ordered by risk.




Atlas Accounting — ERP Build Prompts for Claude
Code
How to use this file

   Give Claude Code the atlas-accounting.zip project plus this file.
   Run the prompts IN ORDER, one per session. Commit after each. Do not skip ahead:
   later prompts depend on earlier ones.
   Paste Prompt 0 at the start of every session, then paste the prompt you are running.
   Each prompt ends with "Done when". Claude Code must not stop until every item is true
   and cd backend && npm test passes.

Order: 0 (context) → 1 Ledger core → 2 Auto-posting + sales documents → 3 Receivables →
4 Financial reports → 5 Multi-currency → 6 Purchasing → 7 Cash & bank → 8 Inventory
valuation & lots → 9 Manufacturing → 10 Fixed assets & tax → 11 HR & payroll → 12
Reporting engine → 13 Roles, approvals, audit → 14 Integrations API → 15 Hardening.




PROMPT 0 — Context and ground rules (paste first, every
session)
You are extending an EXISTING project, not starting a new one. The attached zip is "Atlas
Accounting": the Accounting-department frontend of the Atlas platform plus the full shared
Atlas backend. Do NOT create a new app, do NOT redesign the UI, do NOT replace the
stack, do NOT rename or restructure existing folders. Add to what is there.

Read these before writing any code:

    README.md

    backend/server.js (router mounting), backend/db/init.js (schema),
    backend/db/migrate.js and backend/db/migrations/0001_*.js (migration style)

    backend/lib/permissions.js , backend/middleware/auth.js ,
    backend/lib/auditLog.js , backend/lib/documentNumbering.js ,
    backend/lib/exchangeRate.js , backend/lib/departments.js

    backend/lib/collections.js , backend/lib/returns.js , backend/lib/shopData.js
   (how balances currently work)
    backend/test/helpers.js and one existing test

    frontend/src/appRoutes.jsx , frontend/src/App.jsx ,
    frontend/src/departments/config.js , frontend/src/i18n/translations.js ,
    frontend/src/auth/permissions.js , frontend/src/api.js , one existing page (e.g.
    CollectionsPage.jsx )

Stack and conventions you MUST follow:

   Backend: Node >= 22.5, Express 4, node:sqlite (synchronous, via
    require('../db/init') ), CommonJS. Frontend: React 18, Vite, react-router v6, plain
   CSS files in src/styles/ (follow theme.css tokens and existing page structure). No
new frameworks. Add a dependency only if truly necessary and say why.
Multi-tenant: every new table has company_id INTEGER NOT NULL REFERENCES
companies(id) and every query filters by req.companyId . Never trust a client-supplied
company id.
Schema changes: add CREATE TABLE IF NOT EXISTS to db/init.js for fresh
databases AND a numbered migration in db/migrations/ ( 0002_...js , exporting
up(db) ) for existing databases. Both must produce the same end schema. Migrations
must be idempotent and never destroy data. SQLite cannot drop NOT NULL or alter
CHECK constraints in place; use the table-rebuild pattern in migration 0001 when a
CHECK list must change (for example sync_operations.entity_type ).
Routes go in backend/routes/<name>.js , business logic in backend/lib/<name>.js ,
mounted in server.js under /api/... . Protect every route with requirePermission /
requireAnyPermission . Add new permissions to BOTH backend/lib/permissions.js
(Arabic label, same style as existing) and frontend/src/auth/permissions.js .
Every create/update/post/reverse/approve action calls logAudit({ companyId, actor,
action, entityType, entityId, before, after }) . Audit must capture before/after
values.
Document numbers come from documentNumbering.issueNext(companyId,
documentType) ; never invent a separate numbering scheme.

Money: new accounting tables store amounts as INTEGER minor units (USD cents; SYP
and EUR per the currencies table from Prompt 1), never floating point. Convert only at
the API boundary. Existing REAL columns elsewhere stay as they are; do not rewrite
them.
UI language: Arabic, RTL, using the existing translations.js key pattern ( nav.xxx ,
etc.). Add Arabic strings for every new label; add English only if the file already has an
English block.
Frontend pages are registered in appRoutes.jsx (ONE entry per line, same shape as
existing entries) and grouped in departments/config.js NAV_GROUPS under the
accounting group. NOTE: tools/split-departments.js is referenced in comments but
is NOT in the zip, so edit these files directly and keep their one-entry-per-line shape.
Tests: node --test , using test/helpers.js ( startServer , real HTTP, throwaway DB).
Add tests for every rule you introduce, especially the money rules. Do not weaken or
delete existing tests.
Do not touch unrelated modules (waves, WhatsApp bot, AI, market intelligence) except
where a prompt says to hook into them.
Work in small steps. After each step run the backend tests and cd frontend && npm run
build . At the end give me: files added, files changed, migrations added, permissions
   added, how to try it, and anything you decided that I should review.
   If something in a prompt conflicts with what you find in the code, STOP and tell me what
   conflicts instead of guessing.




PROMPT 1 — Ledger core (double-entry engine)
Goal: build the accounting core every other module will post into. This is the heart of the
system: a strict double-entry ledger. Backend first, then screens.

Schema (all with company_id ):

    currencies (code, name, minor_unit_digits, is_base, is_active). Seed USD (2 digits,
   base), SYP (0 digits), EUR (2 digits). Base currency = companies.currency .
    accounts : hierarchical chart of accounts. Fields: code (unique per company),
    name_ar , name_en nullable, parent_id , type (asset, liability, equity, revenue,
   expense), normal_balance (debit/credit), is_postable (leaf accounts only),
    is_active , currency_code nullable (null = any), is_system (cannot be deleted),
    system_key nullable (e.g. ar_control , ap_control , cash_default , inventory , cogs ,
    sales_revenue , fx_gain_loss , retained_earnings , opening_balance_equity ),
   timestamps.
    fiscal_years and fiscal_periods (year, number, start_date, end_date, status: open |
    closed | locked ). Generate 12 monthly periods per year. locked is permanent and
   cannot be reopened; closed can be reopened only with a permission.
    cost_centers , projects , branches_ref if branches are not already first-class (check
    companies.branches_json and warehouses; reuse what exists, link by id). All optional
   dimensions on journal lines.
    journal_entries : id, company_id, entry_number (from documentNumbering, type JE ),
   entry_date, period_id, branch_id nullable, description, source_type, source_id (the
   originating document; required for system-generated entries, optional for manual),
   status ( draft | posted | reversed ), reverses_entry_id nullable, reversed_by_entry_id
   nullable, created_by, posted_by, posted_at, idempotency_key (unique per company
   when present).
    journal_lines : entry_id, line_no, account_id, debit_minor, credit_minor (exactly one is
   non-zero), currency_code, amount_original_minor, exchange_rate (stored as integer
   ppm or decimal text, locked at posting), cost_center_id, project_id, party_type
   (customer/supplier/employee/null), party_id, memo.
   Attachments: journal_attachments (entry_id, file_path, original_name) stored under
    uploads/ like other attachments but NOT publicly served.
Rules (enforce in ONE posting service, backend/lib/ledger.js ; nothing else may INSERT
into journal tables):

1. postEntry({...}) runs in a single SQLite transaction. Total debits must equal total
    credits in BASE currency or the whole post is rejected.
2. Only is_postable , active accounts; line currency must be allowed by the account.
3. The entry date must fall inside an open period. closed / locked periods reject posting,
    reversing into them, and edits.
4. A posted entry can NEVER be edited or deleted. Corrections happen only through
    reverseEntry(entryId, { date, reason }) , which creates a new posted entry with
    swapped debit/credit, links both entries, and marks the original reversed . Reversing an
    already-reversed entry is rejected.
5. Drafts may be edited and deleted; posting turns a draft into a posted entry.
6. System-generated entries require source_type + source_id . Add a unique constraint
    so the same source cannot post twice unless the earlier entry was reversed
    (idempotency).
7. Every action is audit-logged. Include a ledger_integrity_check(companyId) function
    that verifies: every entry balances, every line references a valid account, no posted entry
    sits in a deleted period, and returns a list of violations.
8. Database-level safety net: add SQLite triggers that block UPDATE/DELETE on posted
    journal_entries and their journal_lines (except setting status to reversed and the
    reverse links).

Chart of accounts templates: ship two selectable seed templates in JSON under
backend/lib/coaTemplates/ : (a) trading/distribution, (b) food manufacturing (raw
materials, WIP, finished goods, packaging, production overhead, wastage, sales by brand).
Use a numbered, Arabic-named chart suitable for a Syrian company (assets 1xxx, liabilities
2xxx, equity 3xxx, revenue 4xxx, COGS 5xxx, expenses 6xxx). Provide
applyCoaTemplate(companyId, templateKey) that refuses to run if the company already
has posted entries.

Opening balances: endpoint and screen to enter opening balances as ONE posted entry per
fiscal year start against opening_balance_equity , with a required balance check, plus Excel
upload of a trial balance (use the existing exceljs / excelParse.js pattern, with a review
step like ImportReview.jsx ).

API ( /api/ledger/... ): accounts CRUD (soft-deactivate, never delete used accounts),
periods (list/close/reopen/lock), entries (list with filters, get with lines, create draft, post,
reverse), cost centers, projects, integrity check.

Permissions to add: view_ledger , manage_accounts , post_journal_entries ,
reverse_journal_entries , manage_fiscal_periods , lock_fiscal_periods ,
manage_opening_balances .

Screens (Arabic, RTL, in the accounting nav): Chart of Accounts tree (add/edit/deactivate,
search), Journal Entry form (multi-line, live debit/credit totals, balance indicator that blocks
posting when unbalanced, attachment, cost center/project per line), Journal list with filters
and status badges, Entry detail with "reverse" action and link to the source document,
Fiscal periods page (close/reopen/lock with confirmation), Opening balances page. Register
in appRoutes.jsx and the accounting group in departments/config.js .

Do NOT change balances , collections or returns in this prompt. That is Prompt 2.

Done when: unbalanced entries are rejected at the API and by the UI; a posted entry cannot
be changed by API or by raw SQL (trigger test); reversal works and is one-shot; posting into
a closed or locked period fails; the same source cannot post twice; integrity check returns
clean on seeded data; tests cover all of the above; both templates apply; audit log shows
every action.




PROMPT 2 — Auto-posting from existing events + sales
documents
Goal: make the existing operational events generate journal entries automatically, and add
real sales documents. After this prompt, the customer balance shown anywhere in Atlas
must be derivable from the ledger.

Part A — Customer sub-ledger and sales documents (new tables, company_id on all):

    sales_invoices + sales_invoice_lines : customer ( shops.id ), branch, warehouse,
   invoice number ( SI via documentNumbering), date, due_date, currency, lines (product,
   qty, unit, unit price, discount, tax code), totals, status ( draft , posted , cancelled via
   credit note only), link to orders.id and existing invoices /delivery records where
   applicable.
    sales_credit_notes (for sales returns and corrections), linked to the originating invoice
   and to return_requests when it comes from a return.
    sales_quotations and sales_orders only if the existing orders table cannot carry
   the same lifecycle; check lib/orderLifecycle.js first and extend rather than
   duplicate. Quote → order → delivery → invoice must be traceable by ids.
   Customer-specific prices, quantity prices, branch/region prices, discounts and
   campaigns already exist in lib/pricingEngine.js and routes/pricing.js . REUSE
   them when pricing an invoice line; do not rebuild pricing.
   Posting an invoice creates the entry: Dr customer receivable control / Cr sales revenue
   (by product category account) / Cr output tax if any; and if stock is tracked, Dr COGS /
   Cr inventory using the cost at that moment (basic cost_price now, upgraded in Prompt
   8). The invoice records its journal entry id.
   Foreign-currency invoices are supported once Prompt 5 exists; until then store currency
   but only post in base currency, and mark clearly in code where Prompt 5 hooks in.

Part B — Hook the existing flows (find them, do not guess):

   Confirmed collection ( lib/collections.js , the function that inserts the new balances
   row): post Dr cash/bank-in-transit (by method) / Cr customer receivable, inside the
   same transaction as the status change, with source_type='collection' .
   Approved return financial adjustment ( lib/returns.js ): post a credit-note entry (Dr
   sales returns / Cr receivable, and Dr inventory / Cr COGS when goods return to stock).
   Delivered orders: decide from orderLifecycle.js where revenue is recognised and
   post there, or post at invoice time; whichever you choose, post once only. Tell me which
   and why.
   Rep cash, expenses and commissions are handled in later prompts; leave stubs only.

Part C — Balances become derived:

   Keep the balances table and its API shape because other code reads it ( shopData.js ,
   WhatsApp bot, statements, dashboards). Change the WRITERS: the ledger becomes the
   source of truth and balances is refreshed from the customer sub-ledger (sum of the
   customer's receivable lines up to the date). Fix the same-day overwrite problem: two
   events on one date must both count.
   Imports from (الأمين routes/import.js ) must keep working. Treat an imported balance
   as an "external reference snapshot" stored separately ( external_balance_snapshots )
   and shown as a reconciliation comparison against the ledger balance, NOT as a value
   that overwrites ledger-derived balances once a company has gone live
   ( companies.modules_json.ledger_live = true ). Before go-live the old behaviour is
   unchanged.
   Backfill tool (script + admin endpoint, dry-run first): for a company going live, create one
   opening-balance entry per customer from the latest balances snapshot, so nothing is
   lost.

Screens: Sales invoice list/detail/create (Arabic RTL, print layout via the existing
documentRenderer.js / documentTemplates.js ), credit note screen, and a "Customer
ledger" tab on the customer view showing every debit/credit line with a link to the source
document and journal entry.

Permissions: view_sales_invoices , create_sales_invoices , post_sales_invoices ,
create_credit_notes .

Done when: confirming a collection, approving a return adjustment and posting an invoice
each create exactly one balanced entry in the same transaction; replaying the same event
posts nothing new; two same-day events both affect the balance; a customer's displayed
balance equals the sum of their ledger lines (test across 50 random operations); going-live
backfill produces matching opening balances; existing dashboards, statements and
WhatsApp balance messages still work; tests cover the above.




PROMPT 3 — Receivables, collections control, credit
Goal: complete the customers-and-collections module on top of the ledger.

   Allocation: receipts (a payment) can be allocated across several invoices
   ( receipt_allocations ), partially or fully, plus unallocated on-account amounts.
   Connect to the existing collections flow: a confirmed collection creates a receipt that
   the accountant can allocate (auto-allocate oldest-first as a default, with manual
   override).
   Aging report for customers: buckets 0–30 / 31–60 / 61–90 / 90+, by customer, rep,
   region and branch, as of any date, computed from open invoice items, with drill-down to
   invoices.
   Credit control: credit limit per customer (check what already exists in shops /settings
   and reuse), block or warn when a new sales order or invoice would exceed it
   (configurable per company: warn or block), override requires override_credit_limit ,
   overdue-debt alerts reusing payment_reminders and the notification system.
   Post-dated cheques received: cheques_received with due date and status (in portfolio,
   deposited, cleared, bounced); bouncing a cheque reverses the receipt effect through a
   proper reversal entry. (Cash/bank accounts arrive in Prompt 7; use a "cheques in
   portfolio" asset account now.)
   Statements: customer account statement (from the ledger) as PDF and Excel via the
   existing export code, and sending via the existing WhatsApp flow guarded by
    send_account_statements .

   Collection forecast: expected collections per week based on due dates and the
   customer's historical payment delay.
   Reconciliation: customer control account in the ledger vs sum of customer sub-ledger
   balances, shown as a daily check; any difference is listed by customer.
   Dashboard fields: update lib/departments.js so receivables , overdueShops , etc.
   read from the ledger; keep field keys stable.
Done when: aging totals equal the receivable control account balance on every test date;
allocations cannot exceed an invoice's open amount or a receipt's amount; a bounced
cheque restores the invoice open amount via reversal; the reconciliation view shows zero
difference on clean data and lists differences when one is forced; tests cover each.




PROMPT 4 — Core financial reports
Goal: standard financial statements computed from the ledger, with drill-down to the
originating document.

   Trial balance (any date range, with opening/period/closing, by branch / cost center /
   project filter).
   General ledger per account and account statement with running balance.
   Income statement, balance sheet, cash-flow statement (direct method from cash/bank
   accounts, and an indirect version if feasible), monthly and yearly comparison,
   comparison to the previous period/year.
   Budgets: budgets + budget_lines per account/cost center per period; budget-vs-
   actual report with variance and percentage.
   Expense analysis by account, cost center, project, branch.
   Period close and year-end: year-end closing entry moves revenue/expense balances to
   retained earnings in one posted entry (reversible only before the next year's first post);
   month-end checklist endpoint listing blockers (draft entries, unposted documents,
   unreconciled items).
   EVERY number in every report must be clickable: total → breakdown by account →
   ledger lines → journal entry → source document (invoice/receipt/etc.) → attachments.
   Implement drill-down as a consistent frontend component and a backend query
   parameter convention.
   Export each report to PDF and Excel, reusing pdfExport.js and xlsxExport.js .
   Performance: reports over 200k journal lines must return in under 2 seconds; add
   proper indexes ( journal_lines(account_id, entry_id) ,
    journal_entries(company_id, entry_date) , etc.) and verify with a seeded benchmark
   script.

Permissions: view_financial_reports , manage_budgets , run_year_end_close .

Done when: the balance sheet balances for every test period; trial balance total debits equal
total credits; income statement net result equals the change in retained earnings after close;
drill-down reaches the source document from every report line; benchmark passes; PDF
and Excel exports open correctly with Arabic text.
PROMPT 5 — Multi-currency (USD / SYP / EUR)
Goal: real multi-currency accounting in the ledger.

    exchange_rates table: currency, rate to base, effective date and time, source (manual /
   API / central bank), created_by . Keep the existing daily USD/SYP fetch
   ( lib/exchangeRate.js ) working and write its result into this table too. Allow manual
   entry per day and per document override with a permission ( override_exchange_rate ).
   Every foreign-currency document stores original amount, currency, rate used, and base
   amount; the rate is locked at posting.
   Customer and supplier balances are tracked in the document currency AND the base
   currency.
   Realized FX gain/loss: when a receipt or payment settles an invoice at a different rate,
   post the difference to the fx_gain_loss system account automatically.
   Unrealized FX revaluation: a period-end tool that revalues open foreign-currency
   balances (receivables, payables, cash/bank in foreign currency) at the closing rate,
   posting an automatic reversing entry on day one of the next period. Dry-run preview
   first.
   Currency conversion at payment: receiving SYP against a USD invoice must work.
   Reports: FX gain/loss report, balances by currency, rate history chart.
   Update invoice posting (Prompt 2) and receipts (Prompt 3) to use these rates.
   Rounding: use the currency's minor-unit digits and put rounding residue into a
    rounding_difference system account so every entry still balances exactly.

Done when: a USD invoice paid in SYP at a different rate settles fully and posts the correct
FX entry; revaluation preview and posting work and the reversal restores balances; every
entry still balances in base currency to the minor unit; tests cover rounding edge cases.




PROMPT 6 — Suppliers and purchasing
Goal: the whole purchase-to-pay cycle. This replaces the payables / activeVendors /
incomingPurchases placeholders ( tracked:false ) in lib/departments.js .

    suppliers (contact, payment terms, currency, tax info, rating fields),
    supplier_price_history .

   Documents (numbers via documentNumbering): purchase request → approval →
   supplier quotation comparison → purchase order → goods receipt → supplier invoice →
   payment → purchase return / debit note.
    Three-way match: PO vs goods receipt vs supplier invoice, with tolerance settings;
    mismatches block posting until approved by approve_purchase_mismatch .
    Approvals on purchase orders by amount thresholds (use the approvals engine from
    Prompt 13 once it exists; until then a simple approver_user_id check, with a clearly
    marked hook).
    Posting: goods receipt → Dr inventory (or GRNI accrual account) / Cr GRNI; supplier
    invoice → clears GRNI, Dr/Cr purchase price variance, Cr supplier payable control, Dr
    input tax if applicable; payment → Dr payable / Cr cash or bank. Landed cost: shipping,
    customs clearance, transport, insurance allocated to receipt lines by value, weight or
    quantity (selectable) and added to item cost.
    Supplier payable aging, supplier statement, supplier ratings (on-time, price consistency,
    quality rejection), purchase price variance report, purchases by supplier and item.
    Update the Vendors dashboard fields in lib/departments.js to compute from real data
    ( activeVendors , incomingPurchases , payables ) and flip tracked accordingly. Keep
    the field keys.
    Screens: suppliers, purchase request/order/receipt/invoice/payment, three-way-match
    review, supplier statement, purchase dashboard. Add to the accounting nav; the
    separate Vendors app will reuse the same backend later.

Permissions: view_purchases , create_purchase_requests , approve_purchase_orders ,
receive_goods , post_supplier_invoices , make_supplier_payments ,
approve_purchase_mismatch , manage_suppliers .

Done when: a full cycle (request → … → payment) works and every step posts the right
entries; payables control equals the supplier sub-ledger; three-way match blocks a
mismatched invoice; landed cost changes item cost correctly; payables aging matches the
ledger; tests cover it.




PROMPT 7 — Cash boxes, banks, vouchers, cheques
Goal: treasury.

    Multiple cash boxes and bank accounts, each linked to a ledger account, each with a
    currency. Per-user access to specific cash boxes.
    Receipt vouchers and payment vouchers (document types RV , PV ), transfers between
    cash boxes and bank accounts (including cross-currency, using Prompt 5 rates),
    expense vouchers against expense accounts, bank fees and charges log.
    Cheques issued and received with full lifecycle (issued, in transit, cleared, bounced,
    cancelled) and a due-cheques alert (use the notifications table and alert sweep pattern).
   Bank statement import (Excel/CSV, reusing import-review UI patterns): parse, map
   columns, store bank_statement_lines , auto-match to ledger transactions by
   amount/date/reference with confidence, show exceptions only for manual review, mark
   matched items reconciled, produce a reconciliation report (book balance vs bank
   balance with reconciling items).
   Rep cash: connect the existing collections flow. Cash collected by a rep and confirmed
   by the accountant moves into the main cash box through a handover document, with
   variance posted to a cash_over_short account.
   Daily cash report per box.

Permissions: view_treasury , manage_cash_boxes , create_vouchers , approve_vouchers ,
manage_cheques , reconcile_bank .

Done when: every voucher/transfer/cheque event posts a balanced entry; bank
reconciliation matches imported lines and leaves a correct unmatched list; cheque bounce
reverses correctly; cross-currency transfer posts an FX line when needed; tests cover it.




PROMPT 8 — Inventory valuation, stock ledger, lots and expiry
Goal: move from "quantity × cost_price" to a real stock ledger with valuation and lot
tracking, without breaking the warehouse module.

   First read how factory_inventory , car_inventory , custody_transfers ,
    inventory_counts , product_units and products.cost_price interact. Do not break
   them. Introduce a unified stock_moves table (company, product, warehouse or custody
   holder, lot_id nullable, qty in base unit, unit_cost_minor, move_type,
   source_type/source_id, date) as the single record of every quantity change. Wrap
   existing writers so that every change they make also writes a stock move in the same
   transaction.
   Valuation methods per company or per category: weighted average (default), FIFO,
   standard cost. Valuation layers table for FIFO. The inventory control account balance
   must equal total valuation; add a daily reconciliation check.
   Every stock move posts a journal entry (Dr/Cr inventory against COGS, GRNI, wastage,
   adjustments, production) with source_type='stock_move' .
   Lots: lots (product, lot_code, production_date, expiry_date, supplier_id nullable,
   supplier_lot, status: available/quarantine/rejected/expired), lot-level balances per
   warehouse, FEFO and FIFO picking suggestions, serial numbers when track_serial is
   on.
   Inventory counts: reuse inventory_counts ; differences post adjustment entries after
    approval, with reason codes. Barcode counting already exists in the inventory counts
    flow (check lib/inventoryCountMatch.js ); keep it.
    Wastage/damage/loss and reclassification/repacking documents with posting.
    Reserved stock for approved orders; reorder points and suggested reorder quantities;
    expiry and low-stock alerts through the existing alert sweep.
    Reports: item balance, item movement card (every move with running quantity and
    value), stock ageing, slow-moving, near-expiry, count variances, inventory cost,
    turnover, product profitability, wastage analysis, forward and reverse lot trace (supplier
    lot → batches → customers, and customer → back to supplier lot), recall report for a lot.
    Item "card" screen that shows balance, valuation, lots, movements, suppliers, sales,
    margin.

Done when: inventory valuation total equals the ledger inventory balance after a random
sequence of 200 moves under each valuation method; a count adjustment, a damage write-
off and a transfer each post correct entries; FEFO picks the earliest expiry; the recall report
for a lot lists every customer that received it; existing warehouse screens and custody
transfers still pass their tests.




PROMPT 9 — Manufacturing (recipes, batches, costing) for
nuts and mixes
Goal: production for a nuts/snacks manufacturer. This is the key differentiator; get the food-
specific rules right.

    recipes and recipe_versions (multi-level BOM; mixes can contain intermediate
    products), components with quantity per batch, expected loss percentage per
    component, packaging and label components, by-products and secondary products.
    Version control: a version is immutable once used in a production order; changes create
    a new version.
    Production flow: production plan → material requirements (MRP: required vs available,
    with shortfall and a suggested purchase request into Prompt 6) → production order →
    raw-material reservation → issue of raw materials (lot-picked, FEFO) → record actual
    output, wastage, rework → quality check → receipt of finished goods into stock with a
    new lot → cost computation → journal entries.
    Cost: theoretical cost from the recipe at latest/average cost, actual cost from issued
    lots, plus labour, energy, packaging, allocated overhead (configurable allocation basis:
    per kg, per hour, per batch). Cost per kilo, cost per unit, yield (actual vs expected),
    variance report.
   Example the system must handle exactly: a "premium nuts mix 1 kg" with almonds 300
   g, cashews 250 g, pistachios 200 g, hazelnuts 150 g, raisins 100 g, plus 1 pack and 1
   label. Calculate each component's quantity per batch, loss during
   sorting/roasting/mixing, component cost from latest purchase or average, packaging,
   labour/energy, actual loss, final cost per kilo, margin at a given selling price, and lot
   trace of each component to the final customer.
   Quality: configurable checks per product, results recorded per lot, ability to quarantine a
   lot, reject a batch, produce a certificate of analysis (COA) document from the
   document-template system.
   Allergens: per-product allergen flags (milk, peanuts, tree nuts, sesame, gluten, others),
   cross-contamination rules (production sequence by allergen, sanitation step required
   between conflicting products, warning when planning violates it), allergen declaration on
   labels (coordinate with existing label/barcode work if present in lib/ or routes/ ; do
   not duplicate).
   Reports: mix cost, batch cost, yield vs expected, wastage, raw material consumption,
   cost variances, product and customer profitability including production cost, lot trace,
   recall.
   Tablet-friendly screen for workshop use (large touch targets) to record issue, output and
   wastage; must work with the existing offline sync (see Prompt 14 for sync entity types).

Done when: the premium-mix example reproduces by hand-calculation in a test to the minor
unit; a version used in an order cannot be edited; MRP flags shortages; wastage and by-
products post to the correct accounts; a lot trace works both ways; allergen sequencing
warns on violation.




PROMPT 10 — Fixed assets, depreciation, tax, accruals
Goal: close the remaining accounting-core items.

   Fixed assets: register (category, cost, purchase date, useful life, salvage, method
   straight-line/declining), automatic monthly depreciation entries, disposal and sale with
   gain/loss, asset schedule report. Purchase from supplier invoice creates the asset.
   Taxes: configurable tax table ( tax_codes : code, name, rate, type sales/purchase,
   account links, effective dates). Do NOT hardcode VAT or any rate; a company with no
   tax codes behaves as today. Support tax-inclusive and tax-exclusive price modes (the
   schema already has companies.price_display_mode ; reuse it). Tax report by period
   from the ledger.
   Adjusting entries: accruals, prepayments with automatic recurring reversal/amortisation
   schedules, recurring journal templates (rent, subscriptions).
    Closing adjustments checklist integrated into the month-end checklist from Prompt 4.

Permissions: manage_fixed_assets , manage_tax_codes , manage_recurring_entries .

Done when: depreciation posts once per period (idempotent), disposal posts correct
gain/loss, tax report reconciles to tax accounts, recurring templates generate entries on
schedule and never twice.




```

## PROMPT 11-lite — Payroll accounting (as built; replaces Prompt 11)

**Scope:** the ACCOUNTING side of payroll only. Attendance, leave, shifts and the payroll calculation live in Hamada's separate HR program. Atlas imports that program's results per period and posts them.

**Not built: sales commissions.** This is an open decision for Hamada: where commissions are calculated (HR program or Atlas), and on which basis (invoiced or collected).

What was built:
- **Payroll intake.** One imported batch per (period, external id). Lines are aggregated per department / cost center / currency: gross, deductions, employer contributions, net, headcount.
  - A re-import with identical content is idempotent (content hash).
  - A changed re-import needs the period reopened with a reason.
- **Accrual.** ONE balanced entry per period (source `payroll_period`), dated on the posting date: Dr salary expense and employer expense / Cr salaries payable and the deductions payable.
  - Foreign-currency lines post at the period rate.
  - Corrections are reversal-only (reopen → reverse → re-import → re-post).
- **Deduction types.** Each type (social insurance, income tax, other …) has its own payable account. Accrual and payment are per type, and there is a balance report per type. Existing single-account setups migrated to one `default` type (migration 0028).
- **Payment through treasury vouchers.**
  - Net salaries and each deduction type are paid by treasury payment vouchers linked to the period or type.
  - Differences against the accrual rate go to realized FX.
- **Employee advances.** Paid by a treasury voucher and tracked per employee by the HR program's employee reference.
  - Recovered through the imported deductions (advance recoveries carried by the import).
  - Property test: the advances control account equals the sum of per-employee balances at every step, and every difference lands in realized FX.
- **Labour cost rates.** Effective-dated per cost center / product line, readable by production orders. Entered manually; they are not derived from payroll.
- **Reports.** Payroll cost by department / cost center / period, deductions payable by type, open advances.
  - All payroll reports need payroll permissions.
  - Employee identities do not appear in vouchers, memos or any non-payroll response.
- **Import format.** `docs/payroll-import-format.md`, CSV template, JSON schema. The whole file is validated first; any bad row rejects the file, with row-level errors.
- **Permissions and controls.**
  - `manage_payroll_intake` (import) and `approve_payroll_posting` (post, reopen, pay).
  - Separation of duties: the importer cannot post when another holder exists (owner break-glass).
  - Every endpoint returns 403 without these permissions. Audit trail on every action.

Done (verified): see BUILD_PROGRESS "Prompt 11-lite" (requirement → test table) and "Before Prompt 12".

### Original Prompt 11 text (reference; superseded by 11-lite)

```text
PROMPT 11 — HR, attendance, payroll, commissions
Goal: employees to payroll to ledger. Reuse existing rep data; do not duplicate it.

    Check users , rep_attendance , commission_settings , rep_targets ,
    lib/commissions.js first. Create employees (full file: personal details, contract,
    position, department, branch, salary structure, status) linked to users when the
    employee has a login. Contracts and salary components (basic, allowances, deductions,
    per-employee).
    Departments and job titles, leave management (annual, sick, unpaid) with balances and
    approvals, working shifts, lateness and absence rules.
    Attendance: use existing rep attendance/GPS; add selfie/fingerprint/card as pluggable
    record sources (store the record and evidence image; do not integrate hardware here),
    flexible schedule and shifts, lateness and absence calculation.
    Advances and loans with instalment schedules deducted from payroll.
    Sales commissions: compute from the existing commission logic using invoiced AND
    collected sales (configurable basis), per rep, tied to targets.
    Payroll run: monthly payroll sheet per branch/department, with attendance deductions,
    advances, commissions, bonuses; approval; payment; payslips (PDF via document
    templates); posting of payroll, taxes/insurance if configured, and payment entries to the
    ledger. Labour cost report by department, project or branch.

Permissions: view_hr , manage_employees , approve_leave , run_payroll ,
approve_payroll , view_salaries (salary figures hidden from everyone without it, at the
API level, not only the UI).

Done when: a payroll run for 20 test employees posts one balanced entry per run, payslips
generate, advances reduce correctly, salary fields are absent from API responses for users
without view_salaries , commission totals match the existing commission report on the
same data.
```

## PROMPT 12 — split into 12a / 12b / 12c (each with its own gate)

The original Prompt 12 text is kept below for reference. Every part runs under the Standing rules and the full gate:
- `npm test` and `npm run build`;
- migration gate on a baseline copy;
- integrity check and browser check;
- requirement → test table;
- CI per push;
- PR and BUILD_PROGRESS current.

### 12a — DONE (73b44db, CI #84/#85/#86 green)
- **Fact tables:** all nine (`fact_journal_lines`, `fact_expenses`, `fact_receivables`, `fact_payables`, `fact_sales_lines`, `fact_purchase_lines`, `fact_inventory_moves`, `fact_production_batches`, `fact_payroll`).
  - Triggers on the source tables fill a change queue.
  - Incremental refresh and a full rebuild use the same per-document builders. Tests prove they give identical rows.
  - Migration 0029.
- **Dimensions:** date/month, branch, warehouse, item, category, customer, supplier, rep, region, project, cost center, employee, currency, channel.
- **Ready reports:** every report from the original Prompt 12 list.
  - Each report carries a data-freshness stamp, and each amount drills down per the Prompt 4 convention (`docs/drill-down.md`).
  - Lot trace, recall and cost variances run live.
  - Payroll cost needs payroll permissions.
- **Reconciliation:** one test per report family (totals == ledger / sub-ledgers / stock valuation).
- **Heavy reports:**
  - run in a worker thread on a read-only second connection, with a timeout (504) and a row cap;
  - the main thread is never blocked;
  - this item was moved forward from Prompt 15.

### 12b — NEXT: Report Builder, saved and scheduled reports, exports
- **Report Builder (no coding):** fields, filters, grouping, period-vs-period and YoY comparison.
  - Calculated ratios go through a SAFE expression parser. Never `eval` or `new Function`.
  - Extend the existing pivot and heatmap routes; do not replace them.
- **One query spec:** a single whitelisted JSON query spec (measure, dimensions, filters, period, compare), validated against a catalog.
  - The builder uses it now; 12c's natural-language questions use it later.
  - Company scoping and permission checks (payroll, costs) live inside the engine.
- **Saved reports:** private or shared, permission-gated.
- **Scheduling:** a background job, idempotent per (report, scheduled time).
  - Missed runs catch up once, not N times.
  - Tests use the injected clock, including across the year boundary.
- **Exports:** PDF / Excel / CSV through the existing export path.
- **Sending by email / WhatsApp:**
  - human-approved, permission-gated, explicit recipients, audited;
  - payroll or cost data is never sent to a recipient without that permission.
- **Done when:** a saved report can be built, shared, scheduled and exported, and all of the above is tested.

### 12c — TODO: natural-language questions + smart alerts
- **Natural-language questions in Arabic.** Examples:
  - كم ربحي هذا الشهر؟
  - أي صنف خسرني؟
  - أي زبون متأخر بالدفع؟
  - ليش ربح فرع دمشق أقل من الشهر الماضي؟
  - كم تكلفة كيلو الخلطة هذا الشهر؟
  - أي مندوب يجمع أكثر وأي مندوب يبيع أكثر؟
  - Follow the existing `lib/ai.js` and `routes/ai.js` pattern and key handling.
  - The model maps the question to the 12b query spec and never writes SQL.
  - The backend executes the spec with company scoping and permissions.
  - The answer shows the numbers, the drill-down and the exact spec used.
  - A question that cannot be mapped gets a clear refusal. Never invent a number.
  - Enabling the AI provider is an open decision for Hamada.
- **Smart alerts:** extend `aiRecommendations.js` / `alertSweep.js`.
  - Margin drop, raw-material cost rise, overdue customer, near-expiry stock, high wastage, large count variance.
  - Rep missed target, customer not visited for N days, inventory-vs-ledger difference.
- **Done when:**
  - every answer includes its query spec and drill-down;
  - an unanswerable question returns a refusal;
  - each alert has a test on the injected clock.

### Original Prompt 12 text (reference)

```text
PROMPT 12 — Reporting engine (fact tables, Report Builder,
natural-language questions)
Goal: the feature that makes this better than الأمين: ask questions, get live drillable answers.

   Analytics layer, separate from entry screens: fact tables built from the ledger and
   operations, refreshed incrementally (materialised tables updated by triggers or a job;
   SQLite has no materialised views): fact_journal_lines , fact_sales_lines ,
    fact_purchase_lines , fact_inventory_moves , fact_production_batches ,
    fact_receivables , fact_payables , fact_payroll , fact_expenses . Dimensions: date,
   branch, warehouse, item, item category, customer, supplier, rep, region, project, cost
   center, employee, currency, channel, campaign, production batch.
   Report Builder (no coding): pick fields, filters, grouping, time comparison (period vs
   period, YoY), calculated ratios and indicators, save, schedule, and send by
   email/WhatsApp/PDF/Excel (reuse existing export and WhatsApp send paths; WhatsApp
   sending stays permission-gated and human-approved like the existing flows). Pivot
   table and heatmap (the reports.js routes already have pivot and heatmap ; extend,
   do not replace).
   Drill-down from any number to total → detail → document → journal entry → stock move
   → attachments, using the convention from Prompt 4.
   Ready reports (the PDF's list): financial (trial balance, ledger, income statement, balance
   sheet, cash flow, monthly/yearly comparison, budget vs actual, expense analysis, FX
   gain/loss), operational (sales by item/customer/branch/rep, purchases by supplier/item,
   stock and movement, counts and variances, receivable aging, collections, rep expenses,
   rep performance), manufacturing (mix cost, batch cost, yield, loss, consumption, cost
   variances, product and customer profitability, lot trace, recall).
   Natural-language questions in Arabic ("كم ربحي هذا الشهر؟", "أي صنف خسرني؟", "أي زبون متأخر بالدفع؟", "ليش ربح فرع دمشق أقل من الشهر الماضي؟", "كم تكلفة كيلو الخلطة هذا الشهر؟", "أي مندوب يجمع أكثر وأي مندوب يبيع أكثر؟"). Check lib/ai.js and routes/ai.js for the
   existing AI pattern and key handling and follow it. Design rule: the model does NOT write
   free SQL. It maps the question to a structured query over the fact tables (a whitelisted
   JSON query spec: measure, dimensions, filters, period), the backend executes it with
   company scoping and permission checks, and the answer shows the numbers with drill-
   down links and the exact query spec used. If the question cannot be mapped, say so;
   never invent a number.
   Smart alerts (extend aiRecommendations.js / alertSweep.js ): margin drop, raw-
   material cost rise, overdue customer, near-expiry stock, high wastage, large count
   variance, rep missed target, customer not visited for N days, inventory-vs-ledger
   difference.
Done when: every ready report exists and its totals match the ledger; a saved report can be
scheduled and exported; fact tables update incrementally and a rebuild-from-scratch gives
identical numbers (test); natural-language answers always include their query spec and
drill-down; an unanswerable question returns a clear refusal.




PROMPT 13 — Roles, approvals, segregation of duties, audit
Goal: complete the permission and control model.

   Add the PDF's roles as permission TEMPLATES in permission_templates (do not
   hardcode roles): general manager, accountant, accountant assistant, warehouse keeper,
   sales manager, sales rep, purchasing officer, production officer, quality officer, HR
   officer, auditor (read-only everywhere, including the audit log).
   Fine-grained rules, enforced on the backend: hide cost prices from users without
    view_costs ; prices cannot be edited after approval; posted documents cannot be
   deleted; no entry in a locked period; the person who created a document cannot
   approve it; stock cannot be issued without a production order or an authorising
   document; field/branch/warehouse-level access scopes per user (extend
    user_permissions or add scope tables).

   Approvals engine: approval_flows (document type, conditions such as amount
   thresholds, ordered steps with role or user approvers), approval_requests ,
    approval_steps , with notifications and a pending-approvals inbox screen. Hook it into
   purchase orders, vouchers, payroll, credit-limit overrides, price overrides and stock
   adjustments. Replace the temporary hooks left in earlier prompts.
   Audit log ( audit_log already exists; extend logAudit callers, do not replace): ensure
   every module records who created, edited, approved, posted, reversed it, before/after
   values, timestamp, device/IP (see devices.js / trusted_devices ), and the reason for
   change where required. Add an audit report screen with filters by document, user,
   module, date.
   Two-factor authentication: only if routes/auth.js has no equivalent, add TOTP for
   users with manage_permissions or approve_payroll ; keep it optional per company.

Done when: auditor role can read everything and change nothing (test every write endpoint
returns 403); a creator cannot approve their own document; hiding costs removes cost
fields from API responses, not only from the UI; approval thresholds route correctly; audit
shows before/after for every module touched in Prompts 1–12.
PROMPT 14 — Mobile/field integration, offline sync, public API
Goal: the field app and outside systems write the new documents safely.

   Offline sync: the sync_operations table restricts entity_type to a fixed list. Extend it
   (table-rebuild migration) to cover: sales_invoice , receipt , expense_claim ,
    stock_count , production_record , and any other new document a rep or tablet
   creates. Every new write endpoint must be idempotent via Idempotency-Key , and
   conflicts must go to sync_conflicts exactly like existing entity types. Posted ledger
   entries are never created directly by the client; the server posts them when it applies the
   operation.
   Rep expenses: rep_expenses with category, amount, photo evidence, approval, and
   posting (Dr expense / Cr rep wallet or cash). Daily rep report (sales, collections,
   expenses, visits) generated automatically.
   Rep screen additions required by the PDF: show customer balance and debts, collect
   cash or transfer, deliver goods, customer return, request expenses, daily report, auto-
   sync when online. Build these in the EXISTING rep/field screens if present in this project;
   if the field app is not in this zip, build only the backend endpoints and list what the field
   app must call.
   Public REST API: /api/v1/... with API keys (hashed at rest, scoped permissions per
   key, per-company, rate-limited, revocable, audit-logged), covering customers, items,
   invoices, stock balances, payments. Webhooks for invoice posted, payment received,
   stock low. Integration hooks for online stores (orders in, stock out) and bank feeds, as
   documented endpoints only; no third-party-specific code.
   Settings screen for API keys and webhooks under the existing Settings page.

Done when: replaying the same offline batch twice creates nothing twice; a conflicting
update lands in the conflicts queue; an API key with limited scope cannot call other scopes;
webhook deliveries retry and are logged; tests cover each.




PROMPT 15 — Hardening, data safety, documentation
Goal: make it safe to run real books on this.

   Backups: extend scripts/backup.js to produce consistent SQLite snapshots (use the
   SQLite backup API or VACUUM INTO , not a raw file copy while writing), keep N daily
   copies, and add scripts/verify-backup.js that restores the latest backup into a temp
   file and runs ledger_integrity_check plus the reconciliation checks. Document the
   restore procedure in README.
   Integrity dashboard (Settings → System): ledger integrity, AR/AP/inventory control-vs-
   subledger differences, unposted documents, period status, last backup and last verified
   restore.
   Data export for audit: full ledger export (Excel/CSV) for any period with source
   references.
   Performance pass: add missing indexes found with EXPLAIN QUERY PLAN on the heaviest
   report queries; add a seeded benchmark (50k invoices, 500k journal lines, 5k
   customers) and record timings in a PERFORMANCE.md . Report anything over 2 seconds.
   Check whether any heavy report blocks the event loop (node:sqlite is synchronous) and,
   if so, move that report to a worker thread or a child process.
   Seed/demo: a new seed script seed-accounting-demo.js producing a coherent 3-
   month dataset (invoices, collections, purchases, production, payroll, bank lines) that
   passes every reconciliation check; use it for the tests' benchmark.
   Documentation: docs/ACCOUNTING.md (ledger rules, posting map: which event posts
   which entry with which accounts, period close procedure, reversal policy),
    docs/PERMISSIONS.md (every new permission and which templates include it),
    docs/API.md for /api/v1 . Update README with the new modules.

   Final audit pass: grep the whole backend for any INSERT/UPDATE into
    journal_entries / journal_lines outside lib/ledger.js ; list and fix. List every
   endpoint lacking a permission check; fix.

Done when: backup verify passes on the demo dataset; integrity dashboard is green;
benchmark numbers are recorded; no code path writes the ledger except lib/ledger.js ;
every endpoint has a permission check; docs exist and match the code.




```

## PROMPT 16 — Automatic costing (ADDED; details to come from Hamada)

Status: TODO. The scope and rules come from Hamada before work starts.

Foundations already built:
- **Effective-dated cost inputs.**
  - From Prompt 9: `mfg_cost_rates` for labour, energy, overhead and by-product credit, per basis.
  - From 11-lite: `labor_cost_rates` per cost center / product line.
- **Rates stored on each production order.** The rate row used is stored on every production order's cost lines, so a closed order's actual cost does not move.
- **Machine hours** are recorded on production orders but not used by any cost basis yet. The "hour" basis uses labour hours.

Notes for the design:
- **Rework cost tracking.** Rework is recorded as a quantity only (yield report). Its cost (re-issued materials, extra labour and energy) is absorbed into the batch. Prompt 16 should track rework as its own cost element or rework order.
- **Labour rates are manual.** They are entered, not derived from payroll cost ÷ hours. Deriving them is a Prompt 16 decision.
- **Theoretical cost must be stable for closed periods.** Today theoretical cost uses the latest purchase prices, so the 12a cost-variance report runs live. It must instead use the rates and prices stored on each order, so a purchase posted later does not change a closed period's variances.

```text
Appendix — screens the PDF names as the first 10 (map to
prompts)
1. Management dashboard → Prompt 4/12 (extend the existing department dashboard)
2. Chart of accounts → Prompt 1
3. Journal entry → Prompt 1
4. Sales invoice → Prompt 2
5. Purchase invoice → Prompt 6
6. Item card → Prompt 8
7. Stock movement → Prompt 8
8. Smart sales report → Prompt 12
 9. Item profitability report → Prompt 8/12
10. Mix/recipe screen → Prompt 9

```
