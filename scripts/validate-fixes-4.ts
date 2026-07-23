/**
 * Round-7 regression harness (2026-07-22): Dalmia Cement — the first VENDOR
 * (payable-side) reconciliation, in two brand-new spreadsheet layouts.
 * Covers: generic layout adapter (header hunting, pivot-sheet skipping,
 * cross-sheet duplicate removal), SAP trailing-minus amounts, RDC-relative
 * orientation (payable recons keep invoices negative on BOTH sides), and
 * money-bearing OTHER rows staying inside the summary identity.
 * Run: npx tsx scripts/validate-fixes-4.ts   (data: ./test-data-210726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';
import { parseAmount } from '../src/core/amount';

const DIR = path.join(process.cwd(), 'test-data-210726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  // amount parsing guards
  ck('amount: SAP trailing minus "300000.00-" -> -300000', parseAmount('300000.00-') === -300000, String(parseAmount('300000.00-')));
  ck('amount: date-like "01-Jan-26" is NOT money', parseAmount('01-Jan-26') === 0, String(parseAmount('01-Jan-26')));
  ck('amount: "30 Days" is NOT money', parseAmount('30 Days') === 0, String(parseAmount('30 Days')));
  ck('amount: "1,23,456.78 Dr" parses', parseAmount('1,23,456.78 Dr') === 123456.78, String(parseAmount('1,23,456.78 Dr')));

  const rdc = await parseLedger(path.join(DIR, 'RDC APP.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'DALMIA APP.xlsx'), 'CUSTOMER');
  ck('generic: RDC AP export parsed (header on row 4, was 0 rows)', rdc.transactions.length >= 1150, String(rdc.transactions.length));
  ck('generic: pivot sheet (Sheet5) skipped', rdc.parserLog.some(l => /no ledger header found/.test(l.message)));
  ck('generic: Dalmia parsed across both sheets (was 0 rows)', cust.transactions.length >= 1200, String(cust.transactions.length));
  ck('generic: overlapping-sheet duplicates removed', cust.parserLog.some(l => /duplicate rows across sheets removed/.test(l.message)));
  ck('generic: Dalmia opening 0 (2021 Open Bal. row)', cust.balances.opening === 0, String(cust.balances.opening));
  ck('generic: Dalmia closing 0 from running-balance column', Math.abs(cust.balances.closing ?? 99) < 1, String(cust.balances.closing));
  const gap = ledgerIntegrityGap(cust);
  ck('generic: Dalmia integrity ties across sheet union', gap != null && Math.abs(gap) < 1, String(gap?.toFixed(2)));

  const r = reconcile(rdc, cust, { partyName: 'Dalmia Cement', periodStart: '2023-05-01', periodEnd: '2026-07-22', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  const custInvSum = cust.transactions.filter(t => t.voucherType === 'INVOICE').reduce((s, t) => s + t.signedAmountRdcView, 0);
  ck('orientation: payable recon NOT flipped (customer invoices stay negative)', custInvSum < 0, custInvSum.toFixed(0));
  ck('reconcile: CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  ck('reconcile: >= 635 matched (round-8: typo-refs + blank-Type payments)', r.matches.length >= 635, String(r.matches.length));
  ck('reconcile: coverage > 99%', Number(r.cards.matchedCoveragePct) > 99, String(r.cards.matchedCoveragePct));
  ck('reconcile: NO stale review flags (was 126 matched-but-flagged payments)', r.possibleMatches.length === 0, String(r.possibleMatches.length));
  const typo = r.matches.find(m => /reference nearly matches/.test(m.remarks || ''));
  ck('reconcile: data-entry-slip refs matched by amount+date (e.g. 2334788076/2334788086)', !!typo, (typo?.remarks || '').slice(0, 70));
  const blankType = r.matches.find(m => m.rdcTxn?.parserNotes?.some(n => /blank Type/.test(n)));
  ck('reconcile: blank-Type RDC payment rows matched as receipts', !!blankType, blankType ? `${blankType.rdcTxn?.date} ${blankType.rdcAmount}` : '');
  ck('reconcile: unexplained ~ 0 (OTHER rows + identity intact)', Math.abs(Number(r.cards.unexplainedDifference)) <= 1, String(r.cards.unexplainedDifference));
  const variance = r.summaryLines.find(l => /Amount differences on reference-matched/.test(l.particular));
  ck('reconcile: matched variance is TDS-scale, not orientation-scale', !!variance && variance.amount < 500000, String(variance?.amount));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
