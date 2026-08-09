/**
 * Round-16 harness (2026-08-09): Henna Realestate — RDC xlsx + a Tally
 * "Ledger Account" PDF that prints its own closing balance:
 *   "Cr Closing Balance 16,25,780.00", transaction totals Dr 7,00,000 /
 *   Cr 23,25,780, then a grand total that INCLUDES the closing balance.
 * Comparing against that grand total made the adapter reject its own correct
 * parse and fall back to a reader that produced no references and 0 matches.
 * Run: npx tsx scripts/validate-fixes-11.ts   (data: ./test-data-280726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { auditLedger } from '../src/core/audit';
import { reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-280726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC_henna 5th.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'Customer Hena 5th.pdf'), 'CUSTOMER');

  ck('Tally Ledger Account adapter accepted (was rejecting its own parse)',
    cust.parserLog.some(l => /Tally Ledger Account PDF adapter/.test(l.message))
    && !cust.parserLog.some(l => /adapter rejected/.test(l.message)));
  ck('stated closing balance used: Cr 16,25,780', Math.abs((cust.balances.closing ?? 0) - 1625780) < 0.01, String(cust.balances.closing));
  ck('transaction totals captured, not the grand total', cust.printedTotals?.debit === 700000 && cust.printedTotals?.credit === 2325780, `Dr ${cust.printedTotals?.debit} / Cr ${cust.printedTotals?.credit}`);
  ck('bill references read from the New Ref lines', cust.transactions.filter(t => t.voucherType === 'INVOICE').every(t => !!t.referenceNo));
  ck('purchases positive in the RDC view', cust.transactions.filter(t => t.voucherType === 'INVOICE').every(t => t.signedAmountRdcView > 0));

  const custAudit = auditLedger(cust, 'CUSTOMER');
  ck('customer parse PROVED against printed totals and stated closing', custAudit.verdict === 'PASS', `${custAudit.verdict} Dr gap ${custAudit.debitTotalGap?.toFixed(2)} closing gap ${custAudit.integrityGap?.toFixed(2)}`);
  ck('RDC parse proved against its printed totals', auditLedger(rdc, 'RDC').verdict === 'PASS');
  ck('RDC closing 15,78,580', Math.abs((rdc.balances.closing ?? 0) - 1578580) < 0.01, String(rdc.balances.closing));

  const r = reconcile(rdc, cust, { partyName: 'Henna', periodStart: '2016-04-01', periodEnd: '2026-08-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  ck('CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  ck('68 matched (was 0)', r.matches.length === 68, String(r.matches.length));
  ck('coverage > 96%', Number(r.cards.matchedCoveragePct) > 96, String(r.cards.matchedCoveragePct));
  ck('nothing left unmatched on the customer side', r.unmatchedCustomer.length === 0, String(r.unmatchedCustomer.length));
  ck('difference -47,200', Math.abs((r.summaryLines.find(l => l.particular === 'Difference')?.amount ?? 0) + 47200) < 0.01);
  // the whole difference is RDC credit notes Henna has not booked
  const reconciling = r.summaryLines.filter(l => l.sign === 'Add' || l.sign === 'Less');
  ck('explained by ONE reconciling line', reconciling.length === 1, String(reconciling.length));
  ck('that line is the 47,200 of unbooked credit notes', /Credit \/ Debit notes/.test(reconciling[0]?.particular || '') && Math.abs(reconciling[0].amount - 47200) < 0.01, `${reconciling[0]?.particular} ${reconciling[0]?.amount}`);
  ck('unexplained 0', Math.abs(Number(r.cards.unexplainedDifference)) <= 0.01, String(r.cards.unexplainedDifference));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
