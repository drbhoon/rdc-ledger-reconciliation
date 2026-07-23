/**
 * Offline validation of the AI-rescue building blocks (no API calls):
 *  - aiRowsToParseResult conversion (signs, balances, de-dupe, refs)
 *  - estimateCostUsd pricing math
 *  - certificate gating stays intact when AI is disabled
 * Run: npx tsx scripts/validate-rescue.ts
 */
import { aiRowsToParseResult, aiVisionRescueParse, type AiLedgerRow } from '../src/services/aiLedgerService';
import { aiCallAllowed, estimateCostUsd, getAiConfig, getAiRunState, recordAiCallFailure, recordAiCallSuccess, startAiRun } from '../src/core/aiConfig';
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

// ── run guardrails (time budget + circuit breaker) ───────────────────────────
const cfg = getAiConfig();
startAiRun({ ...cfg, timeBudgetMs: 60_000 });
ck('guard: calls allowed within budget', aiCallAllowed() === true);
for (let i = 0; i < 6; i++) recordAiCallFailure();
ck('guard: breaker trips after 6 consecutive failures', getAiRunState().tripped === true);
ck('guard: tripped breaker blocks further calls', aiCallAllowed() === false);
startAiRun({ ...cfg, timeBudgetMs: 60_000 });
for (let i = 0; i < 5; i++) recordAiCallFailure();
recordAiCallSuccess();
recordAiCallFailure();
ck('guard: a success resets the failure streak', getAiRunState().tripped === false && aiCallAllowed() === true);
startAiRun({ ...cfg, timeBudgetMs: 0 });
ck('guard: exhausted time budget blocks calls', aiCallAllowed() === false && getAiRunState().budgetExhausted === true, `skipped=${getAiRunState().skippedCalls}`);

// ── vision rescue gating ─────────────────────────────────────────────────────
(async () => {
  const disabled = await aiVisionRescueParse(__filename, 'x.pdf', 'CUSTOMER', { ...cfg, enabled: false });
  ck('vision: disabled AI returns undefined (no crash, no call)', disabled === undefined);

  // Page-window splitting on a real scanned PDF (local-only data; skip if absent)
  const { existsSync, readFileSync } = await import('fs');
  const scanned = './test-data-210726/Customer The Indogrid 30Jun26.pdf';
  if (existsSync(scanned)) {
    const { splitPdfForVision } = await import('../src/services/aiLedgerService');
    const { pageCount, chunks } = await splitPdfForVision(readFileSync(scanned));
    ck('vision: 17-page hi-res scan splits into 4-page windows', pageCount === 17 && chunks.length === 5, `pages=${pageCount} chunks=${chunks.length}`);
    ck('vision: every window is a valid PDF', chunks.every(c => c.subarray(0, 5).toString() === '%PDF-'));
    ck('vision: windows are call-sized (< 4MB each)', chunks.every(c => c.length < 4 * 1024 * 1024), `max=${Math.max(...chunks.map(c => c.length))}`);
  } else {
    console.log('SKIP vision split checks (local scanned PDF not present)');
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
