/** Is the RDC 134.33 integrity gap caused by reading FORMATTED (rounded) cell
 * text instead of the true numeric values? */
import fs from 'fs';
import * as XLSX from 'xlsx';
const F = './test-data-230726/RDC SUROJ  LEDGER.xlsx';
const wb = XLSX.read(fs.readFileSync(F), { cellDates: true, type: 'buffer' });
const ws = wb.Sheets['RDC'];
for (const raw of [false, true]) {
  const m = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw });
  let sum = 0;
  for (let i = 10; i < m.length; i++) {
    const r = m[i] as unknown[];
    const label = r.map(c => String(c ?? '')).join(' ');
    if (/Total of Debits|Customer Closing Balance/i.test(label)) continue;
    const dr = Number(String(r[10] ?? '0').replace(/[^0-9.-]/g, '')) || 0;
    const cr = Number(String(r[11] ?? '0').replace(/[^0-9.-]/g, '')) || 0;
    sum += Math.abs(dr) - Math.abs(cr);
  }
  console.log(`raw=${raw}: Σ(Dr-Cr) = ${sum.toFixed(4)}`);
  console.log(`  sample row 11 Dr cell = ${JSON.stringify((m[10] as unknown[])[10])}`);
}
const cwb = XLSX.read(fs.readFileSync('./test-data-230726/SUROJ LEDGER 2.xlsx'), { cellDates: true, type: 'buffer' });
for (const raw of [false, true]) {
  const cm = XLSX.utils.sheet_to_json<unknown[]>(cwb.Sheets['SUROJ'], { header: 1, defval: '', raw });
  let sum = 0;
  for (let i = 2; i < cm.length; i++) {
    const g = Number(String((cm[i] as unknown[])[6] ?? '').replace(/[^0-9.-]/g, '')) || 0;
    sum += g;
  }
  console.log(`SUROJ raw=${raw}: Σ(Gross Total) = ${sum.toFixed(4)}  | row0 total cell = ${JSON.stringify((cm[0] as unknown[])[6])}`);
}
