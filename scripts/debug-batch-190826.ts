/** Batch triage of the 19-Aug-26 set: parse both sides of every pair, report. */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const D = path.join(process.cwd(), 'test-data-190826');
const R = path.join(D, 'AI Reconciliation  File');

type Pair = { name: string; rdc: string; cust: string };
const PAIRS: Pair[] = [
  { name: 'Shree Ram (vendor)', rdc: path.join(D, 'Shree Ram Ent 31Jul26 - 19-8.xls'), cust: path.join(D, 'Vend Shree Ram Ent 31Jul.26.xls') },
  { name: 'Preet Traders (vendor)', rdc: path.join(D, 'Preet Traders 31mar26.xls'), cust: path.join(D, 'Vend Preet Traders 31Mar26.pdf') },
  { name: 'Afita', rdc: path.join(D, 'RDC-Afita-Mumbai.xlsx'), cust: path.join(D, 'Afita-Mumbai.xlsx') },
  { name: 'Atlas', rdc: path.join(D, 'RDC-Atlas-Mumbai.xlsx'), cust: path.join(D, 'Atlas-Mumbai.xlsx') },
  { name: 'Ecoform', rdc: path.join(D, 'RDC-Ecoform-Mumbai.xlsx'), cust: path.join(D, 'Ecoform-Mumbai.xlsx') },
  { name: 'Premix', rdc: path.join(D, 'RDC-Premix-Mumbai.xlsx'), cust: path.join(D, 'Premix-Mumbai.xlsx') },
  { name: 'PAMR (vendor)', rdc: path.join(R, 'PAMR Industries Reco', 'RDC SOA VENDOR.xlsx'), cust: path.join(R, 'PAMR Industries Reco', 'PAMR SOA.xlsx') },
  { name: 'Ultratech (vendor)', rdc: path.join(R, 'RDC VS ULTRATECH', 'RDC LEDGER.xlsx'), cust: path.join(R, 'RDC VS ULTRATECH', 'ULTRATECH LEDGER.xlsx') },
  { name: 'SPJ Properties', rdc: path.join(R, 'SPJ Reco', 'RDC SOA.xls'), cust: path.join(R, 'SPJ Reco', 'SPJ PROPERTIES PRIVATE LIMITED SOA.xlsx') },
  { name: 'SS SS Constructions', rdc: path.join(R, 'SS SS Constrution', 'RDC SS SS Cons Ledger.xls'), cust: path.join(R, 'SS SS Constrution', 'SS SS Constructions Pvt Ltd  Ledger.pdf') },
  { name: 'Shri Kaila', rdc: path.join(R, 'Shri Kaila Construction', 'SKC - RDC Ledger.xls'), cust: path.join(R, 'Shri Kaila Construction', 'SKC - Customer Ledger.pdf') },
  { name: 'ZCC Techno', rdc: path.join(R, 'ZCC Techno Private Reco', 'RDC Ledger ZCC.xlsx'), cust: path.join(R, 'ZCC Techno Private Reco', 'ZCC Techno SOA.xlsx') },
];

const only = process.argv[2];

(async () => {
  for (const p of PAIRS) {
    if (only && !p.name.toLowerCase().includes(only.toLowerCase())) continue;
    console.log('\n' + '='.repeat(78));
    console.log(p.name);
    console.log('='.repeat(78));
    let rdc, cust;
    for (const [side, file] of [['RDC', p.rdc], ['CUSTOMER', p.cust]] as const) {
      try {
        const parsed = await parseLedger(file, side);
        if (side === 'RDC') rdc = parsed; else cust = parsed;
        const types = new Map<string, number>();
        for (const t of parsed.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
        console.log(`${side}  ${path.basename(file)}`);
        console.log(`  rows=${parsed.transactions.length} opening=${parsed.balances.opening} closing=${parsed.balances.closing} gap=${ledgerIntegrityGap(parsed)?.toFixed(2)}`);
        console.log(`  audit: ${describeAudit(auditLedger(parsed, side))}`);
        console.log(`  types: ${JSON.stringify(Object.fromEntries(types))}`);
        for (const l of parsed.parserLog.slice(0, 5)) console.log(`   [${l.level}] ${l.message.slice(0, 150)}`);
        for (const t of parsed.transactions.slice(0, 3)) console.log(`   ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView}`);
      } catch (e) {
        console.log(`${side}  ${path.basename(file)}  THREW: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (rdc && cust) {
      try {
        const r = reconcile(rdc, cust, { partyName: p.name, periodStart: '2015-04-01', periodEnd: '2026-12-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
        console.log(`RECON verdict=${r.cards.verdict} matched=${r.matches.length} unRDC=${r.unmatchedRdc.length} unCUST=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
        for (const l of r.summaryLines) console.log(`   ${(l.sign || '').padEnd(4)} ${String(l.particular).slice(0, 70).padEnd(72)} ${(l.amount || 0).toLocaleString('en-IN')}`);
      } catch (e) {
        console.log(`RECON THREW: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
})();
