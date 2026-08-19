import path from 'path'; import fs from 'fs'; import * as XLSX from 'xlsx';
const files = process.argv.slice(2);
for (const f of files) {
  const wb = XLSX.read(fs.readFileSync(f), { cellDates: true, type: 'buffer' });
  for (const s of wb.SheetNames) {
    const ws = wb.Sheets[s];
    const ref = ws['!ref'];
    const origin = ref ? XLSX.utils.decode_range(ref).s.r : 0;
    console.log(`${path.basename(f)} :: "${s}" !ref=${ref} originRow=${origin}`);
  }
}
