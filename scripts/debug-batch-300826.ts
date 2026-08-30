/** Diagnosis of the 30-Aug-26 set (5 customers). No fixes - triage only. */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const D = path.join(process.cwd(), 'test-data-300826');
const PAIRS = [
  { name: 'DSR SSC', rdc: 'RDC LEDGER DSR.xlsx', cust: 'DSR LEDGER.xlsx' },
  { name: 'SUNDEW', rdc: 'RDC LEDGER  SUNDEW.xlsx', cust: 'SUNDEW LEDGER.xlsx' },
  { name: 'SRR', rdc: 'RDC LEDGER SRR.xlsx', cust: 'SRR LEDGER.xlsx' },
  { name: 'SUROJ', rdc: 'RDC LEDGER.XLSX', cust: 'SUROJ LEDGER 2.xlsx' },
  { name: 'AGA', rdc: 'RDC AGA INFRA LEDGER.xlsx', cust: 'AGA LEDGER.xlsx' },
];
const only = process.argv[2];
(async () => {
  for (const p of PAIRS) {
    if (only && !p.name.toLowerCase().includes(only.toLowerCase())) continue;
    console.log('\n' + '='.repeat(80) + `\n${p.name}\n` + '='.repeat(80));
    let rdc, cust;
    for (const [side, f] of [['RDC', p.rdc], ['CUSTOMER', p.cust]] as const) {
      try {
        const parsed = await parseLedger(path.join(D, f), side);
        if (side === 'RDC') rdc = parsed; else cust = parsed;
        const types = new Map<string, number>();
        for (const t of parsed.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
        const withRef = parsed.transactions.filter(t => (t.normalizedReferenceNo || '').length >= 4).length;
        console.log(`${side}  ${f}`);
        console.log(`  rows=${parsed.transactions.length} withRef=${withRef} opening=${parsed.balances.opening} closing=${parsed.balances.closing} gap=${ledgerIntegrityGap(parsed)?.toFixed(2)}`);
        console.log(`  audit: ${describeAudit(auditLedger(parsed, side))}`);
        console.log(`  types: ${JSON.stringify(Object.fromEntries(types))}`);
        for (const l of parsed.parserLog.slice(0, 6)) console.log(`   [${l.level}] ${l.message.slice(0, 150)}`);
        for (const t of parsed.transactions.slice(0, 4)) console.log(`   ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView}`);
      } catch (e) { console.log(`${side}  ${f}  THREW: ${e instanceof Error ? e.message : e}`); }
    }
    if (rdc && cust) {
      const r = reconcile(rdc, cust, { partyName: p.name, periodStart: '2015-04-01', periodEnd: '2026-12-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
      console.log(`RECON verdict=${r.cards.verdict} matched=${r.matches.length} possible=${r.possibleMatches.length} unRDC=${r.unmatchedRdc.length} unCUST=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
      for (const l of r.summaryLines) console.log(`   ${(l.sign || '').padEnd(4)} ${String(l.particular).slice(0, 66).padEnd(68)} ${Number(l.amount || 0).toLocaleString('en-IN')}`);
    }
  }
})();
