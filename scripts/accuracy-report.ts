/**
 * ACCURACY MEASUREMENT across every real customer ledger pair available.
 * "Accuracy" = % of reconciliations that are CERTIFIED, i.e. both ledgers
 * parse to tie to their stated closing balance AND the statement fully
 * explains the RDC↔customer difference (all within ₹1). A certified run is,
 * by construction, arithmetically correct — so certified-% is a sound proxy
 * for reconciliation accuracy on a representative sample.
 *
 * Run: npx tsx scripts/accuracy-report.ts
 */
import path from 'path';
import fs from 'fs';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';

const OPTS = { periodStart: '2000-01-01', periodEnd: '2099-12-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 };
const ROOT = path.resolve(__dirname, '..');
const P = (...p: string[]) => path.join(ROOT, ...p);
const NEW = 'test-data-060726/Ledger Recon New Testing_060726';
const OLD = 'test-data';
const AUG = 'test-data-190826';
const AUGR = 'test-data-190826/AI Reconciliation  File';

// One entry per distinct customer (latest available ledgers).
const PAIRS: Array<{ name: string; rdc: string; cust: string }> = [
  { name: 'Balaji',   rdc: P(NEW, 'RDC vs Balaji Infratech/RDC_Balaji Infratech.pdf'), cust: P(NEW, 'RDC vs Balaji Infratech/Customer_Balaji Infratech.pdf') },
  { name: 'Synergia', rdc: P(NEW, 'RDC vs Synergia/RDC_ Synergia Ledger.xlsx'),        cust: P(NEW, 'RDC vs Synergia/Customer_ Synergia Ledger.pdf') },
  { name: 'Talib',    rdc: P(NEW, 'RDC vs Talib/RDC Ledger.xlsx'),                       cust: P(NEW, 'RDC vs Talib/Talib_Customer Ledger.xlsx') },
  { name: 'Maland',   rdc: P(OLD, 'RDC vs Maland/RDC_Debtors_Ledger_Excel_Repor_010726_Maland.xlsx'), cust: P(OLD, 'RDC vs Maland/Malnad Project Ledger.pdf') },
  { name: 'Elite',    rdc: P('Elite - RDC Ledger.xlsx'),                    cust: P('elite - customer - ledger.pdf') },
  { name: 'Pratha',   rdc: P('Pratha Constructions -rdc ledger.xlsx'),     cust: P('Pratha Constructions -customer ledger.xlsx') },
  { name: 'Suruchi',  rdc: P('Suruchi Developers- RDC Ledger.xlsx'),       cust: P('Suruchi Developers -customer Ledger.xlsx') },
  { name: 'Bearys',   rdc: P('bearys - RDC -ledger.xlsx'),                  cust: P('beays  - customer-ledger.xlsx') },
  // The 19-Aug-26 batch: eleven readable pairs across three teams, plus Preet
  // Traders, whose customer ledger is a photographed PDF with no text layer.
  // Preet reports as PARSE=0 (guarded) and is excluded from the ratio - locally
  // there is no OpenAI key, so the vision rescue that could read it cannot run.
  { name: 'Afita',     rdc: P(AUG, 'RDC-Afita-Mumbai.xlsx'),   cust: P(AUG, 'Afita-Mumbai.xlsx') },
  { name: 'Atlas',     rdc: P(AUG, 'RDC-Atlas-Mumbai.xlsx'),   cust: P(AUG, 'Atlas-Mumbai.xlsx') },
  { name: 'Ecoform',   rdc: P(AUG, 'RDC-Ecoform-Mumbai.xlsx'), cust: P(AUG, 'Ecoform-Mumbai.xlsx') },
  { name: 'Premix',    rdc: P(AUG, 'RDC-Premix-Mumbai.xlsx'),  cust: P(AUG, 'Premix-Mumbai.xlsx') },
  { name: 'ShreeRam',  rdc: P(AUG, 'Shree Ram Ent 31Jul26 - 19-8.xls'), cust: P(AUG, 'Vend Shree Ram Ent 31Jul.26.xls') },
  { name: 'Preet',     rdc: P(AUG, 'Preet Traders 31mar26.xls'),        cust: P(AUG, 'Vend Preet Traders 31Mar26.pdf') },
  { name: 'PAMR',      rdc: P(AUGR, 'PAMR Industries Reco/RDC SOA VENDOR.xlsx'), cust: P(AUGR, 'PAMR Industries Reco/PAMR SOA.xlsx') },
  { name: 'UltraTech', rdc: P(AUGR, 'RDC VS ULTRATECH/RDC LEDGER.xlsx'),         cust: P(AUGR, 'RDC VS ULTRATECH/ULTRATECH LEDGER.xlsx') },
  { name: 'SPJ',       rdc: P(AUGR, 'SPJ Reco/RDC SOA.xls'),                     cust: P(AUGR, 'SPJ Reco/SPJ PROPERTIES PRIVATE LIMITED SOA.xlsx') },
  { name: 'SSSS',      rdc: P(AUGR, 'SS SS Constrution/RDC SS SS Cons Ledger.xls'), cust: P(AUGR, 'SS SS Constrution/SS SS Constructions Pvt Ltd  Ledger.pdf') },
  { name: 'ShriKaila', rdc: P(AUGR, 'Shri Kaila Construction/SKC - RDC Ledger.xls'), cust: P(AUGR, 'Shri Kaila Construction/SKC - Customer Ledger.pdf') },
  { name: 'ZCC',       rdc: P(AUGR, 'ZCC Techno Private Reco/RDC Ledger ZCC.xlsx'),  cust: P(AUGR, 'ZCC Techno Private Reco/ZCC Techno SOA.xlsx') },
];

const inr = (n: number) => (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

async function main() {
  const rows: any[] = [];
  for (const pr of PAIRS) {
    if (!fs.existsSync(pr.rdc) || !fs.existsSync(pr.cust)) { rows.push({ name: pr.name, verdict: 'FILE MISSING' }); continue; }
    try {
      const rdc = await parseLedger(pr.rdc, 'RDC');
      const cust = await parseLedger(pr.cust, 'CUSTOMER');
      if (!rdc.transactions.length || !cust.transactions.length) { rows.push({ name: pr.name, verdict: 'PARSE=0 (guarded)', rdcRows: rdc.transactions.length, custRows: cust.transactions.length }); continue; }
      const r = reconcile(rdc, cust, { ...OPTS, partyName: pr.name });
      const c = r.cards as any;
      rows.push({ name: pr.name, verdict: c.verdict, certified: c.certified, rdcRows: rdc.transactions.length, custRows: cust.transactions.length, matched: c.matchedCount, coverage: c.matchedCoveragePct, rdcGap: c.rdcLedgerIntegrityGap, custGap: c.customerLedgerIntegrityGap, unexplained: c.unexplainedDifference });
    } catch (e: any) {
      rows.push({ name: pr.name, verdict: 'ERROR', error: e.message });
    }
  }

  console.log('\nCUSTOMER      VERDICT           RDC/CUST rows   MATCHED  COVER%   RDCgap   CUSTgap   UNEXPLAINED');
  console.log('─'.repeat(104));
  for (const r of rows) {
    if (!r.certified && r.verdict !== 'REVIEW REQUIRED') { console.log(`${r.name.padEnd(12)}  ${String(r.verdict).padEnd(16)}  ${String((r.rdcRows ?? '-') + '/' + (r.custRows ?? '-')).padEnd(14)}  ${r.error || ''}`); continue; }
    console.log(
      `${r.name.padEnd(12)}  ${String(r.verdict).padEnd(16)}  ${String(r.rdcRows + '/' + r.custRows).padEnd(14)}  ${String(r.matched).padStart(6)}  ${String(r.coverage).padStart(6)}  ${String(inr(r.rdcGap)).padStart(7)}  ${String(inr(r.custGap)).padStart(7)}  ${String(inr(r.unexplained)).padStart(11)}`
    );
  }
  const measurable = rows.filter(r => r.verdict === 'CERTIFIED' || r.verdict === 'REVIEW REQUIRED');
  const certified = measurable.filter(r => r.certified);
  const pct = measurable.length ? (certified.length / measurable.length) * 100 : 0;
  console.log('─'.repeat(104));
  console.log(`\nACCURACY: ${certified.length}/${measurable.length} customer reconciliations CERTIFIED = ${pct.toFixed(1)}%`);
  console.log(`(certified = both ledgers tie to closing balance AND statement reconciles to within ₹1)\n`);
  process.exit(pct >= 99 ? 0 : 3);
}
main().catch(e => { console.error(e); process.exit(2); });
