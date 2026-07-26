import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseDate } from '../src/core/date';
const wb = XLSX.read(fs.readFileSync('./test-data-230726/RDC SUROJ  LEDGER.xlsx'), { cellDates: true, type: 'buffer' });
const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['RDC'], { header: 1, defval: '', raw: true });
const cellA = (m[10] as unknown[])[0];
console.log('TZ offset minutes:', new Date().getTimezoneOffset(), 'TZ:', Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log('typeof:', typeof cellA, cellA instanceof Date ? 'Date' : '');
console.log('value:', cellA);
if (cellA instanceof Date) {
  console.log('toISOString:', cellA.toISOString(), 'local:', cellA.toString());
  console.log('local Y-M-D:', cellA.getFullYear(), cellA.getMonth() + 1, cellA.getDate());
  console.log('UTC   Y-M-D:', cellA.getUTCFullYear(), cellA.getUTCMonth() + 1, cellA.getUTCDate());
}
console.log('parseDate ->', parseDate(cellA));
// no-cellDates variant: serial number
const wb2 = XLSX.read(fs.readFileSync('./test-data-230726/RDC SUROJ  LEDGER.xlsx'), { type: 'buffer' });
const m2 = XLSX.utils.sheet_to_json<unknown[]>(wb2.Sheets['RDC'], { header: 1, defval: '', raw: true });
const serial = (m2[10] as unknown[])[0];
console.log('no-cellDates cell:', serial, 'parseDate ->', parseDate(serial));
