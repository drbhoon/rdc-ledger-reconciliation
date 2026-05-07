# CODEX PROMPT — Build RDC Customer Ledger Reconciliation App v2

You are building an internal RDC customer ledger reconciliation app. Do not start with UI only. First build parsers and reconciliation engine that pass the supplied sample sets and the revised accounting logic below.

## Business Problem
RDC has a standard debtors ledger format. Customers send ledgers in different formats: Tally Excel exports, PDF ledger prints, or custom Excel statements. The app must compare one RDC ledger with one customer ledger and show:
- what matched,
- what did not match,
- what may match but needs human approval,
- opening/closing/payment/TDS differences,
- customer entries outside selected RDC period,
- a management reconciliation statement in Add/Less format.

## Critical Corrections From User Review
Implement these before anything else:

### 1. Customer Payment Reversal / Net-Zero Logic
In some customer ledgers, payments are reversed. If customer ledger has debit and credit entries with the same date and same amount, and same voucher/cheque/reference/narration context, the net impact is zero.

Required behavior:
- Identify debit-credit reversal pairs/groups before payment reconciliation.
- Do not count both sides as payments.
- Do not inflate payment value. Example issue: Suruchi customer ledger was incorrectly showing about Rs. 76 lakh as payment because reversal rows were counted gross.
- Classify as `CUSTOMER_PAYMENT_REVERSAL_NET_ZERO`.
- Show details in tab `Net_Zero_Reversals`.
- Include an Add/Less summary line only if required to explain the reconciliation difference.

Algorithm:
- Build `nettingGroupKey` using customer, date, amount, chequeNo, voucherNo, extractedReference, and normalized narration.
- If total debit equals total credit within INR 1 tolerance, mark group as net zero.
- Exclude net-zero groups from payment totals and unmatched payment exceptions.

### 2. Journal Rows Must Be Considered
Do not ignore customer ledger rows where voucher type is `Journal`, `JV`, or similar.

Journal classification rules:
- Narration/reference contains `TDS`, `194Q`, `194C`, `tax deducted`, `TDS on Supply` -> classify as `JOURNAL_TDS` / `TDS` and compare with RDC TDS/receipt/adjustment side.
- Narration/particulars contains invoice reference and credit amount -> classify as `JOURNAL_INVOICE`.
- Narration contains debit note / `D No` / `ARCM` -> classify as debit/credit note based on sign and customer/RDC view.
- Narration contains credit note / invoice cancelled / CN -> classify as credit note or cancellation.
- If unclear, classify as `JOURNAL_ADJUSTMENT_REVIEW`, not ignored.

Suruchi case requirement:
- TDS around Rs. 3,000 booked through Journal must appear in reconciliation.
- Purchase invoices booked by customer through Journal of approx. Rs. 11 lakh must be considered.

Bearys case requirement:
- TDS deducted by customer under `Journal` must appear in the reconciliation summary and `TDS_Compare` tab.

### 3. Reference Extraction From Narration
Invoice number may be present in narration/particulars instead of the designated Bill No/reference column.

Required behavior:
- Extract references from every text field: bill no, narration, particulars, voucher no, allocation rows, remarks, PDF line text.
- If reference is complete and amount matches, use it for matching.
- If reference is truncated, e.g. `11MU25BP1-...`, do not mark as normal missing. Classify as `LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED` and send to review.

Reference regex patterns must include:
```regex
\b\d{1,2}CH\d{2}ARS\d+\b
\b\d{1,2}CH\d{2}BP\d-?\d+\b
\b\d{1,2}CG\d{2}BP\d-?\d+\b
\b\d{1,2}CH\d{2}ARCM\d+\b
\b\d{1,2}CH\d{2}ARMN\d+\b
```
Also extract after keywords:
`Bill No`, `Invoice No`, `Inv No`, `D No`, `Ref`, `Against`, `Being Bill Booked Against Invoice No.`

### 4. Outside RDC Period Separate Category
Customer ledger items outside the selected RDC period must not be mixed with normal unmatched customer items.

Use reason code:
`OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER`

Show them in tab:
`Outside_RDC_Period_Customer_Items`

### 5. Summary Must Match Manual Image Format
The app must produce a reconciliation statement like the provided image.

On-screen and Excel tab layout:

Title: `Reconciliation RDC vs <Customer Name>`

Columns:
- Sign: blank/Add/Less
- Particular
- Amount
- Remarks

Required rows:
1. `Balance As per RDC`
2. `Balance As per <Customer Name>`
3. `Difference`
4. Reconciling Add/Less lines grouped by exception category
5. Final `Difference` or `Unexplained Difference`

Visual style:
- Bold title.
- Yellow header row.
- Yellow difference rows.
- Amounts in Indian number format.
- Remarks column for logic notes like `Manually adjusted against not booked invoice`, `Not considered in AI Recon`, `Reference found in narration`, `Customer reversal netted to zero`.

Also provide optional PNG/PDF export of the summary statement.

## Sample Sets To Pass

### Bearys
Files:
- RDC: `bearys - RDC -ledger.xlsx`
- Customer: `beays  - customer-ledger.xlsx`

Expected behavior:
- Parse customer Tally parent rows and `New Ref` / `Agst Ref` child rows.
- Treat `Purchases` and `Local Purchases` as customer-booked invoices.
- Treat `Bank Payment` as payment.
- Treat customer `Journal` TDS entries as TDS and include them in summary.
- Do not double-count parent/child rows.

### Elite
Files:
- RDC: `Elite - RDC Ledger.xlsx`
- Customer: `elite - customer - ledger.pdf`

Expected behavior:
- Parse PDF invoice references from Bill No and narration lines.
- Group BP payment rows by cheque number before matching.
- Detect wider customer PDF scope and use period filter.
- Payment cheques in customer PDF may contain many allocation lines; compare grouped cheque totals, not individual repeated lines.

### Pratha and Suruchi
Files:
- `Pratha Constructions -rdc ledger.xlsx`
- `Pratha Constructions -customer ledger.xlsx`
- `Suruchi Developers- RDC Ledger.xlsx`
- `Suruchi Developers -customer Ledger.xlsx`

Expected behavior:
- Extract invoice references from narration, not only reference column.
- Do not treat truncated references as confirmed missing.
- In Suruchi, do not count reversed customer payments gross; debit-credit same date/amount should net to zero.
- In Suruchi, Journal entries must be included for TDS and invoice booking.

## Common Normalized Transaction Model
```ts
type NormalizedTxn = {
  sourceSide: 'RDC' | 'CUSTOMER';
  sourceFile: string;
  sourceSheet?: string;
  sourceRow: number | string;
  sourcePage?: number;
  partyName?: string;
  date?: string;
  voucherType:
    | 'INVOICE'
    | 'RECEIPT'
    | 'PAYMENT'
    | 'TDS'
    | 'OPENING'
    | 'CLOSING'
    | 'JOURNAL_INVOICE'
    | 'JOURNAL_TDS'
    | 'JOURNAL_ADJUSTMENT'
    | 'DEBIT_NOTE'
    | 'CREDIT_NOTE'
    | 'REVERSAL'
    | 'OTHER';
  voucherNo?: string;
  referenceNo?: string;
  normalizedReferenceNo?: string;
  extractedReferences?: string[];
  parentVoucherNo?: string;
  chequeNo?: string;
  allocationType?: 'New Ref' | 'Agst Ref' | 'Inferred' | '';
  particulars?: string;
  narration?: string;
  debit: number;
  credit: number;
  signedAmountRdcView: number;
  amountOriginalSign?: 'Dr' | 'Cr' | '';
  nettingGroupKey?: string;
  isNetZeroReversal?: boolean;
  parseConfidence: number;
  parserNotes?: string[];
};
```

## Matching Hierarchy
1. Exact reference + amount within tolerance.
2. Normalized reference + amount within tolerance.
3. Reference found in narration + amount within tolerance.
4. Exact reference + TDS-adjusted amount.
5. Credit/debit note match by ARCM/ARMN/reference and amount.
6. Payment match by cheque/reference after net-zero grouping.
7. Payment match by grouped amount + date tolerance.
8. Fuzzy reference + same amount/date -> review only.
9. Truncated reference -> low confidence review only.
10. Otherwise exception.

Default tolerances:
- Invoice amount tolerance: INR 1.00.
- Payment amount tolerance: INR 1.00 unless user changes.
- Invoice date tolerance: 7 days.
- Payment date tolerance: 15 days.

## Exception Codes
Use these exact reason codes:
- `OPENING_BALANCE_MISMATCH`
- `CLOSING_BALANCE_MISMATCH`
- `MISSING_IN_CUSTOMER`
- `MISSING_IN_RDC`
- `OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER`
- `AMOUNT_MISMATCH`
- `DATE_MISMATCH`
- `PAYMENT_AMOUNT_MISMATCH`
- `PAYMENT_ALLOCATION_MISMATCH`
- `TDS_NOT_FOUND`
- `TDS_JOURNAL_NOT_IN_RDC`
- `JOURNAL_INVOICE_NOT_IN_RDC`
- `REFERENCE_MISMATCH`
- `DUPLICATE_REFERENCE_RDC`
- `DUPLICATE_REFERENCE_CUSTOMER`
- `POSSIBLE_MATCH_REVIEW_REQUIRED`
- `LOW_PARSE_CONFIDENCE`
- `LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED`
- `CUSTOMER_PAYMENT_REVERSAL_NET_ZERO`
- `PERIOD_SCOPE_MISMATCH`
- `JOURNAL_ADJUSTMENT_REVIEW`

## Output Workbook Tabs
Generate these tabs:
1. `Summary_Reco_Statement`
2. `Summary_Cards`
3. `Matched_Invoices`
4. `Unmatched_RDC`
5. `Unmatched_Customer`
6. `Outside_RDC_Period_Customer_Items`
7. `Payment_Compare`
8. `Net_Zero_Reversals`
9. `TDS_Compare`
10. `Journal_Entries_Considered`
11. `Possible_Matches`
12. `Opening_Closing`
13. `Parser_Log`

Every output row must show source file, source sheet/page, source row/line, original reference, normalized reference, date, RDC amount, customer amount, difference, match status, reason code, confidence score, and parser notes.

## UI Requirements
Build a simple internal web app:
- Upload RDC ledger and customer ledger.
- Select customer name and reconciliation period.
- Choose amount/date tolerances.
- Preview detected parser mapping before running.
- Run reconciliation.
- Show summary cards and the Add/Less reconciliation statement.
- Show exception tables.
- Allow user to approve possible matches.
- Export Excel report.
- Export summary statement as PNG/PDF.

## Tech Stack Suggestion
Use a practical stack suitable for GitHub + Railway deployment:
- Next.js or React frontend.
- Node.js backend API.
- `xlsx` for Excel parsing.
- `pdf-parse` or `pdfjs-dist` for PDF text extraction.
- Optional OCR fallback only when PDF text extraction fails.
- PostgreSQL only if persistence/user history is required; otherwise file-in/file-out MVP is acceptable.

## Non-Negotiable Rules
- Never silently ignore unmatched transactions.
- Never ignore Journal/JV rows.
- Never double-count Tally parent and child rows.
- Never count debit-credit reversal pairs gross; net them first.
- Do not treat opening/closing/total rows as invoices.
- Do not auto-match fuzzy or truncated references below confidence 75.
- Always preserve audit trail back to source row/page/line.
- TDS booked through customer Journal must appear in summary and `TDS_Compare`.
- If customer ledger has wider period/scope than RDC ledger, flag `PERIOD_SCOPE_MISMATCH` and classify outside-period customer items separately.
- Before claiming app is complete, run it on Bearys, Elite, Pratha, and Suruchi sample sets and reproduce reasonable reconciliation statements.
