/** Lotus Villa: manual reco says only TWO invoices are unbooked
 * (4KL25BP3-1492 and 4KL25BP1-1675, 26,921.70 each). The app reported 45
 * unmatched RDC invoices — so matching is failing. Compare the references. */
import path from 'path';
import { extractRawText, parseLedger } from '../src/core/parser';
import { auditLedger, describeAudit } from '../src/core/audit';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-250726');
const RDC = 'Lotus Villa RDC Ledger 6-6-26.xlsx';
const CUST = 'Lotus Client Ledger 6-6-26.pdf';

(async () => {
  const raw = await extractRawText(path.join(DIR, CUST));
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log(`customer PDF text: ${raw.length} chars, ${lines.length} lines`);
  lines.slice(0, 30).forEach((l, i) => console.log(`[${i}] ${JSON.stringify(l.slice(0, 175))}`));

  const rdc = await parseLedger(path.join(DIR, RDC), 'RDC');
  const cust = await parseLedger(path.join(DIR, CUST), 'CUSTOMER');
  for (const [n, p] of [['RDC', rdc], ['CUST', cust]] as const) {
    const a = auditLedger(p, n === 'RDC' ? 'RDC' : 'CUSTOMER');
    console.log(`\n${n}: rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
    console.log(`  audit: ${describeAudit(a)}`);
    for (const l of p.parserLog.slice(0, 6)) console.log(`  [${l.level}] ${l.message.slice(0, 130)}`);
    const types = new Map<string, number>();
    for (const t of p.transactions) types.set(t.voucherType, (types.get(t.voucherType) || 0) + 1);
    console.log('  types:', Object.fromEntries(types));
    console.log('  first refs:', p.transactions.slice(0, 12).map(t => `${t.referenceNo}|${t.normalizedReferenceNo}=${t.signedAmountRdcView}`).join('  '));
  }

  // the two invoices the team says are genuinely unbooked
  for (const target of ['1492', '1675']) {
    console.log(`\n--- rows mentioning ${target} ---`);
    for (const [n, p] of [['RDC', rdc], ['CUST', cust]] as const)
      for (const t of p.transactions.filter(t => `${t.referenceNo} ${t.narration}`.includes(target)))
        console.log(`  ${n} ${t.date} ${t.voucherType} ref="${t.referenceNo}" norm="${t.normalizedReferenceNo}" amt=${t.signedAmountRdcView}`);
  }

  const r = reconcile(rdc, cust, { partyName: 'Lotus Villa Pvt. Ltd.', periodStart: '2025-04-01', periodEnd: '2026-06-06', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\nverdict=${r.cards.verdict} matched=${r.matches.length} unmatchedRdc=${r.unmatchedRdc.length} unmatchedCust=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);
  for (const l of r.summaryLines) console.log(`  ${l.sign || ''} ${l.particular}  ${(l.amount || 0).toLocaleString('en-IN')}`);
  console.log('\n--- sample unmatched RDC invoices (should be only 2) ---');
  for (const m of r.unmatchedRdc.slice(0, 10)) console.log(`  ${m.rdcTxn?.date} ${m.rdcTxn?.voucherType} ref="${m.rdcTxn?.referenceNo}" norm="${m.rdcTxn?.normalizedReferenceNo}" amt=${m.rdcAmount}`);
  console.log('--- sample unmatched CUSTOMER invoices ---');
  for (const m of r.unmatchedCustomer.slice(0, 10)) console.log(`  ${m.customerTxn?.date} ${m.customerTxn?.voucherType} ref="${m.customerTxn?.referenceNo}" norm="${m.customerTxn?.normalizedReferenceNo}" amt=${m.customerAmount}`);
})();
