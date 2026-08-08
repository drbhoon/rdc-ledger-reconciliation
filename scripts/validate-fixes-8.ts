/**
 * Round-13 harness (2026-07-27): Senghani — the accounts team reported the AI
 * reco had far more line items and disputed amounts than their manual one.
 * Manual statement (01-Apr-25..20-Jun-26):
 *   RDC 1,22,28,830.14 | Senghani 59,70,696.00 | Difference 62,58,134.14
 * Covers: split-voucher ERP exports (one bill spread over several account
 * rows, invoice number in the narration), cheque-level payment grouping,
 * RDC invoice/credit-note cancellation netting, and short-receipt pairing.
 * Run: npx tsx scripts/validate-fixes-8.ts   (data: ./test-data-250726, gitignored)
 */
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { auditLedger } from '../src/core/audit';
import { reconcile } from '../src/core/reconcile';

const DIR = path.join(process.cwd(), 'test-data-250726');
let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC Senghani Ledger 6-6-26.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'Senghani -Leela Site ledger.xlsx'), 'CUSTOMER');

  // ── split-voucher parsing ─────────────────────────────────────────────────
  ck('split-voucher adapter used', cust.parserLog.some(l => /Split-voucher adapter/.test(l.message)));
  const invoices = cust.transactions.filter(t => t.voucherType === 'INVOICE');
  const tds = cust.transactions.filter(t => t.voucherType === 'TDS');
  ck('one INVOICE per bill, not one row per account head', invoices.length === 4329, String(invoices.length));
  ck('withholding tax kept as its own entries', tds.length === 4310, String(tds.length));
  ck('invoice number lifted out of the narration (every bill has one)',
    invoices.every(t => !!t.referenceNo) && invoices.filter(t => /^\d{1,2}[A-Z]{2}\d{2}/.test(t.referenceNo || '')).length > 4000,
    `${invoices.filter(t => !t.referenceNo).length} without a reference`);
  ck('cheque number captured on payments', cust.transactions.filter(t => t.voucherType === 'PAYMENT' && t.chequeNo).length >= 40);
  ck("customer closing = team's 59,70,696", Math.abs((cust.balances.closing ?? 0) - 5970696) < 1, String(cust.balances.closing));
  const custAudit = auditLedger(cust, 'CUSTOMER');
  ck('customer parse PROVED against its printed Dr/Cr totals', custAudit.verdict === 'PASS', `${custAudit.verdict} Dr gap ${custAudit.debitTotalGap?.toFixed(2)}`);
  ck('RDC parse proved against its printed totals', auditLedger(rdc, 'RDC').verdict === 'PASS');
  ck("RDC closing = team's 1,22,28,830", Math.abs((rdc.balances.closing ?? 0) - 12228830.14) < 1, String(rdc.balances.closing));

  // ── reconciliation ────────────────────────────────────────────────────────
  const r = reconcile(rdc, cust, { partyName: 'Senghani', periodStart: '2025-04-01', periodEnd: '2026-06-20', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  ck('CERTIFIED', r.cards.certified === true, String(r.cards.verdict));
  ck('unexplained ~ 0', Math.abs(Number(r.cards.unexplainedDifference)) <= 1, String(r.cards.unexplainedDifference));
  ck("difference = team's 62,58,134", Math.abs((r.summaryLines.find(l => l.particular === 'Difference')?.amount ?? 0) - 6258134.14) < 1);
  ck('coverage > 95%', Number(r.cards.matchedCoveragePct) > 95, String(r.cards.matchedCoveragePct));

  // the complaint was line-item noise: these are the numbers that caused it
  ck('unmatched RDC rows down to a reviewable handful (was 350)', r.unmatchedRdc.length <= 80, String(r.unmatchedRdc.length));
  const cnLine = r.summaryLines.find(l => /not booked by customer — Credit/.test(l.particular));
  ck('cancelled-invoice credit notes netted off (₹70L of noise removed)', !cnLine || cnLine.amount < 1000000, String(cnLine?.amount));
  ck('cancellation pairs recorded as net-zero', r.netZeroReversals.some(t => t.parserNotes?.some(n => /cancelled by credit note/.test(n))));

  // one cheque paid as four vouchers must match RDC's single receipt
  const chequeGrouped = r.matches.find(m => /invoice allocations totalling|matched to RDC receipt/i.test(m.remarks || '') && (m.rdcAmount ?? 0) === -973808);
  ck('4 vouchers under cheque 006557 matched RDC receipt ₹9,73,808', !!chequeGrouped, chequeGrouped?.remarks?.slice(0, 60));

  // short receipt: paid 90,03,090 / received 87,52,994.56
  const shortfall = r.matches.find(m => m.reasonCode === 'PAYMENT_AMOUNT_MISMATCH');
  ck('short receipt paired and its shortfall reported', !!shortfall && Math.abs(Math.abs(shortfall.difference) - 250095.44) < 1, String(shortfall?.difference));

  // the payment genuinely missing from RDC's books
  const missingPayment = r.summaryLines.find(l => /accounted by customer but not in RDC — Receipts/.test(l.particular));
  ck('payment not yet in RDC books isolated (₹58,01,712)', !!missingPayment && Math.abs(missingPayment.amount - 5801712) < 1, String(missingPayment?.amount));

  // TDS is one line, as in the manual statement
  const tdsLine = r.summaryLines.find(l => /TDS \/ TCS/.test(l.particular));
  ck('TDS deducted by the customer shown as a single line', !!tdsLine && Math.abs(tdsLine.amount - 168982) < 1, String(tdsLine?.amount));
  ck('reconciling lines stay readable (<= 12)', r.summaryLines.length <= 12, String(r.summaryLines.length));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
