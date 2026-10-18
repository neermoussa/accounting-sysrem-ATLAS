# Atlas ERP: handoff for a new advisor chat

You have no memory of earlier chats. This page is the whole briefing. Details live in `BUILD_PROGRESS.md` (one requirement → test table per prompt), `ATLAS-ERP-BUILD-PROMPTS.md` (the prompts and their status) and `docs/`.

## 1. Project in 10 lines
1. **What:** Atlas Accounting, an existing field-sales and accounting web app, is being grown into an Arabic-first ERP that replaces **الأمين**, the accounting program the business uses today.
2. **Owner:** Hamada. He runs one build prompt at a time in Claude Code and reviews the results with an advisor (you).
3. **Stack:**
   - backend: Node 22 + Express, `node:sqlite` (WAL, synchronous);
   - frontend: React + Vite, Arabic RTL with ar/en strings.
4. **Repo:** `hamada010502/accounting-sysrem-ATLAS`, branch `claude/new-session-2ye601`, draft **PR #1** into `main`, with GitHub Actions CI on push and PR.
5. **Multi-tenant:** every row carries `company_id`, and every client-supplied id is checked by `lib/tenantRefs.js`.
6. **Money:** integer minor units only, never floats.
7. **Ledger:** double entry. `lib/ledger.js` is the only writer to the journal tables.
8. **Migrations:** numbered and idempotent (`backend/db/migrations/`). Migrating must produce the same schema as a fresh init.
9. **Releases:** checkpoint branches `checkpoint/prompt-<n>-done`. Tags cannot be pushed: the proxy answers 403.
10. **Tests:** `npm test` runs every backend test on an injected clock fixed at 2026-11-20 (`lib/clock.js`).

## 2. Status (2026-10-18)
- **HEAD before this docs commit:** `73b44db`. This commit adds only these two files.
- **Tests:** 369 backend tests, all passing. Frontend build ok. CI is green on every push since #17 (#84 / #85 / #86 on 73b44db).
- **Latest migration:** `0029_analytics_facts`.
- **Checkpoint branches:** prompt-1, 2, 3, 4, 5, 6, 7, 8a, 8b, 8-fixes, 9, 10, 11-lite, 12a.

Done, one line each:
- **1 Ledger:**
  - chart of accounts (templates), fiscal years / periods, journal entries with reversal, opening balances;
  - integrity check, audit log, document numbering;
  - `ledger_live` flag.
- **2 Sales:** invoices and credit notes posted to the ledger; go-live dry-run → execute moves customer balances into AR.
- **3 Receivables:** receipts and allocation, cheques, aging (with a legacy bucket), forecast, statements, credit control, daily AR reconciliation.
- **4 Reports:** TB, IS, BS, cash flow with drill-down to documents; budgets; year-end close and reopen; month-end checklist.
- **5 Multi-currency:** USD / SYP / EUR. Rate history (`rate_e8` with quote direction); foreign invoices and receipts; realized and unrealized FX; revaluation.
- **6 Purchasing:** suppliers, requests, quotes, POs with approval, goods receipts (GRNI), three-way match, invoices, payments, debit notes.
- **7 Treasury:** cash boxes and banks, vouchers, issued and received cheques, bank statement import and matching, rep cash handover.
- **8a / 8b Stock:**
  - stock ledger per holder; average / FIFO / standard valuation; activation with an opening value;
  - lots, expiry, FEFO, counts, wastage, repack, reorder, trace and recall.
- **9 Manufacturing:**
  - recipes with immutable versions, losses, by-products, multi-level BOM;
  - effective-dated cost rates, MRP;
  - production orders through WIP into lots; QC, allergens; workshop screen.
- **10 Fixed assets, tax and adjustments:**
  - tax codes with effective-dated rates and a price mode; tax report from the ledger;
  - fixed assets and depreciation;
  - recurring entries, accruals with auto-reversal, prepayments, locked periods.
- **11-lite Payroll accounting:** import per period / department / cost center / currency, one accrual per period, deduction types, payments and advances through treasury, labour cost rates, isolation.
- **Before-12 round:** year rollover protection, deduction types, advances property test, import format, payroll 403 test (SHAs in §6).
- **12a Analytics:**
  - nine fact tables, incremental refresh == full rebuild;
  - ready reports with a freshness stamp and drill-down, and a reconciliation test per family;
  - heavy reports run in a worker thread (read-only connection, timeout, row cap).

## 3. Invariants that must never break
**Ledger**
- Every entry balances exactly.
- Amounts are integer minor units. Residue goes to the `rounding_difference` account.
- Posted entries are immutable. Corrections are reversal-only, and documents are reversed only through their own action (`reverse_via_source`).
- Only `lib/ledger.js` writes `journal_entries` / `journal_lines`, and posting is idempotent per (company, source_type, source_id).
- Numbers come from `documentNumbering` and are issued at posting, so there are no gaps from drafts.

**Periods**
- Postings go only into an open period. Locked periods are refused.
- A missing period goes to the failed-posting queue (`posting_failures`, retry action). It is never dropped.
- Year-end close is one entry. Reopen is refused once later entries exist.

**FX**
- Rates are stored as `rate_e8` plus a quote direction; base amounts use BigInt, rounded half away from zero.
- A document keeps its own rate.
- Settlement differences go to `fx_realized` and revaluation to `fx_unrealized`.
- The base currency is locked once entries exist (`currency_locked` trigger).

**`ledger_live` flag**
- Off = the original code path, byte-identical (golden test).
- It is set only by the go-live execute step, and there is no way back.

**Controls**
- Separation of duties is adaptive: it is enforced per step only when another active user holds the second permission. The owner has a break-glass override, which is audited. Steps: PO create→approve, invoice post→pay, voucher create→approve, payroll import→post, count create→approve.

**Isolation**
- Tenant isolation: `tenantRefs` on every client id, plus the cross-company tests.
- Payroll isolation: 403 without the payroll permissions, and no employee or HR data in any other response.

**Engineering**
- Write transactions use `BEGIN IMMEDIATE`, with savepoints for nested ones.
- Golden tests are recorded before any change to existing behaviour. Failure injection on every money path.
- Inventory control == stock valuation, and AR / AP control == sub-ledgers (daily reconciliation).
- The server answers 503 while migrations are pending.

## 4. Known gaps and limits (from BUILD_PROGRESS)
**Stock and sales**
- Reserved stock does not block sales: an invoice can sell reserved quantity.
- `track_serial` (serial numbers) is not built.

**Manufacturing**
- Rework is quantity only; its cost is absorbed into the batch.
- Machine hours are stored but unused. The "hour" basis uses labour hours.
- Allergen label printing is not built. The label text and declaration API exists [مرجّح].

**Tax and fixed assets**
- Foreign-currency goods and landed-cost invoices use a free tax rate, not a tax code. The tax report shows them as explicit rows.
- Depreciation uses a full-month convention: no daily proration, none in the disposal month, no partial disposal, no revaluation or impairment.

**Payroll**
- Lines are aggregates. Only advances are per employee, keyed by the HR program's reference.
- Advance recovery uses the average base of the outstanding advances (exact once fully recovered).
- Deduction types settle with ordinary vouchers and are not tracked per authority or period.
- Labour rates are manual.

**Reports**
- The heavy-report worker has no pool: one worker per request, unlimited.
- Cost variances use the latest purchase prices, so a closed period can change. Next action, item 1.

**Platform**
- An incoming cheque "cancelled" status needs a table rebuild of `cheques_received` (CHECK constraint). Deferred to Prompt 15.
- Tags cannot be pushed (proxy 403): use `checkpoint/*` branches.
- Collections confirmed between Prompt 2 and Prompt 3 on a live company have no receipt row. The backfill endpoint exists.

## 5. Open decisions for Hamada
1. **Base currency of the books:** USD or SYP. Ask his accountant. It cannot change after the first posting.
2. **Go-live cutover plan.**
   - الأمين keeps invoicing during a parallel run.
   - No go-live in Atlas until Atlas invoicing replaces الأمين.
   - The dry run is done first on a COPY of the database, never the real one.
3. **Commissions:** not built. Decide where they are calculated (HR program or Atlas) and on which basis (invoiced or collected).
4. **HR program integration:** confirm the import format (`docs/payroll-import-format.md`), whether imports are file-based or pushed via an API, and the employee reference scheme.
5. **AI provider for 12c:** whether to enable it for natural-language questions. That means which provider and key, and whether data may leave the server.
6. **Sample الأمين export:** a file of per-customer unpaid invoices, needed to make the go-live open-items import real.

## 6. Time-critical: fiscal year 2027
Fiscal year 2027 must exist before **1 Jan 2027**. The protection was requested before 12a and is **built and green** [مؤكد]:

| Item | Commit | CI |
|---|---|---|
| Year rollover: next fiscal year + periods auto-created by 1 Dec (idempotent, audited, skips if present); banner 60 days before year end; failed-posting queue with retry; tests across 31 Dec → 1 Jan (posting, numbering, depreciation, recurring, receipts, balances carried, year-end close) | 0dc07b8 | #68 / #69 green |
| Deduction type → account mapping | 5975152 | #70 / #71 green |
| Advance-recovery property test (USD / SYP) | 4fea5bb | #72 / #73 green |
| Payroll import format doc + CSV template + whole-file validation | c8a8900 | #74 / #75 green |
| Payroll 403 / isolation test | 34dab34 | #76 / #77 green |
| Verified CI SHAs recorded | 6353c08 (11-lite), 580707a (before-12 round) | #66 / #67, #80 / #81 green |

Still to check on the real deployment: the server must be running (the job runs at startup and every sweep), and the 2026 fiscal year must exist there. The banner is shown in the app header; its exact visibility by permission was not rechecked for this handoff [مرجّح].

## 7. Remaining work
- **12b:** Report Builder, saved and scheduled reports, exports. This is the next action.
- **12c:** natural-language questions + smart alerts.
- **13:** roles, approvals, audit. Lighter than written, because much already exists: SoD, audit log, permissions.
- **14:** mobile / offline sync / public API.
- **15:** hardening. Backlog already assigned to it:
  - Playwright smoke tests in CI;
  - an HTTP-level report benchmark;
  - a full tenant sweep of old create paths (ids in INSERT bodies);
  - a worker pool;
  - the cheque "cancelled" status;
  - backups with restore verification, plus the docs.
- **16:** automatic costing (details from Hamada).
- **Extras:** rep cash wallets, close-checklist extensions, restore testing, a single item master.

## 8. How the review loop works
1. Hamada pastes one prompt into Claude Code. Claude Code implements it under the Standing rules and stops with a report: CI per push, a requirement → test table, and the gate.
2. Hamada pastes that report here. You review it critically:
   - the **first line** is the uncomfortable fact, if there is one;
   - every key claim carries a tag: **[مؤكد]** (evidence), **[مرجّح]** (strong inference), **[تخمين]** (guess);
   - no praise.
3. You return a **paste-back block** for Claude Code (fixes and small commits) and green-light the next prompt only when the gate is truly met.

## 9. NEXT ACTION
Run this block when told "execute NEXT ACTION":

```text
NEXT ACTION — small commits, push EACH commit, report CI per push; Standing rules apply
(golden tests first, failure injection on money paths, tenantRefs on every client id,
BEGIN IMMEDIATE + savepoints, flag-off goldens unchanged, injected clock, migrations
verified on a baseline copy, PR title/description and BUILD_PROGRESS current).

0. Report the status of the six pre-12a items with SHAs and CI:
   - year rollover protection (auto-create next fiscal year by 1 Dec, banner 60 days
     before, failed-posting queue, 31 Dec -> 1 Jan tests);
   - deduction-type -> account mapping;
   - advance recovery property test;
   - payroll import format doc + CSV template + whole-file validation;
   - payroll 403 test;
   - recorded CI SHAs.
   Do any that are missing now; year rollover first.
   (Expected: all present — 0dc07b8, 5975152, 4fea5bb, c8a8900, 34dab34, 6353c08/580707a.)
1. The cost-variance report must use the rates stored on each production order, not
   the latest purchase prices.
   Test: a purchase posted after the period leaves the closed period's report
   unchanged. Fix it if not.
2. Cap concurrent report workers (config, default 2) and queue the rest.
   Return 503 + Retry-After when the queue is full. Test it.
3. Branch report test with two real branches, including rename and disable.
4. Randomized property test (several seeds): fact tables incremental == full rebuild
   after random sales, returns, credit notes, purchases, stock moves, production and
   payroll.
5. Then 12b ONLY.
   a. Report Builder:
      - fields, filters, grouping, period-vs-period and YoY;
      - calculated ratios through a SAFE expression parser, never eval or new Function;
      - saved reports, private or shared, permission-gated;
      - extend the existing pivot and heatmap routes.
   b. ONE whitelisted JSON query spec (measure, dimensions, filters, period, compare),
      validated against a catalog, used by the builder now and by natural language in
      12c. Company scoping and permission checks (payroll, costs) live inside the engine.
   c. Scheduling:
      - a background job, idempotent per (report, scheduled time);
      - missed runs catch up once, not N times;
      - injected-clock tests, including the year boundary.
   d. Export PDF / Excel / CSV through the existing path.
   e. Email / WhatsApp sends:
      - human-approved, permission-gated, explicit recipients, audited;
      - never send payroll or cost data to a recipient without that permission.
   Same gate and Standing rules. Stop after 12b.
```
