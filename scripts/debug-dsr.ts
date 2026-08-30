import path from 'path'; import fs from 'fs'; import * as XLSX from 'xlsx';
const f = path.join(process.cwd(), 'test-data-300826/DSR LEDGER.xlsx');
const wb = XLSX.read(fs.readFileSync(f), { cellDates: true, type: 'buffer' });
const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
const types = new Map<string, number>();
for (let i = 1; i < m.length - 2; i++) { const t = String((m[i] as unknown[])[3] ?? '').trim() || '(blank)'; types.set(t, (types.get(t) || 0) + 1); }
console.log('customer Vch Type histogram:', JSON.stringify(Object.fromEntries(types)));
console.log('\nnon-Purchase rows:');
for (let i = 1; i < m.length - 2; i++) { const r = m[i] as unknown[]; const t = String(r[3] ?? '').trim();
  if (!/^purchase$/i.test(t)) console.log(`  [${i}] ${JSON.stringify(r.map(c => String(c).slice(0, 40)))}`); }
