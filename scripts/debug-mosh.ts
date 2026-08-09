/** Mosh. Employee reco as of 31-Aug-25:
 *   RDC 19,24,476.46 | Mosh 7,52,400.00 | Difference 11,72,076.46
 *   Less bill not booked Aug'25 12,92,401.29 + prior 2,88,133.95
 *   Add duplicate invoice booked by Mosh (1RA23ARS998) 22,148.00
 *   Add payment not in Mosh ledger 3,92,400.00
 *   Less short & excess 6,089.22  -> 0.00
 * App read RDC balance as 0.00 and dumped 834 customer rows into "Other entries".
 */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-270726');
const RDC = 'RDC vs Mosh & Ram Steel Reco As of 31st Aug25 9 Aug 4th.xlsx';
const CUST = 'mosh ledger 9 aug 4th.xlsx';

function dump(file: string, rows = 18) {
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, file)), { cellDates: true, type: 'buffer' });
  console.log(`\n##### ${file}: sheets=${JSON.stringify(wb.SheetNames)}`);
  for (const sn of wb.SheetNames.slice(0, 3)) {
    const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '', raw: true });
    console.log(`--- "${sn}" ${m.length} rows`);
    m.slice(0, rows).forEach((r, i) => console.log(`[${i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 22)))}`));
    console.log('  tail:');
    m.slice(-4).forEach((r, i) => console.log(`[${m.length - 4 + i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 22)))}`));
  }
}

(async () => {
  dump(RDC); dump(CUST);
  const rdc = await parseLedger(path.join(DIR, RDC), 'RDC');
  const cust = await parseLedger(path.join(DIR, CUST), 'CUSTOMER');
  for (const [n, p] of [['RDC', rdc], ['CUST', cust]] as const) {
    console.log(`\n=== ${n}: rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
    console.log(`  audit: ${describeAudit(auditLedger(p, n === 'RDC' ? 'RDC' : 'CUSTOMER'))}`);
    for (const l of p.parserLog.slice(0, 8)) console.log(`  [${l.level}] ${l.message.slice(0, 140)}`);
    const types = new Map<string, number>();
    for (const t of p.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
    console.log('  types:', Object.fromEntries(types));
    for (const t of p.transactions.slice(0, 6)) console.log(`  ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView}`);
  }
})();
