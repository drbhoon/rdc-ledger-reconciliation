import fs from 'fs'; import * as XLSX from 'xlsx';
const [file, needle] = process.argv.slice(2);
const wb = XLSX.read(fs.readFileSync(file), { cellDates: true, type: 'buffer' });
for (const s of wb.SheetNames) {
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1, defval: '', raw: true });
  m.forEach((r, i) => { const t = (r as unknown[]).map(c => String(c)).join(' | '); if (t.toLowerCase().includes(needle.toLowerCase())) console.log(`[${s} ${i}] ${t.slice(0, 200)}`); });
}
