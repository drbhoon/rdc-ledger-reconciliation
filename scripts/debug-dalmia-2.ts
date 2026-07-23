/** Inspect WHY items are flagged in the Dalmia recon: possible-matches and
 * unmatched rows where the other side has an equal amount near in date. */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-210726');
(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC APP.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'DALMIA APP.xlsx'), 'CUSTOMER');
  const r = reconcile(rdc, cust, { partyName: 'Dalmia Cement', periodStart: '2023-05-01', periodEnd: '2026-07-22', invoiceTolerance: 2, paymentTolerance: 2, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  console.log(`verdict=${r.cards.verdict} matched=${r.matches.length} possible=${r.possibleMatches.length} unmatchedRdc=${r.unmatchedRdc.length} unmatchedCust=${r.unmatchedCustomer.length} coverage=${r.cards.matchedCoveragePct}%`);

  console.log('\n--- POSSIBLE MATCHES (flagged for human review), first 25 ---');
  for (const m of r.possibleMatches.slice(0, 25)) {
    console.log(`RDC[${m.rdcTxn?.date} ${m.rdcTxn?.voucherType} ref="${m.rdcTxn?.referenceNo}" ${m.rdcAmount}]  <->  CUST[${m.customerTxn?.date} ${m.customerTxn?.voucherType} ref="${m.customerTxn?.referenceNo}" ${m.customerAmount}]  conf=${m.confidence}  ${m.remarks?.slice(0, 60)}`);
  }

  console.log('\n--- UNMATCHED CUSTOMER (in period) with an equal-amount unmatched RDC row within 30d, first 30 ---');
  const urdc = r.unmatchedRdc.filter(m => m.rdcTxn && m.reasonCode !== 'OUTSIDE_PERIOD_PRESENT_IN_RDC');
  let shown = 0;
  for (const m of r.unmatchedCustomer) {
    const c = m.customerTxn; if (!c) continue;
    const amt = Math.abs(c.signedAmountRdcView);
    const cand = urdc.filter(u => Math.abs(Math.abs(u.rdcTxn!.signedAmountRdcView) - amt) <= 2 && c.date && u.rdcTxn!.date);
    if (!cand.length || shown >= 30) continue;
    shown++;
    console.log(`CUST ${c.date} ${c.voucherType} ref="${c.referenceNo}" vno="${c.voucherNo}" amt=${c.signedAmountRdcView}`);
    for (const u of cand.slice(0, 2)) console.log(`   ~ RDC ${u.rdcTxn!.date} ${u.rdcTxn!.voucherType} ref="${u.rdcTxn!.referenceNo}" amt=${u.rdcTxn!.signedAmountRdcView}`);
  }

  console.log('\n--- UNMATCHED RDC sample by reason (first 4 each) ---');
  const byReason = new Map<string, typeof urdc>();
  for (const m of r.unmatchedRdc) byReason.set(m.reasonCode || '?', [...(byReason.get(m.reasonCode || '?') || []), m]);
  for (const [reason, rows] of byReason) {
    console.log(`${reason}: ${rows.length} rows, net=${rows.reduce((s, x) => s + (x.difference || 0), 0).toFixed(2)}`);
    for (const m of rows.slice(0, 4)) console.log(`   ${m.rdcTxn?.date} ${m.rdcTxn?.voucherType} ref="${m.rdcTxn?.referenceNo}" amt=${m.rdcAmount}`);
  }
})();
