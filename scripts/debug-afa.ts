/** AFA. Manual: RDC 13,12,247.34 | AFA 8,58,403.06 | Difference 4,53,844.28
 *  Less invoice not booked 4,49,960.50 / Add excess invoice booked 10,003.37
 *  Less TDS not booked by RDC 13,887.50 / Add short & excess 0.35 -> 0.00
 *  App read the customer balance as -3,46,750.88 (out by 12,05,153.94) and
 *  left 2,174 invoices + 112 receipts unmatched.
 */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-260726');
const RDC = 'RDC AFA INFRA PRIVATE LIMITED 9-8-26.xlsx';
const CUST = 'AFA LEDGER 9-8-26.xlsx';

function dump(file: string) {
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, file)), { cellDates: true, type: 'buffer' });
  console.log(`\n##### ${file}: sheets=${JSON.stringify(wb.SheetNames)}`);
  for (const sn of wb.SheetNames.slice(0, 2)) {
    const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '', raw: true });
    console.log(`--- "${sn}" ${m.length} rows`);
    m.slice(0, 16).forEach((r, i) => console.log(`[${i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 24)))}`));
    console.log('  tail:');
    m.slice(-5).forEach((r, i) => console.log(`[${m.length - 5 + i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 24)))}`));
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
  const r = reconcile(rdc, cust, { partyName: 'AFA', periodStart: '2025-04-01', periodEnd: '2026-06-10', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\nverdict=${r.cards.verdict} matched=${r.matches.length} unmatchedRdc=${r.unmatchedRdc.length} unmatchedCust=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
  for (const l of r.summaryLines) console.log(`  ${l.sign || ''} ${l.particular}  ${(l.amount || 0).toLocaleString('en-IN')}`);
})();
