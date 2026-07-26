/** Pinpoint (a) RDC rows with no usable reference, (b) rows whose parsed amount
 * disagrees with the ledger's own CB running-balance column, (c) the reference
 * vocabulary on both sides. */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { parseAmount } from '../src/core/amount';

const DIR = path.join(process.cwd(), 'test-data-230726');

(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC SUROJ  LEDGER.xlsx'), 'RDC');
  const noRef = rdc.transactions.filter(t => !t.referenceNo);
  console.log(`RDC rows=${rdc.transactions.length}  withEmptyReference=${noRef.length}`);
  console.log('sample empty-ref rows:');
  for (const t of noRef.slice(0, 5)) console.log(`  ${t.date} ${t.voucherType} vno="${t.voucherNo}" refs=${JSON.stringify(t.extractedReferences)} amt=${t.signedAmountRdcView}`);
  const withRef = rdc.transactions.filter(t => t.referenceNo);
  console.log('sample with-ref rows (latest 8):');
  for (const t of withRef.slice(-8)) console.log(`  ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" norm="${t.normalizedReferenceNo}" amt=${t.signedAmountRdcView}`);

  // (b) audit against the ledger's own CB column
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, 'RDC SUROJ  LEDGER.xlsx')), { cellDates: true, type: 'buffer' });
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['RDC'], { header: 1, defval: '', raw: false });
  const HEADER = 8, CB = 12, DR = 10, CR = 11;
  let prev = parseAmount(String(m[9]?.[CB] ?? '0'));
  let mismatches = 0, netMismatch = 0;
  for (let i = 10; i < m.length; i++) {
    const row = m[i] as unknown[];
    const label = row.map(c => String(c ?? '')).join(' ');
    if (/Total of Debits|Customer Closing Balance/i.test(label)) continue;
    const cb = parseAmount(String(row[CB] ?? ''));
    if (!String(row[CB] ?? '').trim()) continue;
    const dr = Math.abs(parseAmount(String(row[DR] ?? '')));
    const cr = Math.abs(parseAmount(String(row[CR] ?? '')));
    const parsedSigned = dr - cr;
    const cbDelta = cb - prev;
    if (Math.abs(cbDelta - parsedSigned) > 1.5) {
      mismatches++; netMismatch += (cbDelta - parsedSigned);
      if (mismatches <= 12) console.log(`  ROW ${i + 1}: CBdelta=${cbDelta.toFixed(2)} parsed=${parsedSigned.toFixed(2)} diff=${(cbDelta - parsedSigned).toFixed(2)} | Dr="${row[DR]}" Cr="${row[CR]}" CB="${row[CB]}" type="${row[1]}" qty="${row[9]}"`);
    }
    prev = cb;
  }
  console.log(`CB-audit mismatched rows=${mismatches} net=${netMismatch.toFixed(2)}`);

  // (c) customer reference vocabulary from the raw columnar sheet
  const cwb = XLSX.read(fs.readFileSync(path.join(DIR, 'SUROJ LEDGER 2.xlsx')), { cellDates: true, type: 'buffer' });
  const cm = XLSX.utils.sheet_to_json<unknown[]>(cwb.Sheets['SUROJ'], { header: 1, defval: '', raw: false });
  console.log('\ncustomer Voucher Ref. No. samples (col 4), rows 2700-2721:');
  for (let i = 2700; i < Math.min(cm.length, 2722); i++) {
    const r = cm[i] as unknown[];
    console.log(`  [${i}] date="${r[0]}" vtype="${r[2]}" vno="${r[3]}" ref="${r[4]}" gross="${r[6]}"`);
  }
  const grossTotal = (cm[0] as unknown[])[6];
  console.log(`\nrow0 Gross Total (column total = closing) = "${grossTotal}"`);
  let sum = 0, dataRows = 0;
  for (let i = 2; i < cm.length; i++) { const g = parseAmount(String((cm[i] as unknown[])[6] ?? '')); if (g) { sum += g; dataRows++; } }
  console.log(`sum of Gross Total over data rows = ${sum.toFixed(2)} across ${dataRows} rows`);
  const vtypes = new Map<string, number>();
  for (let i = 2; i < cm.length; i++) { const v = String((cm[i] as unknown[])[2] ?? '').trim() || '(blank)'; vtypes.set(v, (vtypes.get(v) || 0) + 1); }
  console.log('customer voucher types:', Object.fromEntries(vtypes));
})();
