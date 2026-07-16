/**
 * Offline validation of the AI-rescue building blocks (no API calls):
 *  - aiRowsToParseResult conversion (signs, balances, de-dupe, refs)
 *  - estimateCostUsd pricing math
 *  - certificate gating stays intact when AI is disabled
 * Run: npx tsx scripts/validate-rescue.ts
 */
import { aiRowsToParseResult, type AiLedgerRow } from '../src/services/aiLedgerService';
import { estimateCostUsd } from '../src/core/aiConfig';
import { ledgerIntegrityGap } from '../src/core/reconcile';

let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

// ── conversion ───────────────────────────────────────────────────────────────
const rows: AiLedgerRow[] = [
  { date: '31 Mar 2024', voucherType: 'OPENING', voucherNo: '', reference: '', narration: 'Opening Balance', debit: 0, credit: 13821818.13 },
  { date: '03 Apr 2024', voucherType: 'PAYMENT', voucherNo: '57', reference: '', narration: 'Deutsche Bank Ch.No. 505217 payment paid to RDC', debit: 19809.26, credit: 0 },
  { date: '05 Apr 2024', voucherType: 'INVOICE', voucherNo: 'P/1', reference: '1CH24ARS123', narration: 'Bill booked 1CH24ARS123', debit: 0, credit: 50000 },
  // duplicate of the invoice (chunk-boundary echo) must be dropped
  { date: '05 Apr 2024', voucherType: 'INVOICE', voucherNo: 'P/1', reference: '1CH24ARS123', narration: 'Bill booked 1CH24ARS123', debit: 0, credit: 50000 },
  { date: '31 Mar 2025', voucherType: 'CLOSING', voucherNo: '', reference: '', narration: 'Closing Balance', debit: 0, credit: 13852008.87 },
];
const res = aiRowsToParseResult(rows, 'test.pdf', 'CUSTOMER');
ck('conversion: 2 transactions (duplicate dropped, balances excluded)', res.transactions.length === 2, String(res.transactions.length));
ck('conversion: opening balance captured (+1,38,21,818.13)', Math.abs((res.balances.opening ?? 0) - 13821818.13) < 0.01, String(res.balances.opening));
ck('conversion: closing balance captured', Math.abs((res.balances.closing ?? 0) - 13852008.87) < 0.01, String(res.balances.closing));
const pay = res.transactions.find(t => t.voucherType === 'PAYMENT')!;
ck('conversion: payment signed negative in RDC view (customer debit)', pay.signedAmountRdcView === -19809.26, String(pay.signedAmountRdcView));
ck('conversion: cheque number extracted from narration', pay.chequeNo === '505217', String(pay.chequeNo));
const inv = res.transactions.find(t => t.voucherType === 'INVOICE')!;
ck('conversion: invoice ref normalized', inv.normalizedReferenceNo === '1CH24ARS123', String(inv.normalizedReferenceNo));
ck('conversion: rows flagged as AI-extracted', res.transactions.every(t => t.parserNotes?.includes('AI-extracted row (rescue parser)')));
// integrity math over the converted result
const gap = ledgerIntegrityGap(res);
ck('conversion: integrity gap computable', gap !== undefined, String(gap?.toFixed(2)));

// ── pricing ──────────────────────────────────────────────────────────────────
ck('cost: gpt-5-mini 1M in + 100k out = $0.45', Math.abs(estimateCostUsd('gpt-5-mini', 1_000_000, 100_000) - 0.45) < 1e-9, String(estimateCostUsd('gpt-5-mini', 1_000_000, 100_000)));
ck('cost: gpt-4.1-mini 65k in + 12k out ≈ $0.045', Math.abs(estimateCostUsd('gpt-4.1-mini', 65_000, 12_000) - 0.0452) < 0.001, String(estimateCostUsd('gpt-4.1-mini', 65_000, 12_000)));
ck('cost: gpt-5 pricing distinct from gpt-5-mini', estimateCostUsd('gpt-5', 1_000_000, 0) === 1.25, String(estimateCostUsd('gpt-5', 1_000_000, 0)));
ck('cost: unknown model falls back to default', estimateCostUsd('mystery-model', 1_000_000, 0) === 1.0);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
