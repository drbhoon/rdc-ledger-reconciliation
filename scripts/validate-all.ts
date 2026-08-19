/**
 * Runs every regression suite, the accuracy report and the parse audit in one
 * go, and prints a single verdict. This is the gate before any deploy.
 *
 *   npm run validate
 *
 * Suites whose (gitignored) customer data is not present are reported as
 * SKIPPED rather than failed, so the command still works on a fresh clone.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

type Suite = { name: string; script: string; args?: string[]; needs?: string };
const SUITES: Suite[] = [
  { name: 'Round 1-3  Balaji / Malan / Synergia / Talib', script: 'validate-fixes.ts', args: ['./test-data'], needs: 'test-data' },
  { name: 'Round 2-3  retest set (060726)', script: 'validate-fixes-2.ts', args: ['./test-data-060726/Ledger Recon New Testing_060726'], needs: 'test-data-060726' },
  { name: 'Round 6    Balajee Jan-26 (xlsx + csv)', script: 'validate-fixes-3.ts', needs: 'test-data-210726' },
  { name: 'Round 7-8  Dalmia (vendor / payable)', script: 'validate-fixes-4.ts', needs: 'test-data-210726' },
  { name: 'Round 9    Suroj (columnar register)', script: 'validate-fixes-5.ts', needs: 'test-data-230726' },
  { name: 'Round 10   Dalmia Chennai + ELAN guard', script: 'validate-fixes-6.ts', needs: 'test-data-240726' },
  { name: 'Round 12   Lotus Villa (Tally ledger PDF)', script: 'validate-fixes-7.ts', needs: 'test-data-250726' },
  { name: 'Round 13   Senghani (split vouchers)', script: 'validate-fixes-8.ts', needs: 'test-data-250726' },
  { name: 'Round 14   AFA (invoice register)', script: 'validate-fixes-9.ts', needs: 'test-data-260726' },
  { name: 'Round 15   Mosh (reconciliation workbook)', script: 'validate-fixes-10.ts', needs: 'test-data-270726' },
  { name: 'Round 16   Henna (stated closing balance)', script: 'validate-fixes-11.ts', needs: 'test-data-280726' },
  { name: 'Round 17   19-Aug batch (12 pairs)', script: 'validate-fixes-12.ts', needs: 'test-data-190826' },
  { name: 'AI rescue  (offline, no API calls)', script: 'validate-rescue.ts' },
  { name: 'Usage log  (offline, no database)', script: 'validate-usage.ts' },
];

const root = process.cwd();
// shell:true is needed for npx on Windows, which means arguments containing
// spaces (the 060726 data folder) have to be quoted explicitly.
const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
const run = (script: string, args: string[] = []) =>
  spawnSync('npx', ['tsx', quote(path.join('scripts', script)), ...args.map(quote)], { cwd: root, encoding: 'utf8', shell: true });

let totalPassed = 0, totalFailed = 0, skipped = 0;
const failures: string[] = [];

console.log('='.repeat(78));
console.log('RDC Ledger Reconciliation — full validation');
console.log('='.repeat(78));

for (const suite of SUITES) {
  if (suite.needs && !fs.existsSync(path.join(root, suite.needs))) {
    console.log(`SKIP  ${suite.name}  (data folder ${suite.needs}/ not present)`);
    skipped += 1;
    continue;
  }
  const result = run(suite.script, suite.args);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const tally = output.match(/====\s*(\d+) passed,\s*(\d+) failed\s*====/);
  const passed = tally ? Number(tally[1]) : 0;
  const failed = tally ? Number(tally[2]) : (result.status === 0 ? 0 : 1);
  totalPassed += passed; totalFailed += failed;
  console.log(`${failed ? 'FAIL' : 'PASS'}  ${suite.name.padEnd(46)} ${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed) {
    failures.push(suite.name);
    output.split(/\r?\n/).filter(l => l.startsWith('FAIL')).forEach(l => console.log(`        ${l}`));
  }
}

// Measured accuracy across the reference customers
const accuracy = run('accuracy-report.ts');
const accuracyLine = `${accuracy.stdout || ''}`.split(/\r?\n/).find(l => l.includes('ACCURACY:')) || 'ACCURACY: not available';
// Parse audit across every ledger we hold
const audit = run('audit-report.ts');
const auditLine = `${audit.stdout || ''}`.split(/\r?\n/).find(l => /^PASS \d+/.test(l)) || 'parse audit: not available';

console.log('-'.repeat(78));
console.log(accuracyLine.trim());
console.log(`Parse audit across all local ledgers: ${auditLine.trim()}`);
console.log('-'.repeat(78));
console.log(`${totalPassed} checks passed, ${totalFailed} failed, ${skipped} suite(s) skipped`);
if (failures.length) {
  console.log(`\nFAILED SUITES:\n  - ${failures.join('\n  - ')}`);
  console.log('\nDo not deploy until these pass.');
}
console.log('='.repeat(78));
process.exit(totalFailed ? 1 : 0);
