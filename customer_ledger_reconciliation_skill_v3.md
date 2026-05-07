# Customer Ledger Reconciliation Skill — RDC v3

## Purpose
Reconcile RDC customer ledgers against customer-provided ledgers when formats differ. Convert both sides into a common transaction model, match invoices/payments/TDS/opening/closing balances, and produce an audit-friendly reconciliation statement and exception workbook.

## Key Learnings Added in v3
This version incorporates findings from Suruchi and Bearys review:

1. **Customer payment reversals must be netted.** If the customer ledger has debit and credit entries with the same date, same amount, same voucher/cheque/reference/narration context, treat the net impact as zero. Do not count both sides as payment. These rows must be classified as `CUSTOMER_PAYMENT_REVERSAL_NET_ZERO`.
2. **Journal entries are valid reconciliation entries.** Do not ignore customer ledger `Journal` / `JV` rows. They may represent TDS, invoice booking, debit note, credit note, or adjustment.
3. **Invoice references may be in narration, not only in bill/reference column.** Extract invoice numbers from every available text field: bill no, narration, particulars, voucher number, allocation text, remarks, and PDF line text.
4. **TDS journals must appear in the reconciliation summary.** For Bearys and other Tally ledgers, TDS deducted by customer under `Journal` must be parsed, compared, and summarized separately.
5. **Summary must be produced in reconciliation-statement format.** The app must generate an on-screen and exportable summary similar to the manually prepared image: opening balance difference, add/less lines, and final unreconciled difference.
6. **Customer items outside RDC selected period must be separate.** Do not mix them with normal customer unmatched entries.

## Normalized Data Model
Each source transaction/allocation must be normalized into:

| Field | Meaning |
|---|---|
| source_side | RDC or CUSTOMER |
| source_file | Original file name |
| source_sheet_or_page | Sheet/page/source section |
| source_row_or_line | Source row or PDF text line |
| party_name | Customer/ledger account name |
| date | YYYY-MM-DD |
| voucher_type | INVOICE, RECEIPT, PAYMENT, TDS, OPENING, CLOSING, JOURNAL_INVOICE, JOURNAL_TDS, JOURNAL_ADJUSTMENT, DEBIT_NOTE, CREDIT_NOTE, REVERSAL, OTHER |
| voucher_no | Original voucher number |
| reference_no | Original invoice/reference number |
| normalized_reference_no | Match-ready reference |
| parent_voucher_no | Parent row voucher if allocation row |
| cheque_no | Cheque/UTR/payment reference |
| allocation_type | New Ref, Agst Ref, Inferred, blank |
| particulars | Narration/description |
| debit | Original debit |
| credit | Original credit |
| signed_amount_rdc_view | Invoice/debit positive; receipt/payment/TDS/credit negative |
| netting_group_key | Key used to identify debit-credit reversals/net-zero groups |
| parse_confidence | 0-100 |
| parser_notes | Warnings or assumptions |

## RDC Standard Ledger Parser
Detect by headers such as `Inv/ Receipt Date`, `Doc Type`, `GST Inv Number`, `Tran Dr Amt (Rs)`, `Tran Cr Amt (Rs)`.

Rules:
- `INV` = invoice; use `GST Inv Number` as primary reference; amount = debit.
- `REC` = receipt/payment/TDS credit; use `Inv / Receipt Number`, cheque/receipt reference, or narration when invoice reference is blank; amount = negative credit.
- Parse `Customer Opening Balance` and `Customer Closing Balance` separately.
- Ignore `Total of Debits and Credits` in transaction matching.
- Preserve all row numbers and original references.

## Customer Tally Excel Parser
Detect by headers `Date`, `Particulars`, `Vch Type`, `Vch No.`, `Debit`, `Credit`.

Rules:
1. A row with valid date starts a parent voucher.
2. Following rows where date is blank and text contains `New Ref` or `Agst Ref` are allocation rows attached to the parent.
3. For invoices, use child `New Ref` rows where available, not just the parent row.
4. `Purchases` / `Local Purchases` + `New Ref` + `Cr` = customer-booked RDC invoice; amount is positive from RDC view.
5. `Bank Payment` debit = payment by customer to RDC; amount is negative from RDC view.
6. `Journal`, `JV`, `TDS`, `194Q`, `194C`, `tax deducted`, `TDS on Supply`, or child `Agst Ref` debit linked to TDS narration = TDS/adjustment; amount is negative from RDC view.
7. `Journal` / `JV` rows with invoice-like references and credit amount may be customer-booked invoices. Classify as `JOURNAL_INVOICE`, not ignored.
8. Do not double-count parent amount and child allocation amount.
9. Run debit-credit reversal netting after parsing.

## Customer PDF Parser
Rules:
- Extract text from PDF first. Render pages/use OCR only if text extraction fails.
- Extract invoice references from all line text, not only the Bill No column.
- Extract debit, credit, and balance amounts from each transaction line.
- In customer books, credit invoice = positive from RDC view; debit payment = negative from RDC view.
- Aggregate BP/payment lines by cheque number when one cheque is split into many allocation lines.
- Preserve PDF page/line reference for audit.
- Customer PDFs may have repeated BP rows for the same cheque and many invoice allocations. Group before matching.

## Reference Extraction and Normalization
Extract references from **all text-bearing columns**, including narration and particulars.

Reference patterns must include:
- `\b\d{1,2}CH\d{2}ARS\d+\b`
- `\b\d{1,2}CH\d{2}BP\d-?\d+\b`
- `\b\d{1,2}CG\d{2}BP\d-?\d+\b`
- `\b\d{1,2}CH\d{2}ARCM\d+\b`
- `\b\d{1,2}CH\d{2}ARMN\d+\b`
- references after words such as `Bill No`, `Invoice No`, `Inv No`, `D No`, `Ref`, `Against`, `Being Bill Booked Against Invoice No.`

Normalization:
- Uppercase.
- Trim spaces.
- Remove repeated punctuation.
- For matching only, remove `/`, spaces, and non-meaningful separators.
- Preserve meaningful prefixes like `1CH`, `6CH`, `ARS`, `BP1`, `ARCM`, `ARMN`.
- Keep original reference in output.

If a narration contains a truncated reference such as `11MU25BP1-...`, classify as `LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED`; do not mark directly as missing unless manual review confirms.

## Debit-Credit Reversal / Net-Zero Logic
Before payment reconciliation, identify reversal pairs/groups in the customer ledger.

A reversal/net-zero group exists when:
- same customer ledger,
- same date or same voucher date,
- same amount,
- opposite signs: one debit and one credit,
- same voucher no OR same cheque no OR highly similar narration/particulars OR same extracted reference,
- voucher type indicates payment/reversal/journal/receipt/bank.

Treatment:
- Net signed amount = 0.
- Do not include the gross debit and gross credit in payment totals.
- Show in a separate detail tab `Net_Zero_Reversals`.
- Summary line should say: `Customer payment reversal / debit-credit netted to zero`.
- Reason code: `CUSTOMER_PAYMENT_REVERSAL_NET_ZERO`.

This prevents cases where customer ledger reversed payments are counted twice and incorrectly shown as large payment impact.

## Journal Entry Logic
Never ignore Journal/JV rows. Classify them using narration, reference, and sign:

| Journal Pattern | Classification | RDC View |
|---|---|---|
| TDS, 194Q, 194C, tax deducted | JOURNAL_TDS / TDS | Negative |
| Ready Mix Concrete + invoice reference + credit | JOURNAL_INVOICE | Positive |
| Debit note / D No / ARCM depending on customer sign | DEBIT_NOTE or CREDIT_NOTE review | Based on sign |
| Credit note / CN / invoice cancelled | CREDIT_NOTE | Negative |
| No reference and unclear narration | JOURNAL_ADJUSTMENT_REVIEW | Manual review |

Journal totals must be included in the summary under appropriate lines: TDS, invoices booked through journal, debit notes, credit notes, or adjustments.

## Outside RDC Period Rule
If customer ledger contains a transaction/reference outside the selected RDC reconciliation period:
- Do not classify as normal `MISSING_IN_RDC`.
- Use reason code `OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER`.
- Show in separate tab `Outside_RDC_Period_Customer_Items`.
- Use it to explain opening balance, closing balance, or payment allocation differences.

## Matching Rules
Default tolerance: INR 1.00 for invoice amount.

Hierarchy:
1. Exact reference + amount within tolerance = auto-match, confidence 100.
2. Normalized reference + amount within tolerance = auto-match, confidence 95.
3. Reference found in narration + amount within tolerance = auto-match if reference is complete, confidence 90.
4. Exact reference + TDS-adjusted amount = matched with TDS, confidence 90.
5. Payment by cheque/reference after net-zero grouping + amount/date tolerance = payment match.
6. Amount + nearby date but weak/missing reference = possible match.
7. Fuzzy reference + same amount/date = possible match requiring approval.
8. Truncated/incomplete reference = low parse confidence, not automatic missing.
9. Otherwise exception.

## Exception Codes
- OPENING_BALANCE_MISMATCH
- CLOSING_BALANCE_MISMATCH
- MISSING_IN_CUSTOMER
- MISSING_IN_RDC
- OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER
- AMOUNT_MISMATCH
- DATE_MISMATCH
- PAYMENT_AMOUNT_MISMATCH
- PAYMENT_ALLOCATION_MISMATCH
- TDS_NOT_FOUND
- TDS_JOURNAL_NOT_IN_RDC
- JOURNAL_INVOICE_NOT_IN_RDC
- REFERENCE_MISMATCH
- DUPLICATE_REFERENCE_RDC
- DUPLICATE_REFERENCE_CUSTOMER
- POSSIBLE_MATCH_REVIEW_REQUIRED
- LOW_PARSE_CONFIDENCE
- LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED
- CUSTOMER_PAYMENT_REVERSAL_NET_ZERO
- PERIOD_SCOPE_MISMATCH
- JOURNAL_ADJUSTMENT_REVIEW

## Required Output Tabs
- Summary_Reco_Statement
- Summary_Cards
- Matched_Invoices
- Unmatched_RDC
- Unmatched_Customer
- Outside_RDC_Period_Customer_Items
- Payment_Compare
- Net_Zero_Reversals
- TDS_Compare
- Journal_Entries_Considered
- Possible_Matches
- Opening_Closing
- Parser_Log

## Reconciliation Statement Format
Generate a summary like the manually prepared image:

Title: `Reconciliation RDC vs <Customer Name>`

Columns:
- Sign: blank/Add/Less
- Particular
- Amount
- Remarks

Required flow:
1. Balance as per RDC
2. Balance as per Customer
3. Difference
4. Add/Less reconciling lines grouped by reason code
5. Final Difference

Example lines to support:
- Less: Invoice not booked by customer
- Add: Due to missing invoice number in narration/column but manually mapped
- Add/Less: CN/DN not accounted by customer or RDC
- Less: Wrong CN booked by customer; net impact zero if DN and CN both exist
- Less: Short invoice booked by customer
- Add: Excess/Duplicate invoice booked by customer
- Add: Purchase invoices accounted by customer but not considered in recon
- Less/Add: Payment not considered by RDC/customer
- Less: Debit raised by vendor/customer not accounted by RDC
- Less: TDS entry not accounted by RDC
- Add/Less: Outside RDC period present in customer ledger
- Add/Less: Customer payment reversal netted to zero

The final difference should reconcile to zero where all items are explained. If not, show the balance as `Unexplained Difference`.

## Summary Image / Export Requirement
The app must create:
1. On-screen reconciliation statement in the same visual style as the image: bold title, yellow header, yellow difference rows, Add/Less column, Particular, Amount, Remarks.
2. Excel tab `Summary_Reco_Statement` with the same layout and formatting.
3. Optional PNG/PDF export of the summary statement for management review.

## Non-Negotiable Rules
- Preserve source row/page/line references.
- Never treat opening/closing/total rows as invoices.
- Never double-count customer parent and child allocation rows.
- Never ignore Journal/JV rows.
- Never count debit-credit reversal pairs as gross payment impact; net them to zero.
- Do not auto-match fuzzy or truncated references below confidence 75.
- Always show parser assumptions and low-confidence parsing.
- TDS must be summarized separately, including TDS booked through customer Journal entries.
- Flag period/scope mismatch where the customer ledger covers a wider period than the RDC ledger.
