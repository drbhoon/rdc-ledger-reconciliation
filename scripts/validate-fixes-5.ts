/**
 * Round-9 harness (2026-07-23): Suroj Buildcon — validated against the accounts
 * team's OWN manual reconciliation:
 *    closing as per SUROJ  7,06,201 | closing as per RDC 25,750 | DIFF -6,80,450
 *    "RECEIPTS TO BE TAKEN BY SUROJ  -33,69,981"
 * Covers: true-value (raw) cell reading, SheetJS midnight date artifact, Excel
 * serial upper bound, columnar single-amount Tally registers, reference
 * fallback, same-family reference preference, full-span matching, and the
 * pre-customer-ledger bucket.
 * Run: npx tsx scripts/validate-fixes-5.ts   (data: ./test-data-230726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';
import { parseDate } from '../src/core/date';
import { hasTruncatedReference } from '../src/core/reference';

const DIR = path.join(process.cwd(), 'test-data-230726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  // ── primitives ─────────────────────────────────────────────────────────────
  ck('date: SheetJS midnight artifact snaps forward (11 Sep 23:59:50 -> 12 Sep)',
    parseDate(new Date(2014, 8, 11, 23, 59, 50)) === '2014-09-12', String(parseDate(new Date(2014, 8, 11, 23, 59, 50))));
  ck('date: genuine timestamp keeps its own day', parseDate(new Date(2024, 2, 5, 14, 30, 0)) === '2024-03-05', String(parseDate(new Date(2024, 2, 5, 14, 30, 0))));
  ck('date: Excel serial 41894 -> 2014-09-12', parseDate(41894) === '2014-09-12', String(parseDate(41894)));
  ck('date: an AMOUNT in a date column is not a date (was year 153270)', parseDate(55720408) === undefined, String(parseDate(55720408)));
  ck('reference: complete ref at end of field is NOT "truncated"', hasTruncatedReference(['2HY21ARCM10']) === false);
  ck('reference: ellipsis IS truncated', hasTruncatedReference(['Bill 2HY21ARS733...']) === true);
  ck('reference: dangling separator IS truncated', hasTruncatedReference(['Agst Ref 2HY21ARS-']) === true);

  // ── parsing ────────────────────────────────────────────────────────────────
  const rdc = await parseLedger(path.join(DIR, 'RDC SUROJ  LEDGER.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'SUROJ LEDGER 2.xlsx'), 'CUSTOMER');
  const rGap = ledgerIntegrityGap(rdc), cGap = ledgerIntegrityGap(cust);
  ck('RDC: true cell values tie to stated closing (was a phantom ₹134.33 gap)', rGap != null && Math.abs(rGap) < 1, String(rGap?.toFixed(2)));
  ck('RDC: closing 25,750.39 (paise preserved)', Math.abs((rdc.balances.closing ?? 0) - 25750.39) < 0.01, String(rdc.balances.closing));
  ck('RDC: first invoice keeps its paise (29,250.20 not 29,250)', rdc.transactions.some(t => Math.abs(t.debit - 29250.20) < 0.005));
  ck('RDC: dates are not shifted a day back (12-Sep-2014 present)', rdc.transactions.some(t => t.date === '2014-09-12'));
  ck('RDC: every row has a reference (361 were blank)', rdc.transactions.every(t => !!t.referenceNo), String(rdc.transactions.filter(t => !t.referenceNo).length));
  ck('CUSTOMER: columnar register parsed (was 0 rows)', cust.transactions.length >= 2700, String(cust.transactions.length));
  ck('CUSTOMER: closing 7,06,200.69 from the amount-column total', Math.abs((cust.balances.closing ?? 0) - 706200.69) < 0.01, String(cust.balances.closing));
  ck('CUSTOMER: integrity ties (dateless ₹37 row retained)', cGap != null && Math.abs(cGap) < 1, String(cGap?.toFixed(2)));
  ck('CUSTOMER: purchases positive / payments negative in RDC view',
    cust.transactions.filter(t => t.voucherType === 'INVOICE').every(t => t.signedAmountRdcView > 0)
    && cust.transactions.filter(t => t.voucherType === 'PAYMENT').every(t => t.signedAmountRdcView < 0));

  // ── reconciliation vs the team's manual figures ────────────────────────────
  const r = reconcile(rdc, cust, { partyName: 'SUROJ', periodStart: '2010-04-01', periodEnd: '2026-03-31', invoiceTolerance: 2, paymentTolerance: 2, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  ck('reconcile: CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  const diff = r.summaryLines.find(l => l.particular === 'Difference')!;
  ck("reconcile: Difference = team's manual -6,80,450", Math.abs(diff.amount - -680450.30) < 1, diff.amount.toFixed(2));
  ck('reconcile: full-span matching finds 2500+ pairs (was 46 when period-filtered)', r.matches.length >= 2500, String(r.matches.length));
  ck('reconcile: coverage > 80%', Number(r.cards.matchedCoveragePct) > 80, String(r.cards.matchedCoveragePct));
  ck('reconcile: unexplained ~ 0', Math.abs(Number(r.cards.unexplainedDifference)) <= 1, String(r.cards.unexplainedDifference));
  // the team's own line: RECEIPTS TO BE TAKEN BY SUROJ -33,69,981
  const receiptsToTake = r.unmatchedRdc.filter(m => m.rdcTxn?.voucherType === 'RECEIPT' && m.reasonCode !== 'RDC_BEFORE_CUSTOMER_LEDGER_START')
    .reduce((s, m) => s + (m.rdcAmount || 0), 0);
  ck("reconcile: unmatched RDC receipts = team's -33,69,981", Math.abs(receiptsToTake - -3369981) < 2, receiptsToTake.toFixed(0));
  // Round 14: the customer's brought-forward opening and RDC's earlier entries
  // are netted into ONE line — they are the same thing from both sides, and
  // here they cancel almost exactly.
  const preLedger = r.summaryLines.find(l => /net of RDC entries before/i.test(l.particular));
  ck('reconcile: opening vs pre-ledger RDC entries netted to ~0 on one line', !!preLedger && Math.abs(preLedger.amount) < 2, String(preLedger?.amount));
  ck('reconcile: the pre-ledger rows are still listed for review', r.unmatchedRdc.some(m => m.reasonCode === 'RDC_BEFORE_CUSTOMER_LEDGER_START'));
  // no invoice may be consumed by a debit note quoting its number
  const crossFamily = r.matches.filter(m => m.rdcTxn?.voucherType === 'INVOICE' && m.customerTxn?.voucherType === 'DEBIT_NOTE' && Math.abs(m.difference || 0) > 10000);
  ck('reconcile: invoices not swallowed by debit notes on the same reference', crossFamily.length === 0, String(crossFamily.length));
  ck('reconcile: no bogus "reference truncated" bucket', !r.summaryLines.some(l => /truncated/i.test(l.particular)));
  const split = r.summaryLines.filter(l => /—\s*(Invoices|Receipts|Credit|TDS)/.test(l.particular));
  ck('report: unmatched buckets split by document type (accounts-team layout)', split.length >= 2, String(split.length));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
