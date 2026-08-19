import fs from 'fs'; import * as XLSX from 'xlsx';
const [file, sheetArg, from, to] = process.argv.slice(2);
const wb = XLSX.read(fs.readFileSync(file), { cellDates: true, type: 'buffer' });
const s = sheetArg || wb.SheetNames[0];
const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1, defval: '', raw: true });
for (let i = Number(from); i <= Math.min(Number(to), m.length - 1); i++) console.log(`[${i}] ${JSON.stringify((m[i] as unknown[]).map(c => String(c).slice(0, 34)))}`);
