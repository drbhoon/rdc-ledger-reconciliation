import path from 'path'; import fs from 'fs'; import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
const f = path.join(process.cwd(), 'test-data-190826/Afita-Mumbai.xlsx');
const wb = XLSX.read(fs.readFileSync(f), { cellDates: true, type: 'buffer' });
const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
let dr = 0, cr = 0, n = 0;
for (let i = 13; i <= 735; i++) { const r = m[i] as unknown[];
  const d = Number(String(r[5] ?? '').replace(/,/g, '')) || 0, c = Number(String(r[6] ?? '').replace(/,/g, '')) || 0;
  if (/opening balance/i.test(r.map(String).join(' '))) continue;
  if (d || c) { dr += d; cr += c; n++; } }
console.log(`raw data rows n=${n} Dr=${dr} Cr=${cr}  sum(cust RDC-view)=${cr - dr}`);
(async () => {
  const p = await parseLedger(f, 'CUSTOMER');
  const sum = p.transactions.reduce((s, t) => s + t.signedAmountRdcView, 0);
  console.log(`parsed rows=${p.transactions.length} sum=${sum} opening=${p.balances.opening} closing=${p.balances.closing}`);
  let pdr = 0, pcr = 0; for (const t of p.transactions) { pdr += t.debit; pcr += t.credit; }
  console.log(`parsed Dr=${pdr} Cr=${pcr}`);
  // where does 2131400 come from
  const hits = p.transactions.filter(t => Math.abs(Math.abs(t.signedAmountRdcView) - 2131400) < 1);
  console.log(`rows of 2131400: ${hits.length}`); hits.forEach(t => console.log(`  row${t.sourceRow} ${t.date} ${t.voucherType} vno=${t.voucherNo} dr=${t.debit} cr=${t.credit}`));
  const big = p.transactions.filter(t => t.debit > 1000000); console.log(`big debits: ${big.length}`); big.forEach(t => console.log(`  row${t.sourceRow} ${t.date} ${t.voucherType} vno=${t.voucherNo} dr=${t.debit}`));
})();
