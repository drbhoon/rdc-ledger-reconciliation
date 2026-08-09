import type { LedgerAudit, NormalizedTxn, ParseResult, RowAuditIssue } from './types';

/**
 * Row-level parse audit — proves the parse against what the source document
 * already prints about itself, instead of trusting it.
 *
 * Three independent checks, strongest first:
 *
 *  1. RUNNING-BALANCE CONTINUITY. Most ledgers print a balance on every row.
 *     Each row's amount must equal the movement in that balance, so a single
 *     mis-read figure is caught on the row where it happens — this is what
 *     catches a qty fused into an amount, or an AI reading ₹1,90,400 as
 *     ₹19,04,000, without anybody reporting it.
 *  2. PRINTED DEBIT / CREDIT TOTALS. Verified SEPARATELY, so two errors that
 *     happen to cancel out in the net balance are still caught.
 *  3. OPENING + Σ ROWS = CLOSING (the existing integrity identity).
 *
 * A ledger nobody can verify (no balances, no totals) is reported as
 * NOT_VERIFIABLE rather than PASS — silence is not evidence.
 */
export function auditLedger(parsed: ParseResult, side: 'RDC' | 'CUSTOMER', tolerance = 2): LedgerAudit {
  const checks: string[] = [];
  const issues: RowAuditIssue[] = [];
  const txns = parsed.transactions;
  const aiExtractedRows = txns.filter(t => t.parserNotes?.some(n => /AI-extracted/i.test(n))).length;

  // ── 1. running-balance continuity ─────────────────────────────────────────
  const balancedRows = txns.filter(t => typeof t.runningBalance === 'number' && Number.isFinite(t.runningBalance));
  let rowsChecked = 0;
  if (balancedRows.length >= 3) {
    checks.push(`Running balance continuity on ${balancedRows.length} rows`);
    // Walk EVERY transaction in order, accumulating, and settle up whenever a
    // printed balance appears. A source row can produce more than one entry (an
    // invoice and a payment on the same line, or a voucher split across account
    // heads) and the balance covers all of them.
    let previous = parsed.balances.opening;
    let accumulated = 0;
    const pending: NormalizedTxn[] = [];
    for (const txn of txns) {
      accumulated += txn.signedAmountRdcView;
      pending.push(txn);
      const balance = txn.runningBalance;
      if (typeof balance !== 'number' || !Number.isFinite(balance)) continue;
      if (previous != null) {
        const expected = balance - previous;
        const delta = accumulated - expected;
        rowsChecked += 1;
        if (Math.abs(delta) > tolerance) {
          issues.push({
            sourceRow: pending.map(p => p.sourceRow).join(','), date: txn.date, reference: txn.referenceNo,
            parsedAmount: accumulated, expectedAmount: expected, delta,
            message: `${pending.length > 1 ? `The ${pending.length} entries read from this row total` : 'Row amount'} ${accumulated.toFixed(2)}, but the ledger's own running balance moves by ${expected.toFixed(2)}`,
          });
        }
      }
      previous = balance;
      accumulated = 0;
      pending.length = 0;
    }
  }

  // ── 2. printed debit / credit totals ──────────────────────────────────────
  // Compare like with like: a total printed on one sheet covers only that
  // sheet's rows (workbooks often hold several overlapping-period sheets).
  const totalsSheet = parsed.printedTotals?.sheet;
  const totalsScope = totalsSheet ? txns.filter(t => t.sourceSheet === totalsSheet) : txns;
  const parsedDebitTotal = totalsScope.reduce((s, t) => s + Math.abs(t.debit || 0), 0);
  const parsedCreditTotal = totalsScope.reduce((s, t) => s + Math.abs(t.credit || 0), 0);
  const printedDebitTotal = parsed.printedTotals?.debit;
  const printedCreditTotal = parsed.printedTotals?.credit;
  let debitTotalGap: number | undefined;
  let creditTotalGap: number | undefined;
  // A workbook whose rows span several sheets (after cross-sheet duplicate
  // removal) cannot be checked against a single sheet's printed total — the
  // total and the surviving rows no longer describe the same population.
  const sheetsUsed = new Set(txns.map(t => t.sourceSheet).filter(Boolean));
  const totalsComparable = sheetsUsed.size <= 1;
  if (!totalsComparable && printedDebitTotal != null) {
    checks.push('Printed totals skipped (rows span multiple sheets after duplicate removal)');
  }
  if (totalsComparable && printedDebitTotal != null && printedCreditTotal != null && (printedDebitTotal || printedCreditTotal)) {
    checks.push('Printed debit and credit totals');
    // Opening/closing rows are excluded from transactions but are usually
    // inside the printed totals, so compare both ways and keep the better fit.
    const opening = parsed.balances.opening ?? 0;
    const openingDebit = opening > 0 ? Math.abs(opening) : 0;
    const openingCredit = opening < 0 ? Math.abs(opening) : 0;
    const pick = (parsedValue: number, printed: number, openingPart: number) =>
      Math.abs(Math.abs(parsedValue - printed) < Math.abs(parsedValue + openingPart - printed) ? parsedValue - printed : parsedValue + openingPart - printed);
    debitTotalGap = pick(parsedDebitTotal, printedDebitTotal, openingDebit);
    creditTotalGap = pick(parsedCreditTotal, printedCreditTotal, openingCredit);
  }

  // ── 3. opening + Σ rows = closing ─────────────────────────────────────────
  // Reported for information only. The certificate already tests this, and it
  // is only meaningful after the customer ledger's orientation is normalised,
  // which happens later — judging it here would fail perfectly good files.
  let integrityGap: number | undefined;
  if (parsed.balances.closing != null) {
    integrityGap = txns.reduce((s, t) => s + t.signedAmountRdcView, parsed.balances.opening || 0) - parsed.balances.closing;
  }

  const totalsFail = (debitTotalGap != null && Math.abs(debitTotalGap) > tolerance)
    || (creditTotalGap != null && Math.abs(creditTotalGap) > tolerance);
  // Verifiable only when the file gave us something to check against. "No
  // evidence" is reported as such, never as a pass.
  const verifiable = rowsChecked > 0 || debitTotalGap != null;
  const verdict: LedgerAudit['verdict'] = !verifiable
    ? 'NOT_VERIFIABLE'
    : (issues.length || totalsFail) ? 'FAIL' : 'PASS';

  return {
    side, verdict, checks, rowsChecked, issues: issues.slice(0, 500),
    printedDebitTotal, parsedDebitTotal, debitTotalGap,
    printedCreditTotal, parsedCreditTotal, creditTotalGap,
    integrityGap, aiExtractedRows,
  };
}

/** One-line human summary for logs and the certificate. */
export function describeAudit(a: LedgerAudit) {
  if (a.verdict === 'NOT_VERIFIABLE') return `${a.side}: no running balance or printed totals in the file — the parse could not be independently verified`;
  const bits = [`${a.rowsChecked} rows checked against the ledger's own running balance`];
  if (a.debitTotalGap != null) bits.push(`printed totals off by Dr ${a.debitTotalGap.toFixed(2)} / Cr ${(a.creditTotalGap ?? 0).toFixed(2)}`);
  if (a.integrityGap != null) bits.push(`closing-balance gap ${a.integrityGap.toFixed(2)}`);
  if (a.issues.length) bits.push(`${a.issues.length} row(s) failed`);
  return `${a.side}: ${a.verdict} — ${bits.join('; ')}`;
}
