# Reading a reconciliation — a guide for the accounts team

The app compares an **RDC ledger** against a **customer or vendor ledger** and produces
an Excel workbook. This page explains how to run it, how to read the result, and what
to do when something looks wrong.

---

## 1. Running one

Fill in the party name and the period, attach both ledgers, press **Run & Export**.

| Field | What to put |
|---|---|
| Customer / Vendor Name | The party's name — used only for labelling the report |
| Period Start / End | The period you are reconciling. See the note below |
| Invoice / Payment Tolerance | Rupees of difference to ignore when matching. `1` is normal |
| RDC Ledger | RDC's own export (`.xlsx`, `.xls`, `.csv` or `.pdf`) |
| Customer Ledger | Whatever the customer sent |

**About the period:** matching is *not* limited to it. Every row on both sides is
matched regardless of date, because customers routinely book an invoice weeks late.
The period only decides which of the *leftover* items are labelled "outside the
period". If in doubt, set it wide.

**Which file to upload:** upload the **plain ledger export**, not your working
reconciliation workbook. If a file contains extra sheets (your own reco, annexures,
the customer's ledger), the app will use only the sheet that is a real RDC ledger and
say so in the Parser_Log — but a clean export is always safer.

---

## 2. Read the certificate first

The first sheet, **Reconciliation_Certificate**, is the only place that says whether
the result can be trusted.

**CERTIFIED** means all of the following held:

- each ledger's rows add up to the closing balance that ledger itself states;
- every row agrees with the running balance / printed totals the file prints;
- the statement explains the whole difference between the two balances;
- something actually matched.

**REVIEW REQUIRED** means one of those failed. The reason is on the certificate, and
the detail is in **Parse_Audit**. Do not send a REVIEW REQUIRED reconciliation to a
customer without reading that sheet.

The certificate also shows the AI cost of the run. Most runs use no AI at all.

---

## 3. The sheets, in the order worth reading

| Sheet | What it is |
|---|---|
| **Reconciliation_Certificate** | Trust it or not, and why |
| **Parse_Audit** | Every row the app read that disagrees with the ledger's own arithmetic. Empty is good |
| **Summary_Reco_Statement** | The reconciliation statement itself |
| **Matched_Invoices / Matched_Receipts** | What tied up, with any difference per pair |
| **Large_Variance_Check** | Same invoice number, wildly different amounts — usually a mis-typed figure |
| **Unmatched_RDC / Unmatched_Customer** | Genuinely one-sided items, split into invoices and receipts |
| **Duplicates** | The same bill number booked more than once on one side |
| **Possible_Matches** | Pairs the app would not commit to |
| **Parser_Log** | What the app did with each file, sheet by sheet |

---

## 4. How the statement is written

Every line reads as **(Customer − RDC)**: **Add** when the customer's figure is
higher, **Less** when RDC's is. The lines are grouped the way the team writes a
reconciliation by hand:

```
Balance As per RDC                                        13,12,247.34
Balance As per AFA                                         8,58,403.06
Difference                                                 4,53,844.28
Add   Amount differences on matched invoices/receipts          10,003.37
Less  Invoice/payment present in RDC not booked — Invoices  4,49,960.50
Less  Entry accounted by customer but not in RDC — Receipts    47,134.00
Unexplained Difference                                              0.00
```

**Unexplained Difference must be zero.** If it is not, the app is telling you it
cannot account for that amount — treat the reconciliation as incomplete.

---

## 5. When something looks wrong

Check these in order; the first two explain most cases.

1. **Is the certificate CERTIFIED?** If not, read Parse_Audit — it names the exact
   rows whose amounts do not agree with the ledger's own running balance.
2. **Are both closing balances right?** They are on the statement. If one is wrong,
   the app misread that file and everything below it is unreliable.
3. **Too many unmatched invoices?** Look at whether the reference column is populated
   in Unmatched_Customer. Blank references mean the app could not find the bill
   numbers in that file's layout.
4. **A payment appears on both sides as "missing"?** Check Matched_Receipts first —
   short receipts (tax withheld, bank charges) are matched with the shortfall shown.

If it still looks wrong, send the two ledger files **and your manual reconciliation**.
The manual figures are what the fix gets tested against, and every case sent so far has
been turned into a permanent automated check.

---

## 6. File formats that are handled

Excel and CSV in the RDC debtors and creditors layouts; the customer-side mirror of
the RDC layout; Tally exports (parent-child allocations, columnar registers, and the
"Ledger Account" print); ERP exports that split one voucher across several account
rows; customer-maintained invoice registers where a row holds both an invoice and a
payment; SAP statements of account; and several PDF ledger layouts.

**PDFs that are scans or photographs have no text to read.** The app will attempt them
with AI and then *refuse* the result unless the extracted rows reproduce the
document's own balances — a wrong figure is worse than none. For those customers, ask
for an Excel or Tally export.

---

## 7. For developers

```bash
npm run validate
```

Runs every regression suite, the accuracy report and the parse audit, and prints one
verdict. **It must pass before deploying.** Suites whose customer data is absent are
skipped, so this works on a fresh clone.

```bash
npm run accuracy   # % of reference customers reconciling to CERTIFIED
npm run audit      # row-level parse audit across every local ledger
```

Real customer ledgers live in gitignored `test-data*/` folders and are never
committed. Each reported defect becomes a check in a `scripts/validate-fixes-N.ts`
suite, asserted against the accounts team's own manual figures where available.
