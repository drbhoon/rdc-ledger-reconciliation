import fs from 'fs';
import * as XLSX from 'xlsx';
const wb = XLSX.read(fs.readFileSync('./test-data-240726/RDC ledger Dalmia Chennai.xlsx'), { cellDates: true, type: 'buffer' });
console.log('sheets:', wb.SheetNames);
for (const sn of wb.SheetNames) {
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '', raw: true });
  console.log('--- ' + sn + ': ' + m.length + ' rows');
  m.slice(0, 10).forEach((r, i) => console.log('[' + i + '] ' + JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 24)))));
  console.log('  tail:');
  m.slice(-3).forEach((r, i) => console.log('[' + (m.length - 3 + i) + '] ' + JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 24)))));
}
