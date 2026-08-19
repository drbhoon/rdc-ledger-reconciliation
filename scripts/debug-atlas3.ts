import path from 'path'; import fs from 'fs'; import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
const f = path.join(process.cwd(), 'test-data-190826/Atlas-Mumbai.xlsx');
const wb = XLSX.read(fs.readFileSync(f), { cellDates: true, type: 'buffer' });
const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
let dr = 0, cr = 0, n = 0;
const rawKeys = new Map<string, number>();
for (let i = 19; i <= 293; i++) { const r = m[i] as unknown[];
  const d = Number(String(r[8] ?? '').replace(/,/g, '')) || 0, c = Number(String(r[9] ?? '').replace(/,/g, '')) || 0;
  if (/opening balance/i.test(r.map(String).join(' '))) continue;
  if (d || c) { dr += d; cr += c; n++; rawKeys.set(`${String(r[7])}|${d}|${c}`, (rawKeys.get(`${String(r[7])}|${d}|${c}`) || 0) + 1); } }
console.log(`raw txn rows n=${n} Dr=${dr} Cr=${cr} sum=${cr - dr}`);
(async () => {
  const p = await parseLedger(f, 'CUSTOMER');
  let pdr = 0, pcr = 0; const pk = new Map<string, number>();
  for (const t of p.transactions) { pdr += t.debit; pcr += t.credit; const k = `${t.voucherNo}|${t.debit}|${t.credit}`; pk.set(k, (pk.get(k) || 0) + 1); }
  console.log(`parsed rows=${p.transactions.length} Dr=${pdr} Cr=${pcr} sum=${pcr - pdr} opening=${p.balances.opening} closing=${p.balances.closing}`);
  console.log('\nrows in file but NOT parsed:');
  for (const [k, c] of rawKeys) { const g = pk.get(k) || 0; if (g < c) console.log(`  missing x${c - g}: ${k}`); }
  console.log('\nrows parsed MORE than in file:');
  for (const [k, c] of pk) { const g = rawKeys.get(k) || 0; if (c > g) console.log(`  extra x${c - g}: ${k}`); }
})();
