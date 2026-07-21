/**
 * Debug the team's 2026-07-21 Balaji files (Jan-Apr 2026 period) that produced
 * "upstream error" on Railway. Runs the deterministic pipeline only (AI off).
 * Run: npx tsx scripts/debug-balaji-jan26.ts
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-210726');

async function inspect(file: string, side: 'RDC' | 'CUSTOMER') {
  const t0 = Date.now();
  try {
    const parsed = await parseLedger(path.join(DIR, file), side);
    const gap = ledgerIntegrityGap(parsed);
    console.log(`\n=== ${file} (${side}) — ${Date.now() - t0}ms`);
    console.log(`rows=${parsed.transactions.length} opening=${parsed.balances.opening} closing=${parsed.balances.closing} integrityGap=${gap?.toFixed(2)}`);
    for (const log of parsed.parserLog.slice(0, 8)) console.log(`  [${log.level}] ${log.message}`);
    const types = new Map<string, number>();
    for (const t of parsed.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
    console.log('  voucher types:', Object.fromEntries(types));
    return parsed;
  } catch (e) {
    console.log(`\n=== ${file} (${side}) — THREW after ${Date.now() - t0}ms:`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

async function pair(label: string, rdcFile: string, custFile: string) {
  console.log(`\n########## ${label} ##########`);
  const rdc = await inspect(rdcFile, 'RDC');
  const cust = await inspect(custFile, 'CUSTOMER');
  if (!rdc || !cust || !rdc.transactions.length || !cust.transactions.length) {
    console.log(`>>> ${label}: cannot reconcile (a side is empty) — this is where AI rescue would fire in prod`);
    return;
  }
  const t0 = Date.now();
  const result = reconcile(rdc, cust, { partyName: 'Balajee Infratech', periodStart: '2026-01-01', periodEnd: '2026-04-03', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\n>>> ${label} reconciled in ${Date.now() - t0}ms — verdict=${result.cards.verdict} certified=${result.cards.certified}`);
  console.log(`matched=${result.matches.length} unmatchedRdc=${result.unmatchedRdc.length} unmatchedCust=${result.unmatchedCustomer.length} coverage=${result.cards.matchedCoveragePct}%`);
  for (const l of result.summaryLines) console.log(`  ${l.sign ?? ''}  ${l.particular}  ${l.amount?.toLocaleString('en-IN')}  ${l.remarks ?? ''}`);
}

(async () => {
  await pair('XLSX PAIR', 'Balaji RDC Ledger.xlsx', 'Balaji Ledger.xlsx');
  await pair('CSV PAIR', 'Balaji RDC Ledger.csv', 'Balaji Ledger.csv');
})();
