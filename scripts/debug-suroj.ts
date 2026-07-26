/** Audit the Suroj pair against the team's manual recon.
 * Manual truth: closing as per SUROJ 7,06,201 ; closing as per RDC 25,750 ; DIFF -6,80,450.
 */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-230726');
const RDC = 'RDC SUROJ  LEDGER.xlsx';
const CUST = 'SUROJ LEDGER 2.xlsx';

function dumpStructure(file: string) {
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, file)), { cellDates: true, type: 'buffer' });
  console.log(`\n########## ${file}: sheets=${JSON.stringify(wb.SheetNames)}`);
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '', raw: false });
    console.log(`--- "${sn}": ${rows.length} rows`);
    rows.slice(0, 14).forEach((r, i) => console.log(`  [${i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 26)))}`));
    console.log('  ...tail:');
    rows.slice(-6).forEach((r, i) => console.log(`  [${rows.length - 6 + i}] ${JSON.stringify((r as unknown[]).map(c => String(c).slice(0, 26)))}`));
  }
}

(async () => {
  dumpStructure(RDC);
  dumpStructure(CUST);

  const rdc = await parseLedger(path.join(DIR, RDC), 'RDC');
  const cust = await parseLedger(path.join(DIR, CUST), 'CUSTOMER');
  for (const [label, p] of [['RDC', rdc], ['CUSTOMER', cust]] as const) {
    console.log(`\n=== ${label}: rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
    for (const l of p.parserLog.slice(0, 10)) console.log(`  [${l.level}] ${l.message.slice(0, 150)}`);
    const types = new Map<string, number>();
    for (const t of p.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
    console.log('  types:', Object.fromEntries(types));
    const sum = p.transactions.reduce((s, t) => s + t.signedAmountRdcView, 0);
    console.log(`  Σsigned=${sum.toFixed(2)}  (opening+Σ=${((p.balances.opening || 0) + sum).toFixed(2)})`);
    for (const t of p.transactions.slice(0, 6)) console.log(`  row ${t.sourceRow}: ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" dr=${t.debit} cr=${t.credit}`);
  }

  // duplicate reference detection on both sides (team asks for this explicitly)
  for (const [label, p] of [['RDC', rdc], ['CUSTOMER', cust]] as const) {
    const byRef = new Map<string, number>();
    for (const t of p.transactions) { const k = t.normalizedReferenceNo || ''; if (k) byRef.set(k, (byRef.get(k) || 0) + 1); }
    const dups = [...byRef.entries()].filter(([, n]) => n > 1);
    console.log(`\n${label} duplicate references: ${dups.length} (top: ${dups.slice(0, 6).map(([k, n]) => `${k}x${n}`).join(', ')})`);
  }

  const r = reconcile(rdc, cust, { partyName: 'SUROJ', periodStart: '2010-04-01', periodEnd: '2026-03-31', invoiceTolerance: 2, paymentTolerance: 2, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\n>>> verdict=${r.cards.verdict} matched=${r.matches.length} possible=${r.possibleMatches.length} unmatchedRdc=${r.unmatchedRdc.length} unmatchedCust=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
  for (const l of r.summaryLines) console.log(`  ${l.sign ?? ''}  ${l.particular}  ${l.amount?.toLocaleString('en-IN')}`);
  console.log('\n--- worst matched variances (top 12 by |difference|) ---');
  for (const m of [...r.matches].sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0)).slice(0, 12)) {
    console.log(`  diff=${(m.difference || 0).toFixed(2)} conf=${m.confidence} RDC[${m.rdcTxn?.date} ${m.rdcTxn?.voucherType} ref="${m.rdcTxn?.referenceNo}" ${m.rdcAmount}] CUST[${m.customerTxn?.date} ${m.customerTxn?.voucherType} ref="${m.customerTxn?.referenceNo}" ${m.customerAmount}] ${m.remarks?.slice(0, 50)}`);
  }
  console.log('\n--- RDC receipts and whether matched ---');
  const recs = rdc.transactions.filter(t => ['RECEIPT', 'REVERSAL'].includes(t.voucherType));
  const matchedRdcIds = new Set(r.matches.map(m => m.rdcTxn?.id));
  console.log(`  RDC receipts=${recs.length} matched=${recs.filter(t => matchedRdcIds.has(t.id)).length} total=${recs.reduce((s, t) => s + t.signedAmountRdcView, 0).toFixed(2)}`);
  for (const t of recs.filter(t => !matchedRdcIds.has(t.id)).slice(0, 10)) console.log(`  UNMATCHED RECEIPT ${t.date} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView}`);
  const custPays = cust.transactions.filter(t => ['PAYMENT', 'RECEIPT'].includes(t.voucherType));
  console.log(`  CUST payments=${custPays.length} total=${custPays.reduce((s, t) => s + t.signedAmountRdcView, 0).toFixed(2)}`);
  for (const t of custPays.slice(0, 10)) console.log(`  CUST PAY ${t.date} vno="${t.voucherNo}" ref="${t.referenceNo}" amt=${t.signedAmountRdcView} alloc=${t.allocationType} parent=${t.parentVoucherNo}`);
})();
