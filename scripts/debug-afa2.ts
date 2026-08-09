import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { auditLedger } from '../src/core/audit';
const DIR = path.join(process.cwd(), 'test-data-260726');
(async () => {
  const cust = await parseLedger(path.join(DIR, 'AFA LEDGER 9-8-26.xlsx'), 'CUSTOMER');
  const a = auditLedger(cust, 'CUSTOMER');
  console.log('issues=' + a.issues.length);
  for (const i of a.issues) console.log('  row ' + i.sourceRow + ' ref=' + i.reference + ' read=' + i.parsedAmount.toFixed(2) + ' implied=' + i.expectedAmount.toFixed(2) + ' delta=' + i.delta.toFixed(2));
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, 'AFA LEDGER 9-8-26.xlsx')), { cellDates: true, type: 'buffer' });
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Sheet1'], { header: 1, defval: '', raw: true });
  for (const i of a.issues) {
    const rows = String(i.sourceRow).split(',').map(Number);
    for (const rn of rows) console.log('  RAW[' + rn + '] ' + JSON.stringify((m[rn-1] as unknown[]).map(c => String(c).slice(0, 22))));
  }
})();
