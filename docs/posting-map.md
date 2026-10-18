# Posting map

Every automatic journal entry Atlas creates: which event triggers it, which
entry it produces and which accounts it hits. All entries are posted through
`backend/lib/ledger.js` `postEntry()` (one SQLite transaction, must balance
exactly in base-currency minor units). Accounts are found by **system key**
(`accounts.system_key`), never by code, so a company can renumber its chart.

`AR(customer)` = the `ar_control` account with `party_type='customer'`,
`party_id=<shop id>`. A customer's balance is the sum of its AR lines.

## Rounding policy (all documents)

Each line is rounded to the currency's minor unit (half away from zero). The
document total is the rounded **exact** total. Any residue between the two
goes to `rounding_difference` (6850) so the entry balances exactly:
residue > 0 is a credit, residue < 0 a debit on sales documents (mirrored on
credit notes).

## Idempotency

`journal_entries` has a unique index on `(company, source_type, source_id)`
for posted entries. The same event can never post twice; it can post again
only after its entry was reversed.

| source_type | source_id | created by |
|---|---|---|
| `manual` | — | Journal entry screen / `POST /api/ledger/entries` |
| `reversal` | original entry id | `reverseEntry()` |
| `opening_balance` | fiscal year id | Opening balances screen |
| `customer_opening` | shop id | Go-live backfill |
| `sales_invoice` | `sales_invoices.id` | Posting an invoice |
| `sales_credit_note` | `sales_credit_notes.id` | Credit note / return adjustment / invoice cancel |
| `collection` | `collections.id` | Confirming a collection (live companies) |
| `customer_receipt` | `customer_receipts.id` | Manual receipt / cheque received |
| `cheque_clear` | `cheques_received.id` | Cheque cleared |

## Events

### 1. Sales invoice posted — `POST /api/sales/invoices/:id/post`
Always (does not depend on `ledger_live`; it is a new document).

| | Account | Amount |
|---|---|---|
| Dr | AR(customer) | invoice total |
| Cr | revenue: `product_category_accounts` mapping for the product's category, else `sales_revenue` | each line's net (after discount) |
| Cr | `output_tax` (2140) | sum of line taxes, if any |
| Cr/Dr | `rounding_difference` | residue, if any |
| Dr | `cogs` | Σ qty × unit cost, when the product has `cost_price` |
| Cr | `inventory` | same amount |

Unit cost = `products.cost_price` converted to the sold unit (basic cost now;
Prompt 8 replaces it with real valuation). Invoice stores `journal_entry_id`.
Currency: base only until Prompt 5 (`requireBaseCurrency()` is the hook).

### 2. Credit note — `POST /api/sales/credit-notes`, `POST /api/sales/invoices/:id/cancel`
Posted on creation.

| | Account | Amount |
|---|---|---|
| Dr | `sales_returns` (4200) | Σ line nets (invoice lines: price × qty minus pro-rata discount) |
| Dr | `output_tax` | Σ line taxes |
| Dr/Cr | `rounding_difference` | residue |
| Cr | AR(customer) | credit note total |
| Dr | `inventory` | Σ qty × unit cost — only when `restock` |
| Cr | `cogs` | same amount — only when `restock` |

Against an invoice: quantity per line can't exceed what is still open; when
everything is credited the invoice becomes `cancelled`.

### 3. Collection confirmed — `lib/collections.js` `confirmCollection()` (live only)
Same transaction as the status change; if posting fails the collection stays pending.

| | Account | Amount |
|---|---|---|
| Dr | `cash_default` (1110) for cash, `bank_in_transit` (1115) for transfers | collection amount |
| Cr | AR(customer) | same |

Since Prompt 3 the same transaction also creates a **receipt** (`customer_receipts.collection_id`, no extra entry) that is auto-allocated to the oldest open invoices.

Not live: the original `applyToBalance()` snapshot write, unchanged (now inside one transaction).

### 4. Return financial adjustment — approve (`POST /api/returns/:id/approve`) or manual (`/apply-financial-adjustment`) (live only)
Same transaction as the approval/restock. Creates a credit note
(`return_request_id` set, unique per return) and posts it as in event 2:
lines = items inspected `valid` with a `unit_value`; `restock` when any item
has a product card (those items restock at `cost_price`). The response's
`creditApplied` is the credit note total.

Not live: the original snapshot write, unchanged.

### 4b. Manual receipt — `POST /api/receivables/receipts`

| | Account | Amount |
|---|---|---|
| Dr | `cash_default` (cash/other) or `bank_in_transit` (transfer) | receipt amount |
| Cr | AR(customer) | same |

Allocation to invoices (`receipt_allocations`) posts nothing: AR is one control
account per customer; allocation is sub-ledger matching used by aging, open
amounts and the forecast. Limits: ≤ invoice open amount, Σ ≤ receipt amount.

### 4c. Cheque received / cleared / bounced — `/api/receivables/cheques`

| Event | Dr | Cr |
|---|---|---|
| Received (receipt, method cheque) | `cheques_in_portfolio` (1145) | AR(customer) |
| Deposited | — (status only) | — |
| Cleared | `bank_in_transit` (1115) | `cheques_in_portfolio` |
| Bounced (from portfolio/deposited) | reversal of the receipt entry: AR(customer) | `cheques_in_portfolio` |

A bounce (or any reversal of a receipt/collection entry, from any screen)
marks the receipt `reversed` and deletes its allocations in the same
transaction, so the invoices are open again. A cleared cheque can't bounce here
(Prompt 7, bank reconciliation, owns that case).

### 5. Delivered orders — **no posting**
Decision: revenue is recognised **at invoice time only**. `lib/orderLifecycle.js`
statuses (`delivered`, `paid`, ...) post nothing; since Prompt 3 a draft invoice
can be created from a delivered order (`POST /api/sales/invoices/from-order/:id`:
customer, delivered quantities, order prices, order id) and posted. An invoice may reference
the order (`sales_invoices.order_id`, one live invoice per order). Reason: the
order flow allows partial deliveries, edits and statuses that don't map to a
document a customer receives; posting both would double-count, so exactly one
place posts.

### 6. Go-live backfill — `POST /api/sales/go-live/dry-run`, then `POST /api/sales/go-live {dryRunId, confirmText}` (see docs/go-live-rollback.md)
One entry per customer whose latest `balances` snapshot differs from what the
ledger already holds for it:

| | Account | Amount |
|---|---|---|
| Dr (or Cr if negative) | AR(customer) | snapshot − existing ledger balance |
| Cr (or Dr) | `opening_balance_equity` (3900) | same |

Then `modules_json.ledger_live = true` and every customer's balance row is
re-derived — all in one transaction, after a verified `VACUUM INTO` backup.
Requires a recorded dry run from the last 24h whose plan still matches, and
the confirmation text `Invoices will be created in Atlas from now on`.

### 7. Amin import after go-live — `POST /api/import/batches/:id/commit`
No posting. Rows go to `external_balance_snapshots` and appear on the
reconciliation screen (ledger vs Amin, difference per customer). Before
go-live the original behaviour (write `balances`) is unchanged.

### 8. Reversals

**Only manual entries** can be reversed from the journal screen
(`POST /api/ledger/entries/:id/reverse`). An entry that comes from a document
is refused there (409 `reverse_via_source`, Arabic message naming the action)
and is reversed only through its document, which updates the document's status
in the same transaction:

| source_type | Action |
|---|---|
| `collection` | `POST /api/collections/:id/reverse` (reason required; needs confirm_collections + reverse_journal_entries) → collection `reversed`, its receipt `reversed`, allocations freed |
| `customer_receipt` | `POST /api/receivables/receipts/:id/reverse` (a collection receipt goes through the collection) / cheque `bounce` |
| `sales_invoice` | `POST /api/sales/invoices/:id/cancel` (credit note) |
| `sales_credit_note` | not reversible — issue a new invoice |
| `opening_balance` | `POST /api/ledger/opening-balances/:id/reverse` |
| `customer_opening`, `customer_open_item` | not reversible — go-live rollback = restore the backup |
| `cheque_clear` | not reversible here (bank reconciliation, Prompt 7) |

The reversal itself is a new posted entry with every line's debit/credit swapped. If it touches a
customer's AR line on a live company, that customer's balance row is
re-derived in the same transaction.

### 9. Multi-currency (Prompt 5)

Rates: `exchange_rates` (rate x1e8 + direction, rate >= 1; see `lib/fxRate.js`). A document uses the latest rate effective on or before the end of its date, or a typed override (`override_exchange_rate`). The rate is **locked on the document when posted** (`rate_e8`, `rate_quote`, `total_base_minor`).

| Event | Debit | Credit | Notes |
|---|---|---|---|
| Sales invoice in currency X | AR (customer, X original + base) | revenue / tax in X; COGS/inventory in base | every X line converted once (BigInt); residue -> `rounding_difference` |
| Credit note on an X invoice | sales returns / tax (X) | AR (customer, X) | invoice's own rate: no FX. The credit that closes the invoice relieves exactly its remaining base |
| Receipt in currency Y | cash / bank-in-transit (Y) | AR (customer, Y) | receipt-date rate |
| Allocation of a Y receipt to an X invoice | AR (customer) if gain | `fx_realized` if gain | source `fx_realized` (table `fx_settlements`), dated at the receipt; loss is the mirror. FX = base paid - invoice base relieved. Settled X amount uses the X rate at the receipt date. Closing allocations use exact remaining bases (no dust) |
| Un-allocation / receipt reversal | — | — | its `fx_realized` entry is reversed (source action only) |
| Revaluation at date D (`POST /api/currency/revaluations`) | AR (customer) / foreign cash-bank account, per open item (gain side) | `fx_unrealized` (gain side) | source `fx_revaluation`, dated D; **automatic reversal dated D+1**. Preview first (`/preview`), nothing stored |

#### Where FX lands — the rule (both base currencies)

**FX exists only for amounts that are NOT in the company's base currency.** Whichever currency is the base, a document in the base currency never produces FX; a document in a foreign currency does, at settlement (realized) and at period end while still open (unrealized).

- Realized (`fx_realized`, system account 6800): base paid by the receipt - base the invoice carried for the part settled. Dated at the receipt.
- Unrealized (`fx_unrealized`, 6810): open foreign items (customer invoices, unallocated receipts, and foreign-currency balances on asset/liability accounts such as a cash box or bank) revalued at the closing rate; reversed automatically on the next day.
- Both are expense-type accounts (statement class `opex`): a **gain shows as a negative expense** in the income statement; the FX report shows gains positive.

| | SYP-base company | USD-base company |
|---|---|---|
| Invoice in USD, paid in SYP | FX: the invoice is foreign. $100 @13,000 = 1,300,000; paid 1,400,000 SYP @14,000 = $100 -> **realized gain 100,000 SYP** | no FX: the invoice is base; the SYP receipt is converted at the receipt rate |
| Invoice in SYP, paid in SYP | no FX (base) | FX: 1,300,000 SYP @13,000 = $100.00; paid @14,000 = $92.86 -> **realized loss $7.14** |
| Open foreign invoice at period end, rate moves 13,000 -> 15,000 | USD $200 carried 2,600,000 -> 3,000,000: **unrealized gain 400,000 SYP** | SYP 2,600,000 carried $200.00 -> $173.33: **unrealized loss $26.67** |
| Foreign cash held | USD in a cash/bank account is revalued | SYP in the cash box is revalued (1,300,000 SYP: $92.86 -> $86.67, **loss $6.19**) |

These four cases are the tests `SYP-base company: …` / `USD-base company: …` in `backend/test/multiCurrency.test.js`. Revaluations posted before the split (migration 0014) stay on 6800; the FX report classifies them by source.

Receivables are tracked per document in its own currency (`invoiceOpenMinor`) and in base (`lib/currency.js invoiceBaseOpen`). Payables: no supplier documents yet (Prompt 6) — revaluation covers receivables and foreign-currency asset/liability accounts only.

### 10. Purchasing and payables (Prompt 6) — `/api/purchasing`

Supplier party on the ledger: `party_type = 'supplier'`, `party_id = suppliers.id` (checked by `lib/tenantRefs.js`). AP control = `ap_control`.

| Event | Debit | Credit | Notes |
|---|---|---|---|
| Purchase request / quotation / PO | — | — | no posting; PO approval: threshold `po_approval_threshold_minor` (base) + optional named approver (**PROMPT 13 HOOK**) |
| Goods receipt (accepted qty) | `inventory` | `grni` | PO currency at the **receipt-date** rate; physical stock: the accepted qty is added to the product's **existing** `factory_inventory` row (one row per product, company-wide; the receipt's `warehouse_id` is recorded only — per-warehouse qty comes with Prompt 8) in the **same `ledger.transaction`** as the entry, plus moving-average cost (`products.cost_price`). Invoice posting and landed cost never touch the qty (no double count); a debit note with returned goods removes it. Checkpoints `purchasing.receipt.after_stock` / `.after_entry` |
| Supplier invoice, goods (three-way matched) | `grni` (receipt value of the qty invoiced, FIFO over receipts), `input_tax` | `ap_control` (supplier, invoice currency) | invoice-date rate. The difference is split per line: **price** = invoice amount at the *receipt* rate − GRNI cleared → `purchase_price_variance`; **rate** = invoice amount at the invoice rate − the same at the receipt rate (same quantity) → `fx_realized` (crystallised into AP at posting, so realized, not unrealized; shown as "realized" in the FX report); per-line vs header rounding → `rounding_difference`. Over-invoiced qty with no receipt is valued at the invoice rate (PPV only). Base-currency invoices: rate part is always 0. Line columns `ppv_base_minor` / `fx_base_minor`. Mismatch beyond tolerance blocks posting until `approve_purchase_mismatch` |
| Landed cost invoice (shipping, customs, transport, insurance) | `inventory` (allocated to the receipt's lines by value / weight / quantity, largest remainder), `input_tax` | `ap_control` (the freight supplier) | adds to item cost: new cost = (on hand x cost + share) / on hand |
| Expense invoice (no PO) | chosen expense/asset account, `input_tax` | `ap_control` | rounding residue -> `rounding_difference` |
| Supplier opening balance | `ap_control` with no supplier (reclass) **or** `opening_balance_equity` | `ap_control` (supplier) | posted as an `opening` supplier invoice so it ages and can be paid. No bill/due date = undated legacy (`due_date` NULL, aging bucket `legacy`, like customer_opening). Open-bills import: one `opening` invoice per bill with its own bill/due dates, all-or-nothing after a per-supplier sum check |
| Payment | `ap_control` (supplier, payment currency) | cash (`cash`) / `bank_in_transit` (transfer) / `cheques_payable` (cheque issued from treasury) | payment-date rate; cheques from a bank account: §11 |
| Payment allocated to an invoice at another rate | `ap_control` if gain / `fx_realized` if loss | `fx_realized` if gain / `ap_control` if loss | source `fx_realized_ap`; FX = invoice base relieved - base paid; closing allocations use exact remaining bases |
| Debit note (purchase return) | `ap_control` | `inventory` (or the expense account), `input_tax` | invoice currency at the invoice rate (no FX); stock reduced |
| Revaluation | `ap_control` (supplier) per open foreign invoice / unallocated payment | `fx_unrealized` | the Prompt 5 tool (`/api/currency/revaluations`); payables increase = loss; auto-reversal next day |

Payables aging is built from the AP ledger lines grouped per document, so its total is the AP control balance by construction; AP lines without a supplier show as "unassigned" (spread them with the supplier opening-balance tool).

### 11. Treasury (Prompt 7) — `/api/treasury`

Every cash box / bank account is one postable ledger account (`cash_boxes.account_id`, report class `cash`) with its own currency: a foreign box's account has `accounts.currency_code` set, so the ledger refuses any other currency on it and the box balance is kept in that currency (`amount_original_minor`). The main cash box is `cash_default` (created on first use). Rates: the Prompt 5 engine at the document date (override needs `override_exchange_rate`); carried lines (cheques payable, cheques in portfolio, rep custody) are released at the base they were booked at, and the difference goes to `fx_realized`.

| Event | Debit | Credit | Notes |
|---|---|---|---|
| RV receipt voucher (approved) | box | counter account | source `treasury_voucher`; draft -> approve posts; creator cannot approve when `enforce_purchasing_separation` is on (default) |
| PV payment voucher | counter account (optional employee party) | box | control accounts (`ar_control`, `ap_control`, `grni`, `inventory`, cheque and custody accounts, taxes) are refused — they need their own documents |
| EV expense voucher | expense account (net), `input_tax` | box (gross) | |
| BF bank fee | `bank_charges` | bank box | the bank fees log = the BF vouchers |
| TR transfer, same currency | to-box | from-box | no FX line |
| TR transfer, cross-currency | to-box (received amount at its rate) | from-box (sent amount at its rate) | difference -> `fx_realized` (debit = loss); no received amount typed = converted at the day's rates (no FX line) |
| Voucher reversal | mirror | mirror | refused while one of its lines is matched to a bank statement |
| Cheque issued to a supplier | `ap_control` (supplier) | `cheques_payable` | it **is** a supplier payment (allocation, realized FX, separation of duties) |
| Cheque issued to an account | counter account | `cheques_payable` | source `cheque_issued` |
| Issued cheque cleared | `cheques_payable` (carried base) | bank box (clearing-date rate) | difference -> `fx_realized`; source `cheque_issued_clear` |
| Issued cheque bounced / cancelled (before clearing) | reversal of the issue (supplier payment reversed: AP owed again, allocations freed) | | a cleared cheque cannot bounce |
| Received cheque (Prompt 3) in a foreign currency | `cheques_in_portfolio` | `ar_control` | rate **locked when recorded** (the accountant's confirmation) |
| Received cheque cleared into a bank box | bank box (clearing-date rate) | `cheques_in_portfolio` (carried base) | difference -> `fx_realized`; without a box (base cheques only) -> `bank_in_transit` as before |
| Rep collection in a foreign currency (confirmed) | `cash_default` / `bank_in_transit` / `rep_cash_custody` | `ar_control` | currency + amount in `collection_fx`; rate **locked at confirmation**; base collections unchanged (golden test) |
| Rep cash collection with `rep_cash_handover` = 1 | `rep_cash_custody` (party employee = rep) | `ar_control` | setting off (default) = `cash_default` as before |
| Rep cash handover (one currency per document) | cash box (counted, handover-date rate) | `rep_cash_custody` (carried base) | short/over (counted − expected, in the currency) -> `cash_over_short`; rate difference -> `fx_realized`; a handed-over collection cannot be reversed until the handover is |

Bank reconciliation does not post: statement lines are matched to ledger lines of the bank box (`bank_statement_lines.journal_line_id`, one statement line per ledger line). Auto-match: equal amount (in the box currency), date within 10 days; confidence 50 + date (same day 30, ≤3 days 20, ≤7 days 10) + reference hit 20; ≥80 and unambiguous = matched, 50–79 = suggested; the rest are the exceptions. Report: bank balance = book − deposits in transit + unpresented payments + bank-only credits − bank-only debits ± the first statement's opening difference; `difference_minor` must be 0.

### 12. Stock ledger (Prompt 8a) — `/api/stock`, active per company after activation

Activation (dry run -> execute the same plan) turns today's screen quantities into `opening` moves (factory rows -> the default warehouse, car rows -> the car pool) and posts ONE entry, source `inventory_opening`: Dr/Cr `inventory` and `inventory_custody` by (valuation − what the ledger already carries) / Cr/Dr `opening_balance_equity`. Not activated: none of the rows below happen and the old postings stay (warehouse golden test).

Holders: warehouse (`inventory`), vehicle / rep / car pool (`inventory_custody`). Valuation per product per holder: weighted average (default), FIFO (layers keep their origin through transfers), standard cost (difference to `purchase_price_variance`). Negative stock is refused (`insufficient_stock`).

| Event | Debit | Credit | Value |
|---|---|---|---|
| Goods receipt | holder stock account | `grni` | receipt value; standard: standard value, difference -> `purchase_price_variance` |
| Landed cost | holder stock account (stock still on hand from that receipt line) + `cogs` (share of quantity already gone; standard: `purchase_price_variance`) | `ap_control` | FIFO: to that receipt's open layers wherever they are; average: to the receipt holder if it holds stock |
| Debit note with returned goods | `ap_control` | holder stock account at the ORIGINAL cost (receipt value + landed share; FIFO: its own layers) + `purchase_price_variance` for the difference vs the invoice value | |
| Sales invoice | `cogs` | holder stock account (invoice warehouse, else the order rep's vehicle / rep, else default warehouse) | the 'sale' moves' valuation cost (replaces products.cost_price) |
| Credit note with restock | holder stock account (the sale's holder) | `cogs` | the sale's own cost |
| Return approved (restock) | `inventory_custody` (filing rep's holder) | `cogs` | current cost; the return's credit note then has no inventory leg |
| Custody transfer closed | `inventory_custody` (vehicle / rep) | `inventory` (source warehouse) | at cost; the factory stock goes down (behaviour change, stock ledger only) |
| Transfer document | to-holder account | from-holder account | at cost (same account for warehouse -> warehouse: recorded, nets to zero) |
| Count / screen quantity / offline count / manual adjustment | holder stock account (+) or `inventory_adjustments` (−) | the other | in: current cost; out: valuation; source `stock_move`, reason code on the move |
| Standard cost change | holder stock account | `purchase_price_variance` (or reverse) | qty × (new − old) |

Daily reconciliation (sweep, once per company per day): `inventory` + `inventory_custody` = Σ holder valuations (and each account = its holders), factory/car screen quantities = stock moves; a failure raises `stock_reconciliation_failed`.

### 12b. Lots, counts, wastage, repack (Prompt 8b)

| Event | Debit | Credit |
|---|---|---|
| Count approved, surplus (`count` move in) | holder inventory account (`inventory` / `inventory_custody`) | `inventory_adjustments` |
| Count approved, shortage (`count` move out, FEFO) | `inventory_adjustments` | holder inventory account |
| Wastage / damage / expiry / loss document | `inventory_wastage` | holder inventory account |
| Repack (out of A, into B, same holder) | holder account (B) | holder account (A); standard-cost difference to `purchase_price_variance` |

Lots carry quantity only (`stock_lot_balances`); value stays in the holder's pool, so lots never change a posting amount — only which lot the quantity leaves from (FEFO).

### 13. Manufacturing (Prompt 9) — `/api/manufacturing`, needs the stock ledger

| Event | Debit | Credit |
|---|---|---|
| Issue materials to a production order (lot-picked, FEFO) | `wip` | holder inventory account (cost of the issued lots) |
| Return unused material (into the lot it came from, at issued cost) | holder inventory account | `wip` |
| Close: finished goods received into a new lot | holder inventory account (finished goods value) | — |
| Close: by-products received at their effective value | holder inventory account | — |
| Close: abnormal loss (output below expected) | `inventory_wastage` | — |
| Close: clearing | — | `wip` (net materials), `production_labour`, `production_energy`, `production_overhead` (absorbed at the rates effective on the production date) |
| Close, standard-cost output: difference to the absorbed cost | `purchase_price_variance` (either side) | |
| Reject a batch | `inventory_wastage` (everything charged) | `wip`, `production_labour`, `production_energy`, `production_overhead` |

The value of the finished goods is net cost (materials + labour + energy + overhead − by-products) minus the abnormal-loss share. The abnormal-loss share is round(net × shortfall / expected), and the finished goods take the remainder, so there is no rounding residue. `production_*` accounts are credited when cost is absorbed; payroll and expenses debit them later, and what is left on them is under- or over-absorption. Accounts: food template adopts 1152 (WIP), 5300 (labour) and 5400 (overhead) and adds 5450 (energy); the trading template adds 1157, 5310, 5410 and 5450.

### 14. Fixed assets, tax codes, recurring entries (Prompt 10) — `/api/accounting`

| Event | Debit | Credit |
|---|---|---|
| Register an asset with a funding account (`fixed_asset`) | category asset account (cost) | funding account (cost − opening accumulated), category accumulated account (opening accumulated) |
| Supplier expense invoice, asset line (in the `supplier_invoice` entry) | category asset account (line base) | AP (with the rest of the invoice) |
| Monthly depreciation (`fa_depreciation`, one per asset per month) | category expense account | category accumulated account |
| Disposal / sale (`fa_disposal`) | accumulated depreciation, proceeds account, loss → disposal account | asset cost, gain → disposal account |
| Sales / credit note / expense line with a tax code | — | the code's tax account (credit notes and debit notes: the reverse) instead of output_tax / input_tax |
| Recurring template run (`recurring_run`) | template lines | template lines |
| Accrual | template lines on the run date; auto-reversal (`reversal`) on the 1st of the next month | |
| Prepayment amortisation | expense (debit account) | prepaid (credit account), total / N with cumulative rounding |

Lines without a tax code post exactly as before (one output_tax / input_tax line). These entries cannot be reversed from the journal screen (`reverse_via_source`).

### 15. Payroll accounting (Prompt 11-lite) — `/api/payroll`

Accounts come from `payroll_settings` (chosen per company).

| Event | Debit | Credit |
|---|---|---|
| Accrual (`payroll_period`, one entry per period, posting-date rate per currency) | payroll expense (gross), employer-contribution expense (per cost center) | salaries payable (net), deductions payable (deductions − advance recoveries + employer contributions), employee advances (recoveries at their own base) |
| — rate difference on advance recoveries | `fx_realized` (loss) | `fx_realized` (gain) |
| Payment (`treasury_voucher` linked in payroll_payments) | salaries payable (base currency: amount; foreign: its accrual value) | cash / bank (payment-date rate); difference to `fx_realized` |
| Advance paid (`treasury_voucher` linked in employee_advances) | employee advances | cash / bank |
| Reopen (`reversal` of the accrual) | the accrual reversed line by line | |

## Derived balances (live companies)

After every posted entry that touches AR(customer), `lib/customerLedger.js`
`refreshShopBalance()` rewrites today's `balances` row for that shop as the
sum of its AR lines dated up to today (`source_file='ledger'`). Two events on
the same day therefore both count. Readers (`shopData.js`, WhatsApp bot,
statements, dashboards) keep reading `balances` unchanged.

## Not posted yet (stubs in `lib/salesPosting.js`)

| Event | Prompt |
|---|---|
| Rep commissions (`lib/commissions.js`) | 11 — HR & payroll |
