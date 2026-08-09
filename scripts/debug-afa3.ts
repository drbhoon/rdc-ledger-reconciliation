import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';
const DIR = path.join(process.cwd(), 'test-data-260726');
(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC AFA INFRA PRIVATE LIMITED 9-8-26.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'AFA LEDGER 9-8-26.xlsx'), 'CUSTOMER');
  const r = reconcile(rdc, cust, { partyName: 'AFA', periodStart: '2016-04-01', periodEnd: '2026-06-30', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log('verdict=' + r.cards.verdict + ' matched=' + r.matches.length + ' unmatchedRdc=' + r.unmatchedRdc.length + ' unmatchedCust=' + r.unmatchedCustomer.length + ' coverage=' + r.cards.matchedCoveragePct + '%');
  for (const l of r.summaryLines) console.log('  ' + (l.sign||'') + ' ' + l.particular + '  ' + (l.amount||0).toLocaleString('en-IN'));
  console.log('--- low-confidence RDC rows ---');
  for (const m of r.unmatchedRdc.filter(m => m.reasonCode === 'LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED').slice(0,10))
    console.log('  ' + m.rdcTxn?.date + ' ' + m.rdcTxn?.voucherType + ' ref="' + m.rdcTxn?.referenceNo + '" conf=' + m.rdcTxn?.parseConfidence + ' amt=' + m.rdcAmount + ' part="' + (m.rdcTxn?.particulars||'').slice(0,50) + '"');
  console.log('--- unmatched CUSTOMER ---');
  for (const m of r.unmatchedCustomer.slice(0,12))
    console.log('  ' + m.customerTxn?.date + ' ' + m.customerTxn?.voucherType + ' ref="' + m.customerTxn?.referenceNo + '" amt=' + m.customerAmount);
})();
