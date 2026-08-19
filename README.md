# RDC Customer and Vendor Reconciliation

Internal reconciliation app for RDC ledgers against customer and vendor ledgers.

**Using it? Read [TESTING.md](TESTING.md)** — how to run a reconciliation, how to read
the certificate and the sheets, and what to do when a result looks wrong.

## Design rules

Three rules the code is held to, agreed after the first rounds of testing:

1. **Values are always read deterministically. AI never supplies a number.**
   AI is used to detect structure and, as a last resort, to read a file no parser
   can. Anything it extracts must reproduce the document's own balances or it is
   refused — a wrong figure presented confidently is worse than no reconciliation.
2. **Every parse is proved, not trusted.** Each ledger is checked row by row against
   the running balance and the debit/credit totals the file prints for itself. A file
   that prints neither is reported as *not verifiable*, never as correct.
3. **Correct, or loudly incomplete.** The certificate refuses to certify a run whose
   rows fail their own arithmetic, whose difference is not fully explained, or where
   nothing matched.

## What it handles

- **RDC exports:** debtors and creditors (payable) layouts, Excel / CSV / PDF.
- **Customer ledgers:** the mirror of the RDC layout; Tally parent-child allocations,
  columnar registers and "Ledger Account" prints; the Tally *columnar* print, which has
  no debit/credit pair at all and one money column per contra account; ERP exports that
  split one voucher across several account rows; customer-maintained invoice registers
  where one row carries both an invoice and a payment; SAP and AP statements of account
  keyed only on a document number.
- **Matching:** exact reference, truncated reference, near-identical reference (as a
  second pass, so it can never steal a row that has an exact partner), grouped
  payments by allocation or cheque, short receipts, and cancelled-invoice netting.
  When the counterparty ledger carries no document references at all — a Tally print
  whose voucher number is the customer's own serial — invoices are matched on amount
  and date instead, and every such pair says so in its Remarks.
- **Reporting:** a certificate, a parse audit, the reconciliation statement grouped
  by document type, duplicates, large-variance checks and a full parser log.

## Validation

```powershell
npm run validate
```

Runs every regression suite, the accuracy report and the parse audit, and prints one
verdict. **This must pass before deploying.** Every defect the accounts team has
reported is a permanent check in it, asserted against their own manual figures where
they supplied them.

## Current scope
- Excel RDC parser with opening/closing balances stored separately.
- Customer Tally Excel parser with parent/child allocation protection.
- PDF text parser with cheque-level payment grouping.
- Reference extraction from narration/particulars/voucher fields.
- Journal/JV classification for TDS, invoices, notes, and review adjustments.
- Customer debit-credit reversal net-zero detection before payment matching.
- Excel report with required reconciliation tabs.
- Stateless current-run exports for Railway testing. Reports are generated on demand and are not stored as history.

## Run

```powershell
npm install
npm run recon:samples
npm run dev
```

Open http://localhost:3000.

## Railway

Create a Railway service from this GitHub repo. The included `railway.json` uses Nixpacks and starts Next.js with Railway's `$PORT`.

Set these environment variables:

```text
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4.1-mini
AI_ENABLED=true
AI_CONFIDENCE_THRESHOLD=0.75
AI_MAX_ROWS=80
```

For deterministic-only testing, set `AI_ENABLED=false`.

### Admin console and usage tracking

`/admin` reports API calls, tokens and cost for any date range, plus every run and a
CSV export. It needs three more variables:

```text
DATABASE_URL=<the Railway Postgres connection string>
ADMIN_USERNAME=<your choice>
ADMIN_PASSWORD=<your choice>
```

Add PostgreSQL to the Railway project and reference its connection string as
`DATABASE_URL`. The `reconciliation_runs` table is created automatically on the first
reconciliation — there is no migration step.

Both are optional and fail safe: without `DATABASE_URL` reconciliations run exactly as
before and the console says so; without the admin credentials the console is **closed**,
not open. Usage logging can never fail a reconciliation, and no ledger content is
stored — only file names, counts, the verdict and the usage figures.
