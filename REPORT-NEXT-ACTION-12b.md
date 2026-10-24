# Atlas ERP — report: NEXT ACTION items 0–4 + Prompt 12b

**Most uncomfortable fact:** the repository `neermoussa/accounting-sysrem-ATLAS` is **public**, so Karam Foods' accounting code and this handoff are readable by anyone. Second: **e-mail sending in 12b delivers nothing** (Atlas has no mail transport), and **no test reconciles exported file totals to the ledger**.

Status: built, awaiting review. Nothing here is declared done. 12c is not started.
Tags: [مؤكد] = proven by a test or an output I saw · [مرجّح] = strong inference · [تخمين] = guess.

---

## 1. Where the work is

| | |
|---|---|
| Repo | https://github.com/neermoussa/accounting-sysrem-ATLAS (**public**) |
| Branch | `claude/new-session-2ye601`, base `main` |
| PR | #1 (draft) — "Atlas ERP: NEXT ACTION items 0-4 + Prompt 12b (Report Builder) — awaiting review" |
| Final HEAD | `a74ad17` (code) + the commit that adds this file |
| History | **Not carried over** from `hamada010502/accounting-sysrem-ATLAS` PR #1 (unreachable from this account). `main` = ONE import commit `505b407` from the owner's zip, verified identical to the zip file by file. Old SHAs, old CI run numbers and `checkpoint/*` branches do not exist here; CI numbering restarted at #1; no checkpoint branches were created |
| Baseline (before any change) | local `npm test` 369/369 (also with `PLAYWRIGHT_CHROMIUM_PATH`, strict PDF), `npm run build` ok; CI #1 (main) / #2 (branch) green on `505b407` [مؤكد] |
| CI test counts | not readable here (GitHub's log host is blocked by the session proxy); job and step results are |

## 2. Commits and CI (each pushed separately; every run green [مؤكد])

| SHA | Item | CI push / PR |
|---|---|---|
| 505b407 | Baseline import | #1 (main) / #2 (branch) |
| c6b0d29 | 0. Baseline + pre-12a status recorded; stale BUILD_PROGRESS status table fixed | #3 / #4 |
| ebecacb | 1. Cost-variance report stable for closed periods (migration 0030) | #5 / #6 |
| 54a9a68 | 2. Report worker cap, queue, 503 + Retry-After | #7 / #8 |
| 2689600 | 3. Two-branch reports, rename, disable (+ two gaps fixed) | #9 / #10 |
| 574afe9 | 4. Randomized facts property test | #11 / #12 |
| a028465 | 12b step 0: golden of the legacy pivot / heatmap, recorded on 505b407 | #13 / #14 |
| 90d2f1b | 12b a–b: safe expression parser, query spec engine (migration 0031) | #15 / #16 |
| 843fb54 | 12b c–f: saved, scheduled, exported, sent reports (migration 0032) | #17 / #18 |
| a74ad17 | 12b g: screen, docs, BUILD_PROGRESS | #19 / #20 |

12b sub-steps a+b and c–f were not split into separate commits.

## 3. Item 0 — the six pre-12a items

All six are present in the import. Their test files pass 17/17 locally [مؤكد]. The SHAs belong to the OLD repo (taken from BUILD_PROGRESS) and do not exist in the new one.

| Item | Old SHA | Test |
|---|---|---|
| Year rollover protection | 0dc07b8 | `yearRollover.test.js`: (a) next year + 12 periods created from 1 Dec, once, audited; (b) banner before year end; (c) no-period posting queued, retried, never lost; (d) 31 Dec -> 1 Jan across posting, numbering, depreciation, recurring, receipts, balances, year-end close |
| Deduction types -> accounts | 5975152 | `payrollDeductions.test.js` (3) |
| Advance-recovery property test | 4fea5bb | `payrollAdvancesProperty.test.js` |
| Import format + whole-file validation | c8a8900 | `payrollImportFormat.test.js` (4) |
| Payroll 403 / isolation | 34dab34 | `payrollIsolation.test.js` (3) |
| Recorded CI SHAs | 6353c08 / 580707a | BUILD_PROGRESS "Before Prompt 12" |

## 4. Items 1–4

| Item | SHA / CI | Proving test | Result |
|---|---|---|---|
| 1. Closed-period cost variance unchanged after a later purchase | ebecacb #5/#6 | `costVarianceStable.test.js` "closing stores the theoretical cost for every basis; the closed period report is identical after a later purchase" (+ failure injection, live-fallback marker, tenant) | [مؤكد] |
| 2. Worker cap default 2, queue, 503 + Retry-After | 54a9a68 #7/#8 | `reportPool.test.js` "defaults: 2 workers…", "cap: never more than maxWorkers at once; the rest queue in order; a full queue answers 503 + Retry-After", "a queued report's timeout counts from when it starts running; a failing report frees its slot" | [مؤكد] all 4 fail on the old runner |
| 3. Two branches, rename, disable | 2689600 #9/#10 | `branchReports.test.js` "two branches…", "rename حلب -> حلب الجديدة…", "disable دمشق…", tenant | [مؤكد] |
| 4. Facts incremental == full rebuild | 574afe9 #11/#12 | `factsProperty.test.js`, **3 seeds (11, 2026, 90210) × 60 operations = 180** | [مؤكد] |

- **Item 1 — the premise was only partly right.**
  - The "latest" price already ignored purchases dated after production.
  - What actually moved a closed period: a material with no receipt before the production date falls back to the CURRENT stock average, and `basis=average` always uses it.
  - Proven on the old code: October's theoretical materials went 19.00 -> 26.69 after a November purchase.
  - Fix: the theoretical cost (all three bases) is stored on the production order at close, and the report reads it. Migration 0030 snapshots already-closed orders.
  - An unknown `basis` is now refused (400). It used to be silently treated as `latest`.
- **Item 3 — the test found two gaps** (fixed): the ready `expense_analysis` had no branch dimension, and the ready `trial_balance` had no branch filter. The ready TB by branch now equals the Prompt 4 TB by branch.
  - A rename keeps the old branch's history under its old name and id.
  - A disabled branch refuses new invoices and entries and keeps its history.
- **Item 4 — how the property test works.**
  - After EVERY operation, the queue is drained incrementally in random chunks of 1–6.
  - The nine fact tables are then compared with a full rebuild run inside a ROLLED-BACK transaction, so the incremental state is never reset.
  - Operations: sales, credit notes, approved returns, customer receipts, purchases, supplier invoices, payments, debit notes, stock adjustments, transfers, wastage, production closed or rejected, payroll import / post / correction, manual entries and reversals.
  - Mutation check: skipping the incremental builder of sales, production, payroll or purchase fails all 3 seeds.

## 5. Prompt 12b (per sub-step)

**a. Expression parser** — `lib/analytics/expr.js`, `reportExpr.test.js` (5) [مؤكد]
- Hand-written tokenizer + precedence parser + AST evaluator.
- grep for `eval(`, `new Function`, `Function(`, `require('vm')` over the report path (expr, query, reportWorker, runner, reports, `lib/reportBuilder.js`, `routes/reportBuilder.js`, `routes/reports.js`, the screen):
  - the only hit is the comment `expr.js:4 // … never eval / new Function / vm`;
  - over all of `backend/lib` + `backend/routes`: no hit.
  - A test scans the source too.
- Rejected inputs, each with its code:
  - `process.exit(1)`, `net; cost`, `NET`, `net % 2`, `` `net` ``, `net[0]` -> bad character;
  - `constructor`, `__proto__`, `require` -> unknown name;
  - `net ** 2`, `net cost`, `1e9` -> syntax;
  - `net +` -> incomplete; `(net` -> unclosed parenthesis;
  - empty, spaces, null, an object -> empty;
  - 25 nested parentheses or 25 unary minuses -> too deep;
  - an over-long expression -> too long.
- Division by zero and missing values give null.

**b. Query spec** — `lib/analytics/query.js`, `reportBuilder.test.js` (12), `docs/report-builder.md` [مؤكد]
- ONE JSON spec: source, measures, calcs, dimensions (≤ 3), filters in / not_in with null, period or preset, compare previous_period / previous_year, sort, limit.
- It covers the nine fact tables. Only catalog column names reach SQL; values are bound.
- "hostile or malformed specs are refused by the whitelist" covers 20 cases:
  - unknown top-level field (`sql`);
  - unknown sources (`sales; DROP…`, `__proto__`, `constructor`);
  - unknown measures (`SUM(…)`, `toString`);
  - unknown dimension (`product_id`) and a filter on `company_id`;
  - operator `like`, a non-numeric id, sort injection, `limit` 999999, an unknown compare, non-JSON, an array.
- Company scoping and permissions sit INSIDE `validate()`:
  - "tenant isolation: another company's ids are refused; its rows never appear";
  - "permissions inside the engine…" covers catalog, run, drill, dimension values and pivot, and calls `Q.validate` directly without the report permission -> `forbidden_reports`;
  - 6 cost specs without `view_costs` -> 403 `forbidden_costs`;
  - 3 payroll specs without payroll permissions -> 403 `forbidden_payroll`.
- Results equal independent SQL and the 12a ready reports. Runs go through the capped report worker (503 tested).
- The same spec format for 12c: one exported `validate` / `execute`, documented [مرجّح] — 12c does not exist yet.
- Existing pivot / heatmap: `source=facts` mode added. Legacy output is byte-for-byte equal to the golden recorded on 505b407 (`pivotGolden.test.js`) [مؤكد].

**c. Saved reports** — `reportSaved.test.js` (6) [مؤكد]
- Private = owner only. Sharing needs `share_reports`. A shared report is visible only to holders of `view_financial_reports` AND what its spec needs: a cost report is invisible without `view_costs` and disappears when the permission is removed.
- A spec the user may not run cannot be saved.
- Only the owner edits (audited before / after). Owner or `share_reports` deletes: soft delete, and its schedules stop.
- Another company gets 404 on 6 endpoints.

**d/e. Scheduling + exports** — `reportSchedule.test.js` (7), injected clock [مؤكد]
- **Idempotent per (schedule, slot):** a UNIQUE constraint plus a `BEGIN IMMEDIATE` claim. Two sweeps at the same instant, or two concurrent ones, give 1 run.
- **Catch-up once:** after 10 days down -> ONE run, `missed_slots = 10`, and next_run_at moves past now.
- **Year boundary:** the 1 January run of "last month" reports Dec of the previous year. A monthly schedule on the 31st runs Dec 31 / Jan 31 / Feb 28. Slot maths also covers 29 Feb and 01:30 local on 1 Jan.
- A run uses the owner's CURRENT permissions; if they were lost, a failed run is recorded with no file. A crash-left run is closed as `interrupted`.
- **Exports:**
  - xlsx through the existing `addSheet`, read back with ExcelJS: totals row and Arabic labels present.
  - csv (new): BOM, RFC 4180, a `'` guard on text cells starting with = + - @ — bytes checked.
  - pdf through the existing `renderTablePdf`: `%PDF`, strict with Chromium.
  - Downloads are permission-checked and audited.
- **Totals reconciled to the ledger: NOT tested for the files.** Proven: builder totals = independent SQL over the facts = the 12a ready report; journal-source debits = ready TB; facts = ledger was proven in 12a. So the chain is [مرجّح], not [مؤكد].

**f. Sends** — `reportSend.test.js` (10) [مؤكد]
- **Human approval.** Nothing is delivered on request. Approval = delivery, by ANOTHER `send_reports` holder: a new SoD step `report_send` blocks the requester while another holder exists. The owner may break glass with a reason, audited.
- **Explicit recipients:** 1–20, each a company user, a phone or an e-mail. 11 invalid forms are refused (`'*'`, `{all:true}`, 21 recipients, duplicates…).
- **Per-recipient permission.** Cost or payroll data goes only to company users holding the permission: an outside number or e-mail and a user without `view_costs` are refused at request. If a recipient loses the permission before approval, approval is blocked and the send stays pending. An approver without the data's permission cannot review or approve.
- **Audit:** `report.send.request`, `.approve` (actor + per-recipient results), `.reject`, `.review`. Results are stored per recipient (`sent` / `partially_sent` / `failed`).
- Mutation: removing any of 4 safeguards fails 1–3 tests.
- **WhatsApp** uses the existing session (`whatsapp.js` gained `sendFileToNumber`), tested only with an injected transport. **E-mail** -> always `failed` / `email_not_configured`.

**g. Frontend** — `/reports/builder`, browser check in Chromium on the built frontend [مؤكد]
- Nav entry present.
- Sales by item with net / qty / cost + a % ratio, custom March vs previous period -> 2 rows with compare / change / change % columns and totals. The drill opens its rows.
- Saved as shared; CSV file produced; daily schedule created (next run 2026-11-21 05:00 UTC).
- Send requested to a user (cost notice shown). The second user saw it pending (bell notification) and approved it -> recorded failed "WhatsApp not connected" (no session here).
- Console: only the two pre-login 401s.
- **Bugs the browser check found (fixed):** the example formula rendered reversed in RTL; the sort dropdown showed raw keys.
- **Found while wiring the menu:** `/reports/ready` (12a) sat in the "system" group; it is now under accounting.
- **Bug found by the tests:** approval returned 404 when the requester's report was private. Fixed: the approver is checked against the data's permissions, not the report's visibility.

## 6. Gate

| | |
|---|---|
| Backend tests | **425/425**, of which **56 new** (baseline 369) [مؤكد] |
| Frontend build | ok [مؤكد] |
| Migrations | 0030 (theoretical snapshot), 0031 (permissions to owners), 0032 (report tables); latest 0032 |
| Migration gate | DB built by the BASELINE code (505b407: migrate + seed-demo-company + seed-ledger-demo + 2 closed production orders via the API) -> copy -> migrate: schema identical to a fresh init (425 objects, 0 diff), re-run "up to date", data counts unchanged (+8 permission rows = 4 perms × 2 owners) [مؤكد] |
| Ledger integrity | 0 violations for both companies, 0 FK violations [مؤكد] |
| Requirement -> test tables | `BUILD_PROGRESS.md`: "Repository move…" section (items 0–4) and "Prompt 12b" |
| PR title / BUILD_PROGRESS / prompts status | updated |
| CI | green on every push #1–#20; final code HEAD `a74ad17` = #19 / #20 green |

## 7. Decisions to review
1. **Cost data** = sales cost and margin, stock values, production costs, and purchase prices (the whole purchases and payables sources). Ledger account totals (incl. COGS) are not gated. The new permission `view_costs` is granted to owners only (migration 0031).
2. **`view_costs` is enforced by the 12b engine only.** 12a ready reports and `/api/analytics/drill` still show costs to any `view_financial_reports` holder — left for Prompt 13.
3. **New permissions:** `view_costs`, `share_reports`, `schedule_reports`, `send_reports`.
4. **A send's approver** must hold the data's permissions and may review the file, even when the saved report is private to the requester.
5. **Schedules** use a fixed UTC offset (default +03:00 Damascus; no DST), not an IANA time zone.
6. **The builder has its own drill** with cost / payroll columns stripped; the 12a drill is unchanged.
7. The journal source excludes year-end closing entries unless `includeClosing: true`.
8. `test/helpers.js` responses now carry `headers` as a NON-enumerable property. An enumerable version broke the flag-off golden; this was caught before commit.

## 8. Known gaps
1. The repo is public.
2. E-mail: no transport.
3. WhatsApp file sending was never run against a connected session.
4. Export totals are not reconciled to the ledger by a test.
5. 12a reports do not apply `view_costs`.
6. Fixed UTC offset for schedules.
7. No old history or checkpoint branches in the new repo; CI test counts are unreadable from the session.

## 9. Open decisions for Hamada
1. Make the repository private.
2. E-mail transport for report sends: provider / SMTP, and approval for a new dependency (or WhatsApp-only).
3. Still open from the handoff:
   - base currency (USD / SYP);
   - go-live cutover;
   - commissions;
   - HR integration (format, file vs API, employee reference);
   - AI provider for 12c;
   - sample الأمين export of unpaid invoices.

## 10. Next
Waiting for the next prompt. 12c (natural-language questions + smart alerts) is not started. It would map questions to the 12b spec above (`docs/report-builder.md`) and needs the AI provider decision.
