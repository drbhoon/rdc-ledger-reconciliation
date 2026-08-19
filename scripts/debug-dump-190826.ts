/** Raw dump of a sheet or PDF from the 19-08 set. */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { extractRawText } from '../src/core/parser';

const file = process.argv[2];
const n = Number(process.argv[3] || 30);
(async () => {
  if (/\.pdf$/i.test(file)) {
    const raw = await extractRawText(file);
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    console.log(`PDF: ${raw.length} chars, ${lines.length} non-empty lines, size=${fs.statSync(file).size}`);
    lines.slice(0, n).forEach((l, i) => console.log(`[${i}] ${JSON.stringify(l.slice(0, 180))}`));
    console.log('--- tail ---');
    lines.slice(-10).forEach((l, i) => console.log(`[${lines.length - 10 + i}] ${JSON.stringify(l.slice(0, 180))}`));
    return;
  }
  const wb = XLSX.read(fs.readFileSync(file), { cellDates: true, type: 'buffer' });
  console.log(`sheets=${JSON.stringify(wb.SheetNames)}`);
  for (const s of wb.SheetNames) {
    const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1, defval: '', raw: true });
    console.log(`\n### sheet "${s}" rows=${m.length}`);
    m.slice(0, n).forEach((r, i) => console.log(`[${i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 30)))}`));
    if (m.length > n + 6) {
      console.log('  ...tail...');
      m.slice(-4).forEach((r, i) => console.log(`[${m.length - 4 + i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 30)))}`));
    }
  }
})();
