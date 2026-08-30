import path from 'path';
import { parseLedger } from '../src/core/parser';
const D = path.join(process.cwd(), 'test-data-300826');
(async () => {
  const cust = await parseLedger(path.join(D, 'SRR LEDGER.xlsx'), 'CUSTOMER');
  console.log('parser log:');
  for (const l of cust.parserLog) console.log(`  [${l.level}] ${l.message.slice(0, 170)}`);
  console.log('\nfirst 6 rows:');
  for (const t of cust.transactions.slice(0, 6)) console.log(`  ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" norm="${t.normalizedReferenceNo}" amt=${t.signedAmountRdcView}`);
  const rdc = await parseLedger(path.join(D, 'RDC LEDGER SRR.xlsx'), 'RDC');
  console.log('\nRDC first 4:');
  for (const t of rdc.transactions.slice(0, 4)) console.log(`  ${t.date} ${t.voucherType} ref="${t.referenceNo}" norm="${t.normalizedReferenceNo}" amt=${t.signedAmountRdcView}`);
})();
