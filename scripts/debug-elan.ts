/** ELAN: invoice 3CH26ARMN233 shows a huge wrong amount in the reco output
 * though the customer ledger has it correctly. */
import path from 'path';
import { extractRawText, parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-240726');
const RDC = 'ELAN Chennai  ledger in RDC.xlsx';
const CUST = 'RDC ledger in ELAN Chennai.pdf';
const TARGET = '3CH26ARMN233';

(async () => {
  const raw = await extractRawText(path.join(DIR, CUST));
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log(`customer PDF: ${lines.length} lines`);
  console.log('--- lines mentioning the target ---');
  lines.forEach((l, i) => { if (l.includes('233') && /ARMN|MN233/i.test(l)) console.log(`[${i}] ${JSON.stringify(l.slice(0, 200))}`); });
  console.log('--- first 20 lines for layout ---');
  lines.slice(0, 20).forEach((l, i) => console.log(`[${i}] ${JSON.stringify(l.slice(0, 170))}`));

  const rdc = await parseLedger(path.join(DIR, RDC), 'RDC');
  const cust = await parseLedger(path.join(DIR, CUST), 'CUSTOMER');
  for (const [n, p] of [['RDC', rdc], ['CUST', cust]] as const) {
    console.log(`\n${n}: rows=${p.transactions.length} opening=${p.balances.opening} closing=${p.balances.closing} gap=${ledgerIntegrityGap(p)?.toFixed(2)}`);
    for (const l of p.parserLog.slice(0, 5)) console.log(`  [${l.level}] ${l.message.slice(0, 130)}`);
    const hits = p.transactions.filter(t => (t.referenceNo || '').includes('233') || (t.normalizedReferenceNo || '').includes('MN233'));
    for (const t of hits.slice(0, 6)) console.log(`  HIT ${t.date} ${t.voucherType} vno="${t.voucherNo}" ref="${t.referenceNo}" dr=${t.debit} cr=${t.credit} signed=${t.signedAmountRdcView} part="${(t.particulars || '').slice(0, 90)}"`);
  }

  const r = reconcile(rdc, cust, { partyName: 'ELAN', periodStart: '2026-04-01', periodEnd: '2026-07-23', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`\nverdict=${r.cards.verdict} matched=${r.matches.length} coverage=${r.cards.matchedCoveragePct}%`);
  const all = [...r.matches, ...r.unmatchedRdc, ...r.unmatchedCustomer, ...r.possibleMatches];
  for (const m of all.filter(m => `${m.rdcTxn?.referenceNo} ${m.customerTxn?.referenceNo}`.includes(TARGET))) {
    console.log(`  ${m.matchStatus} ${m.reasonCode || ''} RDC[${m.rdcTxn?.date} ${m.rdcTxn?.voucherType} ${m.rdcAmount}] CUST[${m.customerTxn?.date} ${m.customerTxn?.voucherType} ${m.customerAmount}] diff=${m.difference} :: ${m.remarks?.slice(0, 70)}`);
  }
  for (const l of r.summaryLines) console.log(`  ${l.sign || ''} ${l.particular}  ${(l.amount || 0).toLocaleString('en-IN')}`);
})();
