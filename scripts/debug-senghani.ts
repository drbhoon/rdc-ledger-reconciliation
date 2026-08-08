/** Senghani. Manual reco (01-Apr-25..20-Jun-26):
 *   RDC 1,22,28,830.14 | Senghani 59,70,696.00 | Difference 62,58,134.14
 *   Less payment not in RDC till 20-Jun (booked 22-Jun) 60,51,807.44
 *   Add  bills booked by Senghani for Asmi site           2,18,595.00
 *   Less invoices not booked by Senghani                  4,85,695.08
 *   Less TDS deducted by Senghani                         1,64,249.00
 *   Add  short/excess                                     2,25,022.38  -> 0.00
 */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-250726');
const RDC = 'RDC Senghani Ledger 6-6-26.xlsx';
const CUST = 'Senghani -Leela Site ledger.xlsx';

function dump(file: string, rows = 12) {
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, file)), { cellDates: true, type: 'buffer' });
  console.log(`\n##### ${file}: sheets=${JSON.stringify(wb.SheetNames)}`);
  for (const sn of wb.SheetNames.slice(0, 2)) {
    const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '', raw: true });
    console.log(`--- "${sn}" ${m.length} rows`);
    m.slice(0, rows).forEach((r, i) => console.log(`[${i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 26)))}`));
    console.log('  tail:');
    m.slice(-4).forEach((r, i) => console.log(`[${m.length - 4 + i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 26)))}`));
  }
}

(async () => {
  dump(RDC); dump(CUST);
  const rdc = await parseLedger(path.join(DIR, RDC), 'RDC');
  const cust = await parseLedger(path.join(DIR, CUST), 'CUSTOMER');
  for (const [n, p] of [['RDC', rdc], ['CUST', cust]] as const) {
    console.log(`\n=== ${n}: rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
    console.log(`  audit: ${describeAudit(auditLedger(p, n === 'RDC' ? 'RDC' : 'CUSTOMER'))}`);
    for (const l of p.parserLog.slice(0, 6)) console.log(`  [${l.level}] ${l.message.slice(0, 130)}`);
    const types = new Map<string, number>();
    for (const t of p.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
    console.log('  types:', Object.fromEntries(types));
    for (const t of p.transactions.slice(0, 5)) console.log(`  ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView}`);
  }
  const r = reconcile(rdc, cust, { partyName: 'Senghani', periodStart: '2025-04-01', periodEnd: '2026-06-20', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\nverdict=${r.cards.verdict} matched=${r.matches.length} possible=${r.possibleMatches.length} unmatchedRdc=${r.unmatchedRdc.length} unmatchedCust=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
  for (const l of r.summaryLines) console.log(`  ${l.sign || ''} ${l.particular}  ${(l.amount || 0).toLocaleString('en-IN')}`);
  console.log('\n--- largest unmatched RDC ---');
  for (const m of [...r.unmatchedRdc].sort((a, b) => Math.abs(b.rdcAmount || 0) - Math.abs(a.rdcAmount || 0)).slice(0, 8))
    console.log(`  ${m.rdcTxn?.date} ${m.rdcTxn?.voucherType} ref="${m.rdcTxn?.referenceNo}" amt=${m.rdcAmount} reason=${m.reasonCode}`);
  console.log('--- largest unmatched CUSTOMER ---');
  for (const m of [...r.unmatchedCustomer].sort((a, b) => Math.abs(b.customerAmount || 0) - Math.abs(a.customerAmount || 0)).slice(0, 8))
    console.log(`  ${m.customerTxn?.date} ${m.customerTxn?.voucherType} ref="${m.customerTxn?.referenceNo}" amt=${m.customerAmount} reason=${m.reasonCode}`);
  console.log('--- large variance matches ---');
  for (const m of (r.largeVarianceMatches || []).slice(0, 8))
    console.log(`  RDC[${m.rdcTxn?.referenceNo} ${m.rdcAmount}] CUST[${m.customerTxn?.referenceNo} ${m.customerAmount}] diff=${m.difference}`);
})();
