/**
 * Round-15 harness (2026-08-09): Mosh & Ram Steel — asserted against the
 * employee reconciliation as of 31-Aug-25:
 *   RDC 19,24,476.46 | Mosh 7,52,400.00 | Difference 11,72,076.46
 *   incl. duplicate invoice booked by Mosh (1RA23ARS998) 22,148.00
 * The app had read the RDC balance as 0.00, inflated the ledger with the
 * workbook's other sheets, and dumped 834 customer rows into "Other entries".
 * Run: npx tsx scripts/validate-fixes-10.ts   (data: ./test-data-270726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-270726');
const RDC = 'RDC vs Mosh & Ram Steel Reco As of 31st Aug25 9 Aug 4th.xlsx';
const CUST = 'mosh ledger 9 aug 4th.xlsx';
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  const rdc = await parseLedger(path.join(DIR, RDC), 'RDC');
  const cust = await parseLedger(path.join(DIR, CUST), 'CUSTOMER');

  // ── a reconciliation WORKBOOK is not a ledger ──────────────────────────────
  ck("the customer's own ledger sheet is not read as RDC's", rdc.parserLog.some(l => l.sourceSheet === 'Mosh Ledger' && /not an RDC ledger export/.test(l.message)));
  ck('the Reco working sheet is skipped', rdc.parserLog.some(l => l.sourceSheet === 'Reco' && /not an RDC ledger export/.test(l.message)));
  ck('RDC rows back to the ledger sheet size (was 2,612 with annexures folded in)', rdc.transactions.length <= 1400 && rdc.transactions.length >= 1300, String(rdc.transactions.length));
  ck("RDC balance = employee's 19,24,476.46 (app had 0.00)",
    Math.abs(rdc.transactions.reduce((s, t) => s + t.signedAmountRdcView, 0) - 1924476.46) < 0.01,
    rdc.transactions.reduce((s, t) => s + t.signedAmountRdcView, 0).toFixed(2));

  // ── customer rows must be classified, not dumped in "Other" ───────────────
  const other = cust.transactions.filter(t => t.voucherType === 'OTHER');
  ck('no generic "Other entries" bucket (was 834 rows / ₹69 lakh)', other.length === 0, String(other.length));
  ck('customer rows split into invoices and payments', cust.transactions.filter(t => t.voucherType === 'INVOICE').length > 1000 && cust.transactions.filter(t => t.voucherType === 'PAYMENT').length > 50);

  // ── the duplicate invoice must SURVIVE de-duplication ─────────────────────
  const dupes = cust.transactions.filter(t => (t.referenceNo || '').includes('1RA23ARS998'));
  ck('duplicate invoice 1RA23ARS998 kept, not silently de-duplicated', dupes.length === 2, `${dupes.length} row(s)`);
  ck('the duplicate is worth 22,148', Math.abs(dupes.reduce((s, t) => s + t.signedAmountRdcView, 0) - 22148 * 2) < 1 || Math.abs((dupes[0]?.signedAmountRdcView ?? 0) - 22148) < 1, String(dupes[0]?.signedAmountRdcView));

  const r = reconcile(rdc, cust, { partyName: 'Mosh', periodStart: '2016-04-01', periodEnd: '2025-08-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  ck('CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  const line = (re: RegExp) => r.summaryLines.find(l => re.test(l.particular));
  ck("balance as per RDC = employee's 19,24,476.46", Math.abs((line(/^Balance As per RDC$/)?.amount ?? 0) - 1924476.46) < 0.01, String(line(/^Balance As per RDC$/)?.amount));
  ck("balance as per Mosh = employee's 7,52,400 (app had 7,30,252)", Math.abs((line(/^Balance As per Mosh$/)?.amount ?? 0) - 752400) < 0.01, String(line(/^Balance As per Mosh$/)?.amount));
  ck("difference = employee's 11,72,076.46", Math.abs((line(/^Difference$/)?.amount ?? 0) - 1172076.46) < 0.01, String(line(/^Difference$/)?.amount));
  ck('unexplained ~ 0', Math.abs(Number(r.cards.unexplainedDifference)) <= 1, String(r.cards.unexplainedDifference));
  ck('matched over 1,190 (was 879 invoices reported unbooked)', r.matches.length > 1190, String(r.matches.length));
  ck('coverage > 90%', Number(r.cards.matchedCoveragePct) > 90, String(r.cards.matchedCoveragePct));
  ck('statement stays short (<= 10 lines)', r.summaryLines.length <= 10, String(r.summaryLines.length));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
