/** Diagnose the Indogrid pair (74-page customer PDF, both rescues failed). */
import path from 'path';
import { extractRawText, parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-210726');
const PDF = path.join(DIR, 'Customer The Indogrid 30Jun26.pdf');
const XLS = path.join(DIR, 'RDC Th eindogrid Infra 30Jun26.xls');

(async () => {
  try {
    const raw = await extractRawText(PDF);
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    console.log(`PDF raw text: ${raw.length} chars, ${lines.length} non-empty lines`);
    console.log('--- first 30 lines ---');
    for (const l of lines.slice(0, 30)) console.log(JSON.stringify(l.slice(0, 170)));
    console.log('--- middle 12 lines ---');
    for (const l of lines.slice(Math.floor(lines.length / 2), Math.floor(lines.length / 2) + 12)) console.log(JSON.stringify(l.slice(0, 170)));
    console.log('--- last 8 lines ---');
    for (const l of lines.slice(-8)) console.log(JSON.stringify(l.slice(0, 170)));
  } catch (e) {
    console.log('extractRawText THREW:', e instanceof Error ? e.message : e);
  }
  for (const [f, side] of [[PDF, 'CUSTOMER'], [XLS, 'RDC']] as const) {
    try {
      const p = await parseLedger(f, side);
      console.log(`\n${path.basename(f)} (${side}): rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
      for (const log of p.parserLog.slice(0, 8)) console.log(`  [${log.level}] ${log.message.slice(0, 140)}`);
      const types = new Map<string, number>();
      for (const t of p.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
      console.log('  types:', Object.fromEntries(types));
      for (const t of p.transactions.slice(0, 4)) console.log(`  row: ${t.date} ${t.voucherType} ref=${t.referenceNo} dr=${t.debit} cr=${t.credit}`);
    } catch (e) {
      console.log(`\n${path.basename(f)} (${side}) THREW:`, e instanceof Error ? e.message : e);
    }
  }
})();
