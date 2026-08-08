import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';
const DIR = path.join(process.cwd(), 'test-data-250726');
(async () => {
  const rdc = await parseLedger(path.join(DIR, 'Lotus Villa RDC Ledger 6-6-26.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'Lotus Client Ledger 6-6-26.pdf'), 'CUSTOMER');
  for (const target of ['1424', '1449', '1457', '1472']) {
    console.log('--- ' + target + ' ---');
    for (const t of rdc.transactions.filter(t => (t.referenceNo||'').includes(target)))
      console.log('  RDC  ' + t.date + ' ' + t.voucherType + ' ref=' + t.referenceNo + ' amt=' + t.signedAmountRdcView);
    for (const t of cust.transactions.filter(t => (t.referenceNo||'').includes(target) || (t.extractedReferences||[]).some(r => r.includes(target))))
      console.log('  CUST ' + t.date + ' ' + t.voucherType + ' ref=' + t.referenceNo + ' amt=' + t.signedAmountRdcView + ' allRefs=' + (t.extractedReferences||[]).length + ' hasIt=' + (t.extractedReferences||[]).filter(r=>r.includes(target)).join(','));
  }
})();
