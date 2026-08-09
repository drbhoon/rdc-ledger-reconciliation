/** Henna: RDC xlsx + customer PDF. */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { extractRawText, parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-280726');
const RDC = 'RDC_henna 5th.xlsx';
const CUST = 'Customer Hena 5th.pdf';

(async () => {
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, RDC)), { cellDates: true, type: 'buffer' });
  console.log(`##### ${RDC}: sheets=${JSON.stringify(wb.SheetNames)}`);
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  console.log(`rows=${m.length}`);
  m.slice(0, 14).forEach((r, i) => console.log(`[${i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 24)))}`));
  console.log('tail:');
  m.slice(-4).forEach((r, i) => console.log(`[${m.length - 4 + i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 24)))}`));

  const raw = await extractRawText(path.join(DIR, CUST));
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log(`\n##### ${CUST}: ${raw.length} chars, ${lines.length} lines`);
  lines.slice(0, 34).forEach((l, i) => console.log(`[${i}] ${JSON.stringify(l.slice(0, 165))}`));
  console.log('tail:');
  lines.slice(-10).forEach((l, i) => console.log(`[${lines.length - 10 + i}] ${JSON.stringify(l.slice(0, 165))}`));

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
  const r = reconcile(rdc, cust, { partyName: 'Henna', periodStart: '2016-04-01', periodEnd: '2026-08-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\nverdict=${r.cards.verdict} matched=${r.matches.length} unmatchedRdc=${r.unmatchedRdc.length} unmatchedCust=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
  for (const l of r.summaryLines) console.log(`  ${l.sign || ''} ${l.particular}  ${(l.amount || 0).toLocaleString('en-IN')}`);
})();
