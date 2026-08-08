/**
 * Round-12 harness (2026-07-26): Lotus Villa — asserted against the accounts
 * team's manual reconciliation, which found exactly TWO unbooked invoices:
 *   4KL25BP3-1492  26,921.70
 *   4KL25BP1-1675  26,921.70
 * Covers: the Tally "Ledger Account" PDF adapter (bill numbers live on the
 * New Ref / Agst Ref lines), its printed-totals acceptance gate, and the
 * near-reference SECOND PASS that runs only after exact matching is settled.
 * Run: npx tsx scripts/validate-fixes-7.ts   (data: ./test-data-250726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { auditLedger } from '../src/core/audit';
import { reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-250726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  const rdc = await parseLedger(path.join(DIR, 'Lotus Villa RDC Ledger 6-6-26.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'Lotus Client Ledger 6-6-26.pdf'), 'CUSTOMER');

  ck('Tally Ledger Account adapter used', cust.parserLog.some(l => /Tally Ledger Account PDF adapter/.test(l.message)));
  ck('customer: 47 vouchers parsed', cust.transactions.length === 47, String(cust.transactions.length));
  ck('customer: bill references read from New Ref lines (were all blank)',
    cust.transactions.filter(t => t.voucherType === 'INVOICE').every(t => !!t.referenceNo),
    String(cust.transactions.filter(t => t.voucherType === 'INVOICE' && !t.referenceNo).length));
  ck('customer: a payment keeps every bill it settles', cust.transactions.some(t => t.voucherType === 'PAYMENT' && (t.extractedReferences?.length ?? 0) > 5));
  ck('customer: purchases positive / payments negative in RDC view',
    cust.transactions.filter(t => t.voucherType === 'INVOICE').every(t => t.signedAmountRdcView > 0)
    && cust.transactions.filter(t => t.voucherType === 'PAYMENT').every(t => t.signedAmountRdcView < 0));

  const custAudit = auditLedger(cust, 'CUSTOMER');
  ck('customer: parse PROVED against the printed Dr/Cr totals', custAudit.verdict === 'PASS', `${custAudit.verdict} Dr gap ${custAudit.debitTotalGap?.toFixed(2)}`);
  const rdcAudit = auditLedger(rdc, 'RDC');
  ck('RDC: parse proved against its printed totals', rdcAudit.verdict === 'PASS', rdcAudit.verdict);

  const r = reconcile(rdc, cust, { partyName: 'Lotus Villa Pvt. Ltd.', periodStart: '2025-04-01', periodEnd: '2026-06-06', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  ck('reconcile: CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  ck('reconcile: 47 matched (was 4 before references were read)', r.matches.length === 47, String(r.matches.length));
  ck('reconcile: coverage > 97%', Number(r.cards.matchedCoveragePct) > 97, String(r.cards.matchedCoveragePct));

  // the whole point: the team's manual answer, exactly
  const unmatchedRefs = r.unmatchedRdc.map(m => m.rdcTxn?.referenceNo).sort();
  ck("reconcile: EXACTLY the team's two unbooked invoices",
    unmatchedRefs.length === 2 && unmatchedRefs[0] === '4KL25BP1-1675' && unmatchedRefs[1] === '4KL25BP3-1492',
    unmatchedRefs.join(', '));
  ck('reconcile: nothing left unmatched on the customer side', r.unmatchedCustomer.length === 0, String(r.unmatchedCustomer.length));
  ck('reconcile: those two total 53,843.40', Math.abs(r.unmatchedRdc.reduce((s, m) => s + (m.rdcAmount || 0), 0) - 53843.40) < 0.01);

  // duplicate bill numbers on the customer side must not steal exact partners
  const nearRef = r.matches.filter(m => /reference nearly matches/.test(m.remarks || ''));
  ck('reconcile: the two mis-numbered bills matched on the second pass', nearRef.length === 2, String(nearRef.length));
  const exact1457 = r.matches.find(m => m.rdcTxn?.referenceNo === '4KL25BP1-1457');
  ck('reconcile: RDC ...-1457 kept its EXACT partner (not stolen by a look-alike)',
    !!exact1457 && exact1457.customerTxn?.referenceNo === '4KL25BP1-1457' && Math.abs(exact1457.difference) < 0.01,
    `${exact1457?.customerTxn?.referenceNo} diff ${exact1457?.difference}`);
  const wrong1675 = r.matches.find(m => m.rdcTxn?.referenceNo === '4KL25BP1-1675');
  ck('reconcile: unbooked ...-1675 was NOT force-matched to look-alike ...-1677', !wrong1675, wrong1675?.customerTxn?.referenceNo || 'unmatched');

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
