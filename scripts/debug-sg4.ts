import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';
const DIR = path.join(process.cwd(), 'test-data-250726');
(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC Senghani Ledger 6-6-26.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'Senghani -Leela Site ledger.xlsx'), 'CUSTOMER');
  const r = reconcile(rdc, cust, { partyName: 'Senghani', periodStart: '2025-04-01', periodEnd: '2026-06-20', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  const isPay = (v?: string) => v === 'RECEIPT' || v === 'PAYMENT';
  console.log('--- unmatched RDC receipts ---');
  for (const m of r.unmatchedRdc.filter(m => isPay(m.rdcTxn?.voucherType)))
    console.log('  ' + m.rdcTxn?.date + '  ' + (m.rdcAmount||0).toFixed(2).padStart(14) + '  ' + m.rdcTxn?.referenceNo);
  console.log('--- unmatched CUSTOMER payments ---');
  for (const m of r.unmatchedCustomer.filter(m => isPay(m.customerTxn?.voucherType)))
    console.log('  ' + m.customerTxn?.date + '  ' + (m.customerAmount||0).toFixed(2).padStart(14) + '  chq=' + m.customerTxn?.chequeNo + '  ' + m.customerTxn?.voucherNo);
})();
