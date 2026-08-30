/**
 * Round 18 — the 30-Aug-26 batch (Goverdhan, Nitesh, Suliman, Makrand, Gite).
 *
 * Fourteen customers across five reports. Every assertion below is a defect one
 * of the teams named, or a figure from their own manual working.
 *
 * Run: npx tsx scripts/validate-fixes-13.ts
 *   (data: ./test-data-300826{,-nitesh,-suliman,-makrand,-gite}, all gitignored)
 */
import path from 'path';
import fs from 'fs';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';

const G = path.join(process.cwd(), 'test-data-300826');
const N = path.join(process.cwd(), 'test-data-300826-nitesh');
const S = path.join(process.cwd(), 'test-data-300826-suliman');
const M = path.join(process.cwd(), 'test-data-300826-makrand');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, actual?: unknown) => {
  if (ok) { passed += 1; console.log(`PASS ${name}${actual === undefined ? '' : `  [${actual}]`}`); }
  else { failed += 1; console.log(`FAIL ${name}  [${actual}]`); }
};
const near = (a: number | undefined, b: number, tol = 1) => a != null && Math.abs(a - b) <= tol;

async function pair(rdcFile: string, custFile: string, party: string) {
  const rdc = await parseLedger(rdcFile, 'RDC');
  const cust = await parseLedger(custFile, 'CUSTOMER');
  const r = reconcile(rdc, cust, {
    partyName: party, periodStart: '2015-04-01', periodEnd: '2026-12-31',
    invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15,
  });
  return { rdc, cust, r };
}
const cover = (r: { cards: Record<string, unknown> }) => Number(r.cards.matchedCoveragePct);
const refs = (p: { transactions: Array<{ normalizedReferenceNo?: string }> }): number =>
  p.transactions.filter(t => (t.normalizedReferenceNo || '').length >= 4).length;

(async () => {
  if (!fs.existsSync(G)) { console.log('SKIP: test-data-300826/ not present'); process.exit(0); }

  // ══ Goverdhan ══════════════════════════════════════════════════════════
  // DSR: the bill number lives in a column headed "DD" that the reader had no
  // name for, so 3,218 rows carried no reference and matching was guesswork.
  {
    const { cust, r } = await pair(path.join(G, 'RDC LEDGER DSR.xlsx'), path.join(G, 'DSR LEDGER.xlsx'), 'DSR SSC');
    check('DSR: references read from the unnamed "DD" column (was 0 of 3,218)', refs(cust) > 3000, refs(cust));
    check('DSR: the 11 debit notes are debit notes, not receipts', cust.transactions.filter(t => t.voucherType === 'DEBIT_NOTE').length === 11, cust.transactions.filter(t => t.voucherType === 'DEBIT_NOTE').length);
    check('DSR: RDC credit notes now pair with the customer debit notes', r.matches.some(m => m.rdcTxn?.voucherType === 'CREDIT_NOTE' && m.customerTxn?.voucherType === 'DEBIT_NOTE'), true);
    check('DSR: matched > 3,150 (was 2,733 on amount+date guesses)', r.matches.length > 3150, r.matches.length);
    check('DSR: coverage > 95% (was 90.9%)', cover(r) > 95, cover(r));
    check('DSR: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // Sundew: an SAP line-item statement - one signed amount column, no Dr/Cr.
  {
    const { cust, r } = await pair(path.join(G, 'RDC LEDGER  SUNDEW.xlsx'), path.join(G, 'SUNDEW LEDGER.xlsx'), 'SUNDEW');
    check('Sundew: SAP statement reads (was 0 rows, reported as a scan)', cust.transactions.length > 40, cust.transactions.length);
    check('Sundew: RDC invoice numbers read from the Reference column', refs(cust) > 30, refs(cust));
    check('Sundew: rows reproduce the report total (38,285)', near(cust.balances.closing, 38285, 2), cust.balances.closing);
    check('Sundew: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // SRR: two "Ref. #" columns, and four dateless payment rows worth 7,30,000.
  {
    const { cust, r } = await pair(path.join(G, 'RDC LEDGER SRR.xlsx'), path.join(G, 'SRR LEDGER.xlsx'), 'SRR');
    check('SRR: the four dateless payment rows are kept (7,30,000)', cust.transactions.length === 259, cust.transactions.length);
    check('SRR: ledger ties to itself (gap was 7,30,000)', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('SRR: no phantom opening-balance line — the file states no opening',
      !r.summaryLines.some(l => /Opening balance difference/i.test(String(l.particular))), true);
    check('SRR: references read from the second "Ref. #" column', refs(cust) > 200, refs(cust));
    check('SRR: matched > 245', r.matches.length > 245, r.matches.length);
    check('SRR: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // Suroj: the closing balance the team confirmed as correct.
  {
    const { cust, r } = await pair(path.join(G, 'RDC LEDGER.XLSX'), path.join(G, 'SUROJ LEDGER 2.xlsx'), 'SUROJ');
    check('Suroj: closing balance 7,06,200.69 (team-confirmed)', near(cust.balances.closing, 706200.69, 1), cust.balances.closing);
    check('Suroj: coverage > 90%', cover(r) > 90, cover(r));
    check('Suroj: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // AGA: the bill number sits in a column headed "INVOICE NO".
  {
    const { cust, r } = await pair(path.join(G, 'RDC AGA INFRA LEDGER.xlsx'), path.join(G, 'AGA LEDGER.xlsx'), 'AGA');
    check('AGA: references read from "INVOICE NO" (was 0 of 504)', refs(cust) > 450, refs(cust));
    check('AGA: no nameless "Other entries" bucket (was 488 rows / 1.15 crore)',
      cust.transactions.filter(t => t.voucherType === 'OTHER').length === 0, cust.transactions.filter(t => t.voucherType === 'OTHER').length);
    check('AGA: matched > 450 (was 9)', r.matches.length > 450, r.matches.length);
    check('AGA: coverage > 95% (was 49%)', cover(r) > 95, cover(r));
  }

  // ══ Nitesh ═════════════════════════════════════════════════════════════
  if (fs.existsSync(N)) {
    // AVK: a readable 43,615-character PDF reported as a scan.
    const { cust, r } = await pair(path.join(N, 'A V K WAREHOUSING PVT LTD.xlsx'), path.join(N, 'AVK Client Ledger.pdf'), 'AVK');
    check('AVK: the PDF reads (was 0 rows, blamed on a scan)', cust.transactions.length > 250, cust.transactions.length);
    check('AVK: bill numbers read from the voucher narration', refs(cust) > 250, refs(cust));
    check('AVK: matched > 250 (was 0)', r.matches.length > 250, r.matches.length);
    check('AVK: coverage > 95%', cover(r) > 95, cover(r));
    check('AVK: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);

    // Honeybird: payment vouchers with no voucher number to group by.
    const hb = await pair(path.join(N, 'Honeybird RDC Ledger.xlsx'), path.join(N, 'Honeybird Client Ledger.xlsx'), 'Honeybird');
    check('Honeybird: payment allocations regrouped into their cheques', Number(hb.r.cards.unmatchedCustomerCount) < 30, hb.r.cards.unmatchedCustomerCount);
    check('Honeybird: coverage > 90% (was 48%)', cover(hb.r) > 90, cover(hb.r));

    // Lotus: already correct, and must stay correct.
    const lv = await pair(path.join(N, 'Lotus Villa RDC Ledger.xlsx'), path.join(N, 'Lotus Client Ledger.pdf'), 'Lotus Villa');
    check('Lotus: still 47 of 47 matched', lv.r.matches.length === 47, lv.r.matches.length);
    check('Lotus: still one reconciling line, the 2 unbooked invoices', lv.r.cards.unmatchedRdcCount === 2, lv.r.cards.unmatchedRdcCount);
  }

  // ══ Suliman ════════════════════════════════════════════════════════════
  if (fs.existsSync(S)) {
    // Pressmatic: three "Particulars" columns, opening balance in the second.
    const { cust, r } = await pair(path.join(S, 'PRESSMATIC RDC LEDGER.xlsx'), path.join(S, 'PRESSMATIC LEDGER.xlsx'), 'Pressmatic');
    check('Pressmatic: opening balance recognised, not booked as an entry', near(cust.balances.opening, 1261263.97, 1), cust.balances.opening);
    check('Pressmatic: no phantom 14,84,245.13 opening difference',
      !r.summaryLines.some(l => /Opening balance difference/i.test(String(l.particular)) && Math.abs(Number(l.amount)) > 1400000), true);
    check('Pressmatic: coverage > 90% (was 41%)', cover(r) > 90, cover(r));

    // KBS: was already good; its opening line was the only wrong figure.
    const kbs = await pair(path.join(S, 'KBS CONSTRUCTIONS RDC LEDGER 31MAR26.xls'), path.join(S, 'KBS CONSTRUCTION LEDGER.xlsx'), 'KBS');
    check('KBS: still CERTIFIED at 96%+', kbs.r.cards.verdict === 'CERTIFIED' && cover(kbs.r) > 95, cover(kbs.r));
  }

  // ══ Makrand ════════════════════════════════════════════════════════════
  if (fs.existsSync(M)) {
    // GK: "GST INVOICE" rows filed as payments, and a closing balance read
    // upside down, producing a 3.35 crore phantom integrity gap.
    const { cust, r } = await pair(path.join(M, 'G K ENTERPRISES RDC.xlsx'), path.join(M, 'G K ENTERPRISES.xlsx'), 'GK');
    check('GK: "GST INVOICE" rows are invoices, not payments', cust.transactions.filter(t => t.voucherType === 'INVOICE').length > 150, cust.transactions.filter(t => t.voucherType === 'INVOICE').length);
    check('GK: closing balance -1,67,49,392.76, not positive', near(cust.balances.closing, -16749392.76, 1), cust.balances.closing);
    check('GK: the 3,34,98,785.52 "integrity gap" is gone', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('GK: matches on its own bill numbers (was 42)', r.matches.length > 190, r.matches.length);
    check('GK: coverage > 80% (was 26%)', cover(r) > 80, cover(r));

    // Mosh: RDC's closing row is labelled just "Balance".
    const mosh = await pair(path.join(M, 'RDC Mosh Ledger (1) (1).xlsx'), path.join(M, 'mosh ledger (1) (1).xlsx'), 'Mosh');
    check('Mosh: RDC balance 19,24,476.46, not 0.00', near(mosh.rdc.balances.closing, 1924476.46, 1), mosh.rdc.balances.closing);
    check('Mosh: RDC ledger ties to itself', near(ledgerIntegrityGap(mosh.rdc), 0, 2), ledgerIntegrityGap(mosh.rdc)?.toFixed(2));

    // MVR: two years of RDC history the customer never sent.
    const mvr = await pair(path.join(M, 'RDC MVR ledger.xlsx'), path.join(M, 'MVR ledger.xlsx'), 'MVR');
    check('MVR: coverage measured over the comparable period (was 18%)', cover(mvr.r) > 90, cover(mvr.r));
    check('MVR: unexplained difference still zero', Math.abs(Number(mvr.r.cards.unexplainedDifference)) <= 1, mvr.r.cards.unexplainedDifference);

    // AFA: was already right and must stay right.
    const afa = await pair(path.join(M, 'RDC AFA INFRA PRIVATE LIMITED (1).xlsx'), path.join(M, 'AFA LEDGER (1).xlsx'), 'AFA');
    check('AFA: still CERTIFIED at 92%+', afa.r.cards.verdict === 'CERTIFIED' && cover(afa.r) > 92, cover(afa.r));
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
})();
