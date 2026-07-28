import path from 'path';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';
const DIR = path.join(process.cwd(), 'test-data-240726');
(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC ledger Dalmia Chennai.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'vendor kedger  dalmia chennai.PDF'), 'CUSTOMER');
  for (const [n, p] of [['RDC', rdc], ['CUST', cust]] as const)
    console.log(n + ': rows=' + p.transactions.length + ' opening=' + p.balances.opening + ' closing=' + p.balances.closing + ' gap=' + ledgerIntegrityGap(p)?.toFixed(2));
  console.log('RDC sample:', rdc.transactions.slice(0, 3).map(t => t.date + ' ' + t.voucherType + ' ref=' + t.referenceNo + ' ' + t.signedAmountRdcView).join(' | '));
  const r = reconcile(rdc, cust, { partyName: 'Dalmia Chennai', periodStart: '2026-04-01', periodEnd: '2026-06-30', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log('verdict=' + r.cards.verdict + ' matched=' + r.matches.length + ' coverage=' + r.cards.matchedCoveragePct + '% unmatchedRdc=' + r.unmatchedRdc.length + ' unmatchedCust=' + r.unmatchedCustomer.length);
  for (const l of r.summaryLines) console.log('  ' + (l.sign || '') + ' ' + l.particular + '  ' + (l.amount || 0).toLocaleString('en-IN'));
})();
