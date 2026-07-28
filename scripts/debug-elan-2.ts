/** Read the team's own reco output for ELAN and find 3CH26ARMN233. */
import fs from 'fs';
import * as XLSX from 'xlsx';
const OUT = './test-data-240726/elan reco output.xlsx';
const RDCF = './test-data-240726/ELAN Chennai  ledger in RDC.xlsx';
const TARGET = 'ARMN233';

const wb = XLSX.read(fs.readFileSync(OUT), { cellDates: true, type: 'buffer' });
console.log('sheets:', wb.SheetNames.join(', '));
for (const sn of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sn], { defval: '', raw: true });
  const hits = rows.filter(r => Object.values(r).some(v => String(v).includes(TARGET)));
  if (!hits.length) continue;
  console.log(`\n=== ${sn}: ${hits.length} row(s) mentioning ${TARGET}`);
  for (const h of hits.slice(0, 4)) {
    for (const [k, v] of Object.entries(h)) if (String(v).trim()) console.log(`   ${k}: ${String(v).slice(0, 90)}`);
    console.log('   ---');
  }
}
// summary sheet
for (const sn of wb.SheetNames.filter(s => /summary|reco|certificate/i.test(s))) {
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '', raw: true });
  console.log(`\n=== ${sn} (first 18 rows)`);
  m.slice(0, 18).forEach(r => console.log('   ' + JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 40)))));
}
// RDC source row
const rwb = XLSX.read(fs.readFileSync(RDCF), { cellDates: true, type: 'buffer' });
for (const sn of rwb.SheetNames) {
  const m = XLSX.utils.sheet_to_json<unknown[]>(rwb.Sheets[sn], { header: 1, defval: '', raw: true });
  console.log(`\n=== RDC source "${sn}" header + target rows`);
  console.log('   H ' + JSON.stringify((m[8] as unknown[] || m[0] as unknown[]).map(c => String(c).slice(0, 22))));
  m.forEach((r, i) => { if ((r as unknown[]).some(c => String(c).includes(TARGET))) console.log(`   [${i}] ` + JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 22)))); });
  console.log('   tail:');
  m.slice(-3).forEach((r, i) => console.log(`   [${m.length - 3 + i}] ` + JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 22)))));
}
