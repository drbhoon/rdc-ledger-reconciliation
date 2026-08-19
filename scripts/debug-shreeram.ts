/** Shree Ram Enterprises (vendor): why do only 6 of 32 customer rows match? */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';

const D = path.join(process.cwd(), 'test-data-190826');

(async () => {
  const rdc = await parseLedger(path.join(D, 'Shree Ram Ent 31Jul26 - 19-8.xls'), 'RDC');
  const cust = await parseLedger(path.join(D, 'Vend Shree Ram Ent 31Jul.26.xls'), 'CUSTOMER');
  console.log('RDC refs:', rdc.transactions.filter(t => t.voucherType === 'INVOICE').map(t => `${t.referenceNo}=${t.signedAmountRdcView}`).join('  '));
  console.log('\nCUST refs:', cust.transactions.map(t => `${t.voucherType}:${t.referenceNo || '-'}=${t.signedAmountRdcView}`).join('  '));
  console.log('\nRDC normalized:', rdc.transactions.slice(0, 6).map(t => t.normalizedReferenceNo).join(' '));
  console.log('CUST normalized:', cust.transactions.slice(0, 6).map(t => t.normalizedReferenceNo).join(' '));

  const r = reconcile(rdc, cust, { partyName: 'Shree Ram', periodStart: '2015-04-01', periodEnd: '2026-12-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\nmatched=${r.matches.length}`);
  for (const m of r.matches) console.log(`  MATCH ${m.reasonCode} rdcRef=${m.reasonCode} status=${m.matchStatus} rdc=${m.rdcAmount} cust=${m.customerAmount} diff=${m.difference}`);
  console.log(`\nunmatched RDC (${r.unmatchedRdc.length}):`);
  for (const t of r.unmatchedRdc.slice(0, 12)) console.log(`  ${t.reasonCode} ${t.remarks} amt=${t.rdcAmount}`);
  console.log(`\nunmatched CUST (${r.unmatchedCustomer.length}):`);
  for (const t of r.unmatchedCustomer.slice(0, 12)) console.log(`  ${t.reasonCode} ${t.remarks} amt=${t.customerAmount}`);
})();
