/**
 * Round-6 regression harness (2026-07-21 team retest): the Balajee Infratech
 * Jan-Apr 2026 files that produced "upstream error" / wrong output.
 * Covers: vendor-ledger-mirror orientation (bills=Cr / payments=Dr in the
 * RDC ERP layout), CSV raw date strings (dd/MM/yyyy + dd-MMM-yy, 2-digit
 * years), and the zero-match certification block.
 * Run: npx tsx scripts/validate-fixes-3.ts   (data: ./test-data-210726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';
import { parseDate } from '../src/core/date';

const DIR = path.join(process.cwd(), 'test-data-210726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  // date parsing guards (no files needed)
  ck('date: dd/MM/yyyy is day-first', parseDate('05/01/2026') === '2026-01-05', String(parseDate('05/01/2026')));
  ck('date: dd-MMM-yy 2-digit year -> 20xx', parseDate('07-Mar-26') === '2026-03-07', String(parseDate('07-Mar-26')));
  ck('date: dd/MM/yy 2-digit year -> 20xx (not year 0026)', parseDate('05/01/26') === '2026-01-05', String(parseDate('05/01/26')));

  for (const ext of ['xlsx', 'csv'] as const) {
    const rdc = await parseLedger(path.join(DIR, `Balaji RDC Ledger.${ext}`), 'RDC');
    const cust = await parseLedger(path.join(DIR, `Balaji Ledger.${ext}`), 'CUSTOMER');
    const types = new Map<string, number>();
    for (const t of cust.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
    ck(`${ext}: customer vendor-mirror -> 260 INVOICE + 8 PAYMENT (was 261 RECEIPT)`, types.get('INVOICE') === 260 && types.get('PAYMENT') === 8, JSON.stringify(Object.fromEntries(types)));
    ck(`${ext}: customer opening +50,18,295 captured (was undefined)`, Math.abs((cust.balances.opening ?? 0) - 5018295) < 1, String(cust.balances.opening));
    ck(`${ext}: customer closing +30,39,101 (was -30,39,101)`, Math.abs((cust.balances.closing ?? 0) - 3039101) < 1, String(cust.balances.closing));
    const r = reconcile(rdc, cust, { partyName: 'Balajee Infratech', periodStart: '2026-01-01', periodEnd: '2026-04-03', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
    ck(`${ext}: CERTIFIED with real matches (was 0 matched)`, r.cards.certified === true && r.matches.length >= 260, `matched=${r.matches.length} verdict=${r.cards.verdict}`);
    ck(`${ext}: coverage > 95%`, Number(r.cards.matchedCoveragePct) > 95, String(r.cards.matchedCoveragePct));
    ck(`${ext}: unexplained ~ 0`, Math.abs(Number(r.cards.unexplainedDifference)) <= 1, String(r.cards.unexplainedDifference));
    const inTransit = r.summaryLines.find(l => /accounted by customer but not in RDC/i.test(l.particular));
    ck(`${ext}: 02-Apr 15,00,000 in-transit payment isolated as Less`, !!inTransit && Math.abs(inTransit.amount - 1500000) < 1 && inTransit.sign === 'Less', `${inTransit?.sign} ${inTransit?.amount}`);
    // zero-match certification block: reconcile the RDC ledger against ITSELF
    // parsed as CUSTOMER (mirror signs -> nothing matches) and require REVIEW
    if (ext === 'xlsx') {
      const mirror = await parseLedger(path.join(DIR, `Balaji RDC Ledger.${ext}`), 'CUSTOMER');
      const flipped = { ...mirror, transactions: mirror.transactions.map(t => ({ ...t, referenceNo: 'X' + t.referenceNo, normalizedReferenceNo: 'X' + (t.normalizedReferenceNo || ''), extractedReferences: [], date: undefined })) };
      const bad = reconcile(rdc, flipped, { partyName: 'SelfTest', periodStart: '2026-01-01', periodEnd: '2026-04-03', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
      ck('guard: zero-match run can never be CERTIFIED', bad.matches.length > 0 || bad.cards.certified === false, `matched=${bad.matches.length} certified=${bad.cards.certified}`);
    }
  }
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
