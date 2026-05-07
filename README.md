# RDC Customer and Vendor Reconciliation

Internal parser-first reconciliation app for RDC ledgers vs customer/vendor ledgers.

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
