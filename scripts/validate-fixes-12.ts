/**
 * Round 17 — the 19-Aug-26 batch (Mumbai, Punjab and Delhi teams).
 *
 * Twelve pairs reported in one go: two files that would not read at all, one
 * genuine scan, and a set of reconciliations whose numbers the teams could not
 * use. Every assertion below is the defect they reported, or the figure their
 * own manual working produced.
 *
 * Run: npx tsx scripts/validate-fixes-12.ts   (data: ./test-data-190826, gitignored)
 */
import path from 'path';
import fs from 'fs';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap, reconcile } from '../src/core/reconcile';
import type { ParseResult, ReconcileResult } from '../src/core/types';

const DIR = path.join(process.cwd(), 'test-data-190826');
const RAR = path.join(DIR, 'AI Reconciliation  File');

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

(async () => {
  if (!fs.existsSync(DIR)) { console.log('SKIP: test-data-190826/ not present'); process.exit(0); }

  // ── SPJ Properties: Tally COLUMNAR ledger (no Dr/Cr pair at all) ─────────
  // Reported as "Not reading data"; the app told them their .xlsx was a scan.
  {
    const { cust, r } = await pair(
      path.join(RAR, 'SPJ Reco', 'RDC SOA.xls'),
      path.join(RAR, 'SPJ Reco', 'SPJ PROPERTIES PRIVATE LIMITED SOA.xlsx'), 'SPJ Properties');
    check('SPJ: columnar ledger reads (was 0 rows)', cust.transactions.length > 400, cust.transactions.length);
    check('SPJ: rows reproduce the printed balance 6,97,654', near(cust.balances.closing, 697654), cust.balances.closing);
    check('SPJ: customer ledger ties to itself', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('SPJ: TDS column becomes its own entries', cust.transactions.filter(t => t.voucherType === 'TDS').length > 100, cust.transactions.filter(t => t.voucherType === 'TDS').length);
    check('SPJ: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
    check('SPJ: coverage > 95%', Number(r.cards.matchedCoveragePct) > 95, r.cards.matchedCoveragePct);
  }

  // ── UltraTech: SAP vendor statement, "Document Dt" + duplicated header ───
  {
    const { cust, r } = await pair(
      path.join(RAR, 'RDC VS ULTRATECH', 'RDC LEDGER.xlsx'),
      path.join(RAR, 'RDC VS ULTRATECH', 'ULTRATECH LEDGER.xlsx'), 'UltraTech');
    check('UltraTech: statement reads (was 0 rows)', cust.transactions.length > 60, cust.transactions.length);
    check('UltraTech: invoice number taken from the VARYING "Document  No", not the account code',
      cust.transactions.some(t => t.referenceNo === '8966532383'), cust.transactions[0]?.referenceNo);
    check('UltraTech: matches RDC on invoice number (was 0)', r.matches.length > 30, r.matches.length);
    check('UltraTech: difference is the real one, ~10,336', near(Math.abs(Number(r.summaryLines[2]?.amount) || 0), 10336.2, 2), r.summaryLines[2]?.amount);
  }

  // ── A ledger that read nothing must never be CERTIFIED ───────────────────
  {
    const { r } = await pair(
      path.join(DIR, 'Preet Traders 31mar26.xls'),
      path.join(DIR, 'Vend Preet Traders 31Mar26.pdf'), 'Preet Traders');
    check('Preet: scanned PDF still yields no rows (correct)', r.cards.unmatchedCustomerCount === 0 && r.matches.length === 0, r.matches.length);
    check('Preet: NOT certified against an empty ledger', r.cards.verdict === 'REVIEW REQUIRED', r.cards.verdict);
  }

  // ── Afita / Ecoform / ZCC: the last dated row was emitted once per
  //    trailing total row, so each ledger over-counted its final voucher ────
  {
    const { cust, r } = await pair(
      path.join(DIR, 'RDC-Afita-Mumbai.xlsx'), path.join(DIR, 'Afita-Mumbai.xlsx'), 'AFITA CONSTRUCTIONS');
    check('Afita: final payment counted once (gap was 21,31,400)', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('Afita: customer closing +10,59,524.90, not negative', near(cust.balances.closing, 1059524.9, 1), cust.balances.closing);
    check('Afita: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }
  {
    const { cust, r } = await pair(
      path.join(RAR, 'ZCC Techno Private Reco', 'RDC Ledger ZCC.xlsx'),
      path.join(RAR, 'ZCC Techno Private Reco', 'ZCC Techno SOA.xlsx'), 'ZCC Techno');
    check('ZCC: gap closed (was exactly 50,000 - the last row twice)', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('ZCC: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // ── Ecoform: a customer ledger with NO document references anywhere ──────
  {
    const { cust, r } = await pair(
      path.join(DIR, 'RDC-Ecoform-Mumbai.xlsx'), path.join(DIR, 'Ecoform-Mumbai.xlsx'), 'ECOFORM');
    check('Ecoform: gap closed (was 1,25,906)', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('Ecoform: invoices match on amount+date (was 10 of 156)', r.matches.length > 150, r.matches.length);
    check('Ecoform: coverage 100%', Number(r.cards.matchedCoveragePct) > 99, r.cards.matchedCoveragePct);
    check('Ecoform: statement collapses to the one real item', r.summaryLines.length <= 5, r.summaryLines.length);
    check('Ecoform: that item is the 50,000 receipt', r.summaryLines.some(l => near(Number(l.amount), 50000, 1)), true);
    check('Ecoform: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // ── Atlas: sheet starts at A3, and holds TWO ledger blocks ───────────────
  // Reported at 61%: half the rows were never read.
  {
    const { cust, r } = await pair(
      path.join(DIR, 'RDC-Atlas-Mumbai.xlsx'), path.join(DIR, 'Atlas-Mumbai.xlsx'), 'ATLAS CONSTRUCTION');
    check('Atlas: every row read (was 121 of 273)', cust.transactions.length === 273, cust.transactions.length);
    check('Atlas: Dr total = the printed 90,16,163', near(cust.transactions.reduce((s, t) => s + t.debit, 0), 9016163, 1), cust.transactions.reduce((s, t) => s + t.debit, 0));
    check('Atlas: both site openings summed = 14,82,445.80', near(cust.balances.opening, 1482445.8, 1), cust.balances.opening);
    check('Atlas: ledger ties to itself (gap was 43,52,743)', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('Atlas: closing +6,80,845.76, not negative', near(cust.balances.closing, 680845.76, 1), cust.balances.closing);
    check('Atlas: difference is 1,72,127.26, not 15,33,818.78', near(Math.abs(Number(r.summaryLines[2]?.amount) || 0), 172127.26, 2), r.summaryLines[2]?.amount);
    check('Atlas: coverage > 95% (was 61%)', Number(r.cards.matchedCoveragePct) > 95, r.cards.matchedCoveragePct);
    check('Atlas: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // ── Premix: Tally prints the closing balance on the CONTRA side ──────────
  {
    const { cust, r } = await pair(
      path.join(DIR, 'RDC-Premix-Mumbai.xlsx'), path.join(DIR, 'Premix-Mumbai.xlsx'), 'Premix RMC');
    check('Premix: closing +3,56,499.85, not negative', near(cust.balances.closing, 356499.85, 1), cust.balances.closing);
    check('Premix: ledger ties to itself', near(ledgerIntegrityGap(cust), 0, 2), ledgerIntegrityGap(cust)?.toFixed(2));
    check('Premix: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // ── Shree Ram: RDC creditor export with one opening PER SITE, and a
  //    vendor ledger whose row type lives in the contra-account column ──────
  {
    const { rdc, cust, r } = await pair(
      path.join(DIR, 'Shree Ram Ent 31Jul26 - 19-8.xls'),
      path.join(DIR, 'Vend Shree Ram Ent 31Jul.26.xls'), 'Shree Ram Enterprises');
    check('Shree Ram: both site openings kept (was 0, gap 52,00,833)', near(rdc.balances.opening, -5200833.45, 1), rdc.balances.opening);
    check('Shree Ram: RDC ledger ties to itself', near(ledgerIntegrityGap(rdc), 0, 2), ledgerIntegrityGap(rdc)?.toFixed(2));
    // 23 "Sale" rows and 9 "Rcpt" rows. Before the contra-account column was
    // read they came out as 15 invoices / 17 payments - wrong on both counts,
    // and wrong enough to flip the whole ledger's orientation.
    check('Shree Ram: 9 receipts classified from the contra account',
      cust.transactions.filter(t => t.voucherType === 'PAYMENT').length === 9, cust.transactions.filter(t => t.voucherType === 'PAYMENT').length);
    check('Shree Ram: 23 sales classified as invoices',
      cust.transactions.filter(t => t.voucherType === 'INVOICE').length === 23, cust.transactions.filter(t => t.voucherType === 'INVOICE').length);
    check('Shree Ram: every customer row matched (was 6 of 32)', r.matches.length === 32, r.matches.length);
    check('Shree Ram: matched pairs agree to the rupee (was 24.5 lakh of "differences")',
      r.matches.every(m => Math.abs(m.difference || 0) < 1), Math.max(...r.matches.map(m => Math.abs(m.difference || 0))).toFixed(2));
    check('Shree Ram: CERTIFIED', r.cards.verdict === 'CERTIFIED', r.cards.verdict);
  }

  // ── PAMR: AP statement whose only key is "Document No." ─────────────────
  {
    const { rdc, r } = await pair(
      path.join(RAR, 'PAMR Industries Reco', 'RDC SOA VENDOR.xlsx'),
      path.join(RAR, 'PAMR Industries Reco', 'PAMR SOA.xlsx'), 'PAMR INDUSTRIES');
    check('PAMR: RDC site opening kept (gap was 7,54,560)', near(ledgerIntegrityGap(rdc), 0, 2), ledgerIntegrityGap(rdc)?.toFixed(2));
    check('PAMR: matches on Document No. (was 0)', r.matches.length > 20, r.matches.length);
  }

  // ── Shri Kaila: "Payment" printed where the voucher number goes ──────────
  {
    const { cust, r } = await pair(
      path.join(RAR, 'Shri Kaila Construction', 'SKC - RDC Ledger.xls'),
      path.join(RAR, 'Shri Kaila Construction', 'SKC - Customer Ledger.pdf'), 'Shri Kaila Construction');
    check('SKC: payments classified as payments (1.01 crore was in "Other entries")',
      cust.transactions.filter(t => t.voucherType === 'OTHER').length === 0, cust.transactions.filter(t => t.voucherType === 'OTHER').length);
    check('SKC: "Payment" is not used as a reference', !cust.transactions.some(t => /^payment$/i.test(t.referenceNo || '')), true);
    check('SKC: coverage nearly doubled (was 35%)', Number(r.cards.matchedCoveragePct) > 60, r.cards.matchedCoveragePct);
  }

  // ── The gate itself: an empty ledger can never be certified ──────────────
  {
    const rdc = await parseLedger(path.join(RAR, 'SPJ Reco', 'RDC SOA.xls'), 'RDC');
    const empty: ParseResult = { transactions: [], balances: { openingRows: [], closingRows: [] }, parserLog: [] };
    const r: ReconcileResult = reconcile(rdc, empty, {
      partyName: 'Empty', periodStart: '2015-04-01', periodEnd: '2026-12-31',
      invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15,
    });
    check('gate: zero-row counterparty is REVIEW REQUIRED, never CERTIFIED', r.cards.verdict === 'REVIEW REQUIRED', r.cards.verdict);
    check('gate: and it says so in the parser log', r.parserLog.some(l => /yielded ZERO transactions/i.test(l.message)), true);
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
})();
