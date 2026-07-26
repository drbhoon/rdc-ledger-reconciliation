/** Why did Bearys pick up 3 extra customer rows and an 18.3cr gap? */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap } from '../src/core/reconcile';
const F = path.join(process.cwd(), 'beays  - customer-ledger.xlsx');
(async () => {
  const p = await parseLedger(F, 'CUSTOMER');
  console.log(`rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
  const sum = p.transactions.reduce((s, t) => s + t.signedAmountRdcView, 0);
  console.log('Σsigned =', sum.toFixed(2));
  for (const l of p.parserLog.slice(0, 8)) console.log(`  [${l.level}] ${l.message.slice(0, 140)}`);
  // biggest rows — a balance/total row leaking in would dominate
  console.log('\nlargest 8 rows by |amount|:');
  for (const t of [...p.transactions].sort((a, b) => Math.abs(b.signedAmountRdcView) - Math.abs(a.signedAmountRdcView)).slice(0, 8)) {
    console.log(`  row ${t.sourceRow} ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView} part="${(t.particulars || '').slice(0, 60)}"`);
  }
  console.log('\nrows with no date:');
  for (const t of p.transactions.filter(t => !t.date).slice(0, 8)) console.log(`  row ${t.sourceRow} ${t.voucherType} amt=${t.signedAmountRdcView} part="${(t.particulars || '').slice(0, 70)}"`);
})();
