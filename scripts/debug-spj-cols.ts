import path from 'path'; import fs from 'fs'; import * as XLSX from 'xlsx';
const f = path.join(process.cwd(), 'test-data-190826/AI Reconciliation  File/SPJ Reco/SPJ PROPERTIES PRIVATE LIMITED SOA.xlsx');
const wb = XLSX.read(fs.readFileSync(f), { cellDates: true, type: 'buffer' });
const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
const H = 8;
console.log('headers:', JSON.stringify((m[H] as unknown[]).map(String)));
const types = new Map<string, {n:number; per:Record<number,number>}>();
for (let i = H + 1; i < m.length; i++) {
  const r = m[i] as unknown[];
  const vt = String(r[2] ?? '').trim() || '(blank)';
  const e = types.get(vt) || { n: 0, per: {} as Record<number, number> };
  e.n++;
  for (let c = 5; c <= 8; c++) { const v = Number(String(r[c] ?? '').replace(/,/g, '')); if (v) e.per[c] = (e.per[c] || 0) + v; }
  types.set(vt, e);
}
for (const [k, v] of types) console.log(`${k.padEnd(14)} n=${String(v.n).padEnd(4)} ${JSON.stringify(v.per)}`);
