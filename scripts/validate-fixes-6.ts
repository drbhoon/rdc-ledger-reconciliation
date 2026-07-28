/**
 * Round-10 harness (2026-07-24): Dalmia Chennai (SAP statement PDF + RDC
 * creditor ledger) and the ELAN large-variance guard.
 * Run: npx tsx scripts/validate-fixes-6.ts   (data: ./test-data-240726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';
import type { NormalizedTxn, ParseResult } from '../src/core/types';

const DIR = path.join(process.cwd(), 'test-data-240726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  // ── Dalmia Chennai: SAP statement PDF, deterministic (no AI) ───────────────
  const cust = await parseLedger(path.join(DIR, 'vendor kedger  dalmia chennai.PDF'), 'CUSTOMER');
  ck('SAP PDF: parsed deterministically (was 0 rows -> AI rescue timeout)', cust.transactions.length >= 95, String(cust.transactions.length));
  ck('SAP PDF: adapter used, not the AI rescue', cust.parserLog.some(l => /SAP statement-of-account/.test(l.message)));
  ck('SAP PDF: opening -1,35,48,995.25', Math.abs((cust.balances.opening ?? 0) + 13548995.25) < 0.01, String(cust.balances.opening));
  ck('SAP PDF: closing -67,89,687.39', Math.abs((cust.balances.closing ?? 0) + 6789687.39) < 0.01, String(cust.balances.closing));
  const cGap = ledgerIntegrityGap(cust);
  ck('SAP PDF: ties to its stated closing', cGap != null && Math.abs(cGap) < 1, String(cGap?.toFixed(2)));
  const inv = cust.transactions.find(t => t.referenceNo === '2600503191');
  ck('SAP PDF: qty is not mistaken for the amount (2600503191 = 2,14,189)', !!inv && Math.abs(inv.debit - 214189) < 0.01, `${inv?.debit}`);
  ck('SAP PDF: COLL rows are payments, INV rows invoices',
    cust.transactions.some(t => t.voucherType === 'PAYMENT') && cust.transactions.some(t => t.voucherType === 'INVOICE'));

  // ── RDC creditor (accounts-payable) ledger ────────────────────────────────
  const rdc = await parseLedger(path.join(DIR, 'RDC ledger Dalmia Chennai.xlsx'), 'RDC');
  ck('creditor: detected as a payable ledger', rdc.parserLog.some(l => /creditor\/payable/.test(l.message)));
  ck('creditor: supplier bills classified as INVOICE (were RECEIPT)', rdc.transactions.filter(t => t.voucherType === 'INVOICE').length >= 40, String(rdc.transactions.filter(t => t.voucherType === 'INVOICE').length));
  ck('creditor: TDS credit memos stay TDS, not credit notes', rdc.transactions.some(t => t.voucherType === 'TDS' && /TDS/i.test(t.referenceNo || '')));
  ck('creditor: unlabelled total row skipped (was double-counting ₹69.9L)', rdc.parserLog.some(l => /unlabelled total row/i.test(l.message)));
  const rGap = ledgerIntegrityGap(rdc);
  ck('creditor: ties to its stated closing', rGap != null && Math.abs(rGap) < 1, String(rGap?.toFixed(2)));
  ck('creditor: invoice number captured as the reference', rdc.transactions.some(t => t.referenceNo === '2600503492'));
  ck('creditor: invoice date used, not the month-end GL date', rdc.transactions.some(t => t.referenceNo === '2600503492' && t.date === '2026-04-13'), String(rdc.transactions.find(t => t.referenceNo === '2600503492')?.date));

  const r = reconcile(rdc, cust, { partyName: 'Dalmia Chennai', periodStart: '2026-04-01', periodEnd: '2026-06-30', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  ck('Dalmia Chennai: CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  ck('Dalmia Chennai: 60+ matched (was 0 — signs were flipped)', r.matches.length >= 60, String(r.matches.length));
  ck('Dalmia Chennai: coverage > 95%', Number(r.cards.matchedCoveragePct) > 95, String(r.cards.matchedCoveragePct));
  ck('Dalmia Chennai: unexplained ~ 0', Math.abs(Number(r.cards.unexplainedDifference)) <= 1, String(r.cards.unexplainedDifference));

  // ── ELAN large-variance guard (synthetic, mirrors 3CH26ARMN233) ───────────
  const mk = (side: 'RDC' | 'CUSTOMER', ref: string, amount: number, aiRow = false): NormalizedTxn => ({
    id: `${side}-${ref}`, sourceSide: side, sourceFile: 'x', sourceRow: 1,
    date: '2026-05-30', voucherType: 'INVOICE', voucherNo: ref, referenceNo: ref,
    normalizedReferenceNo: ref, extractedReferences: [ref], allocationType: 'Inferred',
    particulars: '', narration: '', debit: side === 'RDC' ? amount : 0, credit: side === 'RDC' ? 0 : amount,
    signedAmountRdcView: amount, amountOriginalSign: 'Dr', parseConfidence: 90,
    parserNotes: aiRow ? ['AI-extracted row (rescue parser)'] : [],
  });
  const mkLedger = (txns: NormalizedTxn[], closing: number): ParseResult => ({ transactions: txns, balances: { opening: 0, closing, openingRows: [], closingRows: [] }, parserLog: [] });
  const r2 = reconcile(
    mkLedger([mk('RDC', '3CH26ARMN233', 190399.9), mk('RDC', 'OK1', 5000)], 195399.9),
    mkLedger([mk('CUSTOMER', '3CH26ARMN233', 1904000, true), mk('CUSTOMER', 'OK1', 5000)], 1909000),
    { partyName: 'ELAN', periodStart: '2026-04-01', periodEnd: '2026-07-23', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  const flagged = (r2.largeVarianceMatches || []);
  ck('ELAN guard: 10x amount slip is flagged, not shown as a clean match', flagged.length === 1 && flagged[0].rdcTxn?.referenceNo === '3CH26ARMN233', String(flagged.length));
  ck('ELAN guard: reason code set to AMOUNT_MISMATCH', flagged[0]?.reasonCode === 'AMOUNT_MISMATCH', String(flagged[0]?.reasonCode));
  ck('ELAN guard: remark names the 10x digit slip', /10x/.test(flagged[0]?.remarks || ''), (flagged[0]?.remarks || '').slice(0, 80));
  ck('ELAN guard: notes the AI-extracted side', /AI-extracted/.test(flagged[0]?.remarks || ''));
  ck('ELAN guard: an ordinary small variance is NOT flagged', !flagged.some(m => m.rdcTxn?.referenceNo === 'OK1'));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
