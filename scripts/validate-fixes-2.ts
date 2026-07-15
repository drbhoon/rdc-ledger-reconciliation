/**
 * Validation for the 06/07/26 retest feedback (second round).
 * Run: npx tsx scripts/validate-fixes-2.ts "./test-data-060726/Ledger Recon New Testing_060726"
 */
import path from 'path';
import fs from 'fs';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';

const BASE = process.argv[2];
if (!BASE || !fs.existsSync(BASE)) { console.error('Pass the 060726 test-data directory'); process.exit(1); }

const OPTS = { partyName: 'Test', periodStart: '2000-01-01', periodEnd: '2099-12-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 };

let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };
const fmt = (n?: number) => (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const isPay = (v?: string) => ['PAYMENT', 'RECEIPT'].includes(v || '');

async function main() {
  // ── TALIB ──────────────────────────────────────────────────────────────
  {
    const dir = path.join(BASE, 'RDC vs Talib');
    const rdc = await parseLedger(path.join(dir, 'RDC Ledger.xlsx'), 'RDC');
    const cust = await parseLedger(path.join(dir, 'Talib_Customer Ledger.xlsx'), 'CUSTOMER');
    console.log(`\n=== TALIB: rdc=${rdc.transactions.length} cust=${cust.transactions.length} rdcOpen=${fmt(rdc.balances.opening)} rdcClose=${fmt(rdc.balances.closing)}`);
    // 1. customer INVOICE amounts must NOT be 30 (credit-days misread).
    // (TDS journal rows can genuinely be ₹30 — those are excluded.)
    const cust30 = cust.transactions.filter(t => ['INVOICE', 'JOURNAL_INVOICE'].includes(t.voucherType) && t.referenceNo && Math.abs(t.signedAmountRdcView) === 30);
    ck('Talib: no customer invoice amounts read as 30 (credit days)', cust30.length === 0, `${cust30.length} rows =30`);
    const c7960 = cust.transactions.find(t => (t.normalizedReferenceNo || '').includes('7MU6960'));
    ck('Talib: 7MU6960 customer amount = 53,690', !!c7960 && Math.abs(c7960.signedAmountRdcView) === 53690, `got ${c7960?.signedAmountRdcView}`);
    // 2. CM rows are credit notes, not receipts
    const cm = rdc.transactions.filter(t => (t.referenceNo || '').includes('ARCM'));
    ck('Talib: CM rows classified CREDIT_NOTE (not RECEIPT)', cm.length > 0 && cm.every(t => t.voucherType === 'CREDIT_NOTE'), `${cm.length} CMs, types ${[...new Set(cm.map(t=>t.voucherType))].join(',')}`);
    // 3. REV grouped with receipts (67 REC + 1 REV in this ledger)
    const receipts = rdc.transactions.filter(t => t.voucherType === 'RECEIPT');
    ck('Talib: REC+REV both classified RECEIPT (68 total)', receipts.length === 68, String(receipts.length));
    // 4. no Grand Total / closing rows in transactions
    const totals = rdc.transactions.filter(t => /grand total|closing balance/i.test([t.particulars, t.narration, t.voucherNo].join(' ')));
    ck('Talib: no Grand Total/Closing rows in RDC transactions', totals.length === 0, String(totals.length));
    const res = reconcile(rdc, cust, { ...OPTS, partyName: 'Talib' });
    const gapLines = res.summaryLines.filter(l => /integrity gap/.test(l.particular));
    ck('Talib: no giant integrity-gap lines (was 6.48Cr/6.46Cr)', gapLines.every(l => l.amount < 500000), gapLines.map(l => fmt(l.amount)).join(', ') || 'none');
    // 5. receipts matched (67 REC ↔ payment vouchers)
    const recMatches = res.matches.filter(m => isPay(m.rdcTxn?.voucherType));
    ck('Talib: customer payments matched to RDC receipts (>= 40)', recMatches.length >= 40, String(recMatches.length));
    const matchedVariance = res.summaryLines.find(l => /Amount differences on reference-matched/.test(l.particular));
    ck('Talib: matched-variance line sane (< 50L, was 6.95Cr)', !matchedVariance || matchedVariance.amount < 5000000, fmt(matchedVariance?.amount));
    console.log(`matched=${res.matches.length} (receipts ${recMatches.length}) unexplained=${fmt(res.summaryLines.at(-1)?.amount)}`);
    ck('Talib: unexplained ≈ 0', Math.abs(res.summaryLines.at(-1)?.amount || 0) < 1, fmt(res.summaryLines.at(-1)?.amount));

    // Round-3: sign convention = Customer − RDC on every line
    const line = (re: RegExp) => res.summaryLines.find(l => re.test(l.particular));
    const varL = line(/Amount differences on reference-matched/);
    // Collapsed-ref matches carry paise-level (≤ ₹1) differences that sum into
    // this line, so assert the sign convention and that it stays small.
    ck('Talib r3: matched-variance sign per Customer−RDC (Add, small)', varL?.sign === 'Add' && varL.amount < 1000, `${varL?.sign} ${fmt(varL?.amount)}`);
    const refT = line(/Reference truncated/);
    ck('Talib r3: unmatched-RDC group displayed as Less', !refT || refT.sign === 'Less', `${refT?.sign} ${fmt(refT?.amount)}`);
    const entC = line(/Entry accounted by customer/);
    ck('Talib r3: unmatched-customer group displayed as Add', !entC || entC.sign === 'Add', `${entC?.sign} ${fmt(entC?.amount)}`);
    const tdsL = line(/TDS deducted by customer/);
    ck('Talib r3: TDS journal line displayed as Less', !tdsL || tdsL.sign === 'Less', `${tdsL?.sign} ${fmt(tdsL?.amount)}`);
    // Round-3: unmatched customer refs must be clean (no 7MU696053690CR fusions)
    const fused = res.unmatchedCustomer.filter(m => /\d{3,}CR$/i.test(m.customerTxn?.normalizedReferenceNo || ''));
    ck('Talib r3: no fused refs in Unmatched_Customer', fused.length === 0, `${fused.length} e.g. ${fused[0]?.customerTxn?.normalizedReferenceNo || ''}`);
    // Round-3: the two unmatched payments appear voucher-level with correct totals
    const unRec = res.unmatchedCustomer.filter(m => isPay(m.customerTxn?.voucherType));
    const p1 = unRec.find(m => (m.customerTxn?.voucherNo || '').includes('PYT/38154'));
    const p2 = unRec.find(m => (m.customerTxn?.voucherNo || '').includes('PYT/40622'));
    ck('Talib r3: PYT/38154 unmatched payment aggregated = 14,49,110', !!p1 && Math.abs(Math.abs(p1.customerAmount || 0) - 1449110) < 1, fmt(p1?.customerAmount));
    ck('Talib r3: PYT/40622 unmatched payment aggregated = 20,46,903', !!p2 && Math.abs(Math.abs(p2.customerAmount || 0) - 2046903) < 1, fmt(p2?.customerAmount));
    ck('Talib r3: unmatched customer receipts are exactly voucher-level rows', unRec.length === 2, String(unRec.length));

    // Round-4: truncated-ref matching + probable-match suggestions
    const collapsed = res.matches.filter(m => /Truncated customer reference/.test(m.remarks || ''));
    ck('Talib r4: truncated refs matched (10MU5071 = 10MU25ARS5071 style, > 1000)', collapsed.length > 1000, String(collapsed.length));
    const sample = collapsed.find(m => (m.customerTxn?.referenceNo || '') === '10MU5071');
    ck('Talib r4: 10MU5071 matched to 10MU25ARS5071', !!sample && (sample.rdcTxn?.referenceNo || '') === '10MU25ARS5071', `${sample?.customerTxn?.referenceNo} -> ${sample?.rdcTxn?.referenceNo}`);
    const withSugg = res.unmatchedCustomer.filter(m => m.suggestion);
    ck('Talib r4: probable-RDC suggestions on unmatched customer rows (> 100)', withSugg.length > 100, String(withSugg.length));
    ck('Talib r4: suggestion carries RDC ref + amount + row', !!withSugg[0]?.suggestion && /₹/.test(withSugg[0].suggestion!) && /RDC row/.test(withSugg[0].suggestion!), (withSugg[0]?.suggestion || '').slice(0, 60));
    ck('Talib r4: still certified after new tiers', (res.cards as any).certified === true, String((res.cards as any).verdict));
  }

  // ── SYNERGIA ───────────────────────────────────────────────────────────
  {
    const dir = path.join(BASE, 'RDC vs Synergia');
    const rdc = await parseLedger(path.join(dir, 'RDC_ Synergia Ledger.xlsx'), 'RDC');
    const cust = await parseLedger(path.join(dir, 'Customer_ Synergia Ledger.pdf'), 'CUSTOMER');
    const res = reconcile(rdc, cust, { ...OPTS, partyName: 'Synergia' });
    console.log(`\n=== SYNERGIA: rdc=${rdc.transactions.length} cust=${cust.transactions.length}`);
    // customer credit balance = positive payable to RDC
    ck('Synergia: Balance As per Synergia is POSITIVE (+8.64L, was -8.64L)', (res.summaryLines[1].amount || 0) > 0, fmt(res.summaryLines[1].amount));
    ck('Synergia: difference back to ~2.9L (was 20.18L)', Math.abs(res.summaryLines[2].amount - 290418.12) < 2000, fmt(res.summaryLines[2].amount));
    const opening = res.summaryLines.find(l => /Opening balance difference/.test(l.particular));
    ck('Synergia: opening line presented as LESS (customer less RDC)', opening?.sign === 'Less', `${opening?.sign} ${fmt(opening?.amount)}`);
    const recMatches = res.matches.filter(m => isPay(m.rdcTxn?.voucherType));
    const recValue = recMatches.reduce((s, m) => s + Math.abs(m.rdcAmount || 0), 0);
    ck('Synergia: payments matched to receipts (~1.30Cr)', recValue > 10000000, fmt(recValue));
    ck('Synergia: unexplained ≈ 0', Math.abs(res.summaryLines.at(-1)?.amount || 0) < 1, fmt(res.summaryLines.at(-1)?.amount));
    const gapLines = res.summaryLines.filter(l => /integrity gap/.test(l.particular));
    console.log('gap lines:', gapLines.map(l => `${l.sign} ${fmt(l.amount)}`).join('; ') || 'none');
    // Round-3 sign convention
    const varS = res.summaryLines.find(l => /Amount differences on reference-matched/.test(l.particular));
    ck('Synergia r3: matched-variance displayed as Less 9,571.48', varS?.sign === 'Less' && Math.abs(varS.amount - 9571.48) < 1, `${varS?.sign} ${fmt(varS?.amount)}`);
    const checkpoint = res.summaryLines[2].amount + res.summaryLines.slice(3, -1).reduce((s, l) => s + (l.sign === 'Add' ? l.amount : l.sign === 'Less' ? -l.amount : 0), 0);
    ck('Synergia r3: check point (Difference + Σ signed lines) = 0', Math.abs(checkpoint) < 1, fmt(checkpoint));
  }

  // ── BALAJI ─────────────────────────────────────────────────────────────
  {
    const dir = path.join(BASE, 'RDC vs Balaji Infratech');
    const rdc = await parseLedger(path.join(dir, 'RDC_Balaji Infratech.pdf'), 'RDC');
    const cust = await parseLedger(path.join(dir, 'Customer_Balaji Infratech.pdf'), 'CUSTOMER');
    const res = reconcile(rdc, cust, { ...OPTS, partyName: 'Balaji' });
    console.log(`\n=== BALAJI: rdc=${rdc.transactions.length} cust=${cust.transactions.length}`);
    const opening = res.summaryLines.find(l => /Opening balance difference/.test(l.particular));
    ck('Balaji: opening line presented as LESS 1.73L', opening?.sign === 'Less' && Math.abs(opening.amount - 173120.04) < 5, `${opening?.sign} ${fmt(opening?.amount)}`);
    const recMatches = res.matches.filter(m => isPay(m.rdcTxn?.voucherType));
    ck('Balaji: payments matched to receipts (> 0)', recMatches.length > 0, String(recMatches.length));
    ck('Balaji: unexplained ≈ 0', Math.abs(res.summaryLines.at(-1)?.amount || 0) < 1, fmt(res.summaryLines.at(-1)?.amount));
    console.log(`matched=${res.matches.length} (receipts ${recMatches.length})`);
    // Round-3 sign convention (their table: variance Less 7,011.28; RDC-only Less; customer-only Add)
    const varB = res.summaryLines.find(l => /Amount differences on reference-matched/.test(l.particular));
    ck('Balaji r3: matched-variance displayed as Less 7,011.28', varB?.sign === 'Less' && Math.abs(varB.amount - 7011.28) < 1, `${varB?.sign} ${fmt(varB?.amount)}`);
    const misC = res.summaryLines.find(l => /present in RDC not booked by customer/.test(l.particular));
    ck('Balaji r3: RDC-only line displayed as Less', !misC || misC.sign === 'Less', `${misC?.sign} ${fmt(misC?.amount)}`);
    const misR = res.summaryLines.find(l => /Entry accounted by customer/.test(l.particular));
    ck('Balaji r3: customer-only line displayed as Add', !misR || misR.sign === 'Add', `${misR?.sign} ${fmt(misR?.amount)}`);
    const checkpointB = res.summaryLines[2].amount + res.summaryLines.slice(3, -1).reduce((s, l) => s + (l.sign === 'Add' ? l.amount : l.sign === 'Less' ? -l.amount : 0), 0);
    ck('Balaji r3: check point (Difference + Σ signed lines) = 0', Math.abs(checkpointB) < 1, fmt(checkpointB));
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
