/**
 * Round-14 harness (2026-08-09): AFA — asserted against the Accounts team's
 * manual reconciliation as of 10-Jun-26:
 *   RDC 13,12,247.34 | AFA 8,58,403.06 | Difference 4,53,844.28
 *   Less invoice not booked   4,49,960.50
 *   Add  excess invoice booked   10,003.37
 *   Less TDS not booked by RDC   13,887.50
 *   Add  short & excess               0.35   -> 0.00
 * The app had read AFA's balance as -3,46,750.88 (out by 12,05,153.94) and
 * left 2,174 invoices unmatched.
 * Run: npx tsx scripts/validate-fixes-9.ts   (data: ./test-data-260726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { auditLedger } from '../src/core/audit';
import { reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-260726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC AFA INFRA PRIVATE LIMITED 9-8-26.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'AFA LEDGER 9-8-26.xlsx'), 'CUSTOMER');

  ck('invoice-register adapter used', cust.parserLog.some(l => /invoice-register adapter/.test(l.message)));
  ck("customer closing = team's 8,58,403.06 (app had -3,46,750.88)", Math.abs((cust.balances.closing ?? 0) - 858403.06) < 0.01, String(cust.balances.closing));
  ck('opening balance 2,28,000 read from the header', Math.abs((cust.balances.opening ?? 0) - 228000) < 0.01, String(cust.balances.opening));
  const invoices = cust.transactions.filter(t => t.voucherType === 'INVOICE');
  const payments = cust.transactions.filter(t => t.voucherType === 'PAYMENT');
  const notes = cust.transactions.filter(t => t.voucherType === 'CREDIT_NOTE');
  ck('a row carrying an invoice AND a payment yields both', invoices.length > 2000 && payments.length > 100, `${invoices.length} inv / ${payments.length} pay`);
  ck('negative totals read as CREDIT NOTES, not invoices', notes.length === 6, String(notes.length));
  ck('credit notes reduce the balance', notes.every(t => t.signedAmountRdcView < 0));
  ck('payments are not flagged as unreadable references', payments.every(t => (t.parseConfidence ?? 0) >= 75));

  // the proof: every row checked against the register's own running balance
  const audit = auditLedger(cust, 'CUSTOMER');
  ck('customer parse PROVED row by row against the running balance', audit.verdict === 'PASS', `${audit.verdict}, ${audit.rowsChecked} rows, ${audit.issues.length} failed`);
  ck('over 2000 rows actually verified', audit.rowsChecked > 2000, String(audit.rowsChecked));

  const r = reconcile(rdc, cust, { partyName: 'AFA', periodStart: '2016-04-01', periodEnd: '2026-06-30', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  ck('CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  ck("difference = team's 4,53,844.28", Math.abs((r.summaryLines.find(l => l.particular === 'Difference')?.amount ?? 0) - 453844.28) < 0.01);
  ck('2,200 matched (was 2,174 invoices left unmatched)', r.matches.length >= 2200, String(r.matches.length));
  ck('coverage > 92%', Number(r.cards.matchedCoveragePct) > 92, String(r.cards.matchedCoveragePct));

  const invoiceNotBooked = r.summaryLines.find(l => /not booked by customer — Invoices/.test(l.particular));
  ck("'invoice not booked' = team's 4,49,960.50 (was 7.29 crore)", !!invoiceNotBooked && Math.abs(invoiceNotBooked.amount - 449960.50) < 0.01, String(invoiceNotBooked?.amount));
  const excess = r.summaryLines.find(l => /Amount differences/.test(l.particular));
  ck("'excess invoice booked' = team's 10,003.37", !!excess && Math.abs(excess.amount - 10003.37) < 0.01, String(excess?.amount));
  const netted = r.summaryLines.find(l => /net of RDC entries before/.test(l.particular));
  ck('opening vs pre-ledger entries netted to paise, not two 2.28L lines', !!netted && Math.abs(netted.amount) < 1, String(netted?.amount));
  // the team's TDS line is these two, split into its parts
  const custPayments = r.summaryLines.find(l => /accounted by customer but not in RDC — Receipts/.test(l.particular));
  const custInvoices = r.summaryLines.find(l => /accounted by customer but not in RDC — Invoices/.test(l.particular));
  ck("customer-only items net to the team's TDS figure 13,887.50",
    !!custPayments && !!custInvoices && Math.abs((custPayments.amount - custInvoices.amount) - 13887.50) < 0.01,
    `${custPayments?.amount} - ${custInvoices?.amount}`);
  ck('statement stays short (<= 10 lines)', r.summaryLines.length <= 10, String(r.summaryLines.length));
  ck('unexplained under a rupee (RDC ledger rounds by 0.41)', Math.abs(Number(r.cards.unexplainedDifference)) <= 1, String(r.cards.unexplainedDifference));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
