import path from 'path';
import { parseLedger } from '../src/core/parser';
(async () => {
  const cust = await parseLedger(path.join(process.cwd(), 'test-data-250726', 'Senghani -Leela Site ledger.xlsx'), 'CUSTOMER');
  const inv = cust.transactions.filter(t => t.voucherType === 'INVOICE');
  console.log('invoices=' + inv.length + '  withRef=' + inv.filter(t => t.referenceNo).length);
  const shapes = new Map<string, number>();
  for (const t of inv) { const k = (t.referenceNo||'').slice(0,6); shapes.set(k, (shapes.get(k)||0)+1); }
  console.log('ref prefixes:', Object.fromEntries([...shapes.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)));
  console.log('samples:', inv.slice(0,5).map(t=>t.referenceNo).join(' | '));
})();
