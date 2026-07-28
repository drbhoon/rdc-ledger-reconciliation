/** Dalmia Chennai: customer PDF timed out in AI text rescue -> needs a
 * deterministic adapter. First see what text the PDF actually yields. */
import path from 'path';
import { extractRawText, parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-240726');
const PDF = path.join(DIR, 'vendor kedger  dalmia chennai.PDF');
const XLS = path.join(DIR, 'RDC ledger Dalmia Chennai.xlsx');

(async () => {
  const raw = await extractRawText(PDF);
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log(`PDF text: ${raw.length} chars, ${lines.length} non-empty lines`);
  console.log('--- first 45 lines ---');
  lines.slice(0, 45).forEach((l, i) => console.log(`[${i}] ${JSON.stringify(l.slice(0, 190))}`));
  console.log('--- lines 200-225 ---');
  lines.slice(200, 225).forEach((l, i) => console.log(`[${200 + i}] ${JSON.stringify(l.slice(0, 190))}`));
  console.log('--- last 12 lines ---');
  lines.slice(-12).forEach((l, i) => console.log(`[${lines.length - 12 + i}] ${JSON.stringify(l.slice(0, 190))}`));

  for (const [f, side] of [[PDF, 'CUSTOMER'], [XLS, 'RDC']] as const) {
    const p = await parseLedger(f, side);
    console.log(`\n${path.basename(f)} (${side}): rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
    for (const l of p.parserLog.slice(0, 6)) console.log(`  [${l.level}] ${l.message.slice(0, 130)}`);
    for (const t of p.transactions.slice(0, 5)) console.log(`  ${t.date} ${t.voucherType} ref="${t.referenceNo}" dr=${t.debit} cr=${t.credit}`);
  }
})();
