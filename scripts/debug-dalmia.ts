/** Inspect the raw structure of the Dalmia pair (customer xlsx read 0 rows). */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-210726');
(async () => {
  for (const file of ['DALMIA APP.xlsx', 'RDC APP.xlsx']) {
    const wb = XLSX.read(fs.readFileSync(path.join(DIR, file)), { cellDates: true, type: 'buffer' });
    console.log(`\n########## ${file}: sheets=${JSON.stringify(wb.SheetNames)}`);
    for (const sn of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '', raw: false });
      console.log(`--- sheet "${sn}": ${rows.length} rows; first 18 rows:`);
      rows.slice(0, 18).forEach((r, i) => console.log(`  [${i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 28)))}`));
      console.log(`  ... last 4 rows:`);
      rows.slice(-4).forEach((r) => console.log(`  ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 28)))}`));
    }
  }
  const parsed: Record<string, Awaited<ReturnType<typeof parseLedger>>> = {};
  for (const [f, side] of [['RDC APP.xlsx', 'RDC'], ['DALMIA APP.xlsx', 'CUSTOMER']] as const) {
    const p = await parseLedger(path.join(DIR, f), side);
    parsed[side] = p;
    console.log(`\nparse ${f} (${side}): rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
    for (const log of p.parserLog.slice(0, 8)) console.log(`  [${log.level}] ${log.message.slice(0, 150)}`);
    const types = new Map<string, number>();
    for (const t of p.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
    console.log('  types:', Object.fromEntries(types));
    for (const t of p.transactions.slice(0, 4)) console.log(`  row: ${t.date} ${t.voucherType} ref=${t.referenceNo} dr=${t.debit} cr=${t.credit} signed=${t.signedAmountRdcView}`);
  }
  const { reconcile } = await import('../src/core/reconcile');
  const r = reconcile(parsed['RDC'], parsed['CUSTOMER'], { partyName: 'Dalmia Cement', periodStart: '2023-05-01', periodEnd: '2026-07-22', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\n>>> DALMIA reconciled — verdict=${r.cards.verdict} certified=${r.cards.certified}`);
  console.log(`matched=${r.matches.length} unmatchedRdc=${r.unmatchedRdc.length} unmatchedCust=${r.unmatchedCustomer.length} outside=${r.outsidePeriodCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
  for (const l of r.summaryLines) console.log(`  ${l.sign ?? ''}  ${l.particular}  ${l.amount?.toLocaleString('en-IN')}  ${(l.remarks ?? '').slice(0, 60)}`);
})();
