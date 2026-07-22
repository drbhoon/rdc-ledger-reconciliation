/** Diagnose the Rizwan Enterprises pair (customer PDF read 0 rows). */
import path from 'path';
import fs from 'fs';
import { extractRawText, parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-210726');
const PDF = path.join(DIR, 'Cust Ledger Rizwan Enterprises 30Jun26.pdf');
const XLS = path.join(DIR, 'RDC Ledger Rizwan Enterprise 30Jun26.xls');

(async () => {
  // 1. what text does the PDF give us at all?
  try {
    const raw = await extractRawText(PDF);
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    console.log(`PDF raw text: ${raw.length} chars, ${lines.length} non-empty lines`);
    console.log('--- first 40 lines ---');
    for (const l of lines.slice(0, 40)) console.log(JSON.stringify(l.slice(0, 160)));
    console.log('--- last 10 lines ---');
    for (const l of lines.slice(-10)) console.log(JSON.stringify(l.slice(0, 160)));
  } catch (e) {
    console.log('PDF raw text extraction THREW:', e instanceof Error ? e.message : e);
  }
  // 2. deterministic parse of both sides
  for (const [f, side] of [[PDF, 'CUSTOMER'], [XLS, 'RDC']] as const) {
    try {
      const p = await parseLedger(f, side);
      console.log(`\n${path.basename(f)} (${side}): rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
      for (const log of p.parserLog.slice(0, 10)) console.log(`  [${log.level}] ${log.message.slice(0, 140)}`);
      for (const t of p.transactions.slice(0, 5)) console.log(`  row: ${t.date} ${t.voucherType} ref=${t.referenceNo} dr=${t.debit} cr=${t.credit}`);
    } catch (e) {
      console.log(`\n${path.basename(f)} (${side}) THREW:`, e instanceof Error ? e.message : e);
    }
  }
  console.log('\nPDF size:', fs.statSync(PDF).size);
})();
