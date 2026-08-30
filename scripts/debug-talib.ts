import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';
const D = path.join(process.cwd(), 'test-data-060726/Ledger Recon New Testing_060726/RDC vs Talib');
(async () => {
  const rdc = await parseLedger(path.join(D, 'RDC Ledger.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(D, 'Talib_Customer Ledger.xlsx'), 'CUSTOMER');
  const r = reconcile(rdc, cust, { partyName: 'Talib', periodStart: '2015-04-01', periodEnd: '2026-12-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  const pays = r.unmatchedCustomer.filter(m => ['RECEIPT','PAYMENT'].includes(String(m.customerTxn?.voucherType)));
  console.log(`unmatched customer payments: ${pays.length}`);
  for (const m of pays) {
    const t = m.customerTxn!;
    console.log(`  vno="${t.voucherNo}" type=${t.voucherType} amt=${m.customerAmount} ref="${t.referenceNo}" alloc="${t.allocationType}"`);
    console.log(`     particulars="${String(t.particulars||'').slice(0,150)}"`);
  }
})();
