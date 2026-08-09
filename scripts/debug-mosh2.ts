import path from 'path';
import { parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';
const DIR = path.join(process.cwd(), 'test-data-270726');
(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC vs Mosh & Ram Steel Reco As of 31st Aug25 9 Aug 4th.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'mosh ledger 9 aug 4th.xlsx'), 'CUSTOMER');
  for (const [n, p] of [['RDC', rdc], ['CUST', cust]] as const) {
    console.log(n + ': rows=' + p.transactions.length + ' opening=' + p.balances.opening + ' closing=' + p.balances.closing + ' gap=' + ledgerIntegrityGap(p)?.toFixed(2));
    console.log('  sum=' + p.transactions.reduce((s,t)=>s+t.signedAmountRdcView,0).toFixed(2));
    const types = new Map<string, number>();
    for (const t of p.transactions) types.set(t.voucherType, (types.get(t.voucherType)||0)+1);
    console.log('  types:', Object.fromEntries(types));
    console.log('  audit: ' + describeAudit(auditLedger(p, n === 'RDC' ? 'RDC' : 'CUSTOMER')));
    for (const l of p.parserLog.filter(l=>/Skipped|adapter|layout/.test(l.message)).slice(0,10)) console.log('   [' + l.sourceSheet + '] ' + l.message.slice(0,90));
  }
  const r = reconcile(rdc, cust, { partyName: 'Mosh', periodStart: '2016-04-01', periodEnd: '2025-08-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log('\nverdict=' + r.cards.verdict + ' matched=' + r.matches.length + ' unmatchedRdc=' + r.unmatchedRdc.length + ' unmatchedCust=' + r.unmatchedCustomer.length + ' coverage=' + r.cards.matchedCoveragePct + '%');
  for (const l of r.summaryLines) console.log('  ' + (l.sign||'') + ' ' + l.particular + '  ' + (l.amount||0).toLocaleString('en-IN'));
})();
