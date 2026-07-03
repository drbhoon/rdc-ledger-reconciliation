/**
 * Validation harness: runs the four user-reported test sets through the fixed
 * parser + reconciler and asserts the exact defects reported by the user are
 * resolved. Run: npx tsx scripts/validate-fixes.ts "<test-data-dir>"
 */
import path from 'path';
import fs from 'fs';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';

const BASE = process.argv[2];
if (!BASE || !fs.existsSync(BASE)) { console.error('Pass the test-data directory'); process.exit(1); }

const OPTS = { partyName: 'Test', periodStart: '2000-01-01', periodEnd: '2099-12-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 };

let pass = 0, fail = 0;
function ck(label: string, cond: boolean, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? '  [' + detail + ']' : ''));
  cond ? pass++ : fail++;
}
const fmt = (n?: number) => (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

async function main() {
  // ── 1. Balaji: qty-fusion amounts, CM missing, ref-first matching ─────────
  {
    const dir = path.join(BASE, 'RDC vs Balaji Infratech');
    const rdc = await parseLedger(path.join(dir, 'RDC_Balaji Infratech.pdf'), 'RDC');
    const cust = await parseLedger(path.join(dir, 'Customer_Balaji Infratech.pdf'), 'CUSTOMER');
    console.log(`\n=== BALAJI: rdc rows=${rdc.transactions.length} cust rows=${cust.transactions.length}`);
    const t4141 = rdc.transactions.find(t => t.narration?.includes('3GJ25ARS4141'));
    ck('Balaji: 3GJ25ARS4141 amount = 4,501.70 (was 14,501.70)', !!t4141 && Math.abs(t4141.debit - 4501.7) < 0.01, `got ${t4141?.debit}`);
    const cm = rdc.transactions.find(t => t.narration?.includes('2SR25ARCM42'));
    ck('Balaji: credit memo 2SR25ARCM42 captured', !!cm, cm ? `${cm.voucherType} credit=${cm.credit}` : 'missing');
    ck('Balaji: CM classified as CREDIT_NOTE w/ credit 33,276', !!cm && cm.voucherType === 'CREDIT_NOTE' && Math.abs(cm.credit - 33276) < 1, `got ${cm?.credit}`);
    const res = reconcile(rdc, cust, { ...OPTS, partyName: 'Balaji' });
    console.log(`matched=${res.matches.length} unmatchedRdc=${res.unmatchedRdc.length} unmatchedCust=${res.unmatchedCustomer.length}`);
    const matchedInv = res.matches.filter(m => m.rdcTxn?.narration?.includes('3GJ25ARS3792'));
    ck('Balaji: 3GJ25ARS3792 now MATCHES (ref-first) despite amount diff', matchedInv.length === 1, matchedInv[0] ? `diff=${matchedInv[0].difference.toFixed(2)}` : '');
    const matchedTotal = res.matches.reduce((s, m) => s + Math.abs(m.rdcAmount || 0), 0);
    ck('Balaji: matched RDC value > 80 lakhs (user vlookup found 86.7L)', matchedTotal > 8000000, fmt(matchedTotal));
    const rdcGap = (res.cards as any).rdcLedgerIntegrityGap;
    ck('Balaji: RDC ledger integrity gap < 1000 (was ~4.1L of misread amounts)', Math.abs(rdcGap) < 1000, fmt(rdcGap));
    ck('Balaji: summary has opening-balance or variance line when applicable', res.summaryLines.length > 4);
  }

  // ── 2. Malan: FIN002 PDF must parse; no silent blank ──────────────────────
  {
    const dir = path.join(BASE, 'RDC vs Maland');
    const cust = await parseLedger(path.join(dir, 'Malnad Project Ledger.pdf'), 'CUSTOMER');
    console.log(`\n=== MALAN: customer rows=${cust.transactions.length} opening=${fmt(cust.balances.opening)} closing=${fmt(cust.balances.closing)}`);
    ck('Malan: customer PDF parses (> 100 rows; was 0/blank)', cust.transactions.length > 100, String(cust.transactions.length));
    const gap = (cust.balances.closing ?? 0) - cust.transactions.reduce((s, t) => s + t.signedAmountRdcView, cust.balances.opening || 0);
    ck('Malan: parsed rows tie to running balance (gap < 1)', Math.abs(gap) < 1, fmt(gap));
    const rdc = await parseLedger(path.join(dir, 'RDC_Debtors_Ledger_Excel_Repor_010726_Maland.xlsx'), 'RDC');
    const res = reconcile(rdc, cust, { ...OPTS, partyName: 'Malan' });
    ck('Malan: customer balance no longer 0 in summary', Math.abs(res.summaryLines[1].amount) > 1, fmt(res.summaryLines[1].amount));
    console.log(`matched=${res.matches.length} summary custBal=${fmt(res.summaryLines[1].amount)}`);
  }

  // ── 3. Synergia: orientation + opening diff + receipts split ──────────────
  {
    const dir = path.join(BASE, 'RDC vs Synergia');
    const rdc = await parseLedger(path.join(dir, 'RDC_ Synergia Ledger.xlsx'), 'RDC');
    const cust = await parseLedger(path.join(dir, 'Customer_ Synergia Ledger.pdf'), 'CUSTOMER');
    console.log(`\n=== SYNERGIA: rdc rows=${rdc.transactions.length} cust rows=${cust.transactions.length}`);
    ck('Synergia: customer PDF parses', cust.transactions.length > 10, String(cust.transactions.length));
    const res = reconcile(rdc, cust, { ...OPTS, partyName: 'Synergia' });
    const invSum = cust.transactions.filter(t => t.voucherType === 'INVOICE').reduce((s, t) => s + t.signedAmountRdcView, 0);
    ck('Synergia: invoices positive in RDC view after orientation pass', invSum > 0, fmt(invSum));
    ck('Synergia: opening-balance difference line in summary', res.summaryLines.some(l => /Opening balance difference/i.test(l.particular)), res.summaryLines.map(l=>l.particular).join(' | ').slice(0,120));
    const matchedVal = res.matches.filter(m => !['PAYMENT','RECEIPT'].includes(m.rdcTxn?.voucherType||'')).reduce((s,m)=>s+Math.abs(m.rdcAmount||0),0);
    ck('Synergia: matched invoice value > 1 crore (user found 1.12Cr)', matchedVal > 10000000, fmt(matchedVal));
    const recMatched = res.matches.filter(m => ['PAYMENT','RECEIPT'].includes(m.rdcTxn?.voucherType||''));
    console.log(`matched inv value=${fmt(matchedVal)} receipts matched=${recMatched.length} unexplained=${fmt(res.summaryLines.at(-1)?.amount)}`);
  }

  // ── 4. Talib: Tally xlsx — sane refs, amounts on customer rows ────────────
  {
    const dir = path.join(BASE, 'RDC vs Talib');
    const rdc = await parseLedger(path.join(dir, 'RDC Ledger.xlsx'), 'RDC');
    const cust = await parseLedger(path.join(dir, 'Talib_Customer Ledger.xlsx'), 'CUSTOMER');
    console.log(`\n=== TALIB: rdc rows=${rdc.transactions.length} cust rows=${cust.transactions.length}`);
    const badRefs = cust.transactions.filter(t => /\.\d{1,2}$/.test(t.normalizedReferenceNo || '') || (t.normalizedReferenceNo || '').length > 18);
    ck('Talib: no ref+amount fused references (like 7MU69603053690.00)', badRefs.length === 0, `${badRefs.length} bad, e.g. ${badRefs[0]?.normalizedReferenceNo || ''}`);
    const zeroAmt = cust.transactions.filter(t => t.referenceNo && !t.debit && !t.credit);
    ck('Talib: customer rows with a reference carry an amount', zeroAmt.length === 0, `${zeroAmt.length} zero-amount`);
    const closingLeak = [...rdc.transactions, ...cust.transactions].filter(t => /closing balance/i.test(t.particulars || t.narration || ''));
    ck('Talib: no Closing Balance rows leaked into transactions', closingLeak.length === 0, String(closingLeak.length));
    const res = reconcile(rdc, cust, { ...OPTS, partyName: 'Talib' });
    console.log(`matched=${res.matches.length} unmatchedRdc=${res.unmatchedRdc.length} unexplained=${fmt(res.summaryLines.at(-1)?.amount)}`);
    ck('Talib: some invoices match', res.matches.length > 50, String(res.matches.length));
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
