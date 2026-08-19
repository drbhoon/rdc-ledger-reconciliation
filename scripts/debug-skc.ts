import path from 'path';
import { extractRawText, parseLedger } from '../src/core/parser';
const F = path.join(process.cwd(), 'test-data-190826/AI Reconciliation  File/Shri Kaila Construction/SKC - Customer Ledger.pdf');
(async () => {
  const p = await parseLedger(F, 'CUSTOMER');
  const others = p.transactions.filter(t => t.voucherType === 'OTHER');
  console.log(`rows=${p.transactions.length} OTHER=${others.length}`);
  for (const t of others) console.log(`  ${t.date} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView} particulars="${(t.particulars||'').slice(0,90)}"`);
  const raw = await extractRawText(F);
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log('\n--- lines mentioning Payment ---');
  lines.filter(l => /payment/i.test(l)).slice(0, 8).forEach(l => console.log(`  ${JSON.stringify(l.slice(0,160))}`));
})();
