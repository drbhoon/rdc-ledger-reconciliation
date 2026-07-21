/** Compare parsed dates: same rows from xlsx vs csv variants. */
import path from 'path';
import { parseLedger } from '../src/core/parser';

const DIR = path.join(process.cwd(), 'test-data-210726');
(async () => {
  for (const [file, side] of [['Balaji Ledger.xlsx', 'CUSTOMER'], ['Balaji Ledger.csv', 'CUSTOMER'], ['Balaji RDC Ledger.xlsx', 'RDC'], ['Balaji RDC Ledger.csv', 'RDC']] as const) {
    const p = await parseLedger(path.join(DIR, file), side);
    const sample = p.transactions.slice(0, 6).map(t => `${t.referenceNo || t.voucherNo}=${t.date}`).join('  ');
    const months = new Map<string, number>();
    for (const t of p.transactions) { const m = (t.date || 'none').slice(0, 7); months.set(m, (months.get(m) || 0) + 1); }
    console.log(`\n${file}: ${sample}`);
    console.log('  month histogram:', Object.fromEntries([...months.entries()].sort()));
  }
})();
