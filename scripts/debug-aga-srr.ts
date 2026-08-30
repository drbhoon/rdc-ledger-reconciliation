import path from 'path'; import fs from 'fs'; import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
const D = path.join(process.cwd(), 'test-data-300826');
(async () => {
  const aga = await parseLedger(path.join(D, 'AGA LEDGER.xlsx'), 'CUSTOMER');
  console.log('AGA first 4 parsed rows:');
  for (const t of aga.transactions.slice(0, 4)) console.log(`  type=${t.voucherType} alloc="${t.allocationType}" parent="${t.parentVoucherNo}" ref="${t.referenceNo}" particulars="${(t.particulars||'').slice(0,70)}"`);
  // SRR: the dateless orphan rows
  const wb = XLSX.read(fs.readFileSync(path.join(D, 'SRR LEDGER.xlsx')), { cellDates: true, type: 'buffer' });
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  let orphan = 0, orphanRows = 0;
  for (let i = 1; i <= 260; i++) { const r = m[i] as unknown[];
    const hasDate = String(r[4] ?? '').trim() !== '';
    const cr = Number(String(r[7] ?? '').replace(/,/g, '')) || 0, dr = Number(String(r[8] ?? '').replace(/,/g, '')) || 0;
    if (!hasDate && (cr || dr)) { orphan += dr - cr; orphanRows++; console.log(`  SRR orphan row ${i}: dr=${dr} cr=${cr}`); } }
  console.log(`SRR dateless money rows: ${orphanRows}, net debit ${orphan}`);
  const srr = await parseLedger(path.join(D, 'SRR LEDGER.xlsx'), 'CUSTOMER');
  console.log(`SRR parsed rows=${srr.transactions.length} opening=${srr.balances.opening} closing=${srr.balances.closing}`);
})();
