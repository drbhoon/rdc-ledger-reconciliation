import fs from 'fs';
import * as XLSX from 'xlsx';
const wb = XLSX.read(fs.readFileSync('./test-data-250726/Senghani -Leela Site ledger.xlsx'), { cellDates: true, type: 'buffer' });
const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Source Data  Page - 1'], { header: 1, defval: '', raw: true });
console.log('header:', JSON.stringify((m[11] as unknown[]).map(String)));
console.log('--- rows 12..34 ---');
m.slice(12, 34).forEach((r, i) => console.log('[' + (12+i) + '] ' + JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 30)))));
const types = new Map<string, number>();
for (let i = 12; i < m.length - 2; i++) { const t = String((m[i] as unknown[])[2] ?? '').trim(); types.set(t, (types.get(t)||0)+1); }
console.log('Type values:', Object.fromEntries([...types.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12)));
const parts = new Map<string, number>();
for (let i = 12; i < m.length - 2; i++) { const t = String((m[i] as unknown[])[4] ?? '').trim(); parts.set(t, (parts.get(t)||0)+1); }
console.log('Particulars values:', Object.fromEntries([...parts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12)));
console.log('--- a payment voucher sample ---');
let shown = 0;
for (let i = 12; i < m.length - 2 && shown < 12; i++) { const r = m[i] as unknown[]; if (!/PBILL/i.test(String(r[2]))) { console.log('[' + i + '] ' + JSON.stringify(r.map(c => String(c).slice(0, 30)))); shown++; } }
