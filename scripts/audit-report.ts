/** Run the row-level parse audit across every ledger we hold locally.
 * False positives here would be worse than no audit, so this must be clean.
 * Run: npx tsx scripts/audit-report.ts */
import path from 'path';
import fs from 'fs';
import { parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';

const ROOT = process.cwd();
const FILES: Array<[string, 'RDC' | 'CUSTOMER']> = [
  ['test-data/RDC vs Talib/RDC Ledger.xlsx', 'RDC'],
  ['test-data/RDC vs Talib/Talib_Customer Ledger.xlsx', 'CUSTOMER'],
  ['test-data/RDC vs Synergia/RDC_ Synergia Ledger.xlsx', 'RDC'],
  ['test-data/RDC vs Synergia/Customer_ Synergia Ledger.pdf', 'CUSTOMER'],
  ['test-data/RDC vs Maland/RDC_Debtors_Ledger_Excel_Repor_010726_Maland.xlsx', 'RDC'],
  ['test-data/RDC vs Maland/Malnad Project Ledger.pdf', 'CUSTOMER'],
  ['Elite - RDC Ledger.xlsx', 'RDC'],
  ['elite - customer - ledger.pdf', 'CUSTOMER'],
  ['Pratha Constructions -rdc ledger.xlsx', 'RDC'],
  ['Pratha Constructions -customer ledger.xlsx', 'CUSTOMER'],
  ['Suruchi Developers- RDC Ledger.xlsx', 'RDC'],
  ['Suruchi Developers -customer Ledger.xlsx', 'CUSTOMER'],
  ['bearys - RDC -ledger.xlsx', 'RDC'],
  ['beays  - customer-ledger.xlsx', 'CUSTOMER'],
  ['test-data-210726/Balaji RDC Ledger.xlsx', 'RDC'],
  ['test-data-210726/Balaji Ledger.xlsx', 'CUSTOMER'],
  ['test-data-210726/RDC APP.xlsx', 'RDC'],
  ['test-data-210726/DALMIA APP.xlsx', 'CUSTOMER'],
  ['test-data-230726/RDC SUROJ  LEDGER.xlsx', 'RDC'],
  ['test-data-230726/SUROJ LEDGER 2.xlsx', 'CUSTOMER'],
  ['test-data-240726/RDC ledger Dalmia Chennai.xlsx', 'RDC'],
  ['test-data-240726/vendor kedger  dalmia chennai.PDF', 'CUSTOMER'],
  ['test-data-240726/ELAN Chennai  ledger in RDC.xlsx', 'RDC'],
];

(async () => {
  let pass = 0, fail = 0, notVerifiable = 0;
  console.log('FILE'.padEnd(52) + 'SIDE'.padEnd(10) + 'VERDICT'.padEnd(17) + 'CHECKED  ISSUES  DETAIL');
  console.log('─'.repeat(140));
  for (const [rel, side] of FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { console.log(`${rel.slice(-50).padEnd(52)}(missing)`); continue; }
    try {
      const parsed = await parseLedger(file, side);
      const a = auditLedger(parsed, side);
      if (a.verdict === 'PASS') pass++; else if (a.verdict === 'FAIL') fail++; else notVerifiable++;
      const detail = a.issues.length
        ? `worst delta ${Math.max(...a.issues.map(i => Math.abs(i.delta))).toFixed(2)} @ row ${a.issues[0].sourceRow}`
        : (a.debitTotalGap != null ? `totals gap Dr ${a.debitTotalGap.toFixed(2)} Cr ${(a.creditTotalGap ?? 0).toFixed(2)}` : (a.integrityGap != null ? `closing gap ${a.integrityGap.toFixed(2)}` : ''));
      console.log(`${path.basename(rel).slice(0, 50).padEnd(52)}${side.padEnd(10)}${a.verdict.padEnd(17)}${String(a.rowsChecked).padEnd(9)}${String(a.issues.length).padEnd(8)}${detail}`);
    } catch (e) {
      console.log(`${path.basename(rel).slice(0, 50).padEnd(52)}${side.padEnd(10)}ERROR  ${e instanceof Error ? e.message.slice(0, 60) : e}`);
    }
  }
  console.log('─'.repeat(140));
  console.log(`PASS ${pass}   FAIL ${fail}   NOT_VERIFIABLE ${notVerifiable}`);
})();
